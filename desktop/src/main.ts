/**
 * Atelier desktop shell (Electron).
 *
 * Runs the Hono + node:sqlite server in-process on a dynamic loopback port (port 0), loads the
 * built Vite frontend from it, and adds desktop power-tool UX: single-instance lock, system tray,
 * native notifications, native folder picker, and auto-update from GitHub Releases.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, ServerEvent, Task } from '@atelier/contracts';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';
import { runResetLock } from '../../server/src/cli/reset-lock.js';
import { type AtelierServerHandle, startAtelierServer } from '../../server/src/index.js';

const APP_ID = 'com.atelier.desktop';
const appDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------- data locations
// Installed: %APPDATA%\Atelier\{data,workspaces}. Portable .exe: <exe dir>\AtelierData.
// ATELIER_DATA_DIR / ATELIER_WORKSPACES_DIR override either (e.g. a USB stick or a synced folder).
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;
const dataRoot = portableDir ? path.join(portableDir, 'AtelierData') : path.join(app.getPath('appData'), 'Atelier');
const dataDir = path.resolve(process.env.ATELIER_DATA_DIR || path.join(dataRoot, 'data'));
const workspacesDir = path.resolve(process.env.ATELIER_WORKSPACES_DIR || path.join(dataRoot, 'workspaces'));
app.setPath('userData', path.join(dataRoot, 'electron'));
process.env.ATELIER_WEB_DIST = path.join(appDir, 'web');
process.env.ATELIER_APP_VERSION = app.getVersion();

app.setAppUserModelId(APP_ID);

// ---------------------------------------------------------------------------- --reset-lock
if (process.argv.includes('--reset-lock')) {
  void app.whenReady().then(() => {
    try {
      const { dbPath, removed } = runResetLock(dataDir);
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Atelier',
        message: removed ? 'App lock dimatikan.' : 'App lock memang tidak aktif.',
        detail: `${dbPath}\n\nBuka Atelier lagi, lalu aktifkan app lock dari Settings bila perlu.`,
      });
    } catch (err) {
      dialog.showErrorBox('Atelier', `Gagal reset lock: ${err instanceof Error ? err.message : String(err)}`);
    }
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  // ---------------------------------------------------------------------------- single instance
  app.exit(0);
} else {
  bootstrap();
}

function bootstrap(): void {
  let handle: AtelierServerHandle | null = null;
  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let closedHintShown = false;
  let updateReady = false;
  let baseUrl = '';

  const assetPath = (name: string) => path.join(appDir, 'assets', name);

  const showWindow = () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  app.on('second-instance', showWindow);

  // ------------------------------------------------------------------ window
  const isOwnOrigin = (url: string) => {
    try {
      return new URL(url).origin === new URL(baseUrl).origin;
    } catch {
      return false;
    }
  };

  const openExternal = (url: string) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
  };

  function createWindow(): void {
    const iconFile = assetPath('icon.png');
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 600,
      show: false,
      backgroundColor: '#0d0d11',
      title: 'Atelier',
      icon: fs.existsSync(iconFile) ? iconFile : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(appDir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    mainWindow.webContents.setWindowOpenHandler(({ url, disposition }) => {
      // window.open() popups (MCP OAuth login) stay in-app so `window.opener.postMessage` works.
      if (isOwnOrigin(url) || disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isOwnOrigin(url)) {
        event.preventDefault();
        openExternal(url);
      }
    });

    mainWindow.once('ready-to-show', () => mainWindow?.show());

    mainWindow.on('close', (event) => {
      if (quitting) return;
      // Keep agents running in the background: closing the window only hides it to the tray.
      event.preventDefault();
      mainWindow?.hide();
      if (!closedHintShown) {
        closedHintShown = true;
        notify('Atelier tetap jalan di tray', 'Agent terus bekerja di background. Klik ikon tray untuk membuka lagi.');
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    void mainWindow.loadURL(baseUrl);
  }

  // ------------------------------------------------------------------ notifications
  function notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: assetPath('icon.png'), silent: false });
    n.on('click', showWindow);
    n.show();
  }

  const windowFocused = () => Boolean(mainWindow && mainWindow.isVisible() && mainWindow.isFocused());
  const agentState = new Map<string, { status: Agent['status']; pending: boolean }>();
  const taskState = new Map<string, Task['status']>();

  function seedNotificationState(): void {
    if (!handle) return;
    const snap = handle.store.getSnapshot();
    for (const a of snap.agents) agentState.set(a.id, { status: a.status, pending: Boolean(a.pendingFallback) });
    for (const t of snap.tasks) taskState.set(t.id, t.status);
  }

  function onServerEvent(event: ServerEvent): void {
    if (event.type === 'snapshot') {
      agentState.clear();
      taskState.clear();
      for (const a of event.payload.agents) agentState.set(a.id, { status: a.status, pending: Boolean(a.pendingFallback) });
      for (const t of event.payload.tasks) taskState.set(t.id, t.status);
      return;
    }
    if (event.type === 'agent-upserted') {
      const a = event.payload;
      const prev = agentState.get(a.id);
      const pending = Boolean(a.pendingFallback);
      agentState.set(a.id, { status: a.status, pending });
      if (!prev || windowFocused()) return;
      if (pending && !prev.pending) {
        notify(`${a.name} butuh persetujuan`, `Model ${a.pendingFallback?.failedModel ?? ''} gagal — pilih model cadangan untuk lanjut.`);
      } else if (prev.status === 'working' && a.status === 'idle' && a.queueLength === 0) {
        notify(`${a.name} selesai`, a.currentTask ? `Selesai: ${a.currentTask}` : 'Turn selesai — hasilnya siap dicek.');
      } else if (prev.status !== 'error' && a.status === 'error') {
        notify(`${a.name} berhenti dengan error`, (a.lastError ?? 'Lihat detailnya di Atelier.').slice(0, 180));
      }
      return;
    }
    if (event.type === 'task-upserted') {
      const t = event.payload;
      const prev = taskState.get(t.id);
      taskState.set(t.id, t.status);
      if (prev && prev !== t.status && t.status === 'in_review' && !windowFocused()) {
        notify(`${t.identifier} siap direview`, t.title);
      }
    }
  }

  // ------------------------------------------------------------------ tray
  function buildTrayMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: 'Buka Atelier', click: showWindow },
      {
        label: 'Kunci sekarang',
        enabled: Boolean(handle?.vault.isEnabled()),
        click: () => handle?.vault.lockNow(),
      },
      { type: 'separator' },
      {
        label: 'Buka folder data',
        click: () => void shell.openPath(dataRoot),
      },
      ...(updateReady
        ? [{ label: 'Restart & pasang update', click: () => installUpdate() } as Electron.MenuItemConstructorOptions]
        : []),
      { type: 'separator' },
      {
        label: 'Keluar',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
  }

  function createTray(): void {
    const trayFile = assetPath('tray.png');
    const image = fs.existsSync(trayFile) ? nativeImage.createFromPath(trayFile) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip('Atelier');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);
    // Refresh dynamic items (lock state) whenever the menu is about to be shown.
    tray.on('right-click', () => tray?.setContextMenu(buildTrayMenu()));
  }

  // ------------------------------------------------------------------ auto-update (GitHub Releases)
  let autoUpdater: import('electron-updater').AppUpdater | null = null;

  async function setupAutoUpdate(): Promise<void> {
    // Portable .exe cannot self-update; dev runs have no release feed.
    if (!app.isPackaged || portableDir || process.env.ATELIER_DISABLE_UPDATES === '1') return;
    if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
    try {
      const mod = await import('electron-updater');
      autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater;
    } catch (err) {
      console.warn('[atelier] electron-updater unavailable:', err);
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = true;
      tray?.setContextMenu(buildTrayMenu());
      notify('Update Atelier siap', `Versi ${info.version} sudah diunduh. Dipasang otomatis saat keluar, atau restart dari tray.`);
    });
    autoUpdater.on('error', (err) => console.warn('[atelier] auto-update error:', err?.message ?? err));
    const check = () => autoUpdater?.checkForUpdates().catch(() => undefined);
    setTimeout(check, 30_000);
    setInterval(check, 6 * 60 * 60 * 1000).unref();
  }

  function installUpdate(): void {
    if (!autoUpdater) return;
    quitting = true;
    void shutdownServer().finally(() => {
      autoUpdater?.quitAndInstall(false, true);
    });
  }

  // ------------------------------------------------------------------ IPC (preload bridge)
  ipcMain.handle('atelier:pick-folder', async (event, title?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: typeof title === 'string' ? title : 'Pilih folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle('atelier:app-info', () => ({ version: app.getVersion(), portable: Boolean(portableDir), dataRoot }));

  // ------------------------------------------------------------------ lifecycle
  let shutdownPromise: Promise<void> | null = null;
  function shutdownServer(): Promise<void> {
    if (!handle) return Promise.resolve();
    shutdownPromise ??= Promise.race([
      handle.close(), // stops agents, runs "backup on close", closes SQLite
      new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
    ]).catch((err) => console.error('[atelier] shutdown error:', err));
    return shutdownPromise;
  }

  app.on('before-quit', () => {
    quitting = true;
  });

  let finalQuit = false;
  app.on('will-quit', (event) => {
    if (finalQuit || !handle) return;
    event.preventDefault();
    void shutdownServer().finally(() => {
      finalQuit = true;
      tray?.destroy();
      app.exit(0);
    });
  });

  // Keep running in the tray when every window is closed.
  app.on('window-all-closed', () => undefined);

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      handle = await startAtelierServer({
        configOverrides: { port: 0, dataDir, workspacesDir },
      });
    } catch (err) {
      dialog.showErrorBox(
        'Atelier gagal start',
        `${err instanceof Error ? err.message : String(err)}\n\nData folder: ${dataDir}`,
      );
      app.exit(1);
      return;
    }
    handle.backup.startScheduler();
    baseUrl = `http://127.0.0.1:${handle.port}/`;
    console.log(`[atelier] desktop server on ${baseUrl} (data: ${dataDir})`);
    seedNotificationState();
    handle.bus.onEvent(onServerEvent);

    createTray();
    createWindow();
    void setupAutoUpdate();
  });
}
