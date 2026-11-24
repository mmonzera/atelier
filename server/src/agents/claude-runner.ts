import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import {
  getAgentWorkspacePath,
  getDirectAgentWorkspacePath,
  getProjectRepoPath,
} from '../github.js';
import { toLaunchSpec } from '../mcp/config.js';
import type { AtelierStore } from '../store.js';
import { resolveMcpAuth } from '../mcp/oauth.js';
import { formatUncompactedConversation, getScopeKey } from './compactor.js';
import { buildAgentSystemPrompt } from './prompts.js';
import type { AgentRunner, Turn, TurnCallbacks } from './runner.js';
import {
  type EnqueueTaskFn,
  createAtelierSdkMcpServer,
  createStudioTools,
} from './studio-tools.js';

function isPathInside(targetPath: string, rootDir: string): boolean {
  const resolvedTarget = path.resolve(rootDir, targetPath);
  const resolvedRoot = path.resolve(rootDir);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + path.sep)
  );
}

export class ClaudeAgentRunner implements AgentRunner {
  constructor(
    private readonly store: AtelierStore,
    private readonly config: AppConfig,
    private readonly getEnqueue: () => EnqueueTaskFn,
  ) {}

  async run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }> {
    if (!this.config.anthropicApiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not configured. Sign in via Models & Login or set it in .env.',
      );
    }

    type SdkQueryFn = (params: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
    let sdk: { query?: SdkQueryFn } | null = null;
    try {
      const modName = '@anthropic-ai/claude-agent-sdk';
      sdk = (await import(modName)) as { query?: SdkQueryFn };
    } catch (err) {
      throw new Error(
        `Claude Agent SDK (@anthropic-ai/claude-agent-sdk) unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (typeof sdk.query !== 'function') {
      throw new Error('Claude Agent SDK loaded without query() export.');
    }

    const cwd = turn.project
      ? turn.agent.allowShell && turn.project.repo?.localPath
        ? turn.project.repo.localPath
        : turn.agent.allowShell
          ? getProjectRepoPath(this.config.workspacesDir, turn.project.id)
          : getAgentWorkspacePath(this.config.workspacesDir, turn.project.id, turn.agent.id)
      : getDirectAgentWorkspacePath(this.config.workspacesDir, turn.agent.id);
    fs.mkdirSync(cwd, { recursive: true });

    const teamAgents = turn.project
      ? this.store.listProjectAgents(turn.project.id)
      : this.store.listAgents();
    const projectTasks = turn.project
      ? this.store.listProjectTasks(turn.project.id)
      : this.store.listAgentTasks(turn.agent.id);
    const agentProjects = this.store.listAgentProjects(turn.agent.id);
    const settings = this.store.getSettings();
    const scopeKey = getScopeKey(turn.project?.id ?? null);
    const compaction = turn.agent.contextCompactions?.[scopeKey] ?? null;
    const attachedMcp = await resolveMcpAuth(this.store, this.store.getMcpServersForAgent(turn.agent));
    const appendPrompt = buildAgentSystemPrompt(
      turn.agent,
      turn.project,
      teamAgents,
      projectTasks,
      attachedMcp,
      settings.mcpServers,
      agentProjects,
      compaction,
    );
    const promptText = turn.resumeSessionId
      ? turn.prompt
      : formatUncompactedConversation(
          this.store.listAgentMessages(turn.agent.id, turn.project?.id ?? null),
          compaction,
          turn.prompt,
          12,
        );

    const tools = createStudioTools({
      store: this.store,
      projectId: turn.project?.id ?? null,
      actingAgentId: turn.agent.id,
      enqueue: this.getEnqueue(),
      dataDir: this.config.dataDir,
    });
    const atelierMcp = await createAtelierSdkMcpServer(tools);

    const model = turn.agent.modelOverride || settings.model;

    const mcpServers: Record<string, unknown> = {};
    if (atelierMcp) {
      mcpServers.atelier = atelierMcp;
    }
    for (const s of attachedMcp) {
      if (s.transport === 'stdio') {
        const spec = toLaunchSpec(s);
        mcpServers[s.name] = {
          type: 'stdio',
          command: spec.command,
          args: spec.args,
          ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
        };
      } else {
        mcpServers[s.name] = {
          type: s.transport,
          url: s.url ?? '',
          ...(s.headers && Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
        };
      }
    }

    const extraMcpTools = attachedMcp.map((s) => `mcp__${s.name}__*`);
    const allowedTools = turn.agent.allowShell
      ? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__atelier__*', ...extraMcpTools]
      : ['Read', 'Write', 'mcp__atelier__*', ...extraMcpTools];

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    turn.signal.addEventListener('abort', onAbort, { once: true });

    let finalText = '';

    try {
      const stream = sdk.query({
        prompt: promptText,
        options: {
          cwd,
          model,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: appendPrompt,
          },
          resume: turn.resumeSessionId || undefined,
          includePartialMessages: true,
          permissionMode: !turn.agent.allowShell
            ? 'default'
            : turn.project?.allowFullPermissions
              ? 'bypassPermissions'
              : 'acceptEdits',
          allowedTools,
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            if (!turn.agent.allowShell && toolName === 'Bash') {
              return { behavior: 'deny', message: 'Shell execution is disabled for this agent.' };
            }
            const fileCandidate =
              (typeof input.file_path === 'string' && input.file_path) ||
              (typeof input.path === 'string' && input.path) ||
              null;
            if (fileCandidate && !isPathInside(fileCandidate, cwd)) {
              return {
                behavior: 'deny',
                message: `Access denied outside project workspace: ${cwd}`,
              };
            }
            return { behavior: 'allow', updatedInput: input };
          },
          mcpServers,
          abortController,
        },
      });

      for await (const event of stream) {
        if (turn.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const evType = String(event.type || '');
        if (typeof event.session_id === 'string') {
          cb.onSession(event.session_id);
        }

        if (evType === 'stream_event' && event.event && typeof event.event === 'object') {
          const inner = event.event as Record<string, unknown>;
          if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
            const deltaObj = inner.delta as Record<string, unknown>;
            if (deltaObj.type === 'text_delta' && typeof deltaObj.text === 'string') {
              finalText += deltaObj.text;
              cb.onText(deltaObj.text);
            }
          }
        } else if (evType === 'assistant' && event.message && typeof event.message === 'object') {
          const msg = event.message as Record<string, unknown>;
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block && typeof block === 'object') {
                const b = block as Record<string, unknown>;
                if (b.type === 'tool_use' && typeof b.name === 'string') {
                  cb.onTool(b.name, b.input ?? {});
                }
              }
            }
          }
        } else if (evType === 'result') {
          if (typeof event.result === 'string' && !finalText) {
            finalText = event.result;
            cb.onText(finalText);
          }
          if (event.usage && typeof event.usage === 'object') {
            const u = event.usage as Record<string, unknown>;
            cb.onUsage?.(Number(u.input_tokens ?? 0), Number(u.output_tokens ?? 0));
          }
        }
      }

      return { finalText: finalText || 'Completed turn.' };
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
    }
  }
}
