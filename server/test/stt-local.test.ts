import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  MeetingStatusEvent,
  ServerEvent,
  SttBenchmarkResult,
  SttLocalStatus,
} from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../src/agents/runner.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';
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

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

/** Builds a minimal valid uncompressed ZIP archive containing a single file entry. */
function makeStoredZip(entryName: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  // CRC-32 calculation
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30 + nameBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header sig
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // compression: store
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  nameBuf.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBuf.length);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory sig
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // offset of local header
  nameBuf.copy(centralHeader, 46);

  const centralOffset = localHeader.length + content.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralHeader.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, content, centralHeader, eocd]);
}

async function startRangeFileServer(files: Record<string, Buffer>): Promise<{
  baseUrl: string;
  rangeRequests: string[];
}> {
  const rangeRequests: string[] = [];
  const server = http.createServer((req, res) => {
    const reqPath = (req.url ?? '/').split('?')[0]!;
    const data = files[reqPath];
    if (!data) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const range = req.headers.range;
    if (range) {
      rangeRequests.push(`${reqPath}:${range}`);
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(data.length - 1, Number(m[2])) : data.length - 1;
        if (start >= data.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
          res.end();
          return;
        }
        const slice = data.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Length': String(data.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, rangeRequests };
}

function writeFakeWhisperScript(dir: string): string {
  const scriptPath = path.join(dir, 'fake-whisper.mjs');
  const script = `
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const port = Number(getArg('--port', '0'));
const modeFile = process.env.FAKE_WHISPER_MODE_FILE;
const countFile = process.env.FAKE_WHISPER_COUNT_FILE;
const delayMs = Number(process.env.FAKE_WHISPER_DELAY_MS || '0');

function nextCount() {
  if (!countFile) return 1;
  let n = 0;
  try { n = Number(fs.readFileSync(countFile, 'utf8') || '0'); } catch {}
  n += 1;
  fs.writeFileSync(countFile, String(n), 'utf8');
  return n;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/inference') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';
    if (mode === 'crash') {
      process.exit(1);
    }
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const callNum = nextCount();
    // Extract a stable tag if present in WAV tail or just emit callNum + byteLength
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: \`Segment #\${callNum} (\${body.byteLength}B)\` }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1');
`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out waiting for condition');
}

function makeFakeRunner(summaryTag = 'Mocked meeting summary'): AgentRunner {
  return {
    async run() {
      return { finalText: 'ok' };
    },
    async summarize(_provider, _model, input) {
      return `${summaryTag}:\n${input}`;
    },
  };
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (httpServers.length) httpServers.pop()!.close();
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
  delete process.env.FAKE_WHISPER_MODE_FILE;
  delete process.env.FAKE_WHISPER_COUNT_FILE;
  delete process.env.FAKE_WHISPER_DELAY_MS;
});

describe('Local Whisper STT & Meeting Transcription', () => {
  it('installs engine & models with SHA-256 verification, rejects bad hash, resumes Range download, and enforces catalog-only URLs (tests 1, 2, 6)', async () => {
    const dir = makeTempDir('atelier-stt-installer-');
    const engineZip = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake-whisper-exe'));
    const validModel = Buffer.alloc(1024 * 64, 0x42);
    const badModel = Buffer.from('corrupted-model-bytes');

    const { baseUrl, rangeRequests } = await startRangeFileServer({
      '/engine.zip': engineZip,
      '/model-ok.bin': validModel,
      '/model-bad.bin': badModel,
    });

    const catalog: SttCatalog = {
      engines: [
        {
          id: 'cpu-x64',
          version: 'test-v1',
          platform: `${process.platform}-${process.arch}`,
          url: `${baseUrl}/engine.zip`,
          host: '127.0.0.1',
          sha256: sha256Hex(engineZip),
          sizeBytes: engineZip.length,
          exe: 'Release/whisper-server.exe',
        },
      ],
      models: [
        {
          id: 'small-q5_1',
          label: 'Small Test',
          filename: 'ggml-small-test.bin',
          url: `${baseUrl}/model-ok.bin`,
          host: '127.0.0.1',
          sha256: sha256Hex(validModel),
          sizeBytes: validModel.length,
          ramMb: 600,
          quality: 2,
        },
        {
          id: 'base',
          label: 'Bad Hash Model',
          filename: 'ggml-bad-test.bin',
          url: `${baseUrl}/model-bad.bin`,
          host: '127.0.0.1',
          sha256: '0'.repeat(64),
          sizeBytes: badModel.length,
          ramMb: 400,
          quality: 1,
        },
      ],
    };

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
      },
      sttOptions: { catalog },
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;

    // Test 2: Catalog-only enforcement (unknown ids -> 404)
    const unknownModelRes = await fetch(`${base}/api/stt/local/models/unknown-model-id/download`, {
      method: 'POST',
    });
    expect(unknownModelRes.status).toBe(404);

    const unknownEngineRes = await fetch(`${base}/api/stt/local/install-engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'arbitrary-url-engine' }),
    });
    expect(unknownEngineRes.status).toBe(404);

    // Test 1a: Wrong SHA-256 -> error & .part deleted
    const badHashRes = await fetch(`${base}/api/stt/local/models/base/download`, {
      method: 'POST',
    });
    expect(badHashRes.status).toBe(400);
    const modelsDir = path.join(dir, 'data', 'stt', 'models');
    expect(fs.existsSync(path.join(modelsDir, 'ggml-bad-test.bin'))).toBe(false);
    expect(fs.existsSync(path.join(modelsDir, 'ggml-bad-test.bin.part'))).toBe(false);

    // Test 1b: Interrupted download -> pre-seed .part with first 16 KB, verify Range resume
    fs.mkdirSync(modelsDir, { recursive: true });
    const partPath = path.join(modelsDir, 'ggml-small-test.bin.part');
    fs.writeFileSync(partPath, validModel.subarray(0, 16384));

    const resumeRes = await fetch(`${base}/api/stt/local/models/small-q5_1/download`, {
      method: 'POST',
    });
    expect(resumeRes.status).toBe(200);
    expect(rangeRequests).toContain('/model-ok.bin:bytes=16384-');
    const finalModelPath = path.join(modelsDir, 'ggml-small-test.bin');
    expect(fs.existsSync(finalModelPath)).toBe(true);
    expect(fs.existsSync(partPath)).toBe(false);
    expect(sha256Hex(fs.readFileSync(finalModelPath))).toBe(sha256Hex(validModel));

    // Install engine archive + verify extraction
    const engRes = await fetch(`${base}/api/stt/local/install-engine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cpu-x64' }),
    });
    expect(engRes.status).toBe(200);

    // Activate small-q5_1 and verify ready status
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meeting: { activeModelId: 'small-q5_1' } }),
    });

    const stRes = await fetch(`${base}/api/stt/local/status`);
    const stJson = (await stRes.json()) as { status: SttLocalStatus };
    expect(stJson.status.ready).toBe(true);
    expect(stJson.status.installedEngine?.version).toBe('test-v1');
    expect(stJson.status.diskUsage.totalBytes).toBeGreaterThan(0);

    // Test 6: Clear all -> stt/ cleaned and status becomes not installed
    const clearRes = await fetch(`${base}/api/stt/local/all`, { method: 'DELETE' });
    expect(clearRes.status).toBe(200);
    const afterClear = (await clearRes.json()) as { status: SttLocalStatus };
    expect(afterClear.status.ready).toBe(false);
    expect(afterClear.status.installedEngine).toBeNull();
    expect(afterClear.status.diskUsage.totalBytes).toBe(0);
    expect(fs.existsSync(path.join(dir, 'data', 'stt'))).toBe(false);
  });

  it('runs LocalWhisperProvider with fake whisper server, releases on idle timeout, and runs benchmark (tests 3, 7)', async () => {
    const dir = makeTempDir('atelier-stt-provider-');
    const scriptPath = writeFakeWhisperScript(dir);
    const engineZip = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake-exe'));
    const modelBytes = Buffer.from('fake-model-data');
    const { baseUrl } = await startRangeFileServer({
      '/engine.zip': engineZip,
      '/model.bin': modelBytes,
    });

    const catalog: SttCatalog = {
      engines: [
        {
          id: 'cpu-x64',
          version: 'test-v1',
          platform: `${process.platform}-${process.arch}`,
          url: `${baseUrl}/engine.zip`,
          host: '127.0.0.1',
          sha256: sha256Hex(engineZip),
          sizeBytes: engineZip.length,
          exe: 'Release/whisper-server.exe',
        },
      ],
      models: [
        {
          id: 'large-v3-turbo-q5_0',
          label: 'Turbo Test',
          filename: 'ggml-turbo-test.bin',
          url: `${baseUrl}/model.bin`,
          host: '127.0.0.1',
          sha256: sha256Hex(modelBytes),
          sizeBytes: modelBytes.length,
          ramMb: 1400,
          quality: 4,
          recommended: true,
        },
      ],
    };

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
      },
      customRunner: makeFakeRunner(),
      sttOptions: {
        catalog,
        idleTimeoutMs: 250,
        readyTimeoutMs: 5_000,
        buildSpawnSpec: (_cfg, port) => ({
          command: process.execPath,
          args: [scriptPath, '--port', String(port)],
        }),
      },
    });
    handles.push(handle);

    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');

    // Test 3: prepare -> transcribe -> release -> process killed after idleTimeoutMs
    await handle.sttProvider.prepare();
    expect(handle.sttProvider.isRunning()).toBe(true);
    const out = await handle.sttProvider.transcribe(createSampleWav(1), {
      language: 'id',
      signal: AbortSignal.timeout(5_000),
    });
    expect(out.text).toContain('Segment #1');
    await handle.sttProvider.release();

    await waitFor(() => !handle.sttProvider.isRunning(), 5_000);
    expect(handle.sttProvider.isRunning()).toBe(false);

    // Test 7: Benchmark runs and then releases -> idle timeout stops Whisper process
    const base = `http://127.0.0.1:${handle.port}`;
    const benchRes = await fetch(`${base}/api/stt/local/benchmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'large-v3-turbo-q5_0' }),
    });
    expect(benchRes.status).toBe(200);
    const benchJson = (await benchRes.json()) as { result: SttBenchmarkResult };
    expect(benchJson.result.realtimeRatio).toBeGreaterThan(2);
    expect(benchJson.result.recommendation).toBe('live_safe');

    await waitFor(() => !handle.sttProvider.isRunning(), 5_000);
    expect(handle.sttProvider.isRunning()).toBe(false);
  });

  it('switches to economy mode automatically if Whisper crashes twice mid-meeting (test 4)', async () => {
    const dir = makeTempDir('atelier-stt-crash-');
    const scriptPath = writeFakeWhisperScript(dir);
    const modeFile = path.join(dir, 'mode.txt');
    fs.writeFileSync(modeFile, 'crash', 'utf8');
    process.env.FAKE_WHISPER_MODE_FILE = modeFile;

    const engineZip = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake-exe'));
    const modelBytes = Buffer.from('fake-model-data');
    const { baseUrl } = await startRangeFileServer({
      '/engine.zip': engineZip,
      '/model.bin': modelBytes,
    });

    const catalog: SttCatalog = {
      engines: [
        {
          id: 'cpu-x64',
          version: 'test-v1',
          platform: `${process.platform}-${process.arch}`,
          url: `${baseUrl}/engine.zip`,
          host: '127.0.0.1',
          sha256: sha256Hex(engineZip),
          sizeBytes: engineZip.length,
          exe: 'Release/whisper-server.exe',
        },
      ],
      models: [
        {
          id: 'large-v3-turbo-q5_0',
          label: 'Turbo Test',
          filename: 'ggml-turbo-test.bin',
          url: `${baseUrl}/model.bin`,
          host: '127.0.0.1',
          sha256: sha256Hex(modelBytes),
          sizeBytes: modelBytes.length,
          ramMb: 1400,
          quality: 4,
        },
      ],
    };

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
      },
      customRunner: makeFakeRunner(),
      sttOptions: {
        catalog,
        idleTimeoutMs: 250,
        readyTimeoutMs: 5_000,
        buildSpawnSpec: (_cfg, port) => ({
          command: process.execPath,
          args: [scriptPath, '--port', String(port)],
        }),
      },
    });
    handles.push(handle);

    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');

    const started = await handle.meetingService.startMeeting({
      title: 'Crash Fallback Meeting',
      mode: 'live',
    });
    const meetingId = started.meeting.id;

    handle.meetingService.enqueueChunk(meetingId, createSampleWav(1));

    const updated = await waitFor(() => {
      const m = handle.meetingService.getMeeting(meetingId);
      return m && m.meeting.mode === 'economy' ? m : null;
    }, 8_000);

    expect(updated.meeting.mode).toBe('economy');
    expect(updated.meeting.pendingChunks).toBe(1);

    // Confirm chunk WAV file is still preserved on disk
    const pendingDir = path.join(dir, 'data', 'meetings', meetingId, 'pending');
    expect(fs.readdirSync(pendingDir).length).toBe(1);

    // Fix Whisper server and stop -> completes transcription & summary!
    fs.writeFileSync(modeFile, 'ok', 'utf8');
    const finished = await handle.meetingService.stopMeeting(meetingId);
    expect(finished.meeting.status).toBe('completed');
    expect(finished.meeting.transcript).toHaveLength(1);
    expect(finished.meeting.summary).toContain('Mocked meeting summary');
  });

  it('records 3 chunks in economy mode, transcribes in order after stop, summarizes, cleans audio, and idles down (tests 5, 7)', async () => {
    const dir = makeTempDir('atelier-stt-economy-');
    const scriptPath = writeFakeWhisperScript(dir);
    const countFile = path.join(dir, 'count.txt');
    process.env.FAKE_WHISPER_COUNT_FILE = countFile;

    const engineZip = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake-exe'));
    const modelBytes = Buffer.from('fake-model-data');
    const { baseUrl } = await startRangeFileServer({
      '/engine.zip': engineZip,
      '/model.bin': modelBytes,
    });

    const catalog: SttCatalog = {
      engines: [
        {
          id: 'cpu-x64',
          version: 'test-v1',
          platform: `${process.platform}-${process.arch}`,
          url: `${baseUrl}/engine.zip`,
          host: '127.0.0.1',
          sha256: sha256Hex(engineZip),
          sizeBytes: engineZip.length,
          exe: 'Release/whisper-server.exe',
        },
      ],
      models: [
        {
          id: 'large-v3-turbo-q5_0',
          label: 'Turbo Test',
          filename: 'ggml-turbo-test.bin',
          url: `${baseUrl}/model.bin`,
          host: '127.0.0.1',
          sha256: sha256Hex(modelBytes),
          sizeBytes: modelBytes.length,
          ramMb: 1400,
          quality: 4,
        },
      ],
    };

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
      },
      customRunner: makeFakeRunner('Economy Final Notes'),
      sttOptions: {
        catalog,
        idleTimeoutMs: 250,
        readyTimeoutMs: 5_000,
        buildSpawnSpec: (_cfg, port) => ({
          command: process.execPath,
          args: [scriptPath, '--port', String(port)],
        }),
      },
    });
    handles.push(handle);

    await handle.sttInstaller.installEngine('cpu-x64');
    await handle.sttInstaller.downloadModel('large-v3-turbo-q5_0');

    const base = `http://127.0.0.1:${handle.port}`;
    const startRes = await fetch(`${base}/api/meetings/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Economy Test', mode: 'economy', keepAudio: false }),
    });
    expect(startRes.status).toBe(201);
    const { meeting } = (await startRes.json()) as MeetingStatusEvent;
    expect(handle.sttProvider.isRunning()).toBe(false);

    // Enqueue 3 chunks during meeting
    for (let i = 0; i < 3; i += 1) {
      const chunkRes = await fetch(`${base}/api/meetings/${meeting.id}/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: new Uint8Array(createSampleWav(1)),
      });
      expect(chunkRes.status).toBe(201);
    }
    expect(handle.sttProvider.isRunning()).toBe(false);

    const stopRes = await fetch(`${base}/api/meetings/${meeting.id}/stop?wait=1`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    const stopped = (await stopRes.json()) as MeetingStatusEvent;

    expect(stopped.meeting.status).toBe('completed');
    expect(stopped.meeting.transcript.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(stopped.meeting.transcript[0]!.text).toContain('Segment #1');
    expect(stopped.meeting.transcript[1]!.text).toContain('Segment #2');
    expect(stopped.meeting.transcript[2]!.text).toContain('Segment #3');
    expect(stopped.meeting.summary).toContain('Economy Final Notes');
    expect(stopped.meeting.summary).toContain('Segment #3');

    // Audio directory deleted when keepAudio=false
    expect(fs.existsSync(path.join(dir, 'data', 'meetings', meeting.id))).toBe(false);

    // Whisper process stops after idle timeout
    await waitFor(() => !handle.sttProvider.isRunning(), 5_000);
    expect(handle.sttProvider.isRunning()).toBe(false);
  });

  it('drains lagging chunks in order on stop and recovers cleanly without duplicating chunks after app restart (test 8)', async () => {
    const dir = makeTempDir('atelier-stt-restart-');
    const scriptPath = writeFakeWhisperScript(dir);
    const countFile = path.join(dir, 'count.txt');
    process.env.FAKE_WHISPER_COUNT_FILE = countFile;
    process.env.FAKE_WHISPER_DELAY_MS = '120';

    const engineZip = makeStoredZip('Release/whisper-server.exe', Buffer.from('fake-exe'));
    const modelBytes = Buffer.from('fake-model-data');
    const { baseUrl } = await startRangeFileServer({
      '/engine.zip': engineZip,
      '/model.bin': modelBytes,
    });

    const catalog: SttCatalog = {
      engines: [
        {
          id: 'cpu-x64',
          version: 'test-v1',
          platform: `${process.platform}-${process.arch}`,
          url: `${baseUrl}/engine.zip`,
          host: '127.0.0.1',
          sha256: sha256Hex(engineZip),
          sizeBytes: engineZip.length,
          exe: 'Release/whisper-server.exe',
        },
      ],
      models: [
        {
          id: 'large-v3-turbo-q5_0',
          label: 'Turbo Test',
          filename: 'ggml-turbo-test.bin',
          url: `${baseUrl}/model.bin`,
          host: '127.0.0.1',
          sha256: sha256Hex(modelBytes),
          sizeBytes: modelBytes.length,
          ramMb: 1400,
          quality: 4,
        },
      ],
    };

    const dataDir = path.join(dir, 'data');
    const workspacesDir = path.join(dir, 'ws');

    const handle1 = await startAtelierServer({
      configOverrides: { port: 0, dataDir, workspacesDir },
      customRunner: makeFakeRunner('Lagging Stop Summary'),
      sttOptions: {
        catalog,
        idleTimeoutMs: 250,
        readyTimeoutMs: 5_000,
        buildSpawnSpec: (_cfg, port) => ({
          command: process.execPath,
          args: [scriptPath, '--port', String(port)],
        }),
      },
    });
    handles.push(handle1);

    await handle1.sttInstaller.installEngine('cpu-x64');
    await handle1.sttInstaller.downloadModel('large-v3-turbo-q5_0');

    // Part A: Stop while 3 chunks are still pending in Live mode
    const m1 = await handle1.meetingService.startMeeting({ title: 'Lagging Meeting', mode: 'live' });
    handle1.meetingService.enqueueChunk(m1.meeting.id, createSampleWav(1));
    handle1.meetingService.enqueueChunk(m1.meeting.id, createSampleWav(1));
    handle1.meetingService.enqueueChunk(m1.meeting.id, createSampleWav(1));
    handle1.meetingService.enqueueChunk(m1.meeting.id, createSampleWav(1));

    const stopped = await handle1.meetingService.stopMeeting(m1.meeting.id);
    expect(stopped.meeting.status).toBe('completed');
    expect(stopped.meeting.transcript.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(stopped.meeting.summary).toContain('Lagging Stop Summary');

    // Part B: Simulate app close mid-processing (chunk 1 done, chunks 2 & 3 pending), then reopen and resume
    const m2 = await handle1.meetingService.startMeeting({ title: 'Interrupted Meeting', mode: 'economy' });
    handle1.meetingService.enqueueChunk(m2.meeting.id, createSampleWav(1));
    handle1.meetingService.enqueueChunk(m2.meeting.id, createSampleWav(1));
    handle1.meetingService.enqueueChunk(m2.meeting.id, createSampleWav(1));

    // Mark chunk 1 as already done and meeting mid-transcribing before closing server 1
    handle1.db.sqlite
      .prepare(`UPDATE meeting_chunks SET status = 'done', text = 'Already saved #1' WHERE meeting_id = ? AND seq = 1`)
      .run(m2.meeting.id);
    const recRow = handle1.db.sqlite
      .prepare(`SELECT data FROM meetings WHERE id = ?`)
      .get(m2.meeting.id) as { data: string };
    const rec = JSON.parse(recRow.data) as Record<string, unknown>;
    rec.status = 'transcribing';
    handle1.db.sqlite
      .prepare(`UPDATE meetings SET data = ? WHERE id = ?`)
      .run(JSON.stringify(rec), m2.meeting.id);

    await handle1.close();
    handles.pop();

    // Reopen app on same dataDir / dbPath
    process.env.FAKE_WHISPER_DELAY_MS = '0';
    const handle2 = await startAtelierServer({
      configOverrides: { port: 0, dataDir, workspacesDir },
      customRunner: makeFakeRunner('Resumed Notes'),
      sttOptions: {
        catalog,
        idleTimeoutMs: 250,
        readyTimeoutMs: 5_000,
        buildSpawnSpec: (_cfg, port) => ({
          command: process.execPath,
          args: [scriptPath, '--port', String(port)],
        }),
      },
    });
    handles.push(handle2);

    const recovered = handle2.meetingService.getMeeting(m2.meeting.id);
    expect(recovered?.meeting.status).toBe('pending');
    expect(recovered?.meeting.completedChunks).toBe(1);
    expect(recovered?.meeting.pendingChunks).toBe(2);

    const base2 = `http://127.0.0.1:${handle2.port}`;
    const resumeRes = await fetch(`${base2}/api/meetings/${m2.meeting.id}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as MeetingStatusEvent;

    expect(resumed.meeting.status).toBe('completed');
    expect(resumed.meeting.transcript.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(resumed.meeting.transcript[0]!.text).toBe('Already saved #1');
    expect(resumed.meeting.transcript[1]!.text).toContain('Segment #');
    expect(resumed.meeting.transcript[2]!.text).toContain('Segment #');
    expect(resumed.meeting.summary).toContain('Already saved #1');
  });
});
