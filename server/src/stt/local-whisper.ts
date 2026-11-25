import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import type { SttLanguage } from '@atelier/contracts';
import type { SttProvider, SttSegment } from '../meetings/stt.js';

export class WhisperFatalCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperFatalCrashError';
  }
}

export interface LocalWhisperConfig {
  exePath: string | null;
  modelPath: string | null;
  threads: number;
  language: SttLanguage;
  useGpu: boolean;
}

export interface LocalWhisperOptions {
  getConfig: () => LocalWhisperConfig;
  idleTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Optional test hook to override the executable and arguments spawned. */
  buildSpawnSpec?: (cfg: LocalWhisperConfig, port: number) => { command: string; args: string[] };
  onFatalCrash?: (err: Error) => void;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else if (!port) reject(new Error('Failed to allocate a free port for Whisper server.'));
        else resolve(port);
      });
    });
  });
}

function configKey(cfg: LocalWhisperConfig, threads: number): string {
  return JSON.stringify([cfg.exePath, cfg.modelPath, threads, cfg.language, cfg.useGpu]);
}

/** Speed-only server flags: flash attention, no temperature fallback re-decodes, greedy decoding. */
const FAST_SERVER_ARGS = ['-fa', '-nf', '-bo', '1', '-bs', '1'];

export class LocalWhisperProvider implements SttProvider {
  private readonly idleTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private activeConfigKey: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private queue: Promise<unknown> = Promise.resolve();
  private consecutiveCrashes = 0;
  private background = false;
  /** Set when this whisper build rejected the speed flags: start plain from then on. */
  private fastArgsRejected = false;

  constructor(private readonly opts: LocalWhisperOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  }

  public isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  public getPort(): number | null {
    return this.isRunning() ? this.port : null;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public prepare(): Promise<void> {
    return this.enqueueOp(async () => {
      this.clearIdleTimer();
      await this.ensureStarted();
    });
  }

  public transcribe(
    wav: Buffer,
    opts: { language: 'auto' | 'id' | 'en'; prompt?: string; signal: AbortSignal },
  ): Promise<{ text: string; segments?: SttSegment[] }> {
    return this.enqueueOp(async () => {
      this.clearIdleTimer();
      this.inFlight = true;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (opts.signal.aborted) {
            throw new Error('Transcription aborted');
          }
          try {
            await this.ensureStarted();
            const result = await this.sendInference(wav, opts);
            this.consecutiveCrashes = 0;
            return result;
          } catch (err) {
            if (opts.signal.aborted) {
              throw err;
            }
            const isProcessDead = !this.isRunning() || this.isConnectionError(err);
            if (!isProcessDead) {
              throw err;
            }
            this.consecutiveCrashes += 1;
            await this.stopProcess();
            if (this.consecutiveCrashes >= 2 || attempt === 1) {
              const fatal = new WhisperFatalCrashError(
                err instanceof Error
                  ? `Whisper engine crashed repeatedly: ${err.message}`
                  : 'Whisper engine crashed repeatedly.',
              );
              this.opts.onFatalCrash?.(fatal);
              throw fatal;
            }
          }
        }
        throw new WhisperFatalCrashError('Whisper engine failed after restart.');
      } finally {
        this.inFlight = false;
      }
    });
  }

  public release(): Promise<void> {
    return this.enqueueOp(async () => {
      this.clearIdleTimer();
      if (!this.isRunning()) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.inFlight) {
          void this.stopProcess();
        }
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    });
  }

  public setBackground(background: boolean): void {
    this.background = background;
    this.applyPriority();
  }

  /**
   * Threads for the next start. While recording we stay at the configured (small) count so the
   * meeting app keeps its CPU; once recording is over use most cores so the backlog clears fast.
   */
  private effectiveThreads(cfg: LocalWhisperConfig): number {
    const configured = Math.max(1, cfg.threads);
    if (this.background) return configured;
    const cores = Math.max(1, os.cpus().length);
    return Math.min(8, Math.max(configured, cores - 2));
  }

  /**
   * Below normal while recording (the meeting app still wins, but we are not starved the way the
   * old Windows "Idle" class did, which made live transcripts fall minutes behind); normal after Stop.
   */
  private applyPriority(): void {
    const pid = this.child?.pid;
    if (!pid || !this.isRunning()) return;
    try {
      os.setPriority(
        pid,
        this.background ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL,
      );
    } catch {
      // Ignore if the OS refuses the priority change
    }
  }

  public async shutdown(): Promise<void> {
    this.clearIdleTimer();
    await this.stopProcess();
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`.toLowerCase();
    return (
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('exited') ||
      msg.includes('crashed')
    );
  }

  private async ensureStarted(): Promise<void> {
    const cfg = this.opts.getConfig();
    if (!cfg.exePath) {
      throw new Error('Whisper engine is not installed.');
    }
    if (!cfg.modelPath) {
      throw new Error('Selected Whisper model is not downloaded.');
    }
    const threads = this.effectiveThreads(cfg);
    const desiredKey = configKey(cfg, threads);
    if (this.isRunning() && this.activeConfigKey === desiredKey) {
      return;
    }
    if (this.isRunning()) {
      await this.stopProcess();
    }

    const port = await findFreePort();
    const spec = this.opts.buildSpawnSpec
      ? this.opts.buildSpawnSpec(cfg, port)
      : {
          command: cfg.exePath,
          args: [
            '-m',
            cfg.modelPath,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '-t',
            String(threads),
            '-l',
            cfg.language,
            ...(cfg.useGpu ? [] : ['--no-gpu']),
            ...(this.fastArgsRejected ? [] : FAST_SERVER_ARGS),
          ],
        };
    const usingFastArgs = !this.opts.buildSpawnSpec && !this.fastArgsRejected;

    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.port = port;
    this.activeConfigKey = desiredKey;

    this.applyPriority();

    let exitedEarly: string | null = null;
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (d) => {
      if (stderrChunks.length < 20) stderrChunks.push(String(d));
    });
    child.once('exit', (code, signal) => {
      exitedEarly = `Whisper server exited (code=${code}, signal=${signal})`;
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.activeConfigKey = null;
      }
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        const tail = stderrChunks.join('').trim();
        if (usingFastArgs && /unknown argument|usage:|invalid/i.test(tail)) {
          // An older/newer build does not know a speed flag: remember and start without them.
          this.fastArgsRejected = true;
          return this.ensureStarted();
        }
        throw new Error(tail ? `${exitedEarly}: ${tail.slice(-300)}` : exitedEarly);
      }
      try {
        let res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.status === 404) {
          res = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          });
        }
        if (res.ok) {
          return;
        }
      } catch {
        // Server still starting or loading model
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    await this.stopProcess();
    throw new Error(`Whisper server did not become ready within ${this.readyTimeoutMs}ms.`);
  }

  private async sendInference(
    wav: Buffer,
    opts: { language: 'auto' | 'id' | 'en'; prompt?: string; signal: AbortSignal },
  ): Promise<{ text: string; segments?: SttSegment[] }> {
    if (!this.isRunning() || !this.port) {
      throw new Error('Whisper server exited before inference.');
    }

    const child = this.child!;
    const port = this.port;
    const abortCtrl = new AbortController();

    const onCallerAbort = () => abortCtrl.abort(opts.signal.reason);
    const onChildExit = () => abortCtrl.abort(new Error('Whisper server exited during inference'));
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    child.once('exit', onChildExit);

    try {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav');
      // verbose_json adds the sentences with start/end seconds (whisper.cpp server).
      form.set('response_format', 'verbose_json');
      form.set('temperature', '0');
      // No temperature fallback: a hard chunk is accepted as is instead of being decoded up to 6 times.
      form.set('temperature_inc', '0');
      if (opts.language && opts.language !== 'auto') {
        form.set('language', opts.language);
      }
      if (opts.prompt?.trim()) {
        form.set('prompt', opts.prompt.trim());
      }

      const res = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Whisper inference failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        text?: string;
        segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
      };
      const segments: SttSegment[] = [];
      for (const seg of Array.isArray(data.segments) ? data.segments : []) {
        const text = typeof seg.text === 'string' ? seg.text.trim() : '';
        if (!text || typeof seg.start !== 'number' || typeof seg.end !== 'number') continue;
        segments.push({
          startMs: Math.max(0, Math.round(seg.start * 1000)),
          endMs: Math.max(0, Math.round(seg.end * 1000)),
          text,
        });
      }
      const text = typeof data.text === 'string' ? data.text.trim() : segments.map((s) => s.text).join(' ');
      return segments.length > 0 ? { text, segments } : { text };
    } finally {
      opts.signal.removeEventListener('abort', onCallerAbort);
      child.off('exit', onChildExit);
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = null;
    this.activeConfigKey = null;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      try {
        child.kill();
      } catch {
        done();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        done();
      }, 2000);
      killTimer.unref?.();
    });
  }
}
