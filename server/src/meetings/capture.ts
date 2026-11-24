/**
 * Audio capture lives in the desktop shell (Rust): it records the microphone and the system
 * output (loopback), cuts the stream at pauses into ~20 s WAV files and tells the server about
 * each file. This module is the server's side of that line-based protocol.
 *
 *   stdout  ATELIER_AUDIO {"action":"start","meetingId":"…","dir":"…"}   start recording into dir
 *   stdout  ATELIER_AUDIO {"action":"stop","meetingId":"…"}              flush the last chunk, stop
 *   stdout  ATELIER_AUDIO {"action":"pause"|"resume","meetingId":"…"}   drop audio until resumed
 *   stdin   audio-level {"meetingId":"…","levels":[0.02,0.11]}          loudness per 100 ms (UI waveform)
 *   stdout  ATELIER_DETECT {"enabled":true}                              watch for meeting apps
 *   stdin   audio-started {"meetingId":"…"}
 *   stdin   audio-chunk {"meetingId":"…","path":"…","seconds":19.4}
 *   stdin   audio-stopped {"meetingId":"…"}
 *   stdin   audio-error {"meetingId":"…","message":"…","fatal":true}
 *   stdin   meeting-app {"state":"started"|"ended","appId":"zoom","appName":"Zoom"}
 *   stdin   meeting-toggle                                               tray "Catat meeting"
 */

export interface MeetingAudioCaptureHandlers {
  onChunk: (meetingId: string, filePath: string) => void;
  onError: (meetingId: string, message: string, fatal: boolean) => void;
  onLevel?: (meetingId: string, levels: number[]) => void;
}

export interface MeetingAudioCapture {
  /** False when no desktop shell is attached (dev server, tests): audio must come over HTTP. */
  readonly available: boolean;
  setHandlers(handlers: MeetingAudioCaptureHandlers): void;
  start(meetingId: string, dir: string): Promise<void>;
  stop(meetingId: string): Promise<void>;
  /** Keep the devices open but drop the audio until resumed. */
  setPaused(meetingId: string, paused: boolean): void;
}

type Waiter = { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class ShellAudioCapture implements MeetingAudioCapture {
  public readonly available = true;
  private handlers: MeetingAudioCaptureHandlers | null = null;
  private readonly startWaiters = new Map<string, Waiter>();
  private readonly stopWaiters = new Map<string, Waiter>();

  constructor(
    private readonly emit: (tag: string, payload: unknown) => void,
    private readonly opts: { startTimeoutMs?: number; stopTimeoutMs?: number } = {},
  ) {}

  public setHandlers(handlers: MeetingAudioCaptureHandlers): void {
    this.handlers = handlers;
  }

  public start(meetingId: string, dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.settle(this.startWaiters, meetingId, new Error('Superseded by a new start request.'));
      const timer = setTimeout(() => {
        this.startWaiters.delete(meetingId);
        reject(new Error('The desktop app did not start audio capture in time.'));
      }, this.opts.startTimeoutMs ?? 8_000);
      timer.unref?.();
      this.startWaiters.set(meetingId, { resolve, reject, timer });
      this.emit('ATELIER_AUDIO', { action: 'start', meetingId, dir });
    });
  }

  public stop(meetingId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.settle(this.stopWaiters, meetingId);
      // The shell flushes the last partial chunk before it answers; never block stopping forever.
      const timer = setTimeout(() => {
        this.stopWaiters.delete(meetingId);
        resolve();
      }, this.opts.stopTimeoutMs ?? 8_000);
      timer.unref?.();
      this.stopWaiters.set(meetingId, { resolve, reject: () => resolve(), timer });
      this.emit('ATELIER_AUDIO', { action: 'stop', meetingId });
    });
  }

  public setPaused(meetingId: string, paused: boolean): void {
    this.emit('ATELIER_AUDIO', { action: paused ? 'pause' : 'resume', meetingId });
  }

  /** Feed one stdin line from the shell. Returns true when the line belonged to audio capture. */
  public handleLine(command: string, payload: Record<string, unknown>): boolean {
    const meetingId = typeof payload.meetingId === 'string' ? payload.meetingId : '';
    switch (command) {
      case 'audio-level': {
        const levels = Array.isArray(payload.levels)
          ? payload.levels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(0, 20)
          : [];
        if (meetingId && levels.length) this.handlers?.onLevel?.(meetingId, levels);
        return true;
      }
      case 'audio-started':
        this.settle(this.startWaiters, meetingId);
        return true;
      case 'audio-chunk': {
        const filePath = typeof payload.path === 'string' ? payload.path : '';
        if (meetingId && filePath) this.handlers?.onChunk(meetingId, filePath);
        return true;
      }
      case 'audio-stopped':
        this.settle(this.stopWaiters, meetingId);
        return true;
      case 'audio-error': {
        const message = typeof payload.message === 'string' ? payload.message : 'Audio capture failed.';
        const fatal = payload.fatal !== false;
        if (this.startWaiters.has(meetingId)) {
          this.settle(this.startWaiters, meetingId, new Error(message));
        } else {
          this.handlers?.onError(meetingId, message, fatal);
        }
        if (fatal) this.settle(this.stopWaiters, meetingId);
        return true;
      }
      default:
        return false;
    }
  }

  private settle(waiters: Map<string, Waiter>, meetingId: string, err?: Error): void {
    const waiter = waiters.get(meetingId);
    if (!waiter) return;
    waiters.delete(meetingId);
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve();
  }
}

/** Parses `command {json}` lines from the shell. */
export function parseShellLine(line: string): { command: string; payload: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const space = trimmed.indexOf(' ');
  const command = space === -1 ? trimmed : trimmed.slice(0, space);
  if (space === -1) return { command, payload: {} };
  try {
    const parsed = JSON.parse(trimmed.slice(space + 1)) as unknown;
    return {
      command,
      payload: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
    };
  } catch {
    return { command, payload: {} };
  }
}
