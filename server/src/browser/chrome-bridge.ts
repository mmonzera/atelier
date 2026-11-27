import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { type AppConfig, isAllowedHost } from '../config.js';

export type ChromeBridgeAction = 'list_tabs' | 'open_url' | 'inspect_html' | 'snapshot';

export interface ChromeExtensionStatus {
  connected: boolean;
  paired: boolean;
  port: number;
  pairingCode: string | null;
  pairingExpiresAt: string | null;
  extensionPath: string | null;
  connectedAt: string | null;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface StoredBridgeToken {
  token: string;
  createdAt: string;
}

const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) {
    raw += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export class ChromeExtensionBridge {
  private readonly tokenFilePath: string;
  private readonly isVaultLocked: () => boolean;
  private readonly extensionPath: string | null;
  private readonly wss: WebSocketServer;

  private serverPort = 0;
  private bridgeToken: string | null = null;
  private activeSocket: WebSocket | null = null;
  private connectedAt: string | null = null;
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;
  private readonly pending = new Map<string, PendingCommand>();

  constructor(opts: {
    dataDir: string;
    isVaultLocked: () => boolean;
    extensionPath: string | null;
  }) {
    this.tokenFilePath = path.join(opts.dataDir, 'chrome-bridge-token.json');
    this.isVaultLocked = opts.isVaultLocked;
    this.extensionPath = opts.extensionPath;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.loadStoredToken();

    this.wss.on('connection', (ws) => {
      if (this.activeSocket && this.activeSocket !== ws) {
        this.activeSocket.close(4000, 'replaced');
      }
      this.activeSocket = ws;
      this.connectedAt = new Date().toISOString();

      ws.on('message', (raw) => {
        this.handleMessage(raw.toString());
      });

      ws.on('close', () => {
        if (this.activeSocket === ws) {
          this.activeSocket = null;
          this.connectedAt = null;
          this.rejectAllPending(new Error('Koneksi ke Chrome Extension terputus.'));
        }
      });

      ws.on('error', () => {
        if (this.activeSocket === ws) {
          this.activeSocket = null;
          this.connectedAt = null;
          this.rejectAllPending(new Error('Koneksi ke Chrome Extension mengalami error.'));
        }
      });
    });
  }

  private loadStoredToken(): void {
    try {
      if (!fs.existsSync(this.tokenFilePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf8')) as Partial<StoredBridgeToken>;
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
        this.bridgeToken = parsed.token;
      }
    } catch {
      this.bridgeToken = null;
    }
  }

  private persistToken(token: string): void {
    fs.mkdirSync(path.dirname(this.tokenFilePath), { recursive: true });
    const data: StoredBridgeToken = { token, createdAt: new Date().toISOString() };
    fs.writeFileSync(this.tokenFilePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private clearStoredToken(): void {
    this.bridgeToken = null;
    fs.rmSync(this.tokenFilePath, { force: true });
  }

  public setServerPort(port: number): void {
    this.serverPort = port;
  }

  public isConnected(): boolean {
    return (
      !this.isVaultLocked() &&
      Boolean(this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN)
    );
  }

  public getStatus(): ChromeExtensionStatus {
    const now = Date.now();
    const activePairing = this.pairing && this.pairing.expiresAt > now ? this.pairing : null;
    if (!activePairing && this.pairing) {
      this.pairing = null;
    }
    return {
      connected: Boolean(this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN),
      paired: Boolean(this.bridgeToken),
      port: this.serverPort,
      pairingCode: activePairing ? activePairing.code : null,
      pairingExpiresAt: activePairing ? new Date(activePairing.expiresAt).toISOString() : null,
      extensionPath: this.extensionPath,
      connectedAt: this.connectedAt,
    };
  }

  public startPairing(): { code: string; expiresAt: string; port: number } {
    if (this.isVaultLocked()) {
      throw new Error('Atelier sedang terkunci. Buka kunci terlebih dahulu.');
    }
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing = { code, expiresAt, attempts: 0 };
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      port: this.serverPort,
    };
  }

  public exchangePairingCode(rawCode: string): { token: string; port: number } {
    if (this.isVaultLocked()) {
      throw new Error('Atelier sedang terkunci.');
    }
    if (!this.pairing || Date.now() > this.pairing.expiresAt) {
      this.pairing = null;
      throw new Error('Kode pairing tidak ada atau sudah kedaluwarsa. Buat kode baru di Atelier.');
    }
    const normalizedInput = normalizePairingCode(rawCode);
    const normalizedExpected = normalizePairingCode(this.pairing.code);
    if (!normalizedInput || !safeEqual(normalizedInput, normalizedExpected)) {
      this.pairing.attempts += 1;
      if (this.pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
        this.pairing = null;
        throw new Error('Terlalu banyak percobaan gagal. Buat kode pairing baru di Atelier.');
      }
      throw new Error('Kode pairing salah.');
    }

    // Single-use pairing code
    this.pairing = null;
    const token = crypto.randomBytes(32).toString('hex');
    this.bridgeToken = token;
    this.persistToken(token);

    if (this.activeSocket) {
      this.activeSocket.close(4002, 'repaired');
      this.activeSocket = null;
      this.connectedAt = null;
    }

    return { token, port: this.serverPort };
  }

  public unpair(): void {
    this.pairing = null;
    this.clearStoredToken();
    if (this.activeSocket) {
      this.activeSocket.close(4001, 'unpaired');
      this.activeSocket = null;
      this.connectedAt = null;
    }
    this.rejectAllPending(new Error('Chrome Extension telah di-unpair.'));
  }

  public onVaultLock(): void {
    this.pairing = null;
    if (this.activeSocket) {
      this.activeSocket.close(4401, 'locked');
      this.activeSocket = null;
      this.connectedAt = null;
    }
    this.rejectAllPending(new Error('Atelier terkunci.'));
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws/chrome-ext') {
      return false;
    }

    if (!isAllowedHost(request.headers.host, this.serverPort)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden host');
      socket.destroy();
      return true;
    }

    const origin = request.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden origin');
      socket.destroy();
      return true;
    }

    if (this.isVaultLocked()) {
      socket.write('HTTP/1.1 423 Locked\r\nContent-Type: text/plain\r\n\r\nAtelier is locked');
      socket.destroy();
      return true;
    }

    const queryToken = url.searchParams.get('token')?.trim() ?? '';
    const authHeader = request.headers.authorization ?? '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const providedToken = queryToken || bearerMatch?.[1]?.trim() || '';

    if (!this.bridgeToken || !providedToken || !safeEqual(providedToken, this.bridgeToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nInvalid bridge token');
      socket.destroy();
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
    return true;
  }

  private handleMessage(raw: string): void {
    let msg: { v?: unknown; id?: unknown; type?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
        this.activeSocket.send(JSON.stringify({ v: 1, type: 'pong', ts: Date.now() }));
      }
      return;
    }

    const id = typeof msg.id === 'string' ? msg.id : null;
    if (!id) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.ok === true) {
      entry.resolve(msg.result);
    } else {
      const errMsg = typeof msg.error === 'string' && msg.error ? msg.error : 'Perintah Chrome Extension gagal.';
      entry.reject(new Error(errMsg));
    }
  }

  public async sendCommand<T = unknown>(
    action: ChromeBridgeAction,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    if (this.isVaultLocked()) {
      throw new Error('Atelier sedang terkunci.');
    }
    const ws = this.activeSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Chrome Extension belum terhubung. Buka popup Atelier di Chrome lalu hubungkan dengan kode pairing.',
      );
    }

    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Chrome Extension tidak merespons (${action}) dalam ${timeoutMs}ms.`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({ v: 1, id, action, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  public async close(): Promise<void> {
    this.rejectAllPending(new Error('Atelier server ditutup.'));
    if (this.activeSocket) {
      this.activeSocket.close(1001, 'shutdown');
      this.activeSocket = null;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function createChromeExtPublicRouter(bridge: ChromeExtensionBridge, config: AppConfig): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!isAllowedHost(host, config.port)) {
      return c.json({ error: { code: 'forbidden_host', message: 'Forbidden host' } }, 403);
    }

    const origin = c.req.header('origin');
    if (origin) {
      if (!origin.startsWith('chrome-extension://')) {
        return c.json({ error: { code: 'forbidden_origin', message: 'Forbidden origin' } }, 403);
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    return next();
  });

  app.post('/pair', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ code: z.string().trim().min(1).max(32) }).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_code', message: 'Kode pairing wajib diisi.' } }, 400);
    }
    try {
      const result = bridge.exchangePairingCode(parsed.data.code);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pairing gagal.';
      const status = /terkunci/i.test(message) ? 423 : 400;
      return c.json({ error: { code: 'pairing_failed', message } }, status);
    }
  });

  return app;
}
