import { serve } from '@hono/node-server';
import { DEFAULT_MEETING_SETTINGS } from '@atelier/contracts';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { CliInstaller } from './agents/cli-installer.js';
import { ProviderAuthManager } from './agents/provider-auth.js';
import { AgentRuntime } from './agents/runtime.js';
import type { AgentRunner } from './agents/runner.js';
import type { EnqueueTaskFn } from './agents/studio-tools.js';
import { AppUpdateBridge } from './app-update.js';
import { EventBus } from './bus.js';
import { CredentialStore } from './browser/credentials.js';
import { ChromeExtensionBridge, createChromeExtPublicRouter } from './browser/chrome-bridge.js';
import { BrowserManager } from './browser/manager.js';
import { createBrowserMcpRouter } from './browser/mcp-endpoint.js';
import { createBrowserRoutes } from './browser/routes.js';
import { OfficeManager, createOfficeMcpRouter } from './office/mcp-endpoint.js';
import { type AppConfig, loadConfig } from './config.js';
import { GroupChatMigrationError } from './channels/migration.js';
import { AtelierDb } from './db.js';
import { createHttpRouter } from './http.js';
import type { MeetingAudioCapture } from './meetings/capture.js';
import { createMeetingRoutes } from './meetings/routes.js';
import { MeetingService } from './meetings/service.js';
import { AtelierStore } from './store.js';
import { BackupService } from './backup/service.js';
import { createSecurityRoutes } from './security/routes.js';
import { LocalVault, SESSION_COOKIE, parseCookie } from './security/vault.js';
import type { SttCatalog } from './stt/catalog.js';
import { SherpaDiarizer } from './stt/diarization.js';
import { SttInstaller } from './stt/installer.js';
import { type LocalWhisperConfig, LocalWhisperProvider } from './stt/local-whisper.js';
import { createSttRoutes } from './stt/routes.js';

export interface AtelierServerHandle {
  config: AppConfig;
  db: AtelierDb;
  store: AtelierStore;
  bus: EventBus;
  runtime: AgentRuntime;
  vault: LocalVault;
  backup: BackupService;
  browserManager: BrowserManager;
  officeManager: OfficeManager;
  chromeBridge: ChromeExtensionBridge;
  credentials: CredentialStore;
  sttInstaller: SttInstaller;
  sttProvider: LocalWhisperProvider;
  meetingService: MeetingService;
  appUpdate: AppUpdateBridge;
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
  sttOptions?: {
    catalog?: SttCatalog;
    idleTimeoutMs?: number;
    readyTimeoutMs?: number;
    buildSpawnSpec?: (cfg: LocalWhisperConfig, port: number) => { command: string; args: string[] };
    /** Test hook: run something else than the real speaker engine program. */
    buildDiarizerSpawnSpec?: (
      paths: { exe: string; segmentationModel: string; embeddingModel: string },
      args: string[],
    ) => { command: string; args: string[] };
  };
  /** Desktop shell hooks: audio capture and native notifications for meetings. */
  meetingOptions?: {
    capture?: MeetingAudioCapture;
    notify?: (title: string, body: string) => void;
  };
  /** Desktop shell hook for triggering native in-app update checks and installs. */
  updateOptions?: {
    onAction?: (action: 'check' | 'install') => void;
  };
}): Promise<AtelierServerHandle> {
  const config = loadConfig(opts?.configOverrides);
  const db = new AtelierDb(config.dbPath);
  const store = new AtelierStore(db, config);
  store.recoverOnStartup();

  const bus = new EventBus(() => store.getSnapshot(), config.port);
  store.attachBus(bus);

  const credentials = new CredentialStore(db, config.dataDir);
  const browserManager = new BrowserManager({ db, store, bus, config, credentials });
  const officeManager = new OfficeManager({ store, config });

  const runtime = new AgentRuntime(
    store,
    config,
    opts?.customRunner,
    opts?.customRunnerFactory,
    browserManager,
    undefined,
    officeManager,
  );
  const authManager = new ProviderAuthManager();
  const cliInstaller = new CliInstaller({
    dataDir: config.dataDir,
    store,
    authManager,
    onProgress: (payload) => bus.broadcast({ type: 'cli-install-progress', payload }),
  });

  const sttInstaller = new SttInstaller({
    dataDir: config.dataDir,
    catalog: opts?.sttOptions?.catalog,
    onProgress: (event) => bus.broadcast({ type: 'stt-download-progress', payload: event }),
  });

  const sttProvider = new LocalWhisperProvider({
    getConfig: () => {
      const m = store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
      return {
        exePath: sttInstaller.getExePath(),
        modelPath: sttInstaller.getModelPath(m.activeModelId),
        threads: m.threads,
        language: m.language,
        useGpu: m.useGpu,
      };
    },
    idleTimeoutMs: opts?.sttOptions?.idleTimeoutMs,
    readyTimeoutMs: opts?.sttOptions?.readyTimeoutMs,
    buildSpawnSpec: opts?.sttOptions?.buildSpawnSpec,
  });

  const diarizer = new SherpaDiarizer({
    getPaths: () => sttInstaller.getSpeakerPaths(),
    buildSpawnSpec: opts?.sttOptions?.buildDiarizerSpawnSpec,
  });

  const meetingService = new MeetingService({
    db,
    config,
    store,
    bus,
    sttProvider,
    installer: sttInstaller,
    capture: opts?.meetingOptions?.capture,
    notify: opts?.meetingOptions?.notify,
    diarizer,
    summarize: (req, signal) =>
      runtime.summarizeText(req.prompt, signal, {
        provider: req.provider,
        model: req.model,
        systemPrompt: req.system,
      }),
  });

  const appUpdate = new AppUpdateBridge({
    supported: Boolean(process.env.ATELIER_EMBEDDED),
    currentVersion: process.env.ATELIER_APP_VERSION || '0.1.0',
    onRequestAction: opts?.updateOptions?.onAction,
    onBroadcast: (payload) => bus.broadcast({ type: 'app-update', payload }),
  });

  store.setSnapshotAugmenter((base) => {
    const roomQueues: Record<string, ReturnType<typeof runtime.getRoomQueueSnapshot>> = {};
    for (const ch of base.channels ?? []) {
      if (ch.kind === 'room') {
        roomQueues[ch.id] = runtime.getRoomQueueSnapshot(ch.id);
      }
    }
    return {
      ...base,
      roomQueues,
      browserSessions: browserManager.listSessions(),
      browserApprovals: browserManager.listApprovals(),
      cliApprovals: runtime.listCliApprovals(),
      activeMeeting: meetingService.getActiveMeetingStatus(),
      appUpdate: appUpdate.getStatus(),
    };
  });

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const extensionCandidates = [
    process.env.ATELIER_WEB_DIST
      ? path.resolve(process.env.ATELIER_WEB_DIST, '..', 'chrome-extension')
      : null,
    path.resolve(currentDir, '..', '..', 'extensions', 'chrome'),
    path.resolve(process.cwd(), 'extensions', 'chrome'),
  ].filter((p): p is string => Boolean(p));
  const extensionPath = extensionCandidates.find((p) => fs.existsSync(p)) ?? extensionCandidates[0] ?? null;

  const vault = new LocalVault(db);
  const chromeBridge = new ChromeExtensionBridge({
    dataDir: config.dataDir,
    isVaultLocked: () => vault.isLocked(),
    extensionPath,
  });
  browserManager.setChromeBridge(chromeBridge);
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
    chromeBridge.onVaultLock();
  });

  const app = new Hono();
  app.route(
    '/api',
    createHttpRouter({
      store,
      runtime,
      config,
      authManager,
      cliInstaller,
      vault,
      securityRoutes: createSecurityRoutes({
        vault,
        backup,
        bus,
        onLock: () => {
          void browserManager.stopAllWatches();
          chromeBridge.onVaultLock();
        },
      }),
      browserRoutes: createBrowserRoutes({ browserManager, credentials, chromeBridge }),
      sttRoutes: createSttRoutes({ installer: sttInstaller, provider: sttProvider, store }),
      meetingRoutes: createMeetingRoutes({ meetingService }),
      appUpdate,
    }),
  );
  app.route('/mcp/browser', createBrowserMcpRouter({ browserManager, config }));
  app.route('/mcp/office', createOfficeMcpRouter({ officeManager, config }));
  app.route('/chrome-ext', createChromeExtPublicRouter(chromeBridge, config));

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
  chromeBridge.setServerPort(actualPort);

  server.on('upgrade', (request, socket, head) => {
    if (chromeBridge.handleUpgrade(request, socket, head)) {
      return;
    }
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
    officeManager,
    chromeBridge,
    credentials,
    sttInstaller,
    sttProvider,
    meetingService,
    appUpdate,
    server,
    port: actualPort,
    close: async () => {
      authManager.shutdown();
      await meetingService.shutdown();
      await sttProvider.shutdown();
      await runtime.shutdown();
      await chromeBridge.close();
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
      if (err instanceof GroupChatMigrationError) {
        // Data is untouched (rolled back / never started): print the actionable message only.
        console.error(`Failed to start Atelier server: ${err.message}`);
      } else {
        console.error('Failed to start Atelier server:', err);
      }
      process.exit(1);
    });
}
