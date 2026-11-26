import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '@atelier/contracts';
import { ACTION_TAG_RE } from '../agents/atelier-actions.js';
import type { TurnCallbacks } from '../agents/runner.js';
import { toLaunchSpec } from './config.js';

export interface McpDiscoveredTool {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpBridgeError {
  server: string;
  error: string;
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRpc {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface LiveConnection {
  server: McpServerConfig;
  tools: McpDiscoveredTool[];
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_CATALOG_CHARS = 12_000;
const MAX_TOOL_LINE_CHARS = 160;
const MAX_MCP_ACTIONS_PER_ROUND = 6;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // ignore already-exited child
  }
}

function parseJsonOrSse(text: string, expectedId: number | string): JsonRpcResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
      if (Array.isArray(parsed)) {
        return parsed.find((m) => m.id === expectedId) ?? parsed[0] ?? null;
      }
      return parsed;
    } catch {
      // fall through to SSE scan
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean.startsWith('data:')) continue;
    const jsonPart = clean.slice(5).trim();
    if (!jsonPart || jsonPart === '[DONE]') continue;
    try {
      const parsed = JSON.parse(jsonPart) as JsonRpcResponse;
      if (parsed.id === expectedId || parsed.id === undefined) {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

function mapDiscoveredTools(serverName: string, rawTools: unknown): McpDiscoveredTool[] {
  if (!Array.isArray(rawTools)) return [];
  const out: McpDiscoveredTool[] = [];
  for (const item of rawTools) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    const inputSchema =
      rec.inputSchema && typeof rec.inputSchema === 'object'
        ? (rec.inputSchema as Record<string, unknown>)
        : undefined;
    out.push({
      server: serverName,
      name,
      description,
      ...(inputSchema ? { inputSchema } : {}),
    });
  }
  return out;
}

function formatSchemaSignature(schema: Record<string, unknown> | undefined): string {
  if (!schema) return '';
  const props =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (!props) return '';
  const requiredSet = new Set(
    Array.isArray(schema.required) ? schema.required.map((r) => String(r)) : [],
  );
  const keys = Object.keys(props);
  if (keys.length === 0) return '()';
  const parts = keys.slice(0, 8).map((k) => `${k}${requiredSet.has(k) ? '*' : ''}`);
  if (keys.length > 8) parts.push(`+${keys.length - 8}`);
  return `(${parts.join(', ')})`;
}

function formatToolResultText(result: Record<string, unknown>): { text: string; isError: boolean } {
  const isError = Boolean(result.isError);
  let text = '';

  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const item of result.content) {
      if (!item || typeof item !== 'object') {
        parts.push(String(item));
        continue;
      }
      const rec = item as Record<string, unknown>;
      if (rec.type === 'text' && typeof rec.text === 'string') {
        parts.push(rec.text);
      } else if (rec.type === 'image') {
        const mime = typeof rec.mimeType === 'string' ? rec.mimeType : 'image/*';
        parts.push(`[image: ${mime}]`);
      } else if (rec.type === 'resource' && rec.resource && typeof rec.resource === 'object') {
        const res = rec.resource as Record<string, unknown>;
        if (typeof res.text === 'string') parts.push(res.text);
        else if (typeof res.uri === 'string') parts.push(`[resource: ${res.uri}]`);
        else parts.push(JSON.stringify(res));
      } else {
        parts.push(JSON.stringify(rec));
      }
    }
    text = parts.join('\n');
  } else {
    text = JSON.stringify(result);
  }

  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... [truncated]`;
  }
  return { text, isError };
}

async function connectStdio(
  cfg: McpServerConfig,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<LiveConnection> {
  const command = cfg.command?.trim();
  if (!command) {
    throw new Error('Missing stdio command.');
  }

  const spec = toLaunchSpec(cfg);
  let child: ChildProcess;
  let closed = false;
  let buffer = '';
  let stderrTail = '';
  let nextId = 1;
  const pending = new Map<number, PendingRpc>();

  const rejectAllPending = (reason: string) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  };

  child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...(cfg.env ?? {}) },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    rejectAllPending(`MCP server "${cfg.name}" closed.`);
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    killTree(child.pid);
    try {
      child.kill();
    } catch {
      // ignore
    }
  };

  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1500);
  });

  child.stdout?.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });

  child.once('error', (err) => {
    closed = true;
    rejectAllPending(`Failed to spawn MCP server "${cfg.name}": ${err.message}`);
  });

  child.once('close', (code) => {
    closed = true;
    rejectAllPending(
      `MCP process exited (code ${code ?? 'unknown'}).${stderrTail ? ` stderr: ${stderrTail.slice(-300)}` : ''}`,
    );
  });

  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
    reqSignal?: AbortSignal,
    reqTimeoutMs = timeoutMs,
  ): Promise<JsonRpcResponse> => {
    if (closed) {
      return Promise.reject(new Error(`MCP server "${cfg.name}" is closed.`));
    }
    if (reqSignal?.aborted) {
      return Promise.reject(new Error(`MCP request to "${cfg.name}" aborted.`));
    }

    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP request "${method}" to "${cfg.name}" aborted.`));
      };
      reqSignal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        reqSignal?.removeEventListener('abort', onAbort);
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(
          new Error(
            `Timed out after ${Math.round(reqTimeoutMs / 1000)}s waiting for "${method}" on "${cfg.name}".${
              stderrTail ? ` stderr: ${stderrTail.slice(-300)}` : ''
            }`,
          ),
        );
      }, reqTimeoutMs);

      pending.set(id, {
        resolve: (res) => {
          reqSignal?.removeEventListener('abort', onAbort);
          resolve(res);
        },
        reject: (err) => {
          reqSignal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer,
      });

      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        reqSignal?.removeEventListener('abort', onAbort);
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  try {
    const initRes = await sendRequest(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atelier', version: '0.2.0' },
      },
      signal,
      timeoutMs,
    );
    if (initRes.error) {
      throw new Error(initRes.error.message || 'MCP initialize failed.');
    }
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const tools: McpDiscoveredTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const listRes = await sendRequest(
        'tools/list',
        cursor ? { cursor } : {},
        signal,
        timeoutMs,
      );
      if (listRes.error) {
        throw new Error(listRes.error.message || 'MCP tools/list failed.');
      }
      tools.push(...mapDiscoveredTools(cfg.name, listRes.result?.tools));
      const nextCursor =
        typeof listRes.result?.nextCursor === 'string' ? listRes.result.nextCursor.trim() : '';
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return {
      server: cfg,
      tools,
      callTool: async (toolName, args, callSignal, callTimeoutMs = 45_000) => {
        const rpcRes = await sendRequest(
          'tools/call',
          { name: toolName, arguments: args },
          callSignal,
          callTimeoutMs,
        );
        if (rpcRes.error) {
          throw new Error(rpcRes.error.message || `MCP tool "${toolName}" failed.`);
        }
        return (rpcRes.result ?? {}) as Record<string, unknown>;
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function connectHttp(
  cfg: McpServerConfig,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<LiveConnection> {
  const url = cfg.url?.trim();
  if (!url) {
    throw new Error('Missing HTTP endpoint URL.');
  }

  let sessionId: string | null = null;
  let nextId = 1;

  const postRpc = async (
    body: Record<string, unknown>,
    reqSignal?: AbortSignal,
    reqTimeoutMs = timeoutMs,
  ): Promise<{ status: number; text: string }> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    reqSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), reqTimeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(cfg.headers ?? {}),
      };
      if (sessionId) {
        headers['Mcp-Session-Id'] = sessionId;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const nextSession = res.headers.get('mcp-session-id');
      if (nextSession) sessionId = nextSession;
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
      reqSignal?.removeEventListener('abort', onAbort);
    }
  };

  const initId = nextId++;
  const initRes = await postRpc(
    {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atelier', version: '0.2.0' },
      },
    },
    signal,
    timeoutMs,
  );
  if (initRes.status >= 400) {
    throw new Error(`HTTP ${initRes.status}: ${initRes.text.slice(0, 200)}`);
  }
  const initRpc = parseJsonOrSse(initRes.text, initId);
  if (initRpc?.error) {
    throw new Error(initRpc.error.message || 'MCP initialize error.');
  }

  await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal, timeoutMs).catch(
    () => null,
  );

  const tools: McpDiscoveredTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const listId = nextId++;
    const listRes = await postRpc(
      {
        jsonrpc: '2.0',
        id: listId,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      },
      signal,
      timeoutMs,
    );
    if (listRes.status >= 400) {
      throw new Error(`HTTP ${listRes.status}: ${listRes.text.slice(0, 200)}`);
    }
    const listRpc = parseJsonOrSse(listRes.text, listId);
    if (listRpc?.error) {
      throw new Error(listRpc.error.message || 'MCP tools/list error.');
    }
    tools.push(...mapDiscoveredTools(cfg.name, listRpc?.result?.tools));
    const nextCursor =
      typeof listRpc?.result?.nextCursor === 'string' ? listRpc.result.nextCursor.trim() : '';
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return {
    server: cfg,
    tools,
    callTool: async (toolName, args, callSignal, callTimeoutMs = 45_000) => {
      const id = nextId++;
      const res = await postRpc(
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        },
        callSignal,
        callTimeoutMs,
      );
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
      const rpc = parseJsonOrSse(res.text, id);
      if (rpc?.error) {
        throw new Error(rpc.error.message || `MCP tool "${toolName}" failed.`);
      }
      return (rpc?.result ?? {}) as Record<string, unknown>;
    },
    close: async () => {
      // HTTP MCP sessions are stateless sockets per request; nothing persistent to tear down.
    },
  };
}

/**
 * Stateful per-turn MCP client bridge for providers that lack native MCP flags
 * (Antigravity CLI, DeepSeek, OpenRouter). Keeps `stdio` processes and HTTP
 * `Mcp-Session-Id` headers alive across multiple continuation rounds in a turn.
 */
export class McpTurnBridge {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly _tools: McpDiscoveredTool[] = [];
  private readonly _errors: McpBridgeError[] = [];

  public get tools(): McpDiscoveredTool[] {
    return this._tools;
  }

  public get errors(): McpBridgeError[] {
    return this._errors;
  }

  public get hasConnectedTools(): boolean {
    return this._tools.length > 0;
  }

  public async connectAll(
    servers: McpServerConfig[],
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<void> {
    if (servers.length === 0 || signal?.aborted) return;

    const results = await Promise.allSettled(
      servers.map(async (cfg) => {
        if (cfg.transport === 'sse') {
          throw new Error('Legacy SSE transport is not supported by the MCP action bridge.');
        }
        const conn =
          cfg.transport === 'http'
            ? await connectHttp(cfg, signal, timeoutMs)
            : await connectStdio(cfg, signal, timeoutMs);
        return conn;
      }),
    );

    for (let i = 0; i < results.length; i += 1) {
      const cfg = servers[i]!;
      const res = results[i]!;
      if (res.status === 'fulfilled') {
        const conn = res.value;
        this.connections.set(cfg.name, conn);
        this._tools.push(...conn.tools);
      } else {
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        this._errors.push({ server: cfg.name, error: msg });
      }
    }
  }

  private resolveConnection(serverName: string | undefined, toolName: string): {
    conn?: LiveConnection;
    error?: string;
  } {
    if (serverName) {
      const exact = this.connections.get(serverName);
      if (exact) return { conn: exact };
      const lower = serverName.toLowerCase();
      for (const [key, conn] of this.connections) {
        if (key.toLowerCase() === lower) return { conn };
      }
      return {
        error: `MCP server "${serverName}" is not connected. Connected servers: ${[...this.connections.keys()].join(', ') || 'none'}.`,
      };
    }

    const matches = [...this.connections.values()].filter((c) =>
      c.tools.some((t) => t.name === toolName),
    );
    if (matches.length === 1) {
      return { conn: matches[0]! };
    }
    if (matches.length > 1) {
      return {
        error: `Ambiguous MCP tool "${toolName}": exposed by multiple servers (${matches.map((m) => m.server.name).join(', ')}). Specify "server".`,
      };
    }
    return {
      error: `MCP tool "${toolName}" not found on any connected server.`,
    };
  }

  public describeTool(serverName: string | undefined, toolName: string): string {
    const resolved = this.resolveConnection(serverName, toolName);
    if (!resolved.conn) {
      return JSON.stringify({ error: resolved.error ?? `Tool "${toolName}" not found.` });
    }
    const found = resolved.conn.tools.find((t) => t.name === toolName);
    if (!found) {
      return JSON.stringify({
        error: `Tool "${toolName}" not found on server "${resolved.conn.server.name}".`,
      });
    }
    return JSON.stringify({
      server: found.server,
      name: found.name,
      description: found.description,
      inputSchema: found.inputSchema ?? {},
    });
  }

  public async callTool(
    serverName: string | undefined,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 45_000,
  ): Promise<{ server: string; name: string; text: string; isError?: boolean }> {
    const resolved = this.resolveConnection(serverName, toolName);
    if (!resolved.conn) {
      return {
        server: serverName ?? 'unknown',
        name: toolName,
        text: resolved.error ?? `MCP tool "${toolName}" unavailable.`,
        isError: true,
      };
    }

    const conn = resolved.conn;
    try {
      const raw = await conn.callTool(toolName, args, signal, timeoutMs);
      const formatted = formatToolResultText(raw);
      return {
        server: conn.server.name,
        name: toolName,
        text: formatted.text,
        ...(formatted.isError ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        server: conn.server.name,
        name: toolName,
        text: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  public formatPromptCatalog(): string {
    if (this._tools.length === 0 && this._errors.length === 0) return '';

    const lines: string[] = [];
    if (this._tools.length > 0) {
      const header = [
        'MCP Action Bridge (live tools for this turn):',
        '- Your CLI/runtime does not expose external MCP servers natively, so Atelier bridges them for you.',
        '- Call any connected MCP tool below by emitting single-line `<atelier-action>` tags and waiting for the result:',
        '  <atelier-action>{"tool":"mcp_call","server":"<server>","name":"<tool>","arguments":{...}}</atelier-action>',
        '- Need exact parameter schema for a tool first? Call:',
        '  <atelier-action>{"tool":"mcp_describe","server":"<server>","name":"<tool>"}</atelier-action>',
        '- Required arguments are marked with `*` below. You may emit multiple `<atelier-action>` tags in one reply.',
        '',
        'Available MCP tools:',
      ];

      const byServer = new Map<string, McpDiscoveredTool[]>();
      for (const tool of this._tools) {
        const list = byServer.get(tool.server) ?? [];
        list.push(tool);
        byServer.set(tool.server, list);
      }

      lines.push(...header);
      let totalChars = lines.join('\n').length;

      for (const [serverName, serverTools] of byServer) {
        const serverLine = `\n[${serverName}]`;
        if (totalChars + serverLine.length > MAX_CATALOG_CHARS) break;
        lines.push(serverLine);
        totalChars += serverLine.length + 1;

        for (const tool of serverTools) {
          const sig = formatSchemaSignature(tool.inputSchema);
          const desc = tool.description.replace(/\s+/g, ' ').trim();
          let entry = `- ${tool.name}${sig}${desc ? `: ${desc}` : ''}`;
          if (entry.length > MAX_TOOL_LINE_CHARS) {
            entry = `${entry.slice(0, MAX_TOOL_LINE_CHARS - 3)}...`;
          }
          if (totalChars + entry.length + 1 > MAX_CATALOG_CHARS) {
            lines.push(`- ... (${serverTools.length - serverTools.indexOf(tool)} more tools; use mcp_describe)`);
            break;
          }
          lines.push(entry);
          totalChars += entry.length + 1;
        }
      }
    }

    if (this._errors.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Unavailable MCP servers (failed to connect this turn):');
      for (const err of this._errors) {
        lines.push(`- ${err.server}: ${err.error}`);
      }
    }

    return lines.join('\n');
  }

  public async close(): Promise<void> {
    const closers = [...this.connections.values()].map((c) => c.close().catch(() => undefined));
    this.connections.clear();
    await Promise.allSettled(closers);
  }
}

interface MatchedMcpAction {
  full: string;
  kind: 'call' | 'describe';
  server?: string;
  name: string;
  args: Record<string, unknown>;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export async function applyMcpAtelierActions(
  rawText: string,
  bridge: McpTurnBridge,
  cb: Pick<TurnCallbacks, 'onTool'>,
  signal?: AbortSignal,
): Promise<{ cleanText: string; results: Array<{ tool: string; result: string }> }> {
  const knownToolNames = new Set(bridge.tools.map((t) => t.name));
  const matches: MatchedMcpAction[] = [];

  rawText.replace(ACTION_TAG_RE, (full, jsonPayload: string) => {
    try {
      const obj = JSON.parse(jsonPayload) as Record<string, unknown>;
      const rawTool = typeof obj.tool === 'string' ? obj.tool.trim() : '';
      if (!rawTool) return full;

      if (rawTool === 'mcp_describe') {
        const name = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (!name) return full;
        const server = typeof obj.server === 'string' ? obj.server.trim() || undefined : undefined;
        matches.push({ full, kind: 'describe', server, name, args: {} });
      } else if (rawTool === 'mcp_call') {
        const name = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (!name) return full;
        const server = typeof obj.server === 'string' ? obj.server.trim() || undefined : undefined;
        const args = asRecord(obj.arguments ?? obj.args);
        matches.push({ full, kind: 'call', server, name, args });
      } else if (rawTool.startsWith('mcp__')) {
        const parts = rawTool.slice('mcp__'.length).split('__');
        const server = parts[0]?.trim() || undefined;
        const name = parts.slice(1).join('__').trim();
        if (!server || !name) return full;
        const { tool: _t, arguments: explicitArgs, ...rest } = obj;
        const args =
          explicitArgs && typeof explicitArgs === 'object' && !Array.isArray(explicitArgs)
            ? (explicitArgs as Record<string, unknown>)
            : rest;
        matches.push({ full, kind: 'call', server, name, args });
      } else if (knownToolNames.has(rawTool)) {
        const server = typeof obj.server === 'string' ? obj.server.trim() || undefined : undefined;
        const { tool: _t, server: _s, arguments: explicitArgs, ...rest } = obj;
        const args =
          explicitArgs && typeof explicitArgs === 'object' && !Array.isArray(explicitArgs)
            ? (explicitArgs as Record<string, unknown>)
            : rest;
        matches.push({ full, kind: 'call', server, name: rawTool, args });
      }
    } catch {
      // ignore malformed block
    }
    return full;
  });

  if (matches.length === 0) {
    return { cleanText: rawText, results: [] };
  }

  let cleanText = rawText;
  const results: Array<{ tool: string; result: string }> = [];
  for (const m of matches.slice(0, MAX_MCP_ACTIONS_PER_ROUND)) {
    cleanText = cleanText.replace(m.full, '');
    if (m.kind === 'describe') {
      cb.onTool('atelier.mcp_describe', { server: m.server, name: m.name });
      results.push({
        tool: 'mcp_describe',
        result: bridge.describeTool(m.server, m.name),
      });
    } else {
      const res = await bridge.callTool(m.server, m.name, m.args, signal);
      cb.onTool(`mcp__${res.server}__${res.name}`, m.args);
      results.push({
        tool: `mcp__${res.server}__${res.name}`,
        result: res.isError ? `ERROR: ${res.text}` : res.text,
      });
    }
  }

  return { cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(), results };
}
