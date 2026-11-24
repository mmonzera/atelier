import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNotesRequest, formatClock, transcriptForNotes } from '../src/meetings/notes.js';
import {
  type EnergyTrack,
  WAV_BYTES_PER_MS,
  assignSpeakers,
  buildWav,
  classifySide,
  mergeChunksToWav,
  parseEnergyFile,
  sideForRange,
  sliceChunkPcm,
  wavDurationMs,
} from '../src/meetings/speakers.js';
import { buildDiarizationArgs, parseDiarizationOutput } from '../src/stt/diarization.js';
import { createSampleWav } from '../src/stt/wav-sample.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('me / others from the loudness of each source', () => {
  it('calls loud-mic sentences "me", loud-laptop sentences "others", and survives speaker echo', () => {
    expect(classifySide(0.05, 0.001)).toBe('me'); // I talk, nobody else does
    expect(classifySide(0.001, 0.1)).toBe('others'); // microphone is only noise
    expect(classifySide(0.02, 0.15)).toBe('others'); // speakers leak into the mic at a fraction of the level
    expect(classifySide(0.06, 0.02)).toBe('me'); // I talk over a quiet call
    expect(classifySide(0.004, 0.0)).toBe('others'); // mic below the noise floor
  });

  it('reads the energy of the sentence range on the recording timeline', () => {
    // Frames of 100 ms starting at 10.0 s: the mic is loud for 2 s, then the laptop is.
    const track: EnergyTrack = {
      firstFrame: 100,
      mic: [...Array(20).fill(0.06), ...Array(20).fill(0.001)],
      speaker: [...Array(20).fill(0.001), ...Array(20).fill(0.1)],
    };
    expect(sideForRange(track, 10_000, 11_800)).toBe('me');
    expect(sideForRange(track, 12_200, 13_800)).toBe('others');
    expect(sideForRange(null, 0, 1000)).toBeNull();
    expect(sideForRange(track, 30_000, 31_000)).toBeNull(); // past the data
  });

  it('parses the shell\'s energy file and rejects garbage', () => {
    const ok = parseEnergyFile(JSON.stringify({ startSec: 41.2, mic: [0.1, 0.2], speaker: [0, 0.1] }));
    expect(ok?.firstFrame).toBe(412);
    expect(parseEnergyFile('not json')).toBeNull();
    expect(parseEnergyFile(JSON.stringify({ mic: ['x'], speaker: [] }))).toBeNull();
  });
});

describe('matching speaker turns to sentences', () => {
  const sentences = [
    { key: 'a', startMs: 0, endMs: 4000, side: 'me' as const },
    { key: 'b', startMs: 5000, endMs: 9000, side: 'others' as const },
    { key: 'c', startMs: 10_000, endMs: 14_000, side: 'others' as const },
    { key: 'd', startMs: 15_000, endMs: 18_000, side: 'me' as const },
  ];
  const turns = [
    { startMs: 0, endMs: 4200, speaker: 0 },
    { startMs: 4800, endMs: 9200, speaker: 1 },
    { startMs: 9800, endMs: 14_500, speaker: 2 },
    { startMs: 14_800, endMs: 18_200, speaker: 0 },
  ];

  it('keeps "me" for the microphone and numbers the others by first appearance', () => {
    const result = assignSpeakers(sentences, turns);
    expect(result.meCluster).toBe(0);
    expect(result.bySentence.get('a')).toBe('me');
    expect(result.bySentence.get('d')).toBe('me');
    expect(result.bySentence.get('b')).toBe('spk_1');
    expect(result.bySentence.get('c')).toBe('spk_2');
    expect(result.otherIds).toEqual(['spk_1', 'spk_2']);
  });

  it('gives a sentence the speaker with the most overlap', () => {
    const result = assignSpeakers(
      [{ key: 'x', startMs: 0, endMs: 10_000, side: 'others' }],
      [
        { startMs: 0, endMs: 2000, speaker: 3 },
        { startMs: 2000, endMs: 9000, speaker: 4 },
      ],
    );
    expect(result.bySentence.get('x')).toBe('spk_1');
    expect(result.meCluster).toBeNull();
  });

  it('puts a sentence nobody spoke over on the generic "others"', () => {
    const result = assignSpeakers([{ key: 'x', startMs: 50_000, endMs: 52_000, side: 'others' }], turns);
    expect(result.bySentence.get('x')).toBe('others');
  });

  it('trusts the microphone when the diarizer merged me and someone else into one voice', () => {
    // One cluster covers both: half of it is on microphone sentences, so it is not "mine".
    // What the microphone says still wins: my sentence stays "me", the laptop's is another person.
    const result = assignSpeakers(
      [
        { key: 'm', startMs: 0, endMs: 3000, side: 'me' },
        { key: 'o', startMs: 3000, endMs: 6000, side: 'others' },
      ],
      [{ startMs: 0, endMs: 6000, speaker: 0 }],
    );
    expect(result.bySentence.get('m')).toBe('me');
    expect(result.bySentence.get('o')).toBe('spk_1');
    expect(result.meCluster).toBeNull();
  });

  it('never gives a laptop sentence to a cluster that is clearly the user\'s own voice', () => {
    const result = assignSpeakers(
      [
        { key: 'm1', startMs: 0, endMs: 3000, side: 'me' },
        { key: 'm2', startMs: 3000, endMs: 6000, side: 'me' },
        { key: 'o', startMs: 6000, endMs: 7000, side: 'others' },
      ],
      [{ startMs: 0, endMs: 7000, speaker: 0 }],
    );
    expect(result.meCluster).toBe(0);
    expect(result.bySentence.get('o')).toBe('others'); // no other cluster exists: generic "others"
  });
});

describe('WAV helpers', () => {
  it('places chunks at their time on one timeline and slices a voice sample', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-wav-'));
    tempDirs.push(dir);
    const a = path.join(dir, 'a.wav');
    const b = path.join(dir, 'b.wav');
    fs.writeFileSync(a, createSampleWav(2));
    fs.writeFileSync(b, createSampleWav(1));
    const out = path.join(dir, 'merged.wav');
    // b starts at 5 s: 3 s of silence sit between the chunks.
    const { durationMs } = mergeChunksToWav(
      [
        { path: b, startMs: 5000 },
        { path: a, startMs: 0 },
      ],
      out,
    );
    expect(durationMs).toBe(6000);
    const merged = fs.readFileSync(out);
    expect(wavDurationMs(merged)).toBe(6000);
    expect(merged.length).toBe(44 + 6000 * WAV_BYTES_PER_MS);
    expect(merged.toString('ascii', 0, 4)).toBe('RIFF');
    expect(merged.readUInt32LE(40)).toBe(6000 * WAV_BYTES_PER_MS);
    // The 3 s gap is digital silence.
    const gap = merged.subarray(44 + 2500 * WAV_BYTES_PER_MS, 44 + 4500 * WAV_BYTES_PER_MS);
    expect(gap.every((byte) => byte === 0)).toBe(true);

    const chunk = createSampleWav(4);
    const pcm = sliceChunkPcm(chunk, 10_000, 11_000, 12_000);
    expect(pcm.length).toBe(1000 * WAV_BYTES_PER_MS);
    expect(wavDurationMs(buildWav(pcm))).toBe(1000);
    expect(sliceChunkPcm(chunk, 10_000, 30_000, 31_000).length).toBe(0);
  });
});

describe('speaker engine program', () => {
  it('reads turns from the program output and ignores everything else', () => {
    const out = ['OfflineSpeakerDiarizationConfig(...)', 'Started', '0.132 -- 1.280 speaker_00', '2.191 -- 5.465 speaker_01', 'Duration : 41 s', ''].join('\r\n');
    expect(parseDiarizationOutput(out)).toEqual([
      { startMs: 132, endMs: 1280, speaker: 0 },
      { startMs: 2191, endMs: 5465, speaker: 1 },
    ]);
    expect(parseDiarizationOutput('5.0 -- 4.0 speaker_00')).toEqual([]); // end before start
  });

  it('uses the participant count when known, the distance threshold otherwise', () => {
    const paths = { exe: 'e.exe', segmentationModel: 'seg.onnx', embeddingModel: 'emb.onnx' };
    const known = buildDiarizationArgs(paths, 'in.wav', { numSpeakers: 3, threads: 2 });
    expect(known).toContain('--clustering.num-clusters=3');
    expect(known.some((a) => a.startsWith('--clustering.cluster-threshold'))).toBe(false);
    expect(known).toContain('--segmentation.pyannote-model=seg.onnx');
    expect(known).toContain('--embedding.model=emb.onnx');
    expect(known.at(-1)).toBe('in.wav');
    const unknown = buildDiarizationArgs(paths, 'in.wav', { numSpeakers: null, threads: 2 });
    expect(unknown).toContain('--clustering.cluster-threshold=0.9');
  });
});

describe('meeting notes request', () => {
  it('joins consecutive sentences of one speaker and shows the clock', () => {
    expect(formatClock(75_000)).toBe('01:15');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    const text = transcriptForNotes([
      { startMs: 0, speaker: 'Rina', text: 'Good morning.' },
      { startMs: 2000, speaker: 'Rina', text: 'Let us start.' },
      { startMs: 5000, speaker: 'Budi', text: 'Ready.' },
      { startMs: null, speaker: null, text: '  ' },
    ]);
    expect(text).toBe('[00:00] Rina: Good morning. Let us start.\n[00:05] Budi: Ready.');
  });

  it('is its own prompt: Markdown, no tools, the transcript is untrusted, language and layout from settings', () => {
    const base = { title: 'Weekly', date: '2026-11-25 10:00', meetingLanguage: 'auto' as const, transcript: '[00:00] Rina: hi' };
    const normal = buildNotesRequest({ ...base, notesLanguage: 'id', template: '' });
    expect(normal.system).toContain('Markdown');
    expect(normal.system).toContain('untrusted');
    expect(normal.system).not.toContain('JSON'); // the agent-memory summary prompt asks for JSON
    expect(normal.system).toContain('Indonesian');
    expect(normal.system).toContain('Action items');
    expect(normal.prompt).toContain('Meeting: Weekly');
    expect(normal.prompt).toContain('[00:00] Rina: hi');

    const custom = buildNotesRequest({ ...base, notesLanguage: 'auto', meetingLanguage: 'en', template: 'Only list the decisions.' });
    expect(custom.system).toContain('Only list the decisions.');
    expect(custom.system).not.toContain('Action items');
    expect(custom.system).toContain('English');

    const follow = buildNotesRequest({ ...base, notesLanguage: 'auto', template: '' });
    expect(follow.system).toContain('language most of the transcript is in');
  });
});
