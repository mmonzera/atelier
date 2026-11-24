import crypto from 'node:crypto';
import type { McpOAuthStatus, McpServerConfig } from '@atelier/contracts';
import type { AtelierStore } from '../store.js';

/**
 * OAuth 2.1 client for remote MCP servers (MCP authorization spec):
 *   protected-resource metadata -> authorization-server metadata -> dynamic client
 *   registration -> authorization code + PKCE(S256) -> token -> refresh.
 * Credentials are stored server-side (table `mcp_oauth`) and never put in `settings`.
 */

interface StoredOAuth {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 8707 resource indicator sent with authorize/token requests */
  resource: string;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  /** the user supplied this client (provider has no dynamic registration) */
  manualClient?: boolean;
  redirectUri: string;
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: number | null;
  };
}

interface PendingFlow {
  serverId: string;
  verifier: string;
  createdAt: number;
}

const FETCH_TIMEOUT_MS = 15_000;
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

/** The provider cannot register apps automatically: the user must bring their own client. */
export class OAuthClientRequiredError extends Error {
  constructor() {
    super('This provider needs your own OAuth app. Enter its Client ID (and secret) to continue.');
  }
}

const pending = new Map<string, PendingFlow>();
const refreshing = new Map<string, Promise<string | null>>();

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function assertSecureUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL.`);
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
    throw new Error(`${what} must use https.`);
  }
  return u;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Find the protected-resource metadata, preferring the URL the server advertises on 401. */
async function discoverResource(
  mcpUrl: URL,
): Promise<{ authServer: string; resource: string; scope?: string }> {
  let metadataUrl: string | undefined;
  let scope: string | undefined;

  try {
    const probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'atelier', version: '0.2.0' },
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const challenge = probe.headers.get('www-authenticate') ?? '';
    const rawMetaUrl = challenge.match(/resource_metadata="([^"]+)"/i)?.[1];
    if (rawMetaUrl) {
      try {
        metadataUrl = assertSecureUrl(rawMetaUrl, 'Resource metadata URL').toString();
      } catch {
        metadataUrl = undefined;
      }
    }
    scope = challenge.match(/scope="([^"]+)"/i)?.[1];
  } catch {
    // fall through to well-known locations
  }

  const candidates = [
    metadataUrl,
    `${mcpUrl.origin}/.well-known/oauth-protected-resource${mcpUrl.pathname === '/' ? '' : mcpUrl.pathname}`,
    `${mcpUrl.origin}/.well-known/oauth-protected-resource`,
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const meta = await fetchJson(candidate).catch(() => null);
    const servers = Array.isArray(meta?.authorization_servers) ? meta.authorization_servers : [];
    const authServer = str(servers[0]);
    if (meta && authServer) {
      const scopes = Array.isArray(meta.scopes_supported)
        ? meta.scopes_supported.filter((s): s is string => typeof s === 'string')
        : [];
      return {
        authServer,
        resource: str(meta.resource) ?? mcpUrl.origin,
        scope: scope ?? (scopes.length > 0 ? scopes.join(' ') : undefined),
      };
    }
  }
  // Older servers: the MCP server itself is the authorization server.
  return { authServer: mcpUrl.origin, resource: mcpUrl.origin, scope };
}

async function discoverAuthServer(issuer: string): Promise<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}> {
  const base = assertSecureUrl(issuer, 'Authorization server');
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    const meta = await fetchJson(url).catch(() => null);
    const authorizationEndpoint = str(meta?.authorization_endpoint);
    const tokenEndpoint = str(meta?.token_endpoint);
    if (meta && authorizationEndpoint && tokenEndpoint) {
      assertSecureUrl(authorizationEndpoint, 'Authorization endpoint');
      assertSecureUrl(tokenEndpoint, 'Token endpoint');
      const methods = Array.isArray(meta.code_challenge_methods_supported)
        ? meta.code_challenge_methods_supported
        : null;
      if (methods && !methods.includes('S256')) {
        throw new Error('This provider does not support PKCE (S256), which is required.');
      }
      return {
        issuer: str(meta.issuer) ?? issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: str(meta.registration_endpoint),
      };
    }
  }
  throw new Error('Could not find the provider’s OAuth configuration.');
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  assertSecureUrl(registrationEndpoint, 'Registration endpoint');
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Atelier',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = str(body?.client_id);
  if (!res.ok || !clientId) {
    throw new Error('The provider refused automatic app registration.');
  }
  return { clientId, clientSecret: str(body?.client_secret) };
}

function load(store: AtelierStore, serverId: string): StoredOAuth | null {
  const raw = store.getMcpOAuth(serverId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredOAuth;
  } catch {
    return null;
  }
}

function save(store: AtelierStore, serverId: string, data: StoredOAuth): void {
  store.setMcpOAuth(serverId, JSON.stringify(data));
}

function tokenFromResponse(
  body: Record<string, unknown>,
  previous?: StoredOAuth['tokens'],
): StoredOAuth['tokens'] | null {
  const accessToken = str(body.access_token);
  if (!accessToken) return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  return {
    accessToken,
    // some providers omit refresh_token on refresh: keep the old one
    refreshToken: str(body.refresh_token) ?? previous?.refreshToken,
    tokenType: str(body.token_type) ?? 'Bearer',
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  };
}

async function postToken(
  cfg: StoredOAuth,
  params: Record<string, string>,
): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  const form = new URLSearchParams({ ...params, client_id: cfg.clientId, resource: cfg.resource });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const res = await fetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, body };
}

/** Step 1: returns the provider login URL to open in the browser. */
export async function startMcpOAuth(
  store: AtelierStore,
  server: McpServerConfig,
  redirectUri: string,
  manual?: { clientId?: string; clientSecret?: string },
): Promise<string> {
  if (server.transport === 'stdio' || !server.url) {
    throw new Error('Login is only available for remote (HTTP) MCP servers.');
  }
  const mcpUrl = assertSecureUrl(server.url, 'MCP server URL');

  const res = await discoverResource(mcpUrl);
  const as = await discoverAuthServer(res.authServer);

  let existing = load(store, server.id);
  const manualId = manual?.clientId?.trim();
  let client: { clientId: string; clientSecret?: string };
  let manualClient = false;
  if (manualId) {
    client = { clientId: manualId, clientSecret: manual?.clientSecret?.trim() || undefined };
    manualClient = true;
    existing = null; // new credentials: old tokens belong to another app
  } else if (
    existing &&
    existing.redirectUri === redirectUri &&
    existing.tokenEndpoint === as.tokenEndpoint &&
    (existing.manualClient || existing.issuer === as.issuer)
  ) {
    client = { clientId: existing.clientId, clientSecret: existing.clientSecret };
    manualClient = Boolean(existing.manualClient);
  } else {
    if (!as.registrationEndpoint) throw new OAuthClientRequiredError();
    client = await registerClient(as.registrationEndpoint, redirectUri);
    existing = null;
  }

  const cfg: StoredOAuth = {
    issuer: as.issuer,
    authorizationEndpoint: as.authorizationEndpoint,
    tokenEndpoint: as.tokenEndpoint,
    resource: res.resource,
    scope: server.oauthScope?.trim() || res.scope,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    manualClient,
    redirectUri,
    tokens: existing?.tokens,
  };
  save(store, server.id, cfg);

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, { serverId: server.id, verifier, createdAt: now });

  const url = new URL(cfg.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('resource', cfg.resource);
  if (cfg.scope) url.searchParams.set('scope', cfg.scope);
  return url.toString();
}

/** Step 2: the browser comes back with ?code&state. */
export async function completeMcpOAuth(
  store: AtelierStore,
  code: string,
  state: string,
): Promise<{ serverId: string }> {
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS) {
    pending.delete(state);
    throw new Error('This login attempt expired. Start the connection again.');
  }
  pending.delete(state);

  const cfg = load(store, flow.serverId);
  if (!cfg) throw new Error('The MCP server was removed during login.');

  const { ok, body } = await postToken(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: flow.verifier,
  });
  const tokens = ok && body ? tokenFromResponse(body) : null;
  if (!tokens) {
    throw new Error(str(body?.error_description) ?? str(body?.error) ?? 'Token exchange failed.');
  }
  save(store, flow.serverId, { ...cfg, tokens });
  return { serverId: flow.serverId };
}

async function refreshToken(store: AtelierStore, serverId: string): Promise<string | null> {
  const cfg = load(store, serverId);
  const refresh = cfg?.tokens?.refreshToken;
  if (!cfg || !refresh) return null;

  const { ok, body } = await postToken(cfg, { grant_type: 'refresh_token', refresh_token: refresh });
  const tokens = ok && body ? tokenFromResponse(body, cfg.tokens) : null;
  if (!tokens) {
    // refresh token revoked/expired: the user has to log in again
    if (body?.error === 'invalid_grant') save(store, serverId, { ...cfg, tokens: undefined });
    return null;
  }
  save(store, serverId, { ...cfg, tokens });
  return tokens.accessToken;
}

/** A valid access token for the server (refreshing it if needed), or null when not connected. */
export async function getMcpAccessToken(
  store: AtelierStore,
  serverId: string,
): Promise<string | null> {
  const cfg = load(store, serverId);
  const t = cfg?.tokens;
  if (!t) return null;
  if (t.expiresAt === null || t.expiresAt - Date.now() > REFRESH_SKEW_MS) return t.accessToken;

  let inflight = refreshing.get(serverId);
  if (!inflight) {
    inflight = refreshToken(store, serverId)
      .catch(() => null)
      .finally(() => refreshing.delete(serverId));
    refreshing.set(serverId, inflight);
  }
  return inflight;
}

/** Returns copies of the servers with a fresh `Authorization` header for OAuth ones. */
export async function resolveMcpAuth(
  store: AtelierStore,
  servers: McpServerConfig[],
): Promise<McpServerConfig[]> {
  return Promise.all(
    servers.map(async (s) => {
      if (s.auth !== 'oauth' || s.transport === 'stdio') return s;
      const token = await getMcpAccessToken(store, s.id);
      if (!token) return s;
      return { ...s, headers: { ...(s.headers ?? {}), Authorization: `Bearer ${token}` } };
    }),
  );
}

export function getMcpOAuthStatus(store: AtelierStore): Record<string, McpOAuthStatus> {
  const out: Record<string, McpOAuthStatus> = {};
  for (const id of store.listMcpOAuthIds()) {
    const t = load(store, id)?.tokens;
    out[id] = { connected: Boolean(t), expiresAt: t?.expiresAt ?? null };
  }
  return out;
}

export function disconnectMcpOAuth(store: AtelierStore, serverId: string): void {
  const cfg = load(store, serverId);
  // keep a user-supplied OAuth app so logging in again doesn't ask for it twice
  if (cfg?.manualClient) save(store, serverId, { ...cfg, tokens: undefined });
  else store.setMcpOAuth(serverId, null);
}
