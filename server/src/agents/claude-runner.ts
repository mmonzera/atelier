import fs from 'node:fs';
import path from 'node:path';
import type { BrowserManager } from '../browser/manager.js';
import type { AppConfig } from '../config.js';
import {
  getAgentWorkspacePath,
  getDirectAgentWorkspacePath,
  getProjectRepoPath,
} from '../github.js';
import { toLaunchSpec } from '../mcp/config.js';
import type { AtelierStore } from '../store.js';
import { resolveMcpAuth } from '../mcp/oauth.js';
import { AttachmentStore } from '../attachments.js';
import { RoomContextBuilder } from '../channels/context.js';
import { conversationTail, estimateTokens, getScopeKey } from './compactor.js';
import { buildAgentSystemPrompt, renderCanon } from './prompts.js';
import { buildClaudeExtraAllowedTools, buildEffectiveTurnGrants } from './permissions.js';
import type { AgentRunner, Turn, TurnCallbacks } from './runner.js';
import { applyAtelierActions } from './atelier-actions.js';
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
    private readonly browserManager?: BrowserManager,
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
      turn.omitCompaction ? null : compaction,
      [],
      turn.canonText ?? renderCanon(this.store.listCanon(scopeKey)).text,
    );
    const attachmentStore = new AttachmentStore(this.config.dataDir);
    const artifactDirectory = this.store.artifactDirectory(turn.project?.id ?? null);
    const channel = turn.channelId ? this.store.channels.getChannel(turn.channelId) : null;
    let promptText: string;
    if (channel && !turn.recallContinuation) {
      const triggerMessage = turn.currentMessageId
        ? this.store.getMessage(turn.currentMessageId)
        : null;
      const built = new RoomContextBuilder(this.store.channels).build({
        channel,
        agent: turn.agent,
        project: turn.project,
        projectAgents: teamAgents,
        allAgents: this.store.listAgents(),
        tasks: projectTasks,
        triggerMessage,
        currentPrompt: turn.prompt,
        hasResumeSession: Boolean(turn.resumeSessionId),
        turnPurpose: turn.turnPurpose,
        trust: turn.trust,
        tailTokens: settings.autoCompact.tailTokens,
        attachmentNote: (m) => attachmentStore.describe(m.metadata?.attachments),
        omitSummary: turn.omitCompaction,
      });
      cb.onMemoryTail?.(built.memoryTokens.tail, {
        stubs: built.memoryTokens.stubs,
        delta: built.memoryTokens.delta,
      });
      promptText =
        turn.resumeSessionId && turn.canonChanged && turn.canonText
          ? `Canon update since last turn (replaces previous Canon):\n${turn.canonText}\n\n${built.fullPrompt}`
          : built.fullPrompt;
    } else {
      const tail = turn.resumeSessionId || turn.recallContinuation ? '' : conversationTail(
            this.store.listAgentMessages(turn.agent.id, turn.project?.id ?? null),
            compaction,
            turn.prompt,
            settings.autoCompact.tailTokens,
            (m) => attachmentStore.describe(m.metadata?.attachments),
            turn.currentMessageId,
          );
      cb.onMemoryTail?.(estimateTokens(tail));
      promptText = tail ? `${tail}\n\nCURRENT MESSAGE: ${turn.prompt}`
        : turn.resumeSessionId && turn.canonChanged && turn.canonText
          ? `Canon update since last turn (replaces previous Canon):\n${turn.canonText}\n\n${turn.prompt}`
          : turn.prompt;
    }

    if (turn.memoryBlock && !turn.recallContinuation) promptText = `${turn.memoryBlock}\n\n${promptText}`;

    const tools = createStudioTools({
      store: this.store,
      projectId: turn.project?.id ?? null,
      actingAgentId: turn.agent.id,
      enqueue: this.getEnqueue(),
      dataDir: this.config.dataDir,
      cwd,
      config: this.config,
      trust: turn.trust,
      channelId: turn.channelId,
      rootMessageId: turn.rootMessageId,
    });
    const atelierMcp = await createAtelierSdkMcpServer(
      tools,
      !turn.memoryOnly && turn.agent.browser?.enabled && this.browserManager
        ? {
            browserManager: this.browserManager,
            ctx: {
              agentId: turn.agent.id,
              projectId: turn.project?.id ?? null,
              messageId: turn.replyMessageId ?? null,
              signal: turn.signal,
            },
          }
        : undefined,
    );

    const model = turn.modelOverride || turn.agent.modelOverride || settings.model;

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

    const effectiveGrants = buildEffectiveTurnGrants({
      settingsGrants: settings.approvedPermissions,
      oneTimeGrants: turn.oneTimeGrants,
      attachedMcp,
    });
    const extraGrantTools = buildClaudeExtraAllowedTools(effectiveGrants, turn.agent.allowShell);
    const extraMcpTools = attachedMcp.map((s) => `mcp__${s.name}__*`);
    const allowedTools = [
      ...new Set([
        ...(turn.agent.allowShell
          ? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__atelier__*']
          : ['Read', 'Write', 'mcp__atelier__*']),
        ...extraMcpTools,
        ...extraGrantTools,
      ]),
    ];

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
            : turn.project?.allowFullPermissions && turn.trust !== 'teammate'
              ? 'bypassPermissions'
              : 'acceptEdits',
          allowedTools,
          additionalDirectories: [attachmentStore.directory, ...(fs.existsSync(artifactDirectory) ? [artifactDirectory] : [])],
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            if (!turn.agent.allowShell && toolName === 'Bash') {
              return { behavior: 'deny', message: 'Shell execution is disabled for this agent.' };
            }
            if (turn.trust === 'teammate' && toolName === 'Bash') {
              const cmd =
                (typeof input.command === 'string' && input.command) ||
                (typeof input.cmd === 'string' && input.cmd) ||
                '';
              if (/\b(?:git\s+push|rm\s+-rf|npm\s+publish|pnpm\s+publish|yarn\s+publish)\b|curl\b[^|]*\|\s*(?:sh|bash)/i.test(cmd)) {
                if (turn.channelId) {
                  this.store.channels.postMessage({
                    channelId: turn.channelId,
                    author: 'system',
                    agentId: null,
                    text: `${turn.agent.name} requested approval: \`${cmd.slice(0, 120)}\``,
                    metadata: {
                      approvalRequest: {
                        command: cmd.slice(0, 300),
                        approved: false,
                        agentId: turn.agent.id,
                      },
                    },
                  });
                }
                return {
                  behavior: 'deny',
                  message: `needs_user_approval: Sensitive command "${cmd.slice(0, 80)}" cannot run from a teammate trigger without explicit user approval.`,
                };
              }
            }
            const fileCandidate =
              (typeof input.file_path === 'string' && input.file_path) ||
              (typeof input.path === 'string' && input.path) ||
              null;
            // Archived files and user attachments can be read outside the workspace.
            const isRead = ['Read', 'Glob', 'Grep'].includes(toolName);
            const insideArchive = isRead && fileCandidate && (
              isPathInside(fileCandidate, attachmentStore.directory) || isPathInside(fileCandidate, artifactDirectory)
            );
            if (fileCandidate && !insideArchive && !isPathInside(fileCandidate, cwd)) {
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
            cb.onContextTokens?.(Number(u.input_tokens ?? 0) +
              Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0));
          }
        }
      }

      if (/<atelier-action>/i.test(finalText)) {
        const actionRes = applyAtelierActions(finalText, tools, cb);
        finalText = actionRes.cleanText;
      }

      return { finalText: finalText || 'Completed turn.' };
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
    }
  }
  public async summarizeWithSdk(prompt: string, systemPrompt: string, cwd: string, model: string, signal: AbortSignal): Promise<string> {
    const packageName = '@anthropic-ai/claude-agent-sdk';
    const sdk = await import(packageName);
    signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const event of sdk.query({
        prompt,
        options: { cwd, model, systemPrompt, tools: [], mcpServers: {}, maxTurns: 1, persistSession: false, abortController },
      })) {
        if (event.type === 'result' && event.subtype === 'success') return event.result as string;
      }
      throw new Error('Claude returned no memory summary.');
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
