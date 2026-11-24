import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ProviderAuthStatus, UsageDashboardResponse } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

const handles: AtelierServerHandle[] = [];
const dirs: string[] = [];
const fakes: http.Server[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (fakes.length) fakes.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A stand-in for https://openrouter.ai/api/v1 that records requests. */
async function fakeOpenRouter() {
  const seen: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> | null }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/key') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { limit_remaining: 4.5, usage: 1 } }));
      } else if (req.url === '/chat/completions') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Halo ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'dunia' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0123 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fakes.push(server);
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function boot(openrouterBaseUrl: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-or-'));
  dirs.push(dir);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
      openrouterBaseUrl,
    },
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

describe('OpenRouter provider', () => {
  it('stores its key, streams a reply, logs the cost OpenRouter reports, and shows live credit', async () => {
    const fake = await fakeOpenRouter();
    const { handle, base } = await boot(fake.baseUrl);
    const json = { 'Content-Type': 'application/json' };

    const before = (await (await fetch(`${base}/api/providers/status`)).json()) as { providers: ProviderAuthStatus[] };
    expect(before.providers.find((s) => s.provider === 'openrouter')).toMatchObject({ authMode: 'api_key', authenticated: false });

    const saved = await fetch(`${base}/api/providers/openrouter/api-key`, {
      method: 'POST', headers: json, body: JSON.stringify({ apiKey: 'sk-or-v1-testkey-1234' }),
    });
    expect(saved.status).toBe(200);
    const { status } = (await saved.json()) as { status: ProviderAuthStatus };
    expect(status).toMatchObject({ provider: 'openrouter', authenticated: true });
    expect(JSON.stringify(status)).not.toContain('testkey'); // masked

    // Providers that sign in via CLI/OAuth still reject API keys.
    expect((await fetch(`${base}/api/providers/claude/api-key`, {
      method: 'POST', headers: json, body: JSON.stringify({ apiKey: 'x' }),
    })).status).toBe(400);

    const { project, agents } = handle.store.createProject({ name: 'OR', starterAgents: [{ name: 'Bot', role: 'Eng' }] });
    // Make OpenRouter the workspace default too, so a misrouted turn can never reach a real provider.
    handle.store.updateSettings({ provider: 'openrouter', model: 'openrouter/auto' });
    handle.store.updateAgentConfig(agents[0]!.id, { providerOverride: 'openrouter', modelOverride: 'anthropic/claude-sonnet-4.5' });
    expect((await fetch(`${base}/api/agents/${agents[0]!.id}/messages`, {
      method: 'POST', headers: json, body: JSON.stringify({ text: 'halo', projectId: project.id }),
    })).status).toBe(202);

    const started = Date.now();
    let usage: UsageDashboardResponse | null = null;
    while (Date.now() - started < 10_000) {
      usage = (await (await fetch(`${base}/api/usage?range=all`)).json()) as UsageDashboardResponse;
      if ((usage.providers.find((p) => p.provider === 'openrouter')?.turns ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const chat = fake.seen.find((r) => r.url === '/chat/completions')!;
    expect(chat.auth).toBe('Bearer sk-or-v1-testkey-1234');
    expect(chat.body).toMatchObject({ model: 'anthropic/claude-sonnet-4.5', stream: true, usage: { include: true } });

    const summary = usage!.providers.find((p) => p.provider === 'openrouter')!;
    expect(summary.turns).toBe(1);
    expect(summary.inputTokens).toBe(120);
    expect(summary.outputTokens).toBe(30);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.0123, 6); // OpenRouter's own figure, not an estimate
    expect(summary.liveBalance).toMatchObject({ currency: 'USD', remaining: 4.5, available: true });
    expect(handle.store.listAgentMessages(agents[0]!.id, project.id).some((m) => m.text.includes('Halo dunia'))).toBe(true);
  });
});
