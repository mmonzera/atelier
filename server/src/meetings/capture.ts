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
 *   stdin   audio-chunk {"meetingId":"…","path":"…","seconds":19.4,"startSec":41.2,"energyPath":"…"}
 *   stdout  ATELIER_AUDIO {"action":"list-devices","requestId":"…"}      ask for the audio devices
 *   stdin   audio-devices {"requestId":"…","inputs":[{name,isDefault}],"outputs":[…]}
 *   stdout  ATELIER_AUDIO {"action":"meter","enabled":true,"micDevice":…,"speakerDevice":…}   level meter
 *   stdin   audio-meter {"mic":0.02,"speaker":0.11,"micError":null,…}   ~8× a second while it runs
 *   stdin   audio-stopped {"meetingId":"…"}
 *   stdin   audio-error {"meetingId":"…","message":"…","fatal":true}
 *   stdin   meeting-app {"state":"started"|"ended","appId":"zoom","appName":"Zoom"}
 *   stdin   meeting-toggle                                               tray "Catat meeting"
 */

import type { AudioDevicesInfo } from '@atelier/contracts';

/** What the shell says about a finished chunk: where it sits on the recording timeline and its energy file. */
export interface ChunkInfo {
  startSec: number | null;
  energyPath: string | null;
}

export interface MeterReading {
  mic: number;
  speaker: number;
  micError?: string | null;
  speakerError?: string | null;
  micName?: string | null;
  speakerName?: string | null;
}

export interface MeetingAudioCaptureHandlers {
  onChunk: (meetingId: string, filePath: string, info: ChunkInfo) => void;
  onError: (meetingId: string, message: string, fatal: boolean, code?: string | null) => void;
  onLevel?: (meetingId: string, levels: number[]) => void;
  onMeter?: (reading: MeterReading) => void;
}

export interface CaptureDevices {
  micDevice?: string | null;
  speakerDevice?: string | null;
}

export interface MeetingAudioCapture {
  /** False when no desktop shell is attached (dev server, tests): audio must come over HTTP. */
  readonly available: boolean;
  setHandlers(handlers: MeetingAudioCaptureHandlers): void;
  start(meetingId: string, dir: string, devices?: CaptureDevices): Promise<void>;
  stop(meetingId: string): Promise<void>;
  /** Keep the devices open but drop the audio until resumed. */
  setPaused(meetingId: string, paused: boolean): void;
  /** Input and output devices the shell can record. */
  listDevices(): Promise<AudioDevicesInfo>;
  /** Turn the Settings level meter on (for the given devices) or off. */
  setMeter(enabled: boolean, devices?: CaptureDevices): void;
}

type Waiter = { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class ShellAudioCapture implements MeetingAudioCapture {
  public readonly available = true;
  private handlers: MeetingAudioCaptureHandlers | null = null;
  private readonly startWaiters = new Map<string, Waiter>();
  private readonly stopWaiters = new Map<string, Waiter>();
  private readonly deviceWaiters = new Map<string, (info: AudioDevicesInfo) => void>();
  private requestCounter = 0;

  constructor(
    private readonly emit: (tag: string, payload: unknown) => void,
    private readonly opts: { startTimeoutMs?: number; stopTimeoutMs?: number } = {},
  ) {}

  public setHandlers(handlers: MeetingAudioCaptureHandlers): void {
    this.handlers = handlers;
  }

  public start(meetingId: string, dir: string, devices?: CaptureDevices): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.settle(this.startWaiters, meetingId, new Error('Superseded by a new start request.'));
      const timer = setTimeout(() => {
        this.startWaiters.delete(meetingId);
        reject(new Error('The desktop app did not start audio capture in time.'));
      }, this.opts.startTimeoutMs ?? 8_000);
      timer.unref?.();
      this.startWaiters.set(meetingId, { resolve, reject, timer });
      this.emit('ATELIER_AUDIO', {
        action: 'start',
        meetingId,
        dir,
        micDevice: devices?.micDevice ?? null,
        speakerDevice: devices?.speakerDevice ?? null,
      });
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

  public listDevices(): Promise<AudioDevicesInfo> {
    return new Promise<AudioDevicesInfo>((resolve, reject) => {
      const requestId = `dev_${++this.requestCounter}`;
      const timer = setTimeout(() => {
        this.deviceWaiters.delete(requestId);
        reject(new Error('The desktop app did not answer the device list in time.'));
      }, this.opts.startTimeoutMs ?? 8_000);
      timer.unref?.();
      this.deviceWaiters.set(requestId, (info) => {
        clearTimeout(timer);
        resolve(info);
      });
      this.emit('ATELIER_AUDIO', { action: 'list-devices', requestId });
    });
  }

  public setMeter(enabled: boolean, devices?: CaptureDevices): void {
    this.emit('ATELIER_AUDIO', {
      action: 'meter',
      enabled,
      micDevice: devices?.micDevice ?? null,
      speakerDevice: devices?.speakerDevice ?? null,
    });
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
        const startSec =
          typeof payload.startSec === 'number' && Number.isFinite(payload.startSec) ? payload.startSec : null;
        const energyPath = typeof payload.energyPath === 'string' ? payload.energyPath : null;
        if (meetingId && filePath) this.handlers?.onChunk(meetingId, filePath, { startSec, energyPath });
        return true;
      }
      case 'audio-devices': {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const list = (v: unknown) =>
          Array.isArray(v)
            ? v
                .filter(
                  (d): d is { name: string; isDefault?: boolean } =>
                    Boolean(d) && typeof (d as { name?: unknown }).name === 'string',
                )
                .map((d) => ({ name: d.name, isDefault: Boolean(d.isDefault) }))
            : [];
        const waiter = this.deviceWaiters.get(requestId);
        this.deviceWaiters.delete(requestId);
        waiter?.({ inputs: list(payload.inputs), outputs: list(payload.outputs) });
        return true;
      }
      case 'audio-meter': {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        this.handlers?.onMeter?.({
          mic: num(payload.mic),
          speaker: num(payload.speaker),
          micError: str(payload.micError),
          speakerError: str(payload.speakerError),
          micName: str(payload.micName),
          speakerName: str(payload.speakerName),
        });
        return true;
      }
      case 'audio-stopped':
        this.settle(this.stopWaiters, meetingId);
        return true;
      case 'audio-error': {
        const message = typeof payload.message === 'string' ? payload.message : 'Audio capture failed.';
        const fatal = payload.fatal !== false;
        const code = typeof payload.code === 'string' ? payload.code : null;
        if (this.startWaiters.has(meetingId)) {
          this.settle(this.startWaiters, meetingId, new Error(message));
        } else {
          this.handlers?.onError(meetingId, message, fatal, code);
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
