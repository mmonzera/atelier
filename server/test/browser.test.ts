import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent, SiteCredential } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { applyBrowserAtelierActions, CliAgentRunner } from '../src/agents/cli-runners.js';
import { executeBrowserTool } from '../src/browser/tools.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';
import { buildCodexMcpArgs, buildOpenCodeMcpConfig } from '../src/mcp/config.js';
import { detectLocalBrowser } from '../src/qa/browser-qa.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];
const httpServers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function bootServer(label: string, extraOverrides?: Record<string, unknown>) {
  const dir = makeTempDir(`atelier-browser-${label}-`);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
      ...extraOverrides,
    },
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dir };
}

async function startTestHttpServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (httpServers.length) httpServers.pop()!.close();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
});

describe('Remote Browser unit & security checks', () => {
  it('encrypts credentials with machine key, keeps plaintext out of SQLite & API responses, and preserves in encrypted backup', async () => {
    const { handle, base } = await bootServer('enc');
    const secret = 'S3cret_Pass_#9912';

    const res = await fetch(`${base}/api/browser/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'TestSite',
        origin: 'https://example.com',
        loginUrl: 'https://example.com/login',
        username: 'moses@example.com',
        password: secret,
      }),
    });
    expect(res.status).toBe(201);
    const { credential } = (await res.json()) as { credential: SiteCredential };
    expect(credential.maskedUsername).toBe('mo…@example.com');
    expect(JSON.stringify(credential)).not.toContain(secret);

    const listRes = await (await fetch(`${base}/api/browser/credentials`)).json();
    expect(JSON.stringify(listRes)).not.toContain(secret);

    // Verify raw SQLite table has no plaintext password
    const row = handle.db.sqlite
      .prepare(`SELECT data, secret FROM site_credentials WHERE id = ?`)
      .get(credential.id) as { data: string; secret: Uint8Array };
    expect(row.data).not.toContain(secret);
    expect(Buffer.from(row.secret).toString('utf8')).not.toContain(secret);

    // Origin binding check
    expect(() =>
      handle.credentials.getSecretForOrigin(credential.id, 'https://example.com.evil.site'),
    ).toThrow(/origin/i);
    const decrypted = handle.credentials.getSecretForOrigin(credential.id, 'https://example.com/app');
    expect(decrypted.password).toBe(secret);

    // Unencrypted backup strips site_credentials
    const plainExport = handle.backup.exportBackup({ passphrase: null, includeSecrets: false });
    const encExport = handle.backup.exportBackup({ passphrase: 'correct-horse-battery', includeSecrets: true });
    expect(plainExport.bytes.length).toBeGreaterThan(0);

    // Boot second server with a DIFFERENT machine key and import both backups
    const { handle: target, base: targetBase } = await bootServer('enc-target');

    const plainForm = new FormData();
    plainForm.set('file', new Blob([new Uint8Array(plainExport.bytes)]), plainExport.filename);
    await fetch(`${targetBase}/api/backup/import`, { method: 'POST', body: plainForm });
    expect(target.credentials.listCredentials()).toHaveLength(0);

    // Encrypted backup re-encrypts site_credentials for target's machine key
    const encForm = new FormData();
    encForm.set('file', new Blob([new Uint8Array(encExport.bytes)]), encExport.filename);
    encForm.set('passphrase', 'correct-horse-battery');
    const impRes = await fetch(`${targetBase}/api/backup/import`, { method: 'POST', body: encForm });
    expect(impRes.status).toBe(200);
    const importedCreds = target.credentials.listCredentials();
    expect(importedCreds).toHaveLength(1);
    expect(target.credentials.getSecretForOrigin(importedCreds[0]!.id, 'https://example.com').password).toBe(
      secret,
    );
  });

  it('generates OpenCode v2 and v1 MCP remote/local configs', () => {
    const servers = [
      {
        id: 'b1',
        name: 'atelier-browser',
        transport: 'http' as const,
        url: 'http://127.0.0.1:8787/mcp/browser',
        headers: { Authorization: 'Bearer tok123' },
        enabled: true,
      },
      {
        id: 's1',
        name: 'fs',
        transport: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        enabled: true,
      },
    ];
    const v2 = buildOpenCodeMcpConfig(servers, 2, 'linux') as {
      mcp: { servers: Record<string, Record<string, unknown>> };
    };
    expect(v2.mcp.servers['atelier-browser']).toMatchObject({
      type: 'remote',
      url: 'http://127.0.0.1:8787/mcp/browser',
      headers: { Authorization: 'Bearer tok123' },
      disabled: false,
    });
    expect(v2.mcp.servers.fs).toMatchObject({
      type: 'local',
      command: ['node', 'server.js'],
      disabled: false,
    });

    const v1 = buildOpenCodeMcpConfig(servers, 1, 'linux') as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(v1.mcp['atelier-browser']).toMatchObject({
      type: 'remote',
      enabled: true,
    });
  });
});

const hasBrowser = Boolean(detectLocalBrowser());

describe.skipIf(!hasBrowser)('Remote Browser end-to-end with local Chromium/Edge', () => {
  it(
    'performs two-step login with hidden OTP field, persists cookies, enforces origin binding, allowlist, redaction, password type block, approval gate, screenshots, MCP HTTP auth, and screencast stop on lock',
    async () => {
      const secretPass = 'MobbinPass!2026';
      let deleteClicks = 0;

      // Site A: simulates Mobbin-style two-step login (email first, hidden password + hidden OTP in DOM),
      // protected dashboard, password echo page for redaction test, redirect to Site B, and Delete button.
      const siteB = await startTestHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><title>Site B</title><body><h1>Disallowed Site B</h1></body></html>');
      });

      const siteA = await startTestHttpServer((req, res) => {
        const cookie = req.headers.cookie ?? '';
        const authed = cookie.includes('session=valid_cookie');
        const url = req.url ?? '/';

        if (url === '/login' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><html><title>Login</title><body>
            <form id="f" onsubmit="return false;">
              <input id="email" type="email" name="email" placeholder="Enter email" />
              <input id="otp" type="text" name="token" autocomplete="one-time-code" style="display:none" />
              <input id="pw" type="password" name="password" style="display:none" />
              <button id="btn" type="submit">Continue</button>
            </form>
            <script>
              let step = 1;
              document.getElementById('f').addEventListener('submit', async () => {
                if (step === 1) {
                  step = 2;
                  document.getElementById('pw').style.display = 'block';
                  document.getElementById('btn').textContent = 'Sign in';
                } else {
                  const res = await fetch('/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                      email: document.getElementById('email').value,
                      password: document.getElementById('pw').value,
                    }),
                  });
                  if (res.ok) location.href = '/dashboard';
                }
              });
            </script>
          </body></html>`);
          return;
        }

        if (url === '/login' && req.method === 'POST') {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const body = JSON.parse(raw || '{}') as { email?: string; password?: string };
            if (body.email === 'designer@example.com' && body.password === secretPass) {
              res.writeHead(200, {
                'Set-Cookie': 'session=valid_cookie; HttpOnly; Path=/; Max-Age=3600',
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Wrong password' }));
            }
          });
          return;
        }

        if (url === '/dashboard') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          if (!authed) {
            res.end('<html><title>Logged out</title><body>Please log in</body></html>');
            return;
          }
          res.end(`<!doctype html><html><title>Dashboard</title><body>
            <h1>Welcome Designer</h1>
            <p>Echo test: ${secretPass}</p>
            <input id="note" type="text" placeholder="Search patterns" />
            <input id="passinput" type="password" placeholder="Secret" />
            <button id="del" type="button" onclick="fetch('/deleted',{method:'POST'}).then(()=>document.getElementById('msg').textContent='Deleted!')">Delete project</button>
            <div id="msg">Ready</div>
          </body></html>`);
          return;
        }

        if (url === '/deleted' && req.method === 'POST') {
          deleteClicks += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url === '/redirect-to-b') {
          res.writeHead(302, { Location: `${siteB.baseUrl}/` });
          res.end();
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      const { handle, base } = await bootServer('e2e', { approvalTimeoutMs: 4000 });

      // 1. Create credential for Site A (127.0.0.1 is shared host; test origin binding separately with Site B port)
      const cred = handle.credentials.createCredential({
        label: 'SiteA',
        origin: siteA.baseUrl,
        loginUrl: `${siteA.baseUrl}/login`,
        username: 'designer@example.com',
        password: secretPass,
      });

      const { project, agents } = handle.store.createProject({
        name: 'Browser Test',
        starterAgents: [
          {
            name: 'Researcher',
            role: 'UX',
            browser: {
              enabled: true,
              allowedHosts: ['127.0.0.1'],
              credentialIds: [cred.id],
              confirmSensitive: true,
              defaultProfileId: cred.profileId,
            },
          },
        ],
      });
      const agent = agents[0]!;
      const msg = handle.store.createMessage({
        projectId: project.id,
        agentId: agent.id,
        author: 'agent',
        text: 'Testing browser',
        streaming: true,
      });

      // Origin binding: cred for siteA rejected on siteB
      expect(() => handle.credentials.getSecretForOrigin(cred.id, siteB.baseUrl)).toThrow(/origin/i);

      // 2. Test preset auto-detection
      const detectRes = await fetch(`${base}/api/browser/presets/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginUrl: `${siteA.baseUrl}/login` }),
      });
      expect(detectRes.status).toBe(200);
      const detectBody = (await detectRes.json()) as {
        detected: { flow: string; selectors: { username?: string }; screenshotUrl?: string };
      };
      expect(detectBody.detected.flow).toBe('two_step');
      expect(detectBody.detected.selectors.username).toBe('#email');
      expect(detectBody.detected.screenshotUrl).toMatch(/^\/api\/browser\/test-shots\//);

      // 3. Perform browser_login end-to-end
      const ctx = { agentId: agent.id, projectId: project.id, messageId: msg.id };
      const loginOut = await executeBrowserTool(handle.browserManager, 'browser_login', { site: 'SiteA' }, ctx);
      expect(loginOut.isError).toBe(false);
      expect(JSON.parse(loginOut.text)).toMatchObject({ status: 'ok' });
      expect(loginOut.text).not.toContain(secretPass);

      // 4. Cookie persistence check: close profile context, reopen, navigate to /dashboard directly
      await handle.browserManager.closeProfileContext(cred.profileId);
      const openDash = await executeBrowserTool(
        handle.browserManager,
        'browser_open',
        { url: `${siteA.baseUrl}/dashboard` },
        ctx,
      );
      expect(openDash.isError).toBe(false);
      expect(openDash.text).toContain('Dashboard');

      // 5. Snapshot redacts password & prevents typing into password input
      const snapOut = await executeBrowserTool(handle.browserManager, 'browser_snapshot', {}, ctx);
      expect(snapOut.isError).toBe(false);
      expect(snapOut.text).toContain('Welcome Designer');
      expect(snapOut.text).toContain('••••••');
      expect(snapOut.text).not.toContain(secretPass);

      const pwRefMatch = /\[(e\d+)\]\s+<input type="password">/.exec(snapOut.text);
      expect(pwRefMatch).toBeTruthy();
      const typePwOut = await executeBrowserTool(
        handle.browserManager,
        'browser_type',
        { ref: pwRefMatch![1], text: 'attempt' },
        ctx,
      );
      expect(typePwOut.isError).toBe(true);
      expect(typePwOut.text).toMatch(/password/i);

      // 6. Screenshot saves artifact and populates Library + message metadata
      const shotOut = await executeBrowserTool(
        handle.browserManager,
        'browser_screenshot',
        { label: 'Mobbin Dashboard' },
        ctx,
      );
      expect(shotOut.isError).toBe(false);
      const shotJson = JSON.parse(shotOut.text) as { artifactId: string; url: string };
      expect(shotJson.artifactId).toMatch(/^art_/);
      const libRes = (await (await fetch(`${base}/api/projects/${project.id}/library`)).json()) as {
        images: Array<{ id: string; source: string; name: string }>;
      };
      expect(libRes.images.some((i) => i.id === shotJson.artifactId && i.source === 'artifact')).toBe(true);

      // 7. Sensitive action gate (Deny then Allow)
      const delRefMatch = /\[(e\d+)\][^"\n]*"Delete project"/.exec(snapOut.text);
      expect(delRefMatch).toBeTruthy();

      const denyPromise = executeBrowserTool(
        handle.browserManager,
        'browser_click',
        { ref: delRefMatch![1] },
        ctx,
      );
      const pendingApproval = await waitFor(() => handle.browserManager.listApprovals()[0]);
      expect(pendingApproval.action).toContain('Delete project');
      handle.browserManager.resolveApproval(pendingApproval.id, false);
      const denyRes = await denyPromise;
      expect(denyRes.text).toContain('Pengguna menolak aksi ini');
      expect(deleteClicks).toBe(0);

      const allowPromise = executeBrowserTool(
        handle.browserManager,
        'browser_click',
        { ref: delRefMatch![1] },
        ctx,
      );
      const pendingApproval2 = await waitFor(() => handle.browserManager.listApprovals()[0]);
      handle.browserManager.resolveApproval(pendingApproval2.id, true);
      const allowRes = await allowPromise;
      expect(allowRes.isError).toBe(false);
      await waitFor(() => deleteClicks === 1);

      // 8. Allowlist blocks external domain and redirect
      handle.store.updateAgentConfig(agent.id, {
        browser: { ...agent.browser!, allowedHosts: ['localhost'] },
      });
      const blockedDirect = await executeBrowserTool(
        handle.browserManager,
        'browser_open',
        { url: `${siteA.baseUrl}/dashboard` },
        ctx,
      );
      expect(blockedDirect.isError).toBe(true);
      expect(blockedDirect.text).toContain('tidak diizinkan');

      // Allow 127.0.0.1 again but remove disallowed host via policy: test redirect with disallowed host
      // Use subdomain/host mismatch: allow 'localhost' and open 'http://127.0.0.1:...' already verified;
      // verify redirect from localhost -> 127.0.0.1:siteBPort is aborted too!
      const redirRes = await executeBrowserTool(
        handle.browserManager,
        'browser_open',
        { url: `http://localhost:${siteA.port}/redirect-to-b` },
        ctx,
      );
      expect(redirRes.isError).toBe(true);
      expect(redirRes.text).toContain('tidak diizinkan');

      // 9. Screencast emits frames when watched & stops on stopAllWatches
      handle.store.updateAgentConfig(agent.id, {
        browser: { ...agent.browser!, allowedHosts: ['127.0.0.1'] },
      });
      const activeSession = handle.browserManager.listSessions()[0]!;
      const wsEvents: ServerEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
      await new Promise<void>((resolve) => ws.once('open', resolve));
      ws.on('message', (data) => {
        wsEvents.push(JSON.parse(data.toString()) as ServerEvent);
      });

      const watchRes = await fetch(`${base}/api/browser/sessions/${activeSession.id}/watch`, {
        method: 'POST',
      });
      expect(watchRes.status).toBe(200);
      const frameEv = await waitFor(() => wsEvents.find((e) => e.type === 'browser-frame'));
      expect(frameEv.type).toBe('browser-frame');
      if (frameEv.type === 'browser-frame') {
        expect(frameEv.payload.jpegBase64.length).toBeGreaterThan(100);
      }
      await handle.browserManager.stopAllWatches();
      expect(handle.browserManager.listSessions()[0]?.live).toBe(false);
      ws.close();

      // 10. MCP HTTP endpoint (/mcp/browser) token enforcement
      const unauthMcp = await fetch(`${base}/mcp/browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(unauthMcp.status).toBe(401);

      const turnToken = handle.browserManager.issueTurnToken({
        agentId: agent.id,
        projectId: project.id,
        messageId: msg.id,
      });
      const listMcp = await fetch(`${base}/mcp/browser`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${turnToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(listMcp.status).toBe(200);
      const listRpc = (await listMcp.json()) as { result: { tools: Array<{ name: string }> } };
      expect(listRpc.result.tools.some((t) => t.name === 'browser_login')).toBe(true);

      const callMcp = await fetch(`${base}/mcp/browser`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${turnToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'browser_list_logins', arguments: {} },
        }),
      });
      expect(callMcp.status).toBe(200);
      const callRpc = (await callMcp.json()) as { result: { content: Array<{ text: string }> } };
      expect(callRpc.result.content[0]?.text).toContain('de…@example.com');
      expect(callRpc.result.content[0]?.text).not.toContain(secretPass);

      handle.browserManager.revokeTurnToken(turnToken);
      const revokedMcp = await fetch(`${base}/mcp/browser`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${turnToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      expect(revokedMcp.status).toBe(401);

      // 11. Verify plaintext password NEVER appears anywhere in messages, activities, or events tables
      const rawTables = [
        ...handle.db.sqlite.prepare(`SELECT data FROM messages`).all(),
        ...handle.db.sqlite.prepare(`SELECT data FROM activities`).all(),
        ...handle.db.sqlite.prepare(`SELECT payload AS data FROM events`).all(),
      ] as Array<{ data: string }>;
      for (const r of rawTables) {
        expect(r.data).not.toContain(secretPass);
      }

      // 12. OpenAI-compatible (OpenRouter/DeepSeek) function-calling loop executes real browser tools
      let round = 0;
      const fakeAi = await startTestHttpServer((req, res) => {
        if (req.url !== '/chat/completions') {
          res.statusCode = 404;
          res.end();
          return;
        }
        round += 1;
        res.setHeader('Content-Type', 'text/event-stream');
        if (round === 1) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'browser_list_logins', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: 'Selesai memeriksa login.' } }],
            })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 15 } })}\n\n`);
          res.end('data: [DONE]\n\n');
        }
      });

      const cliRunner = new CliAgentRunner(
        handle.store,
        { ...handle.config, openrouterBaseUrl: fakeAi.baseUrl },
        () => () => undefined,
        handle.browserManager,
      );
      handle.store.setProviderSecret('openrouter', 'sk-or-test');
      const toolsUsed: string[] = [];
      const loopResult = await cliRunner.run(
        {
          agent: {
            ...agent,
            providerOverride: 'openrouter',
            modelOverride: 'openai/gpt-5',
          },
          project,
          prompt: 'Cek login situs yang tersedia',
          resumeSessionId: null,
          replyMessageId: msg.id,
          signal: new AbortController().signal,
        },
        {
          onText() {},
          onTool(name) {
            toolsUsed.push(name);
          },
          onSession() {},
        },
      );
      expect(toolsUsed).toContain('browser_list_logins');
      expect(loopResult.finalText).toContain('Selesai memeriksa login.');
      expect(round).toBe(2);

      // 13. Codex MCP auto-approval config and Antigravity <atelier-action> browser dispatch
      const codexArgs = buildCodexMcpArgs(
        [
          {
            id: 'atelier-browser',
            name: 'atelier-browser',
            transport: 'http',
            url: `${base}/mcp/browser`,
            headers: { Authorization: 'Bearer tok' },
            enabled: true,
          },
        ],
        'win32',
        { 'atelier-browser': ['browser_open', 'browser_snapshot'] },
      );
      expect(codexArgs).toContain('mcp_servers.atelier-browser.tools.browser_open.approval_mode="approve"');
      expect(codexArgs).toContain('mcp_servers.atelier-browser.tools.browser_snapshot.approval_mode="approve"');

      const actionTools: string[] = [];
      const actionRes = await applyBrowserAtelierActions(
        'Checking logins:\n<atelier-action>{"tool":"browser_list_logins"}</atelier-action>\nDone.',
        handle.browserManager,
        ctx,
        {
          onTool(name) {
            actionTools.push(name);
          },
        },
      );
      expect(actionTools).toEqual(['browser_list_logins']);
      expect(actionRes.cleanText).toBe('Checking logins:\n\nDone.');
      expect(actionRes.results).toHaveLength(1);
      expect(actionRes.results[0]!.tool).toBe('browser_list_logins');
      expect(actionRes.results[0]!.result).toContain('de…@example.com');
      expect(actionRes.results[0]!.result).not.toContain(secretPass);
    },
    30_000,
  );
});
