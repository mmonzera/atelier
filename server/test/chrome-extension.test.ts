import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { formatHtmlInspectResult } from '../src/browser/inspect-html.js';
import { executeBrowserTool } from '../src/browser/tools.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];
const sockets: WebSocket[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function bootServer(label: string) {
  const dir = makeTempDir(`atelier-chrome-ext-${label}-`);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
    },
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dir };
}

afterEach(async () => {
  while (sockets.length > 0) {
    const ws = sockets.pop()!;
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  while (handles.length > 0) {
    await handles.pop()!.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Chrome Extension bridge & HTML inspection', () => {
  it('enforces pairing code lifecycle, single-use, CORS, and WebSocket token auth', async () => {
    const { handle, base } = await bootServer('pairing');

    // Initial status
    const initRes = await fetch(`${base}/api/browser/extension/status`);
    expect(initRes.status).toBe(200);
    const initStatus = (await initRes.json()) as {
      connected: boolean;
      paired: boolean;
      port: number;
      pairingCode: string | null;
    };
    expect(initStatus.connected).toBe(false);
    expect(initStatus.paired).toBe(false);
    expect(initStatus.port).toBe(handle.port);
    expect(initStatus.pairingCode).toBeNull();

    // Start pairing
    const startRes = await fetch(`${base}/api/browser/extension/pair/start`, { method: 'POST' });
    expect(startRes.status).toBe(200);
    const { code } = (await startRes.json()) as { code: string; port: number };
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Reject non-extension web origin on /chrome-ext/pair
    const evilCors = await fetch(`${base}/chrome-ext/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ code }),
    });
    expect(evilCors.status).toBe(403);

    // Reject wrong pairing code
    const badCode = await fetch(`${base}/chrome-ext/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abcdefghijklmnop',
      },
      body: JSON.stringify({ code: 'WRONG-CODE' }),
    });
    expect(badCode.status).toBe(400);

    // Exchange valid code (with chrome-extension:// CORS headers)
    const pairRes = await fetch(`${base}/chrome-ext/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abcdefghijklmnop',
      },
      body: JSON.stringify({ code }),
    });
    expect(pairRes.status).toBe(200);
    expect(pairRes.headers.get('access-control-allow-origin')).toBe(
      'chrome-extension://abcdefghijklmnop',
    );
    const paired = (await pairRes.json()) as { token: string; port: number };
    expect(paired.token.length).toBeGreaterThanOrEqual(32);
    expect(paired.port).toBe(handle.port);

    // Single-use: reusing the same pairing code fails
    const reuseRes = await fetch(`${base}/chrome-ext/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(reuseRes.status).toBe(400);

    // WS upgrade with invalid token is rejected
    await expect(
      new Promise<void>((resolve, reject) => {
        const badWs = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/chrome-ext?token=invalid`);
        badWs.once('open', () => reject(new Error('Should not have opened')));
        badWs.once('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(401);
          resolve();
        });
        badWs.once('error', () => resolve());
      }),
    ).resolves.toBeUndefined();

    // WS upgrade with valid token succeeds
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws/chrome-ext?token=${encodeURIComponent(paired.token)}`,
        { origin: 'chrome-extension://abcdefghijklmnop' },
      );
      sockets.push(client);
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(handle.chromeBridge.isConnected()).toBe(true);

    // Unpair closes WS and clears token
    const unpairRes = await fetch(`${base}/api/browser/extension/unpair`, { method: 'POST' });
    expect(unpairRes.status).toBe(200);
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
    });
    expect(handle.chromeBridge.isConnected()).toBe(false);
  });

  it('executes browser_chrome_tabs and browser_inspect_html with allowlist, untrusted wrapping, and secret redaction', async () => {
    const { handle, base } = await bootServer('tools');
    const secret = 'SuperSecretPassword99!';
    handle.credentials.createCredential({
      label: 'XLogin',
      origin: 'https://x.com',
      loginUrl: 'https://x.com/i/flow/login',
      username: 'user@example.com',
      password: secret,
    });

    const { project, agents } = handle.store.createProject({
      name: 'Redesign X',
      starterAgents: [
        {
          name: 'Designer',
          role: 'UI/UX',
          browser: {
            enabled: true,
            allowedHosts: ['x.com'],
            credentialIds: [],
            confirmSensitive: true,
          },
        },
      ],
    });
    const agent = agents[0]!;
    const msg = handle.store.createMessage({
      projectId: project.id,
      agentId: agent.id,
      author: 'agent',
      text: 'Inspecting x.com login',
      streaming: true,
    });
    const ctx = { agentId: agent.id, projectId: project.id, messageId: msg.id };

    // Pair & connect simulated Chrome extension
    const startRes = await fetch(`${base}/api/browser/extension/pair/start`, { method: 'POST' });
    const { code } = (await startRes.json()) as { code: string };
    const pairRes = await fetch(`${base}/chrome-ext/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { token } = (await pairRes.json()) as { token: string };

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws/chrome-ext?token=${encodeURIComponent(token)}`,
      );
      sockets.push(client);
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });

    const receivedActions: Array<{ action: string; params: Record<string, unknown> }> = [];
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as {
        id: string;
        action: string;
        params: Record<string, unknown>;
      };
      receivedActions.push({ action: req.action, params: req.params });

      if (req.action === 'list_tabs') {
        ws.send(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: {
              tabs: [
                { id: 101, title: 'Sign in to X', url: 'https://x.com/i/flow/login', active: true },
                { id: 102, title: 'Bank Secret', url: 'https://bank.example.com', active: false },
              ],
            },
          }),
        );
      } else if (req.action === 'open_url') {
        ws.send(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: { tabId: 202, url: 'https://x.com/i/flow/login', title: 'Sign in to X' },
          }),
        );
      } else if (req.action === 'inspect_html') {
        ws.send(
          JSON.stringify({
            v: 1,
            id: req.id,
            ok: true,
            result: {
              url: 'https://x.com/i/flow/login',
              title: 'Sign in to X',
              viewport: { width: 1440, height: 900 },
              selector: 'main',
              html: `<main><h1>Sign in to X</h1><form><input name="text" placeholder="Phone, email, or username" /><span class="leak">${secret}</span><button>Next</button></form></main>`,
              htmlTruncated: false,
              tokens: {
                backgroundColors: ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'],
                textColors: ['rgb(231, 233, 234)', 'rgb(15, 20, 25)'],
                borderColors: ['rgb(51, 54, 57)'],
                fontFamilies: ['TwitterChirp, sans-serif'],
                fontSizes: ['31px', '15px'],
                borderRadii: ['9999px', '4px'],
              },
              keyElements: [
                {
                  tag: 'button',
                  label: 'Next',
                  styles: {
                    backgroundColor: 'rgb(239, 243, 244)',
                    color: 'rgb(15, 20, 25)',
                    borderRadius: '9999px',
                  },
                },
              ],
            },
          }),
        );
      }
    });

    // 1. list_tabs filters out bank.example.com outside allowedHosts
    const tabsOut = await executeBrowserTool(handle.browserManager, 'browser_chrome_tabs', {}, ctx);
    expect(tabsOut.isError).toBe(false);
    expect(tabsOut.text).toContain('https://x.com/i/flow/login');
    expect(tabsOut.text).not.toContain('bank.example.com');

    // 2. browser_inspect_html rejects disallowed host before touching Chrome
    const blockedOut = await executeBrowserTool(
      handle.browserManager,
      'browser_inspect_html',
      { url: 'https://evil.example/login' },
      ctx,
    );
    expect(blockedOut.isError).toBe(true);
    expect(blockedOut.text).toContain('tidak diizinkan');

    // 3. browser_inspect_html opens URL in Chrome, inspects HTML + tokens, wraps untrusted content, and redacts secret
    const inspectOut = await executeBrowserTool(
      handle.browserManager,
      'browser_inspect_html',
      { url: 'https://x.com/i/flow/login', selector: 'main' },
      ctx,
    );
    expect(inspectOut.isError).toBe(false);
    expect(inspectOut.text).toContain('[Konten halaman (tidak tepercaya');
    expect(inspectOut.text).toContain('Design Tokens (computed CSS):');
    expect(inspectOut.text).toContain('TwitterChirp, sans-serif');
    expect(inspectOut.text).toContain('<main><h1>Sign in to X</h1>');
    expect(inspectOut.text).not.toContain(secret);
    expect(inspectOut.text).toContain('••••••');

    expect(receivedActions.map((a) => a.action)).toEqual(['list_tabs', 'open_url', 'inspect_html']);
    expect(receivedActions[1]?.params).toEqual({ url: 'https://x.com/i/flow/login' });
    expect(receivedActions[2]?.params).toEqual({ tabId: 202, selector: 'main' });
  });

  it('formats cleaned HTML and computed design tokens consistently', () => {
    const formatted = formatHtmlInspectResult({
      url: 'https://example.com',
      title: 'Example Login',
      viewport: { width: 1280, height: 800 },
      selector: null,
      html: '<body><button>Login</button></body>',
      htmlTruncated: false,
      tokens: {
        backgroundColors: ['rgb(255, 255, 255)'],
        textColors: ['rgb(17, 24, 39)'],
        borderColors: [],
        fontFamilies: ['Inter, sans-serif'],
        fontSizes: ['14px'],
        borderRadii: ['8px'],
      },
      keyElements: [],
    });
    expect(formatted.formatted).toContain('URL: https://example.com');
    expect(formatted.formatted).toContain('Viewport: 1280x800');
    expect(formatted.formatted).toContain('```html\n<body><button>Login</button></body>\n```');
  });
});
