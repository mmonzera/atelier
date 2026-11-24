import { spawn } from 'node:child_process';
import type { McpProbeResult, McpServerConfig } from '@atelier/contracts';
import { toLaunchSpec } from './config.js';

interface JsonRpcResponse {
  id?: number | string | null;
  result?: {
    tools?: Array<{ name?: string }>;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

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

async function probeStdio(cfg: McpServerConfig, timeoutMs: number): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const command = cfg.command?.trim();
  if (!command) {
    return {
      ok: false,
      tools: [],
      error: 'Missing stdio command.',
      durationMs: Date.now() - startedAt,
    };
  }

  const spec = toLaunchSpec(cfg);
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let stderrTail = '';
    let childPid: number | undefined;

    const finish = (res: Omit<McpProbeResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(childPid);
      resolve({
        ...res,
        durationMs: Date.now() - startedAt,
      });
    };

    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...(cfg.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childPid = child.pid;

    const timer = setTimeout(() => {
      finish({
        ok: false,
        tools: [],
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for MCP response.${
          stderrTail ? ` stderr: ${stderrTail.slice(-300)}` : ''
        }`,
      });
    }, timeoutMs);

    child.once('error', (err) => {
      finish({
        ok: false,
        tools: [],
        error: `Failed to spawn command: ${err.message}`,
      });
    });

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

        if (msg.id === 1) {
          if (msg.error) {
            finish({
              ok: false,
              tools: [],
              error: msg.error.message || 'MCP initialize failed.',
            });
            return;
          }
          try {
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
            );
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
            );
          } catch (err) {
            finish({
              ok: false,
              tools: [],
              error: err instanceof Error ? err.message : 'Failed writing tools/list.',
            });
          }
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({
              ok: false,
              tools: [],
              error: msg.error.message || 'MCP tools/list failed.',
            });
            return;
          }
          const tools = Array.isArray(msg.result?.tools)
            ? msg.result!.tools.map((t) => String(t.name || '')).filter(Boolean)
            : [];
          finish({ ok: true, tools });
        }
      }
    });

    child.once('close', (code) => {
      if (!settled) {
        finish({
          ok: false,
          tools: [],
          error: `MCP process exited (code ${code ?? 'unknown'}) before completing handshake.${
            stderrTail ? ` stderr: ${stderrTail.slice(-300)}` : ''
          }`,
        });
      }
    });

    try {
      const initReq = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'atelier', version: '0.2.0' },
        },
      };
      child.stdin?.write(`${JSON.stringify(initReq)}\n`);
    } catch (err) {
      finish({
        ok: false,
        tools: [],
        error: err instanceof Error ? err.message : 'Failed sending initialize.',
      });
    }
  });
}

function parseJsonOrSse(text: string, expectedId: number): JsonRpcResponse | null {
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

async function probeHttp(cfg: McpServerConfig, timeoutMs: number): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const url = cfg.url?.trim();
  if (!url) {
    return {
      ok: false,
      tools: [],
      error: 'Missing HTTP endpoint URL.',
      durationMs: Date.now() - startedAt,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | null = null;

  const postRpc = async (body: unknown): Promise<{ status: number; text: string }> => {
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
  };

  try {
    const initRes = await postRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atelier', version: '0.2.0' },
      },
    });
    if (initRes.status >= 400) {
      return {
        ok: false,
        tools: [],
        error: `HTTP ${initRes.status}: ${initRes.text.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const initRpc = parseJsonOrSse(initRes.text, 1);
    if (initRpc?.error) {
      return {
        ok: false,
        tools: [],
        error: initRpc.error.message || 'MCP initialize error.',
        durationMs: Date.now() - startedAt,
      };
    }

    await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);

    const listRes = await postRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    if (listRes.status >= 400) {
      return {
        ok: false,
        tools: [],
        error: `HTTP ${listRes.status}: ${listRes.text.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const listRpc = parseJsonOrSse(listRes.text, 2);
    if (listRpc?.error) {
      return {
        ok: false,
        tools: [],
        error: listRpc.error.message || 'MCP tools/list error.',
        durationMs: Date.now() - startedAt,
      };
    }

    const tools = Array.isArray(listRpc?.result?.tools)
      ? listRpc!.result!.tools.map((t) => String(t.name || '')).filter(Boolean)
      : [];
    return {
      ok: true,
      tools,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : 'HTTP MCP probe failed.',
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeMcpServer(
  cfg: McpServerConfig,
  timeoutMs = 20000,
): Promise<McpProbeResult> {
  if (cfg.transport === 'sse') {
    return {
      ok: false,
      tools: [],
      error: 'Legacy SSE test not supported; it will still be passed to agents.',
      durationMs: 0,
    };
  }
  if (cfg.transport === 'http') {
    return probeHttp(cfg, timeoutMs);
  }
  return probeStdio(cfg, timeoutMs);
}
