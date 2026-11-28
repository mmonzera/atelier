import crypto from 'node:crypto';
import { Hono } from 'hono';
import { type AppConfig, isAllowedHost } from '../config.js';
import type { AtelierStore } from '../store.js';
import { executeOfficeTool, officeToolsForMcpList } from './tools.js';

export interface OfficeTurnTokenRecord {
  agentId: string;
  projectId: string | null;
  cwd: string;
  allowShell: boolean;
  createdAt: number;
}

export class OfficeManager {
  public readonly store: AtelierStore;
  public readonly config: AppConfig;
  private readonly turnTokens = new Map<string, OfficeTurnTokenRecord>();

  constructor(opts: { store: AtelierStore; config: AppConfig }) {
    this.store = opts.store;
    this.config = opts.config;
  }

  public issueTurnToken(ctx: {
    agentId: string;
    projectId: string | null;
    cwd: string;
    allowShell: boolean;
  }): string {
    const token = crypto.randomBytes(24).toString('base64url');
    this.turnTokens.set(token, { ...ctx, createdAt: Date.now() });
    return token;
  }

  public resolveTurnToken(token: string): OfficeTurnTokenRecord | null {
    return this.turnTokens.get(token) ?? null;
  }

  public revokeTurnToken(token: string): void {
    this.turnTokens.delete(token);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcOk(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcErr(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Streamable HTTP MCP server mounted outside `/api` at `/mcp/office`.
 * Authenticated via per-turn Bearer token issued by CliAgentRunner.
 */
export function createOfficeMcpRouter(deps: {
  officeManager: OfficeManager;
  config: AppConfig;
}): Hono {
  const { officeManager, config } = deps;
  const app = new Hono();

  app.post('/', async (c) => {
    const host = c.req.header('host');
    if (!isAllowedHost(host, config.port)) {
      return c.json({ error: 'Forbidden host' }, 403);
    }

    const authHeader = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const token = match?.[1]?.trim();
    const ctx = token ? officeManager.resolveTurnToken(token) : null;
    if (!ctx) {
      return c.json({ error: 'Unauthorized or expired MCP turn token' }, 401);
    }

    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | JsonRpcRequest[] | null;
    if (!body) {
      return c.json(rpcErr(null, -32700, 'Invalid JSON'), 400);
    }

    const handleOne = async (req: JsonRpcRequest) => {
      const method = req.method ?? '';
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return null;
      }
      if (method === 'initialize') {
        return rpcOk(req.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'atelier-office', version: '0.1.0' },
        });
      }
      if (method === 'ping') {
        return rpcOk(req.id, {});
      }
      if (method === 'tools/list') {
        return rpcOk(req.id, { tools: officeToolsForMcpList() });
      }
      if (method === 'tools/call') {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments ?? {};
        if (!name) {
          return rpcErr(req.id, -32602, 'Missing tool name');
        }
        const result = await executeOfficeTool(
          { store: officeManager.store, config: officeManager.config },
          name,
          args,
          {
            agentId: ctx.agentId,
            projectId: ctx.projectId,
            cwd: ctx.cwd,
            allowShell: ctx.allowShell,
          },
        );
        return rpcOk(req.id, {
          content: [{ type: 'text', text: result.text }],
          isError: result.isError,
        });
      }
      return rpcErr(req.id, -32601, `Method not found: ${method}`);
    };

    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map(handleOne))).filter((r) => r !== null);
      if (results.length === 0) return c.body(null, 202);
      return c.json(results);
    }

    const res = await handleOne(body);
    if (res === null) {
      return c.body(null, 202);
    }
    return c.json(res);
  });

  return app;
}
