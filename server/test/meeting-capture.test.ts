import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MeetingAppEvent, MeetingStatusEvent, ServerEvent } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../src/agents/runner.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';
import { ShellAudioCapture, parseShellLine } from '../src/meetings/capture.js';
import { createSampleWav } from '../src/stt/wav-sample.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const fakeRunner: AgentRunner = {
  async run() {
    return { finalText: 'ok' };
  },
  async summarize() {
    return 'summary';
  },
};

/**
 * Plays the desktop shell's part of the protocol: answers start/stop, writes chunk WAVs into
 * the folder the server names, and announces them over the stdin channel.
 */
function fakeShell(opts: { failStart?: string; chunksBeforeStop?: number } = {}) {
  const emitted: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  let seq = 0;
  let dir = '';
  const capture: ShellAudioCapture = new ShellAudioCapture(
    (tag, payload) => {
      const p = payload as Record<string, unknown>;
      emitted.push({ tag, payload: p });
      const meetingId = String(p.meetingId);
      const send = (line: string) => {
        const parsed = parseShellLine(line)!;
        capture.handleLine(parsed.command, parsed.payload);
      };
      const writeChunk = () => {
        seq += 1;
        const file = path.join(dir, `${String(seq).padStart(5, '0')}.wav`);
        fs.writeFileSync(file, createSampleWav(1));
        send(`audio-chunk ${JSON.stringify({ meetingId, path: file, seconds: 1 })}`);
      };
      setTimeout(() => {
        if (p.action === 'start') {
          if (opts.failStart) {
            send(`audio-error ${JSON.stringify({ meetingId, message: opts.failStart, fatal: true })}`);
            return;
          }
          dir = String(p.dir);
          send(`audio-started ${JSON.stringify({ meetingId })}`);
          for (let i = 0; i < (opts.chunksBeforeStop ?? 0); i += 1) writeChunk();
        } else if (p.action === 'stop') {
          writeChunk(); // the audio since the last pause
          send(`audio-stopped ${JSON.stringify({ meetingId })}`);
        }
      }, 10);
    },
    { startTimeoutMs: 2_000, stopTimeoutMs: 2_000 },
  );
  return { capture, emitted };
}

async function startServer(dataRoot: string, capture?: ShellAudioCapture, notices?: string[]) {
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dataRoot, 'data'),
      workspacesDir: path.join(dataRoot, 'ws'),
    },
    customRunner: fakeRunner,
    meetingOptions: {
      capture,
      notify: (title) => notices?.push(title),
    },
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Meeting audio capture through the desktop shell', () => {
  it('records chunks from the shell and flushes the last one before draining on stop', async () => {
    const root = makeTempDir('atelier-capture-');
    const { capture, emitted } = fakeShell({ chunksBeforeStop: 2 });
    const handle = await startServer(root, capture);
    const base = `http://127.0.0.1:${handle.port}`;

    const list = (await (await fetch(`${base}/api/meetings`)).json()) as { captureAvailable: boolean };
    expect(list.captureAvailable).toBe(true);

    const startRes = await fetch(`${base}/api/meetings/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'economy' }),
    });
    expect(startRes.status).toBe(201);
    const { meeting } = (await startRes.json()) as MeetingStatusEvent;

    const startCmd = emitted.find((e) => e.tag === 'ATELIER_AUDIO' && e.payload.action === 'start');
    expect(startCmd?.payload.dir).toBe(path.join(root, 'data', 'meetings', meeting.id, 'incoming'));

    // Chunks written by the shell are queued (and their files moved out of incoming/).
    const start = Date.now();
    while (handle.meetingService.getMeeting(meeting.id)!.meeting.totalChunks < 2) {
      if (Date.now() - start > 3_000) throw new Error('chunks not queued');
      await new Promise((r) => setTimeout(r, 20));
    }

    const stopRes = await fetch(`${base}/api/meetings/${meeting.id}/stop?wait=1`, { method: 'POST' });
    const stopped = (await stopRes.json()) as MeetingStatusEvent;
    expect(emitted.some((e) => e.tag === 'ATELIER_AUDIO' && e.payload.action === 'stop')).toBe(true);
    // 2 during the meeting + the final flush; no engine installed, so they wait as pending.
    expect(stopped.meeting.totalChunks).toBe(3);
    expect(stopped.meeting.status).toBe('pending');
    const incoming = path.join(root, 'data', 'meetings', meeting.id, 'incoming');
    expect(fs.readdirSync(incoming)).toEqual([]);
  });

  it('fails the start cleanly when the shell cannot open any audio device', async () => {
    const root = makeTempDir('atelier-capture-fail-');
    const { capture } = fakeShell({ failStart: 'Tidak bisa merekam' });
    const handle = await startServer(root, capture);
    const base = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${base}/api/meetings/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'economy' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('capture_failed');
    expect(body.error.message).toContain('Tidak bisa merekam');
    expect(handle.meetingService.getActiveMeetingStatus()).toBeNull();
  });

  it('adopts chunk files the shell wrote before the app closed', async () => {
    const root = makeTempDir('atelier-capture-adopt-');
    const first = await startServer(root);
    const started = await first.meetingService.startMeeting({ mode: 'economy' });
    const incoming = path.join(root, 'data', 'meetings', started.meeting.id, 'incoming');
    fs.mkdirSync(incoming, { recursive: true });
    fs.writeFileSync(path.join(incoming, '00001.wav'), createSampleWav(1));
    fs.writeFileSync(path.join(incoming, '00002.wav.part'), Buffer.from('half-written'));
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    const second = await startServer(root);
    const recovered = second.meetingService.getMeeting(started.meeting.id)!;
    expect(recovered.meeting.status).toBe('pending');
    expect(recovered.meeting.totalChunks).toBe(1);
    expect(fs.existsSync(path.join(incoming, '00001.wav'))).toBe(false);
  });

  it('marks the meeting as finishing the moment Stop is pressed', async () => {
    const root = makeTempDir('atelier-capture-stop-');
    const { capture } = fakeShell();
    const handle = await startServer(root, capture);
    const base = `http://127.0.0.1:${handle.port}`;
    const started = await handle.meetingService.startMeeting({ mode: 'economy' });

    const res = await fetch(`${base}/api/meetings/${started.meeting.id}/stop`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as MeetingStatusEvent;
    expect(body.meeting.status).not.toBe('recording');

    // The rest finishes in the background (final flush, then pending: no engine installed).
    const t0 = Date.now();
    while (handle.meetingService.getMeeting(started.meeting.id)!.meeting.status === 'transcribing') {
      if (Date.now() - t0 > 5_000) throw new Error('stop did not finish');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.meetingService.getMeeting(started.meeting.id)!.meeting.totalChunks).toBe(1);
  });

  it('pauses without counting the paused time, and discards a recording', async () => {
    const root = makeTempDir('atelier-capture-pause-');
    const { capture, emitted } = fakeShell();
    const handle = await startServer(root, capture);
    const base = `http://127.0.0.1:${handle.port}`;
    const events: ServerEvent[] = [];
    handle.bus.onEvent((ev: ServerEvent) => events.push(ev));
    const started = await handle.meetingService.startMeeting({ mode: 'economy' });
    const id = started.meeting.id;

    const post = (p: string, body?: unknown) =>
      fetch(`${base}/api/meetings/${id}/${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const paused = (await (await post('pause', { paused: true })).json()) as MeetingStatusEvent;
    expect(paused.meeting.paused).toBe(true);
    expect(emitted.some((e) => e.payload.action === 'pause')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    const resumed = (await (await post('pause', { paused: false })).json()) as MeetingStatusEvent;
    expect(resumed.meeting.paused).toBe(false);
    expect(resumed.meeting.pausedMs).toBeGreaterThanOrEqual(50);
    expect(emitted.some((e) => e.payload.action === 'resume')).toBe(true);

    // Levels from the shell are relayed for the waveform, not stored.
    capture.handleLine('audio-level', { meetingId: id, levels: [0.1, 0.2] });
    expect(events.some((e) => e.type === 'meeting-level' && e.payload.levels.length === 2)).toBe(true);

    expect((await post('discard')).status).toBe(200);
    expect(emitted.some((e) => e.payload.action === 'stop')).toBe(true);
    expect(handle.meetingService.getMeeting(id)).toBeNull();
    expect(events.some((e) => e.type === 'meeting-removed' && e.payload.id === id)).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'meetings', id))).toBe(false);
  });
});

describe('Meeting notes management', () => {
  it('announces finished notes, renames, and deletes a meeting with its files', async () => {
    const root = makeTempDir('atelier-notes-');
    const notices: string[] = [];
    const handle = await startServer(root, undefined, notices);
    const base = `http://127.0.0.1:${handle.port}`;

    const started = await handle.meetingService.startMeeting({ mode: 'economy', keepAudio: true });
    const id = started.meeting.id;

    // Busy meetings cannot be deleted.
    expect((await fetch(`${base}/api/meetings/${id}`, { method: 'DELETE' })).status).toBe(409);

    // No audio: stopping completes straight away and tells the user the notes are ready.
    const stopped = await handle.meetingService.stopMeeting(id);
    expect(stopped.meeting.status).toBe('completed');
    expect(notices.some((n) => /notes are ready|Catatan meeting siap/.test(n))).toBe(true);

    const renamed = await fetch(`${base}/api/meetings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Weekly sync' }),
    });
    expect(((await renamed.json()) as MeetingStatusEvent).meeting.title).toBe('Weekly sync');

    const dir = path.join(root, 'data', 'meetings', id);
    expect(fs.existsSync(dir)).toBe(true); // keepAudio left the folder
    expect((await fetch(`${base}/api/meetings/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await fetch(`${base}/api/meetings/${id}`)).status).toBe(404);
  });
});

describe('Meeting app detection', () => {
  it('offers notes for meeting apps, respects the settings, and asks to stop when the app ends', async () => {
    const root = makeTempDir('atelier-detect-');
    const notices: string[] = [];
    const { capture } = fakeShell();
    const handle = await startServer(root, capture, notices);
    const events: MeetingAppEvent[] = [];
    handle.bus.onEvent((ev: ServerEvent) => {
      if (ev.type === 'meeting-app') events.push(ev.payload);
    });

    handle.meetingService.handleMeetingApp({ state: 'started', appId: 'zoom', appName: 'Zoom' });
    expect(events).toEqual([{ state: 'started', appId: 'zoom', appName: 'Zoom', meetingId: null }]);
    expect(notices).toHaveLength(1);

    // "Don't ask again" for browsers, and detection switched off entirely.
    handle.store.updateSettings({ meeting: { ignoredMeetingApps: ['browser'] } });
    handle.meetingService.handleMeetingApp({ state: 'started', appId: 'browser', appName: 'Google Chrome' });
    handle.store.updateSettings({ meeting: { detectMeetingApps: false } });
    handle.meetingService.handleMeetingApp({ state: 'started', appId: 'teams', appName: 'Microsoft Teams' });
    expect(events).toHaveLength(1);

    // While recording, the app ending carries the meeting id so the UI can offer to stop.
    handle.store.updateSettings({ meeting: { detectMeetingApps: true } });
    const started = await handle.meetingService.startMeeting({ mode: 'economy' });
    handle.meetingService.handleMeetingApp({ state: 'started', appId: 'teams', appName: 'Microsoft Teams' });
    expect(events).toHaveLength(1); // already taking notes: no offer
    handle.meetingService.handleMeetingApp({ state: 'ended', appId: 'zoom', appName: 'Zoom' });
    expect(events[1]).toEqual({ state: 'ended', appId: 'zoom', appName: 'Zoom', meetingId: started.meeting.id });
    expect(notices).toHaveLength(2);
  });
});
