import fs from 'node:fs';
import type { AppConfig } from '../config.js';
import type { OfficialRateWindow } from './local-usage.js';

/**
 * Official Claude plan limits (the 5-hour session and weekly percentages Claude Desktop shows).
 *
 * Source: the same endpoint Claude Code's `/usage` uses, `GET /api/oauth/usage`. It is not
 * documented by Anthropic, so every failure degrades to "no official data" and the dashboard falls
 * back to local estimates.
 *
 * Credential handling:
 * - The access token is read from Claude Code's own credentials file on each refresh, kept only in
 *   memory for the request, and sent to nothing but the configured Anthropic usage URL.
 * - It is never logged, stored, cached, or included in backups or API responses.
 * - The refresh token is never read: refreshing would rotate it and could sign the CLI out. When the
 *   access token has expired we wait for Claude Code to refresh it.
 */

export type ClaudeOauthUsageStatus =
  | 'ok'
  | 'disabled'
  | 'no_credentials'
  | 'expired'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

export interface ClaudeOauthUsage {
  status: ClaudeOauthUsageStatus;
  fiveHour: OfficialRateWindow | null;
  weekly: OfficialRateWindow | null;
  /** Weekly Opus-only window, when the plan reports one. */
  weeklyOpus: OfficialRateWindow | null;
  fetchedAt: number;
}

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 30_000;
const MIN_FORCE_GAP_MS = 10_000;

let cache: { key: string; value: ClaudeOauthUsage } | null = null;

function result(status: ClaudeOauthUsageStatus, partial: Partial<ClaudeOauthUsage> = {}): ClaudeOauthUsage {
  return { status, fiveHour: null, weekly: null, weeklyOpus: null, fetchedAt: Date.now(), ...partial };
}

function readAccessToken(file: string): { token: string } | 'no_credentials' | 'expired' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'no_credentials';
  }
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!token) return 'no_credentials';
  const expiresAt = Number(oauth?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) return 'expired';
  return { token };
}

function parseWindow(raw: unknown): OfficialRateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { utilization, resets_at: resetsAt } = raw as { utilization?: unknown; resets_at?: unknown };
  const percent = Number(utilization);
  if (utilization === null || utilization === undefined || !Number.isFinite(percent)) return null;
  const resets = typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null;
  return { percentUsed: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10, resetsAt: resets };
}

export async function fetchClaudeOauthUsage(
  config: Pick<AppConfig, 'claudeCredentialsPath' | 'claudeUsageUrl'>,
  opts?: { forceRefresh?: boolean },
): Promise<ClaudeOauthUsage> {
  const file = config.claudeCredentialsPath;
  if (!file) return result('disabled');

  const key = `${file}|${config.claudeUsageUrl}`;
  const now = Date.now();
  if (cache?.key === key) {
    const age = now - cache.value.fetchedAt;
    const ttl = cache.value.status === 'ok' ? OK_TTL_MS : FAIL_TTL_MS;
    if (age < (opts?.forceRefresh ? MIN_FORCE_GAP_MS : ttl)) return cache.value;
  }

  const store = (value: ClaudeOauthUsage) => {
    cache = { key, value };
    return value;
  };

  const credentials = readAccessToken(file);
  if (credentials === 'no_credentials' || credentials === 'expired') return store(result(credentials));

  try {
    const res = await fetch(config.claudeUsageUrl, {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'atelier-usage',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401 || res.status === 403) return store(result('unauthorized'));
    if (res.status === 429) return store(result('rate_limited'));
    if (!res.ok) return store(result('unavailable'));
    const data = (await res.json()) as Record<string, unknown>;
    const fiveHour = parseWindow(data.five_hour);
    const weekly = parseWindow(data.seven_day);
    if (!fiveHour && !weekly) return store(result('unavailable'));
    return store(result('ok', { fiveHour, weekly, weeklyOpus: parseWindow(data.seven_day_opus) }));
  } catch {
    return store(result('unavailable'));
  }
}

/** Test hook: drop the in-memory cache. */
export function resetClaudeOauthUsageCache(): void {
  cache = null;
}
