import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig, ModelEntry, ModelProvider } from '@atelier/contracts';
import type { AppConfig } from '../config.js';
import {
  getAgentWorkspacePath,
  getDirectAgentWorkspacePath,
  getProjectRepoPath,
} from '../github.js';
import {
  buildCodexMcpArgs,
  claudeAllowedMcpTools,
  writeAgentMcpConfigFile,
} from '../mcp/config.js';
import type { AtelierStore } from '../store.js';
import { ClaudeAgentRunner } from './claude-runner.js';
import { resolveCliBinary, spawnCli } from './cli-spawn.js';
import { AttachmentStore } from '../attachments.js';
import { formatUncompactedConversation, getScopeKey, getUncompactedMessages } from './compactor.js';
import { resolveMcpAuth } from '../mcp/oauth.js';
import { buildAgentSystemPrompt } from './prompts.js';
import type { AgentRunner, Turn, TurnCallbacks } from './runner.js';
import {
  CreateAgentToolSchema,
  CreateTaskToolSchema,
  type EnqueueTaskFn,
  MessageAgentToolSchema,
  RunBrowserQaToolSchema,
  type StudioTools,
  UpdateTaskToolSchema,
  createStudioTools,
} from './studio-tools.js';

const ACTION_TAG_RE = /<atelier-action>\s*([\s\S]*?)\s*<\/atelier-action>/g;

export function discoverLocalCodexModels(): ModelEntry[] {
  const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (!fs.existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      models?: Array<{ slug?: string; display_name?: string; visibility?: string }>;
    };
    if (!Array.isArray(raw.models)) return [];
    return raw.models
      .filter((m) => m.slug && m.visibility !== 'hide')
      .map((m) => ({
        id: String(m.slug),
        label: String(m.display_name || m.slug),
        provider: 'openai' as const,
        builtIn: true,
      }));
  } catch {
    return [];
  }
}

export function applyAtelierActions(
  rawText: string,
  tools: StudioTools,
  cb: Pick<TurnCallbacks, 'onTool'>,
): { cleanText: string; actionsExecuted: number } {
  let actionsExecuted = 0;

  const cleanText = rawText
    .replace(ACTION_TAG_RE, (_full, jsonPayload: string) => {
      try {
        const obj = JSON.parse(jsonPayload) as Record<string, unknown>;
        const toolName = typeof obj.tool === 'string' ? obj.tool : '';
        if (toolName === 'create_agent') {
          const parsed = CreateAgentToolSchema.parse(obj);
          const { agent } = tools.create_agent(parsed);
          cb.onTool('atelier.create_agent', { name: agent.name, role: agent.role });
          actionsExecuted += 1;
        } else if (toolName === 'create_task') {
          const parsed = CreateTaskToolSchema.parse(obj);
          const { task } = tools.create_task(parsed);
          cb.onTool('atelier.create_task', { identifier: task.identifier, title: task.title });
          actionsExecuted += 1;
        } else if (toolName === 'update_task') {
          const parsed = UpdateTaskToolSchema.parse(obj);
          const { task } = tools.update_task(parsed);
          cb.onTool('atelier.update_task', { identifier: task.identifier, status: task.status });
          actionsExecuted += 1;
        } else if (toolName === 'message_agent') {
          const parsed = MessageAgentToolSchema.parse(obj);
          tools.message_agent(parsed);
          cb.onTool('atelier.message_agent', { targetAgentId: parsed.targetAgentId });
          actionsExecuted += 1;
        } else if (toolName === 'run_browser_qa') {
          const parsed = RunBrowserQaToolSchema.parse(obj);
          const { url } = tools.run_browser_qa(parsed);
          cb.onTool('atelier.run_browser_qa', { url, watchLive: parsed.watchLive });
          actionsExecuted += 1;
        }
      } catch {
        // Ignore malformed action blocks
      }
      return '';
    })
    .trim();

  return { cleanText, actionsExecuted };
}

function validateModelId(model: string): string {
  const trimmed = model.trim();
  if (!/^[a-zA-Z0-9._:/-]+$/.test(trimmed)) {
    throw new Error(`Invalid model identifier: "${model}"`);
  }
  return trimmed;
}

function parseProviderSessionId(
  stored: string | null,
  expectedProvider: ModelProvider,
): string | null {
  if (!stored) return null;
  const prefix = `${expectedProvider}:`;
  if (stored.startsWith(prefix)) {
    return stored.slice(prefix.length) || null;
  }
  return null;
}

function readJsonLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
      idx = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    const rest = buffer.trim();
    if (rest) onLine(rest);
  });
}

export class CliAgentRunner implements AgentRunner {
  private readonly sdkFallback: ClaudeAgentRunner;

  constructor(
    private readonly store: AtelierStore,
    private readonly config: AppConfig,
    private readonly getEnqueue: () => EnqueueTaskFn,
  ) {
    this.sdkFallback = new ClaudeAgentRunner(store, config, getEnqueue);
  }

  private get attachmentStore(): AttachmentStore {
    return new AttachmentStore(this.config.dataDir);
  }

  private buildConversationContext(turn: Turn, hasNativeResume: boolean): string {
    if (hasNativeResume) return turn.prompt;
    const scopeKey = getScopeKey(turn.project?.id ?? null);
    const compaction = turn.agent.contextCompactions?.[scopeKey];
    const history = this.store.listAgentMessages(turn.agent.id, turn.project?.id ?? null);
    const files = this.attachmentStore;
    return formatUncompactedConversation(history, compaction, turn.prompt, 12, (m) =>
      files.describe(m.metadata?.attachments),
    );
  }

  async run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }> {
    const settings = this.store.getSettings();
    const provider = turn.providerOverride ?? turn.agent.providerOverride ?? settings.provider;
    const model = validateModelId(turn.modelOverride || turn.agent.modelOverride || settings.model);

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
    const scopeKey = getScopeKey(turn.project?.id ?? null);
    const compaction = turn.agent.contextCompactions?.[scopeKey] ?? null;
    const attachedMcp = await resolveMcpAuth(this.store, this.store.getMcpServersForAgent(turn.agent));
    const systemPrompt = buildAgentSystemPrompt(
      turn.agent,
      turn.project,
      teamAgents,
      projectTasks,
      attachedMcp,
      settings.mcpServers,
      agentProjects,
      compaction,
    );

    const tools = createStudioTools({
      store: this.store,
      projectId: turn.project?.id ?? null,
      actingAgentId: turn.agent.id,
      enqueue: this.getEnqueue(),
      dataDir: this.config.dataDir,
    });

    let rawText = '';
    if (provider === 'claude') {
      rawText = await this.runClaude(turn, cb, {
        cwd,
        model,
        systemPrompt,
        customPath: settings.cliPaths?.claude,
        mcpServers: attachedMcp,
      });
    } else if (provider === 'openai') {
      rawText = await this.runCodex(turn, cb, {
        cwd,
        model,
        systemPrompt,
        customPath: settings.cliPaths?.openai,
        mcpServers: attachedMcp,
      });
    } else if (provider === 'deepseek') {
      rawText = await this.runDeepSeek(turn, cb, {
        model,
        systemPrompt,
      });
    } else if (provider === 'opencode') {
      rawText = await this.runOpenCode(turn, cb, {
        cwd,
        model,
        systemPrompt,
        customPath: settings.cliPaths?.opencode,
        mcpServers: attachedMcp,
      });
    } else {
      rawText = await this.runAntigravity(turn, cb, {
        cwd,
        model,
        systemPrompt,
        effort: settings.reasoningEffort.toLowerCase(),
        customPath: settings.cliPaths?.antigravity,
        mcpServers: attachedMcp,
      });
    }

    const { cleanText } = applyAtelierActions(rawText, tools, cb);
    return { finalText: cleanText || 'Completed turn.' };
  }

  private async runClaude(
    turn: Turn,
    cb: TurnCallbacks,
    opts: {
      cwd: string;
      model: string;
      systemPrompt: string;
      customPath?: string;
      mcpServers: McpServerConfig[];
    },
  ): Promise<string> {
    const binPath = await resolveCliBinary('claude', opts.customPath);
    if (!binPath) {
      if (this.config.anthropicApiKey) {
        const res = await this.sdkFallback.run(turn, cb);
        return res.finalText;
      }
      throw new Error(
        'Claude CLI is not installed and ANTHROPIC_API_KEY is unset. Open Models & Login to sign in.',
      );
    }

    const nativeResumeId = parseProviderSessionId(turn.resumeSessionId, 'claude');
    const permissionMode = !turn.agent.allowShell
      ? 'acceptEdits'
      : turn.project?.allowFullPermissions
        ? 'bypassPermissions'
        : 'auto';

    const baseTools = turn.agent.allowShell ? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] : ['Read', 'Write'];
    const allowedTools = [...baseTools, ...claudeAllowedMcpTools(opts.mcpServers)].join(',');
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      opts.model,
      '--permission-mode',
      permissionMode,
      '--allowedTools',
      allowedTools,
    ];
    let mcpConfigPath: string | null = null;
    if (opts.mcpServers.length > 0) {
      mcpConfigPath = writeAgentMcpConfigFile(
        this.config.dataDir,
        turn.agent.id,
        opts.mcpServers,
      );
      args.push('--mcp-config', mcpConfigPath);
    }
    if (!turn.agent.allowShell) {
      args.push('--disallowedTools', 'Bash');
    }
    // "=" form: --add-dir is variadic and would otherwise swallow the next flag.
    args.push(`--add-dir=${this.attachmentStore.directory}`);
    if (nativeResumeId) {
      args.push('--resume', nativeResumeId);
    }

    const promptBody = this.buildConversationContext(turn, Boolean(nativeResumeId));
    const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${promptBody}`;

    try {
      return await this.execStreaming(binPath, args, opts.cwd, fullPrompt, turn.signal, (line, acc) => {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (typeof ev.session_id === 'string') cb.onSession(`claude:${ev.session_id}`);

          if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
            const inner = ev.event as Record<string, unknown>;
            if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
              const d = inner.delta as Record<string, unknown>;
              if (d.type === 'text_delta' && typeof d.text === 'string') {
                cb.onText(d.text);
                return acc + d.text;
              }
            }
          } else if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
            const msg = ev.message as Record<string, unknown>;
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
          } else if (ev.type === 'result') {
            if (ev.usage && typeof ev.usage === 'object') {
              const u = ev.usage as Record<string, unknown>;
              cb.onUsage?.(Number(u.input_tokens ?? 0), Number(u.output_tokens ?? 0));
            }
            if (typeof ev.result === 'string' && !acc) {
              cb.onText(ev.result);
              return ev.result;
            }
          }
        } catch {
          // ignore non-JSON diagnostic line
        }
        return acc;
      });
    } finally {
      if (mcpConfigPath) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  private async runCodex(
    turn: Turn,
    cb: TurnCallbacks,
    opts: {
      cwd: string;
      model: string;
      systemPrompt: string;
      customPath?: string;
      mcpServers: McpServerConfig[];
    },
  ): Promise<string> {
    const binPath = await resolveCliBinary('openai', opts.customPath);
    if (!binPath) {
      throw new Error(
        'Codex CLI not found. Install `@openai/codex` and sign in with ChatGPT in Models & Login.',
      );
    }

    const sandboxMode = !turn.agent.allowShell
      ? 'read-only'
      : turn.project?.allowFullPermissions
        ? 'danger-full-access'
        : 'workspace-write';

    const imageArgs = this.attachmentStore
      .imagePaths(turn.attachments)
      .flatMap((p) => ['--image', p]);
    const args = [
      'exec',
      ...buildCodexMcpArgs(opts.mcpServers),
      ...imageArgs,
      '--json',
      '--skip-git-repo-check',
      '-C',
      opts.cwd,
      '-s',
      sandboxMode,
      '-m',
      opts.model,
      '-',
    ];

    const promptBody = this.buildConversationContext(turn, false);
    const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${promptBody}`;

    return this.execStreaming(binPath, args, opts.cwd, fullPrompt, turn.signal, (line, acc) => {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
          cb.onSession(`openai:${ev.thread_id}`);
        } else if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
          const item = ev.item as Record<string, unknown>;
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            cb.onText(item.text);
            return acc ? `${acc}\n${item.text}` : item.text;
          }
          if (item.type === 'command_execution') {
            cb.onTool('Bash', { command: item.command });
          } else if (item.type === 'file_change') {
            cb.onTool('Edit', { changes: item.changes });
          } else if (item.type === 'mcp_tool_call') {
            cb.onTool(String(item.tool || 'mcp'), item.arguments ?? {});
          }
        } else if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
          const u = ev.usage as Record<string, unknown>;
          cb.onUsage?.(Number(u.input_tokens ?? 0), Number(u.output_tokens ?? 0));
        }
      } catch {
        if (line && !line.startsWith('{')) {
          cb.onText(`${line}\n`);
          return acc ? `${acc}\n${line}` : line;
        }
      }
      return acc;
    });
  }

  private async runAntigravity(
    turn: Turn,
    cb: TurnCallbacks,
    opts: {
      cwd: string;
      model: string;
      systemPrompt: string;
      effort: string;
      customPath?: string;
      mcpServers: McpServerConfig[];
    },
  ): Promise<string> {
    const binPath = await resolveCliBinary('antigravity', opts.customPath);
    if (!binPath) {
      throw new Error(
        'Antigravity CLI (`agy`) not found. Install `agy` or set its binary path in Models & Login.',
      );
    }

    if (opts.mcpServers.length > 0) {
      cb.onTool('atelier.mcp_skipped', { reason: 'Antigravity CLI has no MCP flag' });
    }

    const mode = !turn.agent.allowShell
      ? 'plan'
      : turn.project?.allowFullPermissions
        ? 'auto'
        : 'accept-edits';

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--model',
      opts.model,
      '--effort',
      opts.effort,
      '--mode',
      mode,
    ];

    const promptBody = this.buildConversationContext(turn, false);
    const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${promptBody}`;

    return this.execStreaming(binPath, args, opts.cwd, fullPrompt, turn.signal, (line, acc) => {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (typeof ev.session_id === 'string') cb.onSession(`antigravity:${ev.session_id}`);
        if (typeof ev.delta === 'string') {
          cb.onText(ev.delta);
          return acc + ev.delta;
        }
        if (typeof ev.text === 'string') {
          cb.onText(ev.text);
          return acc + ev.text;
        }
        if (ev.type === 'tool_use' && typeof ev.name === 'string') {
          cb.onTool(ev.name, ev.input ?? {});
        }
        if (typeof ev.result === 'string' && !acc) {
          cb.onText(ev.result);
          return ev.result;
        }
      } catch {
        cb.onText(`${line}\n`);
        return acc ? `${acc}\n${line}` : line;
      }
      return acc;
    });
  }

  private async runDeepSeek(
    turn: Turn,
    cb: TurnCallbacks,
    opts: {
      model: string;
      systemPrompt: string;
    },
  ): Promise<string> {
    const apiKey = this.store.getProviderSecret('deepseek') || this.config.deepseekApiKey;
    if (!apiKey) {
      throw new Error(
        'DeepSeek API key not configured. Add it in Accounts & Models or set DEEPSEEK_API_KEY in .env.',
      );
    }

    const scopeKey = getScopeKey(turn.project?.id ?? null);
    const compaction = turn.agent.contextCompactions?.[scopeKey];
    const history = getUncompactedMessages(
      this.store.listAgentMessages(turn.agent.id, turn.project?.id ?? null),
      compaction,
    ).slice(-12);
    const prior =
      history.length > 0 && history[history.length - 1]!.text === turn.prompt
        ? history.slice(0, -1)
        : history;

    const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: opts.systemPrompt },
      ...prior.map((m) => ({
        role: (m.author === 'agent' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.author === 'teammate' ? `[Teammate] ${m.text}` : m.text,
      })),
      { role: 'user', content: turn.prompt },
    ];

    const res = await fetch(`${this.config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: turn.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`DeepSeek API error (${res.status}): ${errBody.slice(0, 240) || res.statusText}`);
    }

    if (!res.body) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (text) cb.onText(text);
      if (data.usage) {
        cb.onUsage?.(Number(data.usage.prompt_tokens ?? 0), Number(data.usage.completion_tokens ?? 0));
      }
      return text;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta =
          parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
        if (delta) {
          accumulated += delta;
          cb.onText(delta);
        }
        if (parsed.usage) {
          cb.onUsage?.(
            Number(parsed.usage.prompt_tokens ?? 0),
            Number(parsed.usage.completion_tokens ?? 0),
          );
        }
      } catch {
        // ignore malformed SSE chunk
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          processLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) {
        processLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }

    return accumulated;
  }

  private async runOpenCode(
    turn: Turn,
    cb: TurnCallbacks,
    opts: {
      cwd: string;
      model: string;
      systemPrompt: string;
      customPath?: string;
      mcpServers: McpServerConfig[];
    },
  ): Promise<string> {
    const binPath = await resolveCliBinary('opencode', opts.customPath);
    if (!binPath) {
      throw new Error(
        'OpenCode CLI (`opencode`) not found. Install OpenCode or set its binary path in Accounts & Models.',
      );
    }

    if (opts.mcpServers.length > 0) {
      cb.onTool('atelier.mcp_skipped', {
        reason: 'OpenCode CLI manages MCP servers in opencode.json',
      });
    }

    const nativeResumeId = parseProviderSessionId(turn.resumeSessionId, 'opencode');
    const args = [
      'run',
      '--format',
      'json',
      '--model',
      opts.model,
      ...(nativeResumeId ? ['--session', nativeResumeId] : []),
    ];

    const promptBody = this.buildConversationContext(turn, Boolean(nativeResumeId));
    const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${promptBody}`;

    return this.execStreaming(binPath, args, opts.cwd, fullPrompt, turn.signal, (line, acc) => {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        const sid =
          typeof ev.sessionID === 'string'
            ? ev.sessionID
            : typeof ev.session_id === 'string'
              ? ev.session_id
              : null;
        if (sid) cb.onSession(`opencode:${sid}`);

        const part = ev.part && typeof ev.part === 'object' ? (ev.part as Record<string, unknown>) : null;
        if (ev.type === 'text' && part && typeof part.text === 'string') {
          cb.onText(part.text);
          return acc + part.text;
        }
        if (typeof ev.delta === 'string') {
          cb.onText(ev.delta);
          return acc + ev.delta;
        }
        if (typeof ev.text === 'string') {
          cb.onText(ev.text);
          return acc + ev.text;
        }
        if ((ev.type === 'tool_use' || ev.type === 'tool') && part) {
          const state =
            part.state && typeof part.state === 'object'
              ? (part.state as Record<string, unknown>)
              : null;
          cb.onTool(String(part.tool || ev.name || 'tool'), state?.input ?? part.input ?? {});
        }
        if (ev.type === 'step_finish' && part?.tokens && typeof part.tokens === 'object') {
          const t = part.tokens as Record<string, unknown>;
          cb.onUsage?.(Number(t.input ?? 0), Number(t.output ?? 0));
        }
      } catch {
        if (line && !line.startsWith('{')) {
          cb.onText(`${line}\n`);
          return acc ? `${acc}\n${line}` : line;
        }
      }
      return acc;
    });
  }

  private execStreaming(
    binPath: string,
    args: string[],
    cwd: string,
    stdinPayload: string,
    signal: AbortSignal,
    onLine: (line: string, accumulated: string) => string,
    timeoutMs = 15 * 60_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const turnController = new AbortController();
      let timedOut = false;
      const onParentAbort = () => turnController.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        turnController.abort();
      }, timeoutMs);

      const cleanupTimers = () => {
        clearTimeout(timeoutTimer);
        signal.removeEventListener('abort', onParentAbort);
      };

      const child = spawnCli(binPath, args, {
        cwd,
        stdin: 'pipe',
        signal: turnController.signal,
      });
      let accumulated = '';
      let stderrText = '';

      readJsonLines(child.stdout, (line) => {
        accumulated = onLine(line, accumulated);
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrText += chunk.toString();
      });

      child.stdin?.write(stdinPayload);
      child.stdin?.end();

      child.once('error', (err) => {
        cleanupTimers();
        reject(err);
      });

      child.once('close', (code) => {
        cleanupTimers();
        if (timedOut) {
          reject(new Error(`Agent CLI timed out after ${Math.round(timeoutMs / 60_000)}m`));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (code !== 0 && !accumulated) {
          reject(
            new Error(
              stderrText.trim() || `Agent CLI exited with status ${code ?? 'unknown'}`,
            ),
          );
          return;
        }
        resolve(accumulated);
      });
    });
  }
}
