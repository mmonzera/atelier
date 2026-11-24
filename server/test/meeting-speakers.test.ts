import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AudioDevicesInfo, MeetingStatusEvent, ServerEvent, SttLocalStatus } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../src/agents/runner.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';
import { ShellAudioCapture, parseShellLine } from '../src/meetings/capture.js';
import type { SttCatalog } from '../src/stt/catalog.js';
import { createSampleWav } from '../src/stt/wav-sample.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];
const httpServers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const sha256Hex = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** A minimal valid ZIP holding one stored file (the system tar unpacks it like a .tar.bz2). */
function makeStoredZip(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + content.length, 16);
  return Buffer.concat([local, content, central, eocd]);
}

async function startFileServer(files: Record<string, Buffer>): Promise<string> {
  const server = http.createServer((req, res) => {
    const data = files[(req.url ?? '/').split('?')[0]!];
    if (!data) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': String(data.length) });
    res.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpServers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Whisper stand-in: two timed sentences per chunk, like `verbose_json`. */
function writeFakeWhisper(dir: string): string {
  const file = path.join(dir, 'fake-whisper.mjs');
  fs.writeFileSync(
    file,
    `
import http from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
let n = 0;
http.createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('ok'); return; }
  for await (const _ of req) {}
  n += 1;
  const segments = [
    { start: 0, end: 2, text: ' part A of chunk ' + n },
    { start: 2.5, end: 5, text: ' part B of chunk ' + n },
  ];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: segments.map((s) => s.text.trim()).join(' '), segments }));
}).listen(port, '127.0.0.1');
`,
  );
  return file;
}

/** Speaker engine stand-in: prints the turns from FAKE_DIARIZER_OUTPUT and records its arguments. */
function writeFakeDiarizer(dir: string): string {
  const file = path.join(dir, 'fake-diarizer.mjs');
  fs.writeFileSync(
    file,
    `
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_DIARIZER_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_DIARIZER_FAIL) { console.error('model crashed'); process.exit(3); }
console.log('Started');
console.log(process.env.FAKE_DIARIZER_OUTPUT);
`,
  );
  return file;
}

interface Calls {
  provider: string;
  model: string | undefined;
  input: string;
  system: string | undefined;
}

function makeRunner(calls: Calls[]): AgentRunner {
  return {
    async run() {
      return { finalText: 'ok' };
    },
    async summarize(provider, model, input, _signal, opts) {
      calls.push({ provider, model, input, system: opts?.systemPrompt });
      return `NOTES #${calls.length}`;
    },
  };
}

/** The desktop shell's side of the protocol, answering what the server asks. */
function fakeShell() {
  const emitted: Array<Record<string, unknown>> = [];
  const meters: boolean[] = [];
  const capture: ShellAudioCapture = new ShellAudioCapture((tag, payload) => {
    const p = payload as Record<string, unknown>;
    emitted.push({ tag, ...p });
    const reply = (line: string) => {
      const parsed = parseShellLine(line)!;
      capture.handleLine(parsed.command, parsed.payload);
    };
    setTimeout(() => {
      if (tag !== 'ATELIER_AUDIO') return;
      if (p.action === 'start') reply(`audio-started ${JSON.stringify({ meetingId: p.meetingId })}`);
      if (p.action === 'stop') reply(`audio-stopped ${JSON.stringify({ meetingId: p.meetingId })}`);
      if (p.action === 'list-devices') {
        reply(
          `audio-devices ${JSON.stringify({
            requestId: p.requestId,
            inputs: [
              { name: 'Microphone (Realtek)', isDefault: false },
              { name: 'V380 Camera', isDefault: true },
            ],
            outputs: [{ name: 'Speakers (Realtek)', isDefault: true }],
          })}`,
        );
      }
      if (p.action === 'meter') meters.push(Boolean(p.enabled));
    }, 5);
  });
  return { capture, emitted, meters };
}

/** A chunk as the shell hands it over: WAV + energy file in the incoming folder, announced by line. */
function dropChunk(
  capture: ShellAudioCapture,
  incomingDir: string,
  meetingId: string,
  n: number,
  startSec: number,
  loudSide: 'mic' | 'speaker',
) {
  fs.mkdirSync(incomingDir, { recursive: true });
  const wav = path.join(incomingDir, `${String(n).padStart(5, '0')}.wav`);
  const energy = path.join(incomingDir, `${String(n).padStart(5, '0')}.energy.json`);
  fs.writeFileSync(wav, createSampleWav(6));
  const loud = Array(60).fill(0.08);
  const quiet = Array(60).fill(0.001);
  fs.writeFileSync(
    energy,
    JSON.stringify({
      frameMs: 100,
      startSec,
      firstFrame: startSec * 10,
      mic: loudSide === 'mic' ? loud : quiet,
      speaker: loudSide === 'mic' ? quiet : loud,
    }),
  );
  capture.handleLine('audio-chunk', { meetingId, path: wav, seconds: 6, startSec, energyPath: energy });
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (httpServers.length) httpServers.pop()!.close();
  for (const key of ['FAKE_DIARIZER_ARGS_FILE', 'FAKE_DIARIZER_OUTPUT', 'FAKE_DIARIZER_FAIL']) delete process.env[key];
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    for (let i = 0; i < 6; i += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }
});

async function setup() {
  const dir = makeTempDir('atelier-speakers-');
  const whisper = writeFakeWhisper(dir);
  const diarizer = writeFakeDiarizer(dir);
  const argsFile = path.join(dir, 'diarizer-args.jsonl');
  process.env.FAKE_DIARIZER_ARGS_FILE = argsFile;
  // Chunk 1 (0–5 s) is me, chunk 2 (10–15 s) and chunk 3 (20–25 s) are two other people.
  process.env.FAKE_DIARIZER_OUTPUT = [
    '0.000 -- 5.000 speaker_00',
    '10.000 -- 15.000 speaker_01',
    '20.000 -- 25.000 speaker_02',
  ].join('\n');

  const whisperEngine = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake'));
  const model = Buffer.from('fake-model');
  const speakerEngine = makeStoredZip('bin/fake-diarizer.exe', Buffer.from('fake'));
  const segmentation = makeStoredZip('seg/model.int8.onnx', Buffer.from('fake-seg'));
  const embedding = Buffer.from('fake-embedding');
  const base = await startFileServer({
    '/whisper.zip': whisperEngine,
    '/model.bin': model,
    '/speakers.zip': speakerEngine,
    '/seg.zip': segmentation,
    '/emb.onnx': embedding,
  });
  const platform = `${process.platform}-${process.arch}`;
  const catalog: SttCatalog = {
    engines: [
      {
        id: 'cpu-x64',
        version: 'test-v1',
        platform,
        url: `${base}/whisper.zip`,
        host: '127.0.0.1',
        sha256: sha256Hex(whisperEngine),
        sizeBytes: whisperEngine.length,
        exe: 'Release/whisper-server.exe',
      },
    ],
    models: [
      {
        id: 'large-v3-turbo-q5_0',
        label: 'Turbo Test',
        filename: 'ggml-test.bin',
        url: `${base}/model.bin`,
        host: '127.0.0.1',
        sha256: sha256Hex(model),
        sizeBytes: model.length,
        ramMb: 1,
        quality: 4,
      },
    ],
    speakers: {
      version: 'speakers-test',
      platform,
      engine: { url: `${base}/speakers.zip`, host: '127.0.0.1', sha256: sha256Hex(speakerEngine), sizeBytes: speakerEngine.length, exe: 'fake-diarizer.exe' },
      segmentation: { url: `${base}/seg.zip`, host: '127.0.0.1', sha256: sha256Hex(segmentation), sizeBytes: segmentation.length, modelFile: 'model.int8.onnx' },
      embedding: { url: `${base}/emb.onnx`, host: '127.0.0.1', sha256: sha256Hex(embedding), sizeBytes: embedding.length, filename: 'embedding.onnx' },
    },
  };

  const calls: Calls[] = [];
  const shell = fakeShell();
  const notices: string[] = [];
  const handle = await startAtelierServer({
    configOverrides: { port: 0, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'ws') },
    customRunner: makeRunner(calls),
    sttOptions: {
      catalog,
      idleTimeoutMs: 250,
      readyTimeoutMs: 5_000,
      buildSpawnSpec: (_cfg, port) => ({ command: process.execPath, args: [whisper, '--port', String(port)] }),
      buildDiarizerSpawnSpec: (_paths, args) => ({ command: process.execPath, args: [diarizer, ...args] }),
    },
    meetingOptions: { capture: shell.capture, notify: (title) => notices.push(title) },
  });
  handles.push(handle);
  const api = `http://127.0.0.1:${handle.port}/api`;
  const post = (p: string, body?: unknown) =>
    fetch(`${api}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { dir, handle, api, post, calls, shell, notices, argsFile };
}

describe('speaker engine install', () => {
  it('installs from the catalog with SHA-256 checks, reports status, and can be removed', async () => {
    const { handle, post, api } = await setup();
    expect(handle.sttInstaller.getSpeakerPaths()).toBeNull();

    const res = await post('/stt/local/speakers/install');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: SttLocalStatus };
    expect(body.status.speakerEngine.installed).toBe(true);
    expect(body.status.speakerEngine.version).toBe('speakers-test');
    expect(body.status.diskUsage.speakersBytes).toBeGreaterThan(0);
    const paths = handle.sttInstaller.getSpeakerPaths()!;
    expect(fs.existsSync(paths.exe)).toBe(true);
    expect(path.basename(paths.exe)).toBe('fake-diarizer.exe');
    expect(path.basename(paths.segmentationModel)).toBe('model.int8.onnx');
    expect(path.basename(paths.embeddingModel)).toBe('embedding.onnx');

    const removed = await fetch(`${api}/stt/local/speakers`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(handle.sttInstaller.getSpeakerPaths()).toBeNull();
  });

  it('rejects a download whose hash does not match', async () => {
    const dir = makeTempDir('atelier-speakers-bad-');
    const base = await startFileServer({ '/e.zip': makeStoredZip('bin/x.exe', Buffer.from('x')) });
    const handle = await startAtelierServer({
      configOverrides: { port: 0, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'ws') },
      sttOptions: {
        catalog: {
          engines: [],
          models: [],
          speakers: {
            version: 'v',
            platform: `${process.platform}-${process.arch}`,
            engine: { url: `${base}/e.zip`, host: '127.0.0.1', sha256: 'f'.repeat(64), sizeBytes: 1, exe: 'x.exe' },
            segmentation: { url: `${base}/s`, host: '127.0.0.1', sha256: 'a'.repeat(64), sizeBytes: 1, modelFile: 'm' },
            embedding: { url: `${base}/m`, host: '127.0.0.1', sha256: 'b'.repeat(64), sizeBytes: 1, filename: 'e' },
          },
        },
      },
    });
    handles.push(handle);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/stt/local/speakers/install`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('hash_mismatch');
    expect(handle.sttInstaller.getSpeakerPaths()).toBeNull();
  });
});

describe('a meeting with speaker names', () => {
  it('records timed sentences, tells me from others, finds the voices, and names them', async () => {
    const { handle, api, post, calls, shell, notices, argsFile } = await setup();
    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');
    await post('/stt/local/speakers/install');

    // The user picked a microphone and wrote the notes with another provider.
    handle.store.updateSettings({
      meeting: { micDevice: 'Microphone (Realtek)', notesProvider: 'deepseek', notesModel: 'deepseek-chat', notesLanguage: 'id' },
    });

    const events: ServerEvent[] = [];
    handle.bus.onEvent((ev: ServerEvent) => events.push(ev));

    const startRes = await post('/meetings/start', { mode: 'economy', title: 'Weekly' });
    expect(startRes.status).toBe(201);
    const { meeting } = (await startRes.json()) as MeetingStatusEvent;
    const start = shell.emitted.find((e) => e.action === 'start')!;
    expect(start.micDevice).toBe('Microphone (Realtek)');
    expect(start.speakerDevice).toBeNull();

    const incoming = path.join(handle.config.dataDir, 'meetings', meeting.id, 'incoming');
    dropChunk(shell.capture, incoming, meeting.id, 1, 0, 'mic');
    dropChunk(shell.capture, incoming, meeting.id, 2, 10, 'speaker');
    dropChunk(shell.capture, incoming, meeting.id, 3, 20, 'speaker');
    expect(fs.readdirSync(incoming)).toEqual([]); // handed over

    // The shell reports a dead microphone: the warning carries a code the UI can act on.
    shell.capture.handleLine('audio-error', { meetingId: meeting.id, message: 'Mikrofon "V380" hening', fatal: false, code: 'mic_silent' });
    const warned = (await (await fetch(`${api}/meetings/${meeting.id}`)).json()) as MeetingStatusEvent;
    expect(warned.warning).toContain('V380');
    expect(warned.warningCode).toBe('mic_silent');

    const stopRes = await fetch(`${api}/meetings/${meeting.id}/stop?wait=1`, { method: 'POST' });
    const stopped = (await stopRes.json()) as MeetingStatusEvent;
    const m = stopped.meeting;
    expect(m.status).toBe('completed');
    expect(events.some((e) => e.type === 'meeting-status' && e.payload.meeting.status === 'identifying')).toBe(true);

    // Sentences with their place on the recording timeline.
    expect(m.transcript.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2000],
      [2500, 5000],
      [10_000, 12_000],
      [12_500, 15_000],
      [20_000, 22_000],
      [22_500, 25_000],
    ]);
    // Me from the loud microphone; the two other people from the speaker engine.
    expect(m.transcript.map((s) => s.speakerId)).toEqual(['me', 'me', 'spk_1', 'spk_1', 'spk_2', 'spk_2']);
    expect(m.speakers.map((s) => [s.id, s.isMe])).toEqual([
      ['me', true],
      ['spk_1', false],
      ['spk_2', false],
    ]);
    expect(m.speakersPending).toBe(true);
    expect(m.audioKept).toBe(true);
    expect(notices.some((n) => /siap|ready/i.test(n))).toBe(true);

    // The notes used the chosen provider, their own prompt, and the transcript with names.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.provider).toBe('deepseek');
    expect(calls[0]!.model).toBe('deepseek-chat');
    expect(calls[0]!.system).toContain('Indonesian');
    expect(calls[0]!.system).not.toContain('JSON');
    expect(calls[0]!.input).toContain('[00:00] Saya: part A of chunk 1 part B of chunk 1');
    expect(calls[0]!.input).toContain('[00:10] Pembicara 1: part A of chunk 2');
    expect(calls[0]!.input).toContain('[00:20] Pembicara 2: part A of chunk 3');

    // Without a known number of people the program decides by threshold.
    const firstArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
    expect(firstArgs).toContain('--clustering.cluster-threshold=0.9');

    // A voice sample can be played while the audio is kept.
    const sample = await fetch(`${api}/meetings/${meeting.id}/speakers/spk_1/sample.wav`);
    expect(sample.status).toBe(200);
    expect(sample.headers.get('content-type')).toBe('audio/wav');
    expect((await sample.arrayBuffer()).byteLength).toBeGreaterThan(44 + 32 * 400);

    // Naming: rename, merge two voices that are the same person, then finish → notes written again.
    const renamed = await fetch(`${api}/meetings/${meeting.id}/speakers/spk_1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rina' }),
    });
    expect(((await renamed.json()) as MeetingStatusEvent).meeting.speakers.find((s) => s.id === 'spk_1')?.name).toBe('Rina');
    const merged = await post(`/meetings/${meeting.id}/speakers/spk_2/merge`, { into: 'spk_1' });
    const afterMerge = ((await merged.json()) as MeetingStatusEvent).meeting;
    expect(afterMerge.speakers.map((s) => s.id)).toEqual(['me', 'spk_1']);
    expect(afterMerge.transcript.filter((s) => s.speakerId === 'spk_1')).toHaveLength(4);
    expect((await post(`/meetings/${meeting.id}/speakers/me/merge`, { into: 'spk_1' })).status).toBe(400);

    const done = await post(`/meetings/${meeting.id}/speakers-done`, { regenerate: true });
    const final = ((await done.json()) as MeetingStatusEvent).meeting;
    expect(final.speakersPending).toBe(false);
    expect(final.audioKept).toBe(false);
    expect(final.summary).toBe('NOTES #2');
    expect(calls).toHaveLength(2);
    // Merged into one person, so her consecutive sentences read as one line.
    expect(calls[1]!.input).toContain('[00:10] Rina: part A of chunk 2 part B of chunk 2 part A of chunk 3');
    expect(calls[1]!.input).toContain('Saya: part A of chunk 1');
    expect(calls[1]!.input).not.toContain('Pembicara');
    // The audio kept for naming is gone; the notes and transcript stay.
    expect(fs.existsSync(path.join(handle.config.dataDir, 'meetings', meeting.id))).toBe(false);
    expect((await fetch(`${api}/meetings/${meeting.id}/speakers/spk_1/sample.wav`)).status).toBe(404);
  });

  it('runs the speaker engine again with the number of participants, and survives an engine failure', async () => {
    const { handle, api, post, shell, argsFile } = await setup();
    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');
    await post('/stt/local/speakers/install');

    const { meeting } = (await (await post('/meetings/start', { mode: 'economy' })).json()) as MeetingStatusEvent;
    const incoming = path.join(handle.config.dataDir, 'meetings', meeting.id, 'incoming');
    dropChunk(shell.capture, incoming, meeting.id, 1, 0, 'mic');
    dropChunk(shell.capture, incoming, meeting.id, 2, 10, 'speaker');
    await fetch(`${api}/meetings/${meeting.id}/stop?wait=1`, { method: 'POST' });

    // Two people in the room: tell the engine so.
    process.env.FAKE_DIARIZER_OUTPUT = ['0.000 -- 5.000 speaker_00', '10.000 -- 15.000 speaker_01'].join('\n');
    const again = await post(`/meetings/${meeting.id}/diarize`, { participants: 2 });
    expect(again.status).toBe(200);
    const lines = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toContain('--clustering.num-clusters=2');
    const status = ((await again.json()) as MeetingStatusEvent).meeting;
    expect(status.status).toBe('completed');
    expect(status.speakers.map((s) => s.id)).toEqual(['me', 'spk_1']);

    // The engine crashes: the meeting keeps its "me" / "others" labels and says why.
    process.env.FAKE_DIARIZER_FAIL = '1';
    const failed = await post(`/meetings/${meeting.id}/diarize`, { participants: 3 });
    expect(failed.status).toBe(200);
    const after = (await failed.json()) as MeetingStatusEvent;
    expect(after.meeting.status).toBe('completed');
    expect(after.warningCode).toBe('speakers_failed');
    expect(after.warning).toContain('model crashed');
    expect(after.meeting.transcript.length).toBe(4);
  });

  it('can write the notes again with another provider, and refuses while a meeting is still recording', async () => {
    const { handle, api, post, calls, shell } = await setup();
    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');

    const { meeting } = (await (await post('/meetings/start', { mode: 'economy' })).json()) as MeetingStatusEvent;
    expect((await post(`/meetings/${meeting.id}/regenerate-notes`, {})).status).toBe(409);
    dropChunk(shell.capture, path.join(handle.config.dataDir, 'meetings', meeting.id, 'incoming'), meeting.id, 1, 0, 'mic');
    await fetch(`${api}/meetings/${meeting.id}/stop?wait=1`, { method: 'POST' });
    expect(calls[0]!.provider).toBe('claude'); // follows the app default

    const res = await post(`/meetings/${meeting.id}/regenerate-notes`, { provider: 'openrouter', model: 'openrouter/auto' });
    expect(res.status).toBe(200);
    expect(calls[1]!.provider).toBe('openrouter');
    expect(calls[1]!.model).toBe('openrouter/auto');
    expect(((await res.json()) as MeetingStatusEvent).meeting.summary).toBe('NOTES #2');
    // Without the speaker engine nothing was kept, and there is nothing to name.
    const detail = ((await (await fetch(`${api}/meetings/${meeting.id}`)).json()) as MeetingStatusEvent).meeting;
    expect(detail.speakersPending).toBe(false);
    expect(detail.speakers.map((s) => s.id)).toEqual(['me']);
    expect((await post(`/meetings/${meeting.id}/diarize`, {})).status).toBe(400);
  });
});

describe('audio devices and level meter', () => {
  it('lists the shell\'s devices, starts and stops the meter, and relays its readings', async () => {
    const { handle, api, post, shell } = await setup();
    const events: ServerEvent[] = [];
    handle.bus.onEvent((ev: ServerEvent) => events.push(ev));

    const devices = (await (await fetch(`${api}/meetings/audio-devices`)).json()) as AudioDevicesInfo;
    expect(devices.inputs.map((d) => d.name)).toEqual(['Microphone (Realtek)', 'V380 Camera']);
    expect(devices.inputs.find((d) => d.isDefault)?.name).toBe('V380 Camera');
    expect(devices.outputs).toHaveLength(1);

    // A choice made in the page is previewed before it is saved.
    expect((await post('/meetings/audio-meter', { enabled: true, micDevice: 'Microphone (Realtek)', speakerDevice: null })).status).toBe(200);
    const meterStart = shell.emitted.find((e) => e.action === 'meter' && e.enabled === true)!;
    expect(meterStart.micDevice).toBe('Microphone (Realtek)');
    shell.capture.handleLine('audio-meter', { mic: 0.07, speaker: 0.01, micName: 'Microphone (Realtek)' });
    expect(events.some((e) => e.type === 'meeting-meter' && e.payload.mic === 0.07 && e.payload.micName === 'Microphone (Realtek)')).toBe(true);

    expect((await post('/meetings/audio-meter', { enabled: false })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(shell.meters).toEqual([true, false]);

    // Settings with null follow the Windows defaults.
    const saved = handle.store.updateSettings({ meeting: { micDevice: 'Microphone (Realtek)' } });
    expect(saved.meeting?.micDevice).toBe('Microphone (Realtek)');
    expect(handle.store.updateSettings({ meeting: { micDevice: null } }).meeting?.micDevice).toBeNull();
  });
});
