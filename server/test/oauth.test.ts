import crypto from 'node:crypto';
import type { McpServerConfig } from '@atelier/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthClientRequiredError,
  completeMcpOAuth,
  disconnectMcpOAuth,
  getMcpOAuthStatus,
  resolveMcpAuth,
  startMcpOAuth,
} from '../src/mcp/oauth.js';

const MCP = 'https://mcp.example.com/mcp';
const AS = 'https://auth.example.com';
const REDIRECT = 'http://127.0.0.1:8787/api/mcp/oauth/callback';

function makeStore() {
  const mem = new Map<string, string>();
  return {
    mem,
    store: {
      getMcpOAuth: (id: string) => mem.get(id) ?? null,
      setMcpOAuth: (id: string, d: string | null) => {
        if (d === null) mem.delete(id);
        else mem.set(id, d);
      },
      listMcpOAuthIds: () => [...mem.keys()],
    } as never,
  };
}

const server: McpServerConfig = {
  id: 'mcp_1',
  name: 'example',
  transport: 'http',
  url: MCP,
  enabled: true,
  auth: 'oauth',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface Provider {
  tokenCalls: URLSearchParams[];
  refreshResult: () => Response;
}

function installProvider(opts: { dcr?: boolean } = {}): Provider {
  const dcr = opts.dcr ?? true;
  const p: Provider = {
    tokenCalls: [],
    refreshResult: () =>
      json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === MCP) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"`,
          },
        });
      }
      if (url.includes('oauth-protected-resource')) {
        return json({ resource: MCP, authorization_servers: [AS] });
      }
      if (url.startsWith(`${AS}/.well-known/oauth-authorization-server`)) {
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          ...(dcr ? { registration_endpoint: `${AS}/register` } : {}),
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${AS}/register`) return json({ client_id: 'client-1' }, 201);
      if (url === `${AS}/token`) {
        const form = new URLSearchParams(String(init?.body));
        p.tokenCalls.push(form);
        if (form.get('grant_type') === 'authorization_code') {
          return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
        }
        return p.refreshResult();
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return p;
}

async function login(store: never) {
  const authUrl = new URL(await startMcpOAuth(store, server, REDIRECT));
  const state = authUrl.searchParams.get('state')!;
  await completeMcpOAuth(store, 'the-code', state);
  return authUrl;
}

describe('MCP OAuth login', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('builds a PKCE authorize URL, exchanges the code and sends a Bearer header', async () => {
    const provider = installProvider();
    const { store } = makeStore();
    const authUrl = await login(store);

    expect(authUrl.origin + authUrl.pathname).toBe(`${AS}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe('client-1');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('resource')).toBe(MCP);
    expect(authUrl.searchParams.get('scope')).toBe('read write');

    // the challenge must be the S256 hash of the verifier sent at token exchange
    const exchange = provider.tokenCalls[0];
    const expected = crypto
      .createHash('sha256')
      .update(exchange.get('code_verifier')!)
      .digest('base64url');
    expect(authUrl.searchParams.get('code_challenge')).toBe(expected);
    expect(exchange.get('code')).toBe('the-code');

    expect(getMcpOAuthStatus(store)[server.id].connected).toBe(true);
    const [resolved] = await resolveMcpAuth(store, [server]);
    expect(resolved.headers?.Authorization).toBe('Bearer access-1');
  });

  it('rejects an unknown or replayed state', async () => {
    installProvider();
    const { store } = makeStore();
    await expect(completeMcpOAuth(store, 'c', 'forged')).rejects.toThrow(/expired/);

    const authUrl = new URL(await startMcpOAuth(store, server, REDIRECT));
    const state = authUrl.searchParams.get('state')!;
    await completeMcpOAuth(store, 'c', state);
    await expect(completeMcpOAuth(store, 'c', state)).rejects.toThrow(/expired/);
  });

  it('refreshes an expiring token and keeps the rotated refresh token', async () => {
    const provider = installProvider();
    const { store } = makeStore();
    await login(store);

    vi.setSystemTime(Date.now() + 3600_000 - 10_000); // inside the refresh skew
    const [resolved] = await resolveMcpAuth(store, [server]);
    expect(resolved.headers?.Authorization).toBe('Bearer access-2');
    expect(provider.tokenCalls.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(provider.tokenCalls.at(-1)?.get('refresh_token')).toBe('refresh-1');

    vi.setSystemTime(Date.now() + 3600_000 - 10_000);
    await resolveMcpAuth(store, [server]);
    expect(provider.tokenCalls.at(-1)?.get('refresh_token')).toBe('refresh-2');
  });

  it('marks the server disconnected when the refresh token was revoked', async () => {
    const provider = installProvider();
    provider.refreshResult = () => json({ error: 'invalid_grant' }, 400);
    const { store } = makeStore();
    await login(store);

    vi.setSystemTime(Date.now() + 3600_000);
    const [resolved] = await resolveMcpAuth(store, [server]);
    expect(resolved.headers?.Authorization).toBeUndefined();
    expect(getMcpOAuthStatus(store)[server.id].connected).toBe(false);
  });

  it('leaves token-based and stdio servers untouched', async () => {
    installProvider();
    const { store } = makeStore();
    const plain: McpServerConfig = { ...server, id: 'p', auth: undefined, headers: { X: '1' } };
    const stdio: McpServerConfig = { id: 's', name: 's', transport: 'stdio', command: 'x', enabled: true };
    const out = await resolveMcpAuth(store, [plain, stdio]);
    expect(out[0]).toEqual(plain);
    expect(out[1]).toEqual(stdio);
  });

  it('refuses login for stdio servers', async () => {
    installProvider();
    const { store } = makeStore();
    await expect(
      startMcpOAuth(store, { id: 's', name: 's', transport: 'stdio', command: 'x', enabled: true }, REDIRECT),
    ).rejects.toThrow(/remote/);
  });

  it('asks for your own OAuth app when the provider has no automatic registration', async () => {
    const provider = installProvider({ dcr: false });
    const { store } = makeStore();
    await expect(startMcpOAuth(store, server, REDIRECT)).rejects.toBeInstanceOf(
      OAuthClientRequiredError,
    );

    const creds = { clientId: 'my-app', clientSecret: 'my-secret' };
    const authUrl = new URL(await startMcpOAuth(store, server, REDIRECT, creds));
    expect(authUrl.searchParams.get('client_id')).toBe('my-app');
    await completeMcpOAuth(store, 'c', authUrl.searchParams.get('state')!);
    expect(provider.tokenCalls[0].get('client_secret')).toBe('my-secret');
    expect(getMcpOAuthStatus(store)[server.id].connected).toBe(true);

    // logging out keeps the app, so logging in again needs no credentials
    disconnectMcpOAuth(store, server.id);
    expect(getMcpOAuthStatus(store)[server.id].connected).toBe(false);
    const again = new URL(await startMcpOAuth(store, server, REDIRECT));
    expect(again.searchParams.get('client_id')).toBe('my-app');
  });

  it('forgets a dynamically registered app on log out', async () => {
    installProvider();
    const { store } = makeStore();
    await login(store);
    disconnectMcpOAuth(store, server.id);
    expect(getMcpOAuthStatus(store)[server.id]).toBeUndefined();
  });

  it('requests only the configured scope when one is set', async () => {
    installProvider();
    const { store } = makeStore();
    const url = new URL(
      await startMcpOAuth(store, { ...server, oauthScope: 'repo read:user' }, REDIRECT),
    );
    expect(url.searchParams.get('scope')).toBe('repo read:user');
  });

  it('ignores non-HTTPS resource_metadata URLs in WWW-Authenticate', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === MCP) {
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="http://evil.example/.well-known/oauth-protected-resource"',
            },
          });
        }
        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
          return json({ resource: MCP, authorization_servers: [AS] });
        }
        if (url.startsWith(`${AS}/.well-known/oauth-authorization-server`)) {
          return json({
            issuer: AS,
            authorization_endpoint: `${AS}/authorize`,
            token_endpoint: `${AS}/token`,
            registration_endpoint: `${AS}/register`,
            code_challenge_methods_supported: ['S256'],
          });
        }
        if (url === `${AS}/register`) return json({ client_id: 'client-1' }, 201);
        return new Response('not found', { status: 404 });
      }),
    );

    const { store } = makeStore();
    await startMcpOAuth(store, server, REDIRECT);
    expect(requested.some((u) => u.startsWith('http://evil.example'))).toBe(false);
    expect(requested).toContain('https://mcp.example.com/.well-known/oauth-protected-resource/mcp');
  });
});
