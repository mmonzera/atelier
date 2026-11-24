import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerEvent, WorkspaceState } from '@atelier/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import { isAllowedHost, isAllowedOrigin } from './config.js';

/** Close code sent when the app lock revokes a session (idle timeout, "Lock now", password change). */
export const WS_CLOSE_LOCKED = 4401;

export interface BusAuth {
  /** Returns the session token for an authorized upgrade, `null` when the lock is off, or `false` to reject. */
  authorize(request: IncomingMessage): string | null | false;
}

export class EventBus {
  private wss: WebSocketServer;
  private readonly socketTokens = new Map<WebSocket, string | null>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private auth: BusAuth | null = null;

  constructor(
    private readonly getSnapshot: () => WorkspaceState,
    private serverPort: number,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket) => {
      socket.on('close', () => this.socketTokens.delete(socket));
      const snapshot: ServerEvent = {
        type: 'snapshot',
        payload: this.getSnapshot(),
      };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(snapshot));
      }
    });
  }

  public setServerPort(port: number): void {
    this.serverPort = port;
  }

  public setAuth(auth: BusAuth): void {
    this.auth = auth;
  }

  /** In-process subscribers (e.g. the desktop shell's native notifications). */
  public onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const host = request.headers.host;
    const origin = request.headers.origin;
    if (!isAllowedHost(host, this.serverPort) || !isAllowedOrigin(origin, this.serverPort)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden origin');
      socket.destroy();
      return;
    }

    const token = this.auth ? this.auth.authorize(request) : null;
    if (token === false) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nLocked');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.socketTokens.set(ws, token);
      this.wss.emit('connection', ws, request);
    });
  }

  /** Disconnects sockets opened with this session token (or every authenticated socket when `token` is omitted). */
  public revokeSessions(token?: string): void {
    for (const [ws, t] of this.socketTokens) {
      if (token === undefined ? t !== null : t === token) {
        ws.close(WS_CLOSE_LOCKED, 'locked');
        this.socketTokens.delete(ws);
      }
    }
  }

  /** Disconnects every socket (lock just turned on: unauthenticated sockets must re-auth). */
  public disconnectAll(code = WS_CLOSE_LOCKED): void {
    for (const ws of this.wss.clients) ws.close(code, 'locked');
    this.socketTokens.clear();
  }

  public broadcast(event: ServerEvent): void {
    const raw = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must never break the broadcast path
      }
    }
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.wss.clients) ws.terminate();
      this.wss.close(() => resolve());
    });
  }
}
