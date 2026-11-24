import { serve } from '@hono/node-server';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ProviderAuthManager } from './agents/provider-auth.js';
import { AgentRuntime } from './agents/runtime.js';
import type { AgentRunner } from './agents/runner.js';
import type { EnqueueTaskFn } from './agents/studio-tools.js';
import { EventBus } from './bus.js';
import { CredentialStore } from './browser/credentials.js';
import { BrowserManager } from './browser/manager.js';
import { createBrowserMcpRouter } from './browser/mcp-endpoint.js';
import { createBrowserRoutes } from './browser/routes.js';
import { type AppConfig, loadConfig } from './config.js';
import { AtelierDb } from './db.js';
import { createHttpRouter } from './http.js';
import { AtelierStore } from './store.js';
import { BackupService } from './backup/service.js';
import { createSecurityRoutes } from './security/routes.js';
import { LocalVault, SESSION_COOKIE, parseCookie } from './security/vault.js';

export interface AtelierServerHandle {
  config: AppConfig;
  db: AtelierDb;
  store: AtelierStore;
  bus: EventBus;
  runtime: AgentRuntime;
  vault: LocalVault;
  backup: BackupService;
  browserManager: BrowserManager;
  credentials: CredentialStore;
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export async function startAtelierServer(opts?: {
  configOverrides?: Parameters<typeof loadConfig>[0];
  customRunner?: AgentRunner;
  customRunnerFactory?: (deps: { store: AtelierStore; enqueue: EnqueueTaskFn }) => AgentRunner;
}): Promise<AtelierServerHandle> {
  const config = loadConfig(opts?.configOverrides);
  const db = new AtelierDb(config.dbPath);
  const store = new AtelierStore(db, config);
  store.recoverOnStartup();

  const bus = new EventBus(() => store.getSnapshot(), config.port);
  store.attachBus(bus);

  const credentials = new CredentialStore(db, config.dataDir);
  const browserManager = new BrowserManager({ db, store, bus, config, credentials });
  store.setSnapshotAugmenter((base) => ({
    ...base,
    browserSessions: browserManager.listSessions(),
    browserApprovals: browserManager.listApprovals(),
  }));

  const runtime = new AgentRuntime(
    store,
    config,
    opts?.customRunner,
    opts?.customRunnerFactory,
    browserManager,
  );
  const authManager = new ProviderAuthManager();

  const vault = new LocalVault(db);
  const backup = new BackupService(db, store, config, {
    beforeImport: () => runtime.stopAll(),
  });

  // WebSocket upgrades need a valid session too while the lock is on; revoked sessions are kicked.
  bus.setAuth({
    authorize: (request) => {
      if (!vault.isEnabled()) return null;
      const token = parseCookie(request.headers.cookie, SESSION_COOKIE);
      return token && vault.isAuthorized(token) ? token : false;
    },
  });
  vault.onRevoke((token) => {
    bus.revokeSessions(token);
    void browserManager.stopAllWatches();
  });

  const app = new Hono();
  app.route(
    '/api',
    createHttpRouter({
      store,
      runtime,
      config,
      authManager,
      vault,
      securityRoutes: createSecurityRoutes({
        vault,
        backup,
        bus,
        onLock: () => void browserManager.stopAllWatches(),
      }),
      browserRoutes: createBrowserRoutes({ browserManager, credentials }),
    }),
  );
  app.route('/mcp/browser', createBrowserMcpRouter({ browserManager, config }));

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // The desktop shell bundles the server into one file, so it passes the web build location explicitly.
  const webDistDir = process.env.ATELIER_WEB_DIST
    ? path.resolve(process.env.ATELIER_WEB_DIST)
    : path.resolve(currentDir, '..', '..', 'web', 'dist');

  app.get('*', (c) => {
    if (!fs.existsSync(webDistDir)) {
      return c.text('Atelier server running. Build @atelier/web or run `npm run dev`.', 200);
    }

    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(webDistDir, safePath);

    if (
      fullPath.startsWith(webDistDir) &&
      fs.existsSync(fullPath) &&
      fs.statSync(fullPath).isFile()
    ) {
      const ext = path.extname(fullPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(fs.readFileSync(fullPath), {
        status: 200,
        headers: { 'Content-Type': contentType },
      });
    }

    const indexPath = path.join(webDistDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return c.html(fs.readFileSync(indexPath, 'utf8'));
    }
    return c.notFound();
  });

  const server = await new Promise<Server>((resolve) => {
    const httpServer = serve(
      {
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
      },
      () => resolve(httpServer as unknown as Server),
    );
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : config.port;
  // Sync actual ephemeral port when port 0 is passed in tests
  config.port = actualPort;
  bus.setServerPort(actualPort);

  server.on('upgrade', (request, socket, head) => {
    bus.handleUpgrade(request, socket, head);
  });

  return {
    config,
    db,
    store,
    bus,
    runtime,
    vault,
    backup,
    browserManager,
    credentials,
    server,
    port: actualPort,
    close: async () => {
      authManager.shutdown();
      await runtime.shutdown();
      await browserManager.shutdown();
      // "Backup on close": snapshot via VACUUM INTO before the DB handle goes away.
      await backup.runOnClose();
      vault.shutdown();
      await bus.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

// Run when executed directly as entrypoint
// Never auto-start when bundled into the desktop sidecar: it starts the server itself.
const isMain =
  !process.env.ATELIER_EMBEDDED &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  startAtelierServer()
    .then((handle) => {
      handle.backup.startScheduler();
      let closing = false;
      const shutdown = (signal: string) => {
        if (closing) return;
        closing = true;
        console.log(`Received ${signal}, shutting down Atelier…`);
        handle
          .close()
          .catch((err) => console.error('Shutdown error:', err))
          .finally(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      const s = handle.store.getSettings();
      console.log(
        `Atelier server listening on http://${handle.config.host}:${handle.port} (provider=${s.provider}, model=${s.model})`,
      );
    })
    .catch((err) => {
      console.error('Failed to start Atelier server:', err);
      process.exit(1);
    });
}
