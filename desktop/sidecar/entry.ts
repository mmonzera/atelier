/**
 * Atelier server sidecar — started by the Tauri (Rust) shell.
 *
 * Protocol (line based):
 *   stdout  ATELIER_READY {"port":N}                 server is listening on 127.0.0.1:N
 *   stdout  ATELIER_NOTIFY {"title":"…","body":"…"}   shell shows a native notification if unfocused
 *   stdin   lock                                      revoke every app-lock session ("Kunci sekarang")
 *   stdin   shutdown                                  graceful stop: agents -> backup-on-close -> SQLite
 *   stdin   EOF                                       shell died: same as shutdown (no orphan servers)
 *   meeting audio capture + meeting-app detection: see server/src/meetings/capture.ts
 *
 * `node server.mjs --reset-lock` removes the app lock (lost password + recovery key).
 */
import path from 'node:path';
import readline from 'node:readline';
import type { Agent, ServerEvent, Task } from '@atelier/contracts';
import { runResetLock } from '../../server/src/cli/reset-lock.js';
import { startAtelierServer } from '../../server/src/index.js';
import { ShellAudioCapture, parseShellLine } from '../../server/src/meetings/capture.js';

const dataDir = path.resolve(process.env.ATELIER_DATA_DIR ?? './data');
const workspacesDir = path.resolve(process.env.ATELIER_WORKSPACES_DIR ?? './workspaces');

function emit(tag: string, payload: unknown): void {
  process.stdout.write(`${tag} ${JSON.stringify(payload)}\n`);
}

if (process.argv.includes('--reset-lock')) {
  const { dbPath, removed } = runResetLock(dataDir);
  console.log(
    removed
      ? `App lock dimatikan untuk ${dbPath}. Buka Atelier lagi lalu aktifkan dari Settings bila perlu.`
      : `App lock memang tidak aktif di ${dbPath}.`,
  );
  process.exit(0);
}

// Audio capture and meeting-app detection run in the shell; see server/src/meetings/capture.ts.
const audioCapture = new ShellAudioCapture(emit);

const handle = await startAtelierServer({
  configOverrides: { port: Number(process.env.ATELIER_PORT ?? 0), dataDir, workspacesDir },
  meetingOptions: {
    capture: audioCapture,
    notify: (title, body) => emit('ATELIER_NOTIFY', { title, body }),
  },
});
handle.backup.startScheduler();

let detectEnabled: boolean | null = null;
function syncMeetingDetection(): void {
  const enabled = handle.store.getSettings().meeting?.detectMeetingApps ?? true;
  if (enabled === detectEnabled) return;
  detectEnabled = enabled;
  emit('ATELIER_DETECT', { enabled });
}

// ---------------------------------------------------------------- notification rules
const agentState = new Map<string, { status: Agent['status']; pending: boolean }>();
const taskState = new Map<string, Task['status']>();

function seed(agents: Agent[], tasks: Task[]): void {
  agentState.clear();
  taskState.clear();
  for (const a of agents) agentState.set(a.id, { status: a.status, pending: Boolean(a.pendingFallback) });
  for (const t of tasks) taskState.set(t.id, t.status);
}
const initial = handle.store.getSnapshot();
seed(initial.agents, initial.tasks);

const notify = (title: string, body: string) => emit('ATELIER_NOTIFY', { title, body });

handle.bus.onEvent((event: ServerEvent) => {
  if (event.type === 'settings-changed') {
    syncMeetingDetection();
    return;
  }
  if (event.type === 'snapshot') {
    seed(event.payload.agents, event.payload.tasks);
    return;
  }
  if (event.type === 'agent-upserted') {
    const a = event.payload;
    const prev = agentState.get(a.id);
    const pending = Boolean(a.pendingFallback);
    agentState.set(a.id, { status: a.status, pending });
    if (!prev) return;
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
    if (prev && prev !== t.status && t.status === 'in_review') notify(`${t.identifier} siap direview`, t.title);
  }
});

// ---------------------------------------------------------------- control channel + shutdown
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.race([handle.close(), new Promise<void>((r) => setTimeout(r, 18_000))]).catch((err) =>
    console.error('[atelier] shutdown error:', err),
  );
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const parsed = parseShellLine(line);
  if (!parsed) return;
  const { command, payload } = parsed;
  if (command === 'lock') handle.vault.lockNow();
  else if (command === 'shutdown') void shutdown();
  else if (audioCapture.handleLine(command, payload)) return;
  else if (command === 'meeting-app') {
    const state = payload.state === 'ended' ? 'ended' : 'started';
    const appId = typeof payload.appId === 'string' ? payload.appId : '';
    const appName = typeof payload.appName === 'string' ? payload.appName : appId;
    if (appId) handle.meetingService.handleMeetingApp({ state, appId, appName });
  } else if (command === 'meeting-toggle') {
    handle.meetingService
      .toggleRecording()
      .then((ev) => {
        const recording = ev.meeting.status === 'recording';
        emit('ATELIER_NOTIFY', {
          title: recording ? 'Mencatat meeting' : 'Catatan meeting selesai',
          body: recording
            ? 'Atelier merekam mic dan suara laptop. Klik ikon tray → Catat meeting untuk berhenti.'
            : 'Transkrip dan ringkasan sedang disiapkan.',
        });
      })
      .catch((err: unknown) =>
        emit('ATELIER_NOTIFY', {
          title: 'Gagal mencatat meeting',
          body: (err instanceof Error ? err.message : String(err)).slice(0, 180),
        }),
      );
  }
});
rl.on('close', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

emit('ATELIER_READY', { port: handle.port });
syncMeetingDetection();
