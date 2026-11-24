import fs from 'node:fs';

/**
 * Helpers for telling speakers apart. Pure functions (no database), so they can be tested alone:
 * - which side a sentence is on ("me" = the microphone, "others" = the laptop sound),
 * - matching diarization turns to sentences,
 * - building the one WAV the diarizer reads, and a short sample of a voice to play back.
 */

export type Side = 'me' | 'others';

/** Loudness per 100 ms of the microphone and of the laptop sound, as written by the desktop shell. */
export interface EnergyTrack {
  /** Absolute index (on the recording timeline, 100 ms per frame) of the first value. */
  firstFrame: number;
  mic: number[];
  speaker: number[];
}

export const ENERGY_FRAME_MS = 100;

export function parseEnergyFile(raw: string): EnergyTrack | null {
  try {
    const data = JSON.parse(raw) as Partial<{ firstFrame: number; startSec: number; mic: number[]; speaker: number[] }>;
    const nums = (v: unknown): number[] | null =>
      Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null;
    const mic = nums(data.mic);
    const speaker = nums(data.speaker);
    if (!mic || !speaker || mic.length === 0) return null;
    const firstFrame =
      typeof data.firstFrame === 'number' && Number.isFinite(data.firstFrame)
        ? Math.max(0, Math.floor(data.firstFrame))
        : Math.max(0, Math.floor(((data.startSec ?? 0) * 1000) / ENERGY_FRAME_MS));
    return { firstFrame, mic, speaker };
  } catch {
    return null;
  }
}

/**
 * Mic loud and the laptop sound quiet → me. The laptop sound clearly louder than the mic → others
 * (a speaker without headset leaks into the mic, but at a fraction of the original level).
 * Thresholds are RMS of 16-bit audio scaled to ±1; provisional, refined from real recordings.
 */
export function classifySide(mic: number, speaker: number): Side {
  const MIC_FLOOR = 0.006; // below this the microphone is only noise
  const SPEAKER_QUIET = 0.003;
  const MIC_DOMINANCE = 1.8;
  if (mic < MIC_FLOOR) return 'others';
  if (speaker < SPEAKER_QUIET) return 'me';
  return mic >= speaker * MIC_DOMINANCE ? 'me' : 'others';
}

/** Side of the sentence between `startMs` and `endMs` (absolute timeline), or null without energy data. */
export function sideForRange(track: EnergyTrack | null, startMs: number, endMs: number): Side | null {
  if (!track) return null;
  const from = Math.max(0, Math.floor(startMs / ENERGY_FRAME_MS) - track.firstFrame);
  const to = Math.min(track.mic.length, Math.max(from + 1, Math.ceil(endMs / ENERGY_FRAME_MS) - track.firstFrame));
  if (from >= track.mic.length) return null;
  let mic = 0;
  let speaker = 0;
  let n = 0;
  for (let i = from; i < to; i += 1) {
    mic += track.mic[i] ?? 0;
    speaker += track.speaker[i] ?? 0;
    n += 1;
  }
  if (n === 0) return null;
  return classifySide(mic / n, speaker / n);
}

// ------------------------------------------------------------------------------- diarization

export interface DiarizeTurn {
  startMs: number;
  endMs: number;
  /** Cluster number from the diarizer (0-based), not yet a speaker id. */
  speaker: number;
}

export interface SentenceRef {
  key: string;
  startMs: number;
  endMs: number;
  side: Side | null;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export interface SpeakerAssignment {
  /** sentence key → speaker id ("me", "spk_1", …, or "others" when the diarizer heard nobody) */
  bySentence: Map<string, string>;
  /** Speaker ids of the other participants, in order of first appearance: spk_1, spk_2, … */
  otherIds: string[];
  /** The diarizer's cluster that is the user (or null). */
  meCluster: number | null;
}

/**
 * Gives every sentence a speaker. The energy side wins for "me" (the microphone is the most
 * reliable witness of the user's own voice); the diarizer then separates the others.
 */
export function assignSpeakers(sentences: SentenceRef[], turns: DiarizeTurn[]): SpeakerAssignment {
  const clusters = [...new Set(turns.map((t) => t.speaker))];

  // How much of each cluster's speech falls on sentences the microphone claims as "me".
  const meOverlap = new Map<number, number>();
  const totalOverlap = new Map<number, number>();
  for (const s of sentences) {
    for (const t of turns) {
      const ov = overlapMs(s.startMs, s.endMs, t.startMs, t.endMs);
      if (ov <= 0) continue;
      totalOverlap.set(t.speaker, (totalOverlap.get(t.speaker) ?? 0) + ov);
      if (s.side === 'me') meOverlap.set(t.speaker, (meOverlap.get(t.speaker) ?? 0) + ov);
    }
  }
  let meCluster: number | null = null;
  let bestShare = 0.5; // a cluster is "me" when most of its speech is on microphone sentences
  for (const c of clusters) {
    const share = (meOverlap.get(c) ?? 0) / Math.max(1, totalOverlap.get(c) ?? 0);
    if (share > bestShare) {
      bestShare = share;
      meCluster = c;
    }
  }

  const bySentence = new Map<string, string>();
  const otherOrder: number[] = [];
  const idForCluster = (cluster: number): string => {
    let idx = otherOrder.indexOf(cluster);
    if (idx === -1) {
      otherOrder.push(cluster);
      idx = otherOrder.length - 1;
    }
    return `spk_${idx + 1}`;
  };

  for (const s of [...sentences].sort((a, b) => a.startMs - b.startMs)) {
    if (s.side === 'me') {
      bySentence.set(s.key, 'me');
      continue;
    }
    // Cluster with the most speech inside this sentence (the user's own cluster only when the
    // microphone gave no verdict).
    const votes = new Map<number, number>();
    for (const t of turns) {
      if (s.side === 'others' && t.speaker === meCluster) continue;
      const ov = overlapMs(s.startMs, s.endMs, t.startMs, t.endMs);
      if (ov > 0) votes.set(t.speaker, (votes.get(t.speaker) ?? 0) + ov);
    }
    let best: number | null = null;
    let bestOv = 0;
    for (const [cluster, ov] of votes) {
      if (ov > bestOv) {
        best = cluster;
        bestOv = ov;
      }
    }
    if (best === null) bySentence.set(s.key, 'others');
    else if (best === meCluster) bySentence.set(s.key, 'me');
    else bySentence.set(s.key, idForCluster(best));
  }

  return { bySentence, otherIds: otherOrder.map((_, i) => `spk_${i + 1}`), meCluster };
}

// ------------------------------------------------------------------------------- WAV helpers

/** 16 kHz, 16-bit, mono: 32 bytes of audio per millisecond. */
export const WAV_BYTES_PER_MS = 32;
const WAV_HEADER_BYTES = 44;

export function wavDurationMs(wav: Buffer): number {
  return Math.max(0, Math.round((wav.length - WAV_HEADER_BYTES) / WAV_BYTES_PER_MS));
}

export function buildWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface TimelineChunk {
  path: string;
  startMs: number;
}

/**
 * One WAV with every chunk at its place on the recording timeline (gaps are silence), which is
 * what the diarizer reads. Written in pieces, so an hour of audio does not sit in memory.
 */
export function mergeChunksToWav(chunks: TimelineChunk[], outPath: string): { durationMs: number } {
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, Buffer.alloc(WAV_HEADER_BYTES));
    let written = 0; // PCM bytes so far
    const zeros = Buffer.alloc(64 * 1024);
    for (const chunk of [...chunks].sort((a, b) => a.startMs - b.startMs)) {
      let wav: Buffer;
      try {
        wav = fs.readFileSync(chunk.path);
      } catch {
        continue; // audio already gone
      }
      const pcm = wav.subarray(WAV_HEADER_BYTES);
      const offset = Math.max(0, Math.round(chunk.startMs * WAV_BYTES_PER_MS)) & ~1; // keep samples aligned
      let gap = offset - written;
      while (gap > 0) {
        const n = Math.min(gap, zeros.length);
        fs.writeSync(fd, zeros, 0, n);
        written += n;
        gap -= n;
      }
      // Overlap with the previous chunk (should not happen): skip what is already written.
      const skip = Math.max(0, written - offset);
      if (skip < pcm.length) {
        fs.writeSync(fd, pcm, skip, pcm.length - skip);
        written += pcm.length - skip;
      }
    }
    const header = buildWav(Buffer.alloc(0));
    header.writeUInt32LE(36 + written, 4);
    header.writeUInt32LE(written, 40);
    fs.writeSync(fd, header, 0, WAV_HEADER_BYTES, 0);
    return { durationMs: Math.round(written / WAV_BYTES_PER_MS) };
  } finally {
    fs.closeSync(fd);
  }
}

/** PCM of `[fromMs, toMs)` inside a chunk WAV that starts at `chunkStartMs` on the timeline. */
export function sliceChunkPcm(wav: Buffer, chunkStartMs: number, fromMs: number, toMs: number): Buffer {
  const startByte = WAV_HEADER_BYTES + (Math.max(0, fromMs - chunkStartMs) * WAV_BYTES_PER_MS & ~1);
  const endByte = Math.min(wav.length, WAV_HEADER_BYTES + (Math.max(0, toMs - chunkStartMs) * WAV_BYTES_PER_MS & ~1));
  return startByte < endByte ? wav.subarray(startByte, endByte) : Buffer.alloc(0);
}
