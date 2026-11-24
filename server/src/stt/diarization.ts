import { spawn } from 'node:child_process';
import os from 'node:os';
import type { DiarizeTurn } from '../meetings/speakers.js';
import type { SpeakerEnginePaths } from './installer.js';

/**
 * Runs sherpa-onnx's offline speaker diarization program on one WAV (16 kHz mono) and reads who
 * spoke when. It prints, after a "Started" line, one turn per line:
 *
 *     0.132 -- 1.280 speaker_00
 */

export interface SpeakerDiarizer {
  /** The engine is installed and can run. */
  readonly available: boolean;
  diarize(
    wavPath: string,
    opts: { numSpeakers?: number | null; threads: number; signal: AbortSignal },
  ): Promise<DiarizeTurn[]>;
}

export class DiarizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiarizationError';
  }
}

/**
 * Without a known number of speakers the program decides by a distance threshold: larger means
 * fewer speakers. 0.9 told two voices apart in a test and did not invent extra ones.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.9;

export function parseDiarizationOutput(text: string): DiarizeTurn[] {
  const turns: DiarizeTurn[] = [];
  const line = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+speaker_(\d+)\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    turns.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), speaker: Number(m[3]) });
  }
  return turns;
}

export function buildDiarizationArgs(
  paths: SpeakerEnginePaths,
  wavPath: string,
  opts: { numSpeakers?: number | null; threads: number },
): string[] {
  const threads = String(Math.max(1, Math.min(os.cpus().length, Math.round(opts.threads))));
  return [
    ...(opts.numSpeakers && opts.numSpeakers > 0
      ? [`--clustering.num-clusters=${Math.round(opts.numSpeakers)}`]
      : [`--clustering.cluster-threshold=${DEFAULT_CLUSTER_THRESHOLD}`]),
    `--segmentation.pyannote-model=${paths.segmentationModel}`,
    `--embedding.model=${paths.embeddingModel}`,
    `--segmentation.num-threads=${threads}`,
    `--embedding.num-threads=${threads}`,
    wavPath,
  ];
}

export class SherpaDiarizer implements SpeakerDiarizer {
  constructor(
    private readonly deps: {
      getPaths: () => SpeakerEnginePaths | null;
      /** Test hook: run something else than the real program. */
      buildSpawnSpec?: (paths: SpeakerEnginePaths, args: string[]) => { command: string; args: string[] };
    },
  ) {}

  public get available(): boolean {
    return this.deps.getPaths() !== null;
  }

  public diarize(
    wavPath: string,
    opts: { numSpeakers?: number | null; threads: number; signal: AbortSignal },
  ): Promise<DiarizeTurn[]> {
    const paths = this.deps.getPaths();
    if (!paths) return Promise.reject(new DiarizationError('The speaker engine is not installed.'));
    const args = buildDiarizationArgs(paths, wavPath, opts);
    const spec = this.deps.buildSpawnSpec
      ? this.deps.buildSpawnSpec(paths, args)
      : { command: paths.exe, args };

    return new Promise<DiarizeTurn[]>((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(new DiarizationError('Cancelled.'));
        return;
      }
      const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) {
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // keep the default priority
        }
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        if (stderr.length < 4000) stderr += String(d);
      });
      const onAbort = () => {
        child.kill();
        reject(new DiarizationError('Cancelled.'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', (err) => {
        opts.signal.removeEventListener('abort', onAbort);
        reject(new DiarizationError(`Could not start the speaker engine: ${err.message}`));
      });
      child.once('close', (code) => {
        opts.signal.removeEventListener('abort', onAbort);
        if (opts.signal.aborted) return;
        if (code !== 0) {
          const tail = stderr.trim().slice(-300) || stdout.trim().slice(-300);
          reject(new DiarizationError(`The speaker engine stopped with code ${code}${tail ? `: ${tail}` : ''}`));
          return;
        }
        resolve(parseDiarizationOutput(stdout));
      });
    });
  }
}
