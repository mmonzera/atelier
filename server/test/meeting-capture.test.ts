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

    const stopRes = await fetch(`${base}/api/meetings/${meeting.id}/stop`, { method: 'POST' });
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
