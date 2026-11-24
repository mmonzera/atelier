import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { UsageDashboardResponse } from '@atelier/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchClaudeOauthUsage, resetClaudeOauthUsageCache } from '../src/agents/claude-oauth-usage.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

const TOKEN = 'sk-ant-oat01-super-secret-access-token';
const REFRESH = 'sk-ant-ort01-super-secret-refresh-token';

const handles: AtelierServerHandle[] = [];
const dirs: string[] = [];
const servers: http.Server[] = [];

beforeEach(() => resetClaudeOauthUsageCache());
afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (servers.length) servers.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-oauth-'));
  dirs.push(dir);
  return dir;
}

function writeCredentials(dir: string, expiresAt: number) {
  const file = path.join(dir, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt } }));
  return file;
}

async function fakeAnthropic(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const requests: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage` };
}

const okBody = {
  five_hour: { utilization: 37.5, resets_at: '2030-01-01T05:00:00Z' },
  seven_day: { utilization: 12, resets_at: '2030-01-05T00:00:00Z' },
  seven_day_opus: null,
};

describe('official Claude plan usage', () => {
  it('reads the 5-hour and weekly windows and sends the token only to the usage URL', async () => {
    const fake = await fakeAnthropic((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(okBody));
    });
    const claudeCredentialsPath = writeCredentials(tempDir(), Date.now() + 3_600_000);
    const usage = await fetchClaudeOauthUsage({ claudeCredentialsPath, claudeUsageUrl: fake.url });

    expect(usage.status).toBe('ok');
    expect(usage.fiveHour).toEqual({ percentUsed: 37.5, resetsAt: '2030-01-01T05:00:00.000Z' });
    expect(usage.weekly?.percentUsed).toBe(12);
    expect(usage.weeklyOpus).toBeNull();
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fake.requests[0]!['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(JSON.stringify(usage)).not.toContain('secret');

    // a second call inside the cache window does not hit Anthropic again
    await fetchClaudeOauthUsage({ claudeCredentialsPath, claudeUsageUrl: fake.url });
    expect(fake.requests).toHaveLength(1);
  });

  it('never contacts Anthropic when the token is expired, missing, or the feature is off', async () => {
    const fake = await fakeAnthropic((_req, res) => res.end(JSON.stringify(okBody)));
    const expired = writeCredentials(tempDir(), Date.now() - 1000);
    expect((await fetchClaudeOauthUsage({ claudeCredentialsPath: expired, claudeUsageUrl: fake.url })).status).toBe('expired');
    resetClaudeOauthUsageCache();
    const missing = path.join(tempDir(), 'nope.json');
    expect((await fetchClaudeOauthUsage({ claudeCredentialsPath: missing, claudeUsageUrl: fake.url })).status).toBe('no_credentials');
    expect((await fetchClaudeOauthUsage({ claudeCredentialsPath: null, claudeUsageUrl: fake.url })).status).toBe('disabled');
    expect(fake.requests).toHaveLength(0);
  });

  it('maps auth and rate-limit failures to a status instead of throwing', async () => {
    for (const [code, status] of [[401, 'unauthorized'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
      resetClaudeOauthUsageCache();
      const fake = await fakeAnthropic((_req, res) => {
        res.statusCode = code;
        res.end('{}');
      });
      const claudeCredentialsPath = writeCredentials(tempDir(), Date.now() + 3_600_000);
      expect((await fetchClaudeOauthUsage({ claudeCredentialsPath, claudeUsageUrl: fake.url })).status).toBe(status);
    }
  });

  it('replaces the estimated Claude windows on the dashboard and never leaks the token', async () => {
    const fake = await fakeAnthropic((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(okBody));
    });
    const dir = tempDir();
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
        claudeProjectsDir: null,
        codexSessionsDir: null,
        claudeCredentialsPath: writeCredentials(dir, Date.now() + 3_600_000),
        claudeUsageUrl: fake.url,
      },
    });
    handles.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/usage?range=all`);
    const raw = await res.text();
    expect(raw).not.toContain('secret');
    const claude = (JSON.parse(raw) as UsageDashboardResponse).providers.find((p) => p.provider === 'claude')!;
    expect(claude.fiveHour).toMatchObject({ percentUsed: 37.5, isOfficial: true });
    expect(claude.weekly).toMatchObject({ percentUsed: 12, isOfficial: true });
    expect(claude.sourceLabel).toBe('Official Claude plan limits');
  });
});
