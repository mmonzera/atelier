import { Hono } from 'hono';
import { type AppConfig, isAllowedHost } from '../config.js';
import type { BrowserManager } from './manager.js';
import { browserToolsForMcpList, executeBrowserTool } from './tools.js';

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
 * Streamable HTTP MCP server mounted outside `/api` at `/mcp/browser`.
 * Authenticated via per-turn Bearer token issued by CliAgentRunner.
 */
export function createBrowserMcpRouter(deps: {
  browserManager: BrowserManager;
  config: AppConfig;
}): Hono {
  const { browserManager, config } = deps;
  const app = new Hono();

  app.post('/', async (c) => {
    const host = c.req.header('host');
    if (!isAllowedHost(host, config.port)) {
      return c.json({ error: 'Forbidden host' }, 403);
    }

    const authHeader = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const token = match?.[1]?.trim();
    const ctx = token ? browserManager.resolveTurnToken(token) : null;
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
          serverInfo: { name: 'atelier-browser', version: '0.1.0' },
        });
      }
      if (method === 'ping') {
        return rpcOk(req.id, {});
      }
      if (method === 'tools/list') {
        return rpcOk(req.id, { tools: browserToolsForMcpList() });
      }
      if (method === 'tools/call') {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments ?? {};
        if (!name) {
          return rpcErr(req.id, -32602, 'Missing tool name');
        }
        const result = await executeBrowserTool(browserManager, name, args, {
          agentId: ctx.agentId,
          projectId: ctx.projectId,
          messageId: ctx.messageId,
        });
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
