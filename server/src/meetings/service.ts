import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AgentColor,
  type AudioDevicesInfo,
  DEFAULT_MEETING_SETTINGS,
  type MeetingAppEvent,
  type MeetingMode,
  type MeetingSession,
  type MeetingSpeaker,
  type MeetingStatus,
  type MeetingStatusEvent,
  type MeetingTranscriptSegment,
  type ModelProvider,
  type SttLanguage,
} from '@atelier/contracts';
import type { EventBus } from '../bus.js';
import type { AppConfig } from '../config.js';
import type { AtelierDb } from '../db.js';
import type { AtelierStore } from '../store.js';
import { getSmallerInstalledModel } from '../stt/catalog.js';
import type { SttInstaller } from '../stt/installer.js';
import type { SpeakerDiarizer } from '../stt/diarization.js';
import { WhisperFatalCrashError } from '../stt/local-whisper.js';
import type { ChunkInfo, MeetingAudioCapture } from './capture.js';
import { buildNotesRequest, transcriptForNotes } from './notes.js';
import {
  type EnergyTrack,
  assignSpeakers,
  buildWav,
  mergeChunksToWav,
  parseEnergyFile,
  sideForRange,
  sliceChunkPcm,
  wavDurationMs,
} from './speakers.js';
import type { SttProvider, SttSegment } from './stt.js';

/** 16 kHz, 16-bit mono PCM: bytes per second of audio in a chunk WAV. */
const WAV_BYTES_PER_SEC = 16_000 * 2;
const NOMINAL_CHUNK_SEC = 20;

export class MeetingServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

interface StoredMeetingRecord {
  id: string;
  title: string;
  mode: MeetingMode;
  language: SttLanguage;
  modelId: string;
  status: MeetingStatus;
  keepAudio: boolean;
  prompt?: string;
  summary: string | null;
  error: string | null;
  warning?: string | null;
  createdAt: string;
  updatedAt: string;
  pausedMs?: number;
  pausedSince?: string | null;
  warningCode?: string | null;
  /** The speaker engine is installed: keep every chunk's audio until the speakers are named. */
  keepForSpeakers?: boolean;
  /** Voices were found and the user has not finished naming them. */
  speakersPending?: boolean;
  /** Number of participants the user told us (for a repeat run of the speaker engine). */
  participants?: number | null;
}

interface ChunkRow {
  meeting_id: string;
  seq: number;
  status: string;
  text: string | null;
  audio_path: string | null;
  created_at: string;
  updated_at: string;
  start_ms: number | null;
  energy_path: string | null;
}

/** Where a chunk sits on the recording timeline and where its loudness file is. */
interface ChunkMeta {
  startMs?: number | null;
  energyPath?: string | null;
}

interface SegmentRow {
  meeting_id: string;
  seq: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  side: string | null;
  speaker_id: string | null;
}

interface SpeakerRow {
  meeting_id: string;
  id: string;
  label: string;
  name: string | null;
  color: string;
  is_me: number;
  sort: number;
}

/** Colour per speaker: the user is blue, the others take the next free colour. */
const ME_COLOR: AgentColor = 'blue';
const OTHER_COLORS: AgentColor[] = ['orange', 'green', 'magenta', 'teal', 'amber', 'purple', 'cyan', 'pink'];

export interface NotesRequest {
  system: string;
  prompt: string;
  provider: ModelProvider | null;
  model: string | null;
}

export type SummarizeMeetingFn = (req: NotesRequest, signal: AbortSignal) => Promise<string | null>;

/** Audio kept only for naming speakers is deleted after this long if the user never does it. */
const SPEAKER_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

export class MeetingService {
  private readonly meetingsDir: string;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly stoppingMeetings = new Set<string>();
  private readonly activeAborts = new Map<string, AbortController>();
  /** Meetings whose Stop is in progress (protects against double clicks). */
  private readonly finishing = new Set<string>();

  constructor(
    private readonly deps: {
      db: AtelierDb;
      config: AppConfig;
      store: AtelierStore;
      bus: EventBus;
      sttProvider: SttProvider;
      installer: SttInstaller;
      summarize?: SummarizeMeetingFn;
      /** Tells the other participants apart after the meeting (optional engine). */
      diarizer?: SpeakerDiarizer;
      /** Desktop-shell audio capture; absent in tests and plain dev servers (audio comes over HTTP). */
      capture?: MeetingAudioCapture;
      /** Native notification (desktop shell only), shown when the window is not focused. */
      notify?: (title: string, body: string) => void;
    },
  ) {
    this.meetingsDir = path.join(deps.config.dataDir, 'meetings');
    deps.capture?.setHandlers({
      onChunk: (meetingId, filePath, info) => this.enqueueChunkFile(meetingId, filePath, info),
      onError: (meetingId, message, fatal, code) => this.handleCaptureError(meetingId, message, fatal, code),
      onMeter: (reading) => this.deps.bus.broadcast({ type: 'meeting-meter', payload: reading }),
      // Not stored: only drives the live waveform while recording.
      onLevel: (meetingId, levels) =>
        this.deps.bus.broadcast({ type: 'meeting-level', payload: { meetingId, levels } }),
    });
    this.recoverInterruptedMeetings();
  }

  public get captureAvailable(): boolean {
    return Boolean(this.deps.capture?.available);
  }

  /** Input and output devices of the desktop shell (for the pickers in Settings). */
  public async listAudioDevices(): Promise<AudioDevicesInfo> {
    if (!this.deps.capture?.available) {
      throw new MeetingServiceError('capture_unavailable', 'Recording needs the Atelier desktop app.', 400);
    }
    return this.deps.capture.listDevices();
  }

  private meterTimer: NodeJS.Timeout | null = null;

  /**
   * Settings level meter: opens the chosen devices without recording and streams their loudness.
   * Turns itself off after 90 s unless refreshed, so a forgotten settings page never holds the mic.
   */
  public setAudioMeter(
    enabled: boolean,
    devices?: { micDevice?: string | null; speakerDevice?: string | null },
  ): void {
    const capture = this.deps.capture;
    if (!capture?.available) {
      throw new MeetingServiceError('capture_unavailable', 'Recording needs the Atelier desktop app.', 400);
    }
    if (this.meterTimer) clearTimeout(this.meterTimer);
    this.meterTimer = null;
    if (!enabled || this.getActiveMeetingStatus()?.meeting.status === 'recording') {
      capture.setMeter(false);
      return;
    }
    const settings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    capture.setMeter(true, {
      micDevice: devices?.micDevice !== undefined ? devices.micDevice : settings.micDevice,
      speakerDevice: devices?.speakerDevice !== undefined ? devices.speakerDevice : settings.speakerDevice,
    });
    this.meterTimer = setTimeout(() => capture.setMeter(false), 90_000);
    this.meterTimer.unref?.();
  }

  private getIncomingDir(meetingId: string): string {
    return path.join(this.meetingsDir, meetingId, 'incoming');
  }

  private recoverInterruptedMeetings(): void {
    const rows = this.deps.db.sqlite
      .prepare(`SELECT id, data FROM meetings`)
      .all() as Array<{ id: string; data: string }>;
    const now = new Date().toISOString();
    for (const row of rows) {
      try {
        const rec = JSON.parse(row.data) as StoredMeetingRecord;
        if (
          rec.status === 'recording' ||
          rec.status === 'transcribing' ||
          rec.status === 'identifying' ||
          rec.status === 'summarizing'
        ) {
          const updated: StoredMeetingRecord = {
            ...rec,
            status: 'pending',
            updatedAt: now,
          };
          this.deps.db.sqlite
            .prepare(`UPDATE meetings SET data = ? WHERE id = ?`)
            .run(JSON.stringify(updated), row.id);
        }
        // Chunk files the shell wrote but the server never registered (app closed mid-meeting).
        if (rec.status !== 'completed') this.adoptIncomingFiles(row.id);
        // Audio kept for naming speakers does not stay forever.
        if (rec.speakersPending && Date.now() - Date.parse(rec.updatedAt) > SPEAKER_AUDIO_TTL_MS) {
          this.releaseSpeakerAudio(rec.id);
        }
      } catch {
        // ignore malformed row
      }
    }
  }

  private adoptIncomingFiles(meetingId: string): void {
    const dir = this.getIncomingDir(meetingId);
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .sort();
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const energyFile = full.replace(/\.wav$/i, '.energy.json');
        const energyPath = fs.existsSync(energyFile) ? energyFile : null;
        let startMs: number | null = null;
        if (energyPath) {
          const track = parseEnergyFile(fs.readFileSync(energyPath, 'utf8'));
          if (track) startMs = track.firstFrame * 100;
        }
        this.insertChunk(meetingId, fs.readFileSync(full), { startMs, energyPath });
        fs.rmSync(full, { force: true });
      } catch {
        // leave it for the next start
      }
    }
  }

  private getPendingDir(meetingId: string): string {
    return path.join(this.meetingsDir, meetingId, 'pending');
  }

  private readRecord(meetingId: string): StoredMeetingRecord | null {
    const row = this.deps.db.sqlite
      .prepare(`SELECT data FROM meetings WHERE id = ?`)
      .get(meetingId) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as StoredMeetingRecord;
  }

  private saveRecord(rec: StoredMeetingRecord): void {
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO meetings (id, created_at, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(rec.id, rec.createdAt, JSON.stringify(rec));
  }

  private readChunks(meetingId: string): ChunkRow[] {
    return this.deps.db.sqlite
      .prepare(`SELECT * FROM meeting_chunks WHERE meeting_id = ? ORDER BY seq ASC`)
      .all(meetingId) as unknown as ChunkRow[];
  }

  private readSegments(meetingId: string): SegmentRow[] {
    return this.deps.db.sqlite
      .prepare(`SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms ASC, seq ASC, idx ASC`)
      .all(meetingId) as unknown as SegmentRow[];
  }

  private readSpeakers(meetingId: string): SpeakerRow[] {
    return this.deps.db.sqlite
      .prepare(`SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY is_me DESC, sort ASC`)
      .all(meetingId) as unknown as SpeakerRow[];
  }

  private audioKept(rec: StoredMeetingRecord): boolean {
    return rec.keepAudio || Boolean(rec.speakersPending);
  }

  /**
   * The transcript in order: the sentences of each transcribed chunk (with time and speaker), or
   * the chunk's plain text when it has no sentences (meetings from before timestamps existed).
   */
  private buildTranscript(completed: ChunkRow[], segments: SegmentRow[]): MeetingTranscriptSegment[] {
    const bySeq = new Map<number, SegmentRow[]>();
    for (const seg of segments) {
      const list = bySeq.get(seg.seq);
      if (list) list.push(seg);
      else bySeq.set(seg.seq, [seg]);
    }
    const out: MeetingTranscriptSegment[] = [];
    for (const chunk of completed) {
      const sentences = bySeq.get(chunk.seq);
      if (sentences?.length) {
        for (const seg of sentences) {
          out.push({
            seq: seg.seq,
            idx: seg.idx,
            text: seg.text,
            createdAt: chunk.updated_at,
            startMs: seg.start_ms,
            endMs: seg.end_ms,
            speakerId: seg.speaker_id,
          });
        }
      } else {
        out.push({
          seq: chunk.seq,
          idx: 0,
          text: chunk.text ?? '',
          createdAt: chunk.updated_at,
          startMs: chunk.start_ms,
          endMs: null,
          speakerId: null,
        });
      }
    }
    return out;
  }

  private buildSpeakers(rec: StoredMeetingRecord, segments: SegmentRow[]): MeetingSpeaker[] {
    const counts = new Map<string, number>();
    for (const s of segments) if (s.speaker_id) counts.set(s.speaker_id, (counts.get(s.speaker_id) ?? 0) + 1);
    const kept = this.audioKept(rec);
    return this.readSpeakers(rec.id)
      .filter((sp) => (counts.get(sp.id) ?? 0) > 0)
      .map((sp) => ({
        id: sp.id,
        label: sp.label,
        name: sp.name,
        color: sp.color as AgentColor,
        isMe: sp.is_me === 1,
        segmentCount: counts.get(sp.id) ?? 0,
        hasSample: kept,
      }));
  }

  private buildStatusEvent(rec: StoredMeetingRecord): MeetingStatusEvent {
    const chunks = this.readChunks(rec.id);
    const completed = chunks.filter((c) => c.status === 'done');
    const pending = chunks.filter((c) => c.status !== 'done');
    const totalChunks = chunks.length;
    const completedChunks = completed.length;
    const pendingChunks = pending.length;

    // Chunks are cut at pauses (~15–25 s), so measure the queued audio instead of assuming 20 s.
    // The chunk currently being transcribed is not "behind" yet.
    const lagSeconds =
      rec.mode === 'live' && rec.status === 'recording' && pendingChunks > 1
        ? Math.round(pending.slice(1).reduce((sum, c) => sum + this.chunkSeconds(c), 0))
        : 0;
    const isLagging = rec.mode === 'live' && rec.status === 'recording' && pendingChunks > 3;

    const smallerModelId = isLagging
      ? getSmallerInstalledModel(rec.modelId, this.deps.installer.getInstalledModelIds())
      : null;

    let warning = rec.warning ?? null;
    if (isLagging && !warning) {
      const mins = Math.max(1, Math.round(lagSeconds / 60));
      warning = `Transcript lagging behind by ~${mins} min`;
    }

    const transcribeProgress =
      totalChunks > 0
        ? Math.round((completedChunks / totalChunks) * 100)
        : rec.status === 'completed'
          ? 100
          : 0;

    const segments = this.readSegments(rec.id);
    const transcript = this.buildTranscript(completed, segments);
    const speakers = this.buildSpeakers(rec, segments);

    const session: MeetingSession = {
      id: rec.id,
      title: rec.title,
      mode: rec.mode,
      language: rec.language,
      modelId: rec.modelId,
      status: rec.status,
      keepAudio: rec.keepAudio,
      pendingChunks,
      completedChunks,
      totalChunks,
      lagSeconds,
      transcribeProgress,
      transcript,
      summary: rec.summary,
      error: rec.error,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      paused: Boolean(rec.pausedSince),
      pausedMs: rec.pausedMs ?? 0,
      pausedSince: rec.pausedSince ?? null,
      speakers,
      speakersPending: Boolean(rec.speakersPending),
      audioKept: this.audioKept(rec),
    };

    return {
      meeting: session,
      canSwitchSmallerModel: Boolean(isLagging && smallerModelId),
      smallerModelId,
      warning,
      warningCode: rec.warning ? (rec.warningCode ?? null) : null,
    };
  }

  private chunkSeconds(chunk: ChunkRow): number {
    try {
      if (chunk.audio_path) {
        const size = fs.statSync(chunk.audio_path).size;
        if (size > 44) return (size - 44) / WAV_BYTES_PER_SEC;
      }
    } catch {
      // file gone: fall back to the nominal length
    }
    return NOMINAL_CHUNK_SEC;
  }

  private broadcastStatus(rec: StoredMeetingRecord): MeetingStatusEvent {
    const event = this.buildStatusEvent(rec);
    this.deps.bus.broadcast({ type: 'meeting-status', payload: event });
    return event;
  }

  public getMeeting(meetingId: string): MeetingStatusEvent | null {
    const rec = this.readRecord(meetingId);
    return rec ? this.buildStatusEvent(rec) : null;
  }

  public listMeetings(): MeetingSession[] {
    const rows = this.deps.db.sqlite
      .prepare(`SELECT data FROM meetings ORDER BY created_at DESC`)
      .all() as Array<{ data: string }>;
    return rows.map((r) => this.buildStatusEvent(JSON.parse(r.data) as StoredMeetingRecord).meeting);
  }

  public getActiveMeetingStatus(): MeetingStatusEvent | null {
    const rows = this.deps.db.sqlite
      .prepare(`SELECT data FROM meetings ORDER BY created_at DESC`)
      .all() as Array<{ data: string }>;
    for (const row of rows) {
      const rec = JSON.parse(row.data) as StoredMeetingRecord;
      if (
        rec.status === 'recording' ||
        rec.status === 'transcribing' ||
        rec.status === 'identifying' ||
        rec.status === 'summarizing' ||
        rec.status === 'pending'
      ) {
        return this.buildStatusEvent(rec);
      }
    }
    return null;
  }

  public async startMeeting(opts?: {
    title?: string;
    mode?: MeetingMode;
    language?: SttLanguage;
    modelId?: string;
    keepAudio?: boolean;
    prompt?: string;
  }): Promise<MeetingStatusEvent> {
    const currentActive = this.getActiveMeetingStatus();
    if (
      currentActive &&
      (currentActive.meeting.status === 'recording' ||
        currentActive.meeting.status === 'transcribing' ||
        currentActive.meeting.status === 'identifying' ||
        currentActive.meeting.status === 'summarizing')
    ) {
      throw new MeetingServiceError(
        'meeting_already_active',
        'A meeting session is already active.',
        409,
      );
    }

    const settings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    const mode: MeetingMode = opts?.mode ?? settings.mode;
    const language: SttLanguage = opts?.language ?? settings.language;
    const modelId = opts?.modelId ?? settings.activeModelId;
    const keepAudio = opts?.keepAudio ?? settings.keepAudio;
    const now = new Date().toISOString();
    const id = `mtg_${crypto.randomUUID().slice(0, 8)}`;

    const rec: StoredMeetingRecord = {
      id,
      title: opts?.title?.trim() || `Meeting ${now.slice(0, 16).replace('T', ' ')}`,
      mode,
      language,
      modelId,
      status: 'recording',
      keepAudio,
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      summary: null,
      error: null,
      warning: null,
      // With the speaker engine installed every chunk's audio is kept until the voices are named.
      keepForSpeakers: Boolean(settings.speakerLabels && this.deps.diarizer?.available),
      speakersPending: false,
      participants: null,
      createdAt: now,
      updatedAt: now,
    };

    fs.mkdirSync(this.getPendingDir(id), { recursive: true });
    this.saveRecord(rec);

    // Clean up a failed start so the user can fix the engine, model or microphone and retry.
    const discard = () => {
      this.deps.db.sqlite.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
      fs.rmSync(path.join(this.meetingsDir, id), { recursive: true, force: true });
    };

    if (mode === 'live') {
      // While recording, Whisper only gets CPU that the meeting app and Atelier don't need.
      this.deps.sttProvider.setBackground?.(true);
      try {
        await this.deps.sttProvider.prepare();
      } catch (err) {
        discard();
        throw new MeetingServiceError(
          'stt_prepare_failed',
          err instanceof Error ? err.message : 'Failed to start Whisper engine.',
          400,
        );
      }
    }

    if (this.deps.capture?.available) {
      const incomingDir = this.getIncomingDir(id);
      fs.mkdirSync(incomingDir, { recursive: true });
      try {
        await this.deps.capture.start(id, incomingDir, {
          micDevice: settings.micDevice,
          speakerDevice: settings.speakerDevice,
        });
      } catch (err) {
        discard();
        if (mode === 'live') await this.deps.sttProvider.release().catch(() => undefined);
        throw new MeetingServiceError(
          'capture_failed',
          err instanceof Error ? err.message : 'Failed to start audio capture.',
          400,
        );
      }
    }

    return this.broadcastStatus(rec);
  }

  /** Pause or resume recording. Paused time is not recorded and not counted in the timer. */
  public setPaused(meetingId: string, paused: boolean): MeetingStatusEvent {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (rec.status !== 'recording') {
      throw new MeetingServiceError('meeting_not_recording', 'This meeting is not being recorded.', 409);
    }
    const now = new Date();
    if (paused && !rec.pausedSince) {
      rec.pausedSince = now.toISOString();
    } else if (!paused && rec.pausedSince) {
      rec.pausedMs = (rec.pausedMs ?? 0) + Math.max(0, now.getTime() - Date.parse(rec.pausedSince));
      rec.pausedSince = null;
    }
    rec.updatedAt = now.toISOString();
    this.saveRecord(rec);
    this.deps.capture?.setPaused(meetingId, paused);
    return this.broadcastStatus(rec);
  }

  /** Close a running pause so the recorded duration stays right after the meeting ends. */
  private foldPause(rec: StoredMeetingRecord): void {
    if (!rec.pausedSince) return;
    rec.pausedMs = (rec.pausedMs ?? 0) + Math.max(0, Date.now() - Date.parse(rec.pausedSince));
    rec.pausedSince = null;
  }

  /** Throw a meeting away while (or after) recording: stops capture and deletes everything. */
  public async discardMeeting(meetingId: string): Promise<void> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    this.stoppingMeetings.add(meetingId);
    try {
      this.activeAborts.get(meetingId)?.abort();
      if (rec.status === 'recording' && this.deps.capture?.available) {
        await this.deps.capture.stop(meetingId).catch(() => undefined);
      }
      await this.workers.get(meetingId)?.catch(() => undefined);
      this.removeMeetingData(meetingId);
      if (rec.mode === 'live') {
        this.deps.sttProvider.setBackground?.(false);
        await this.deps.sttProvider.release().catch(() => undefined);
      }
    } finally {
      this.stoppingMeetings.delete(meetingId);
    }
  }

  private removeMeetingData(meetingId: string): void {
    this.deps.db.sqlite.prepare(`DELETE FROM meeting_segments WHERE meeting_id = ?`).run(meetingId);
    this.deps.db.sqlite.prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ?`).run(meetingId);
    this.deps.db.sqlite.prepare(`DELETE FROM meeting_chunks WHERE meeting_id = ?`).run(meetingId);
    this.deps.db.sqlite.prepare(`DELETE FROM meetings WHERE id = ?`).run(meetingId);
    fs.rmSync(path.join(this.meetingsDir, meetingId), { recursive: true, force: true });
    this.deps.bus.broadcast({ type: 'meeting-removed', payload: { id: meetingId } });
  }

  /** Tray "Catat meeting": start a meeting, or stop the one being recorded. */
  public async toggleRecording(): Promise<MeetingStatusEvent> {
    const active = this.getActiveMeetingStatus();
    if (active?.meeting.status === 'recording') {
      return this.stopMeeting(active.meeting.id);
    }
    return this.startMeeting();
  }

  /** Called when the desktop shell sees a meeting app start or stop using the microphone. */
  public handleMeetingApp(ev: MeetingAppEvent): void {
    const settings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    const active = this.getActiveMeetingStatus();
    const recordingId = active?.meeting.status === 'recording' ? active.meeting.id : null;

    if (ev.state === 'started') {
      if (!settings.detectMeetingApps || settings.ignoredMeetingApps.includes(ev.appId)) return;
      if (recordingId) return; // already taking notes
      this.deps.bus.broadcast({ type: 'meeting-app', payload: { ...ev, meetingId: null } });
      const lang = this.deps.store.getSettings().language;
      this.deps.notify?.(
        lang === 'en' ? `${ev.appName} is using the microphone` : `${ev.appName} sedang memakai mikrofon`,
        lang === 'en'
          ? 'Open Atelier to take notes for this meeting.'
          : 'Buka Atelier untuk mencatat meeting ini.',
      );
      return;
    }

    // "ended": let the UI dismiss its offer, or ask whether to stop the running recording.
    this.deps.bus.broadcast({ type: 'meeting-app', payload: { ...ev, meetingId: recordingId } });
    if (recordingId) {
      const lang = this.deps.store.getSettings().language;
      this.deps.notify?.(
        lang === 'en' ? 'Meeting finished?' : 'Meeting sudah selesai?',
        lang === 'en'
          ? `${ev.appName} released the microphone. Open Atelier to stop taking notes.`
          : `${ev.appName} sudah melepas mikrofon. Buka Atelier untuk menyelesaikan catatan.`,
      );
    }
  }

  private handleCaptureError(meetingId: string, message: string, fatal: boolean, code?: string | null): void {
    const rec = this.readRecord(meetingId);
    if (!rec || rec.status !== 'recording') return;
    rec.warning = fatal
      ? `Audio capture stopped: ${message}. Press Stop to transcribe what was recorded.`
      : message;
    rec.warningCode = code ?? null;
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    this.broadcastStatus(rec);
    if (fatal) {
      const lang = this.deps.store.getSettings().language;
      this.deps.notify?.(
        lang === 'en' ? 'Meeting recording stopped' : 'Rekaman meeting berhenti',
        message,
      );
    }
  }

  public enqueueChunk(meetingId: string, wav: Buffer, info?: ChunkMeta): MeetingStatusEvent {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (rec.status !== 'recording') {
      throw new MeetingServiceError(
        'meeting_not_recording',
        `Meeting ${meetingId} is not accepting audio chunks (status=${rec.status}).`,
        409,
      );
    }

    const now = this.insertChunk(meetingId, wav, info);
    rec.updatedAt = now;
    this.saveRecord(rec);
    const statusEvent = this.broadcastStatus(rec);

    if (rec.mode === 'live') {
      this.ensureLiveWorker(meetingId);
    }
    return statusEvent;
  }

  /** A chunk WAV written by the desktop shell. The file is moved into the queue and removed. */
  public enqueueChunkFile(meetingId: string, filePath: string, info?: ChunkInfo): void {
    const incoming = path.resolve(this.getIncomingDir(meetingId)) + path.sep;
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(incoming)) {
      return; // only files inside this meeting's incoming folder
    }
    let wav: Buffer;
    try {
      wav = fs.readFileSync(resolved);
    } catch {
      return;
    }
    const rec = this.readRecord(meetingId);
    if (!rec) return;
    // The energy file (mic vs laptop loudness) travels with the chunk; same folder rule.
    let energyPath: string | null = null;
    if (info?.energyPath) {
      const energy = path.resolve(info.energyPath);
      if (energy.startsWith(incoming) && fs.existsSync(energy)) energyPath = energy;
    }
    const meta: ChunkMeta = {
      startMs: info?.startSec !== null && info?.startSec !== undefined ? Math.round(info.startSec * 1000) : null,
      energyPath,
    };
    if (rec.status === 'recording') {
      this.enqueueChunk(meetingId, wav, meta);
    } else {
      // Arrived after Stop began (last flush): keep it so the drain still transcribes it.
      this.insertChunk(meetingId, wav, meta);
    }
    fs.rmSync(resolved, { force: true });
  }

  /**
   * Stores a chunk WAV under the next sequence number and returns the timestamp used. A chunk
   * without a known position follows the previous one on the timeline.
   */
  private insertChunk(meetingId: string, wav: Buffer, info?: ChunkMeta): string {
    const last = this.deps.db.sqlite
      .prepare(`SELECT seq, start_ms, audio_path FROM meeting_chunks WHERE meeting_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(meetingId) as { seq: number; start_ms: number | null; audio_path: string | null } | undefined;
    const seq = (last?.seq ?? 0) + 1;

    let startMs = info?.startMs ?? null;
    if (startMs === null) {
      let prevDuration = NOMINAL_CHUNK_SEC * 1000;
      try {
        if (last?.audio_path) prevDuration = wavDurationMs(fs.readFileSync(last.audio_path));
      } catch {
        // previous audio already deleted: assume the usual length
      }
      startMs = last ? (last.start_ms ?? 0) + prevDuration : 0;
    }

    const pendingDir = this.getPendingDir(meetingId);
    fs.mkdirSync(pendingDir, { recursive: true });
    const audioPath = path.join(pendingDir, `${String(seq).padStart(5, '0')}.wav`);
    fs.writeFileSync(audioPath, wav);

    // Move the energy file next to the audio (the incoming folder is only a hand-over spot).
    let energyPath: string | null = null;
    if (info?.energyPath && fs.existsSync(info.energyPath)) {
      energyPath = path.join(pendingDir, `${String(seq).padStart(5, '0')}.energy.json`);
      try {
        fs.copyFileSync(info.energyPath, energyPath);
        fs.rmSync(info.energyPath, { force: true });
      } catch {
        energyPath = null;
      }
    }

    const now = new Date().toISOString();
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO meeting_chunks (meeting_id, seq, status, text, audio_path, created_at, updated_at, start_ms, energy_path)
         VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(meetingId, seq, audioPath, now, now, startMs, energyPath);
    return now;
  }

  private ensureLiveWorker(meetingId: string): void {
    if (this.workers.has(meetingId) || this.stoppingMeetings.has(meetingId)) return;
    const promise = this.runLiveWorker(meetingId).finally(() => {
      if (this.workers.get(meetingId) === promise) {
        this.workers.delete(meetingId);
      }
    });
    this.workers.set(meetingId, promise);
  }

  private async runLiveWorker(meetingId: string): Promise<void> {
    while (true) {
      if (this.stoppingMeetings.has(meetingId)) break;
      const rec = this.readRecord(meetingId);
      if (!rec || rec.status !== 'recording' || rec.mode !== 'live') break;

      const nextChunk = this.deps.db.sqlite
        .prepare(
          `SELECT * FROM meeting_chunks WHERE meeting_id = ? AND status = 'pending' ORDER BY seq ASC LIMIT 1`,
        )
        .get(meetingId) as unknown as ChunkRow | undefined;

      if (!nextChunk) break;

      // Broadcast current lag state before processing next chunk
      this.broadcastStatus(rec);

      const ok = await this.transcribeSingleChunk(rec, nextChunk, { switchEconomyOnCrash: true });
      if (!ok) break;
    }
  }

  private async transcribeSingleChunk(
    rec: StoredMeetingRecord,
    chunk: ChunkRow,
    opts: { switchEconomyOnCrash: boolean },
  ): Promise<boolean> {
    const audioPath = chunk.audio_path;
    if (!audioPath || !fs.existsSync(audioPath)) {
      const now = new Date().toISOString();
      this.deps.db.sqlite
        .prepare(
          `UPDATE meeting_chunks SET status = 'done', text = '', updated_at = ? WHERE meeting_id = ? AND seq = ?`,
        )
        .run(now, rec.id, chunk.seq);
      return true;
    }

    const wav = fs.readFileSync(audioPath);
    const controller = new AbortController();
    this.activeAborts.set(rec.id, controller);

    try {
      const result = await this.deps.sttProvider.transcribe(wav, {
        language: rec.language,
        prompt: rec.prompt,
        signal: controller.signal,
      });

      const now = new Date().toISOString();
      // Persist transcription result BEFORE deleting the WAV file.
      this.deps.db.sqlite
        .prepare(
          `UPDATE meeting_chunks SET status = 'done', text = ?, updated_at = ? WHERE meeting_id = ? AND seq = ?`,
        )
        .run(result.text, now, rec.id, chunk.seq);
      this.storeSentences(rec, chunk, result, wavDurationMs(wav));

      if (!rec.keepAudio && !rec.keepForSpeakers) {
        fs.rmSync(audioPath, { force: true });
      }
      if (chunk.energy_path) fs.rmSync(chunk.energy_path, { force: true });

      const fresh = this.readRecord(rec.id) ?? rec;
      fresh.updatedAt = now;
      if (fresh.error) fresh.error = null;
      this.saveRecord(fresh);
      this.broadcastStatus(fresh);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed.';
      const fresh = this.readRecord(rec.id) ?? rec;
      fresh.updatedAt = new Date().toISOString();

      if (err instanceof WhisperFatalCrashError && opts.switchEconomyOnCrash) {
        fresh.mode = 'economy';
        fresh.warning =
          'Whisper crashed twice. Switched to economy mode and kept audio for transcription after the meeting.';
        fresh.error = message;
      } else {
        fresh.error = message;
      }
      this.saveRecord(fresh);
      this.broadcastStatus(fresh);
      return false;
    } finally {
      if (this.activeAborts.get(rec.id) === controller) {
        this.activeAborts.delete(rec.id);
      }
    }
  }

  private speakerLabel(kind: 'me' | 'others' | 'spk', n = 0): string {
    const id = this.deps.store.getSettings().language !== 'en';
    if (kind === 'me') return id ? 'Saya' : 'Me';
    if (kind === 'others') return id ? 'Lainnya' : 'Others';
    return id ? `Pembicara ${n}` : `Speaker ${n}`;
  }

  /** Makes sure the "me" / "others" speaker exists for this meeting. */
  private ensureSideSpeaker(meetingId: string, side: 'me' | 'others'): void {
    this.deps.db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO meeting_speakers (meeting_id, id, label, name, color, is_me, sort)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        meetingId,
        side,
        this.speakerLabel(side),
        side === 'me' ? ME_COLOR : OTHER_COLORS[0]!,
        side === 'me' ? 1 : 0,
        side === 'me' ? 0 : 1,
      );
  }

  /**
   * Stores the sentences of a transcribed chunk with their place on the recording timeline, and
   * (when the shell measured it) whether the microphone or the laptop sound carried each one.
   */
  private storeSentences(
    rec: StoredMeetingRecord,
    chunk: ChunkRow,
    result: { text: string; segments?: SttSegment[] },
    durationMs: number,
  ): void {
    const text = result.text.trim();
    const list: SttSegment[] = result.segments?.length
      ? result.segments
      : text
        ? [{ startMs: 0, endMs: durationMs, text }]
        : [];
    const labels = (this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS).speakerLabels;
    let track: EnergyTrack | null = null;
    if (labels && chunk.energy_path) {
      try {
        track = parseEnergyFile(fs.readFileSync(chunk.energy_path, 'utf8'));
      } catch {
        track = null;
      }
    }
    const base = chunk.start_ms ?? 0;
    const sqlite = this.deps.db.sqlite;
    sqlite.prepare(`DELETE FROM meeting_segments WHERE meeting_id = ? AND seq = ?`).run(rec.id, chunk.seq);
    const insert = sqlite.prepare(
      `INSERT INTO meeting_segments (meeting_id, seq, idx, start_ms, end_ms, text, side, speaker_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    list.forEach((seg, i) => {
      const start = base + Math.max(0, seg.startMs);
      const end = base + Math.max(seg.endMs, seg.startMs + 200);
      const side = labels ? sideForRange(track, start, end) : null;
      insert.run(rec.id, chunk.seq, i, start, end, seg.text, side, side);
      if (side) this.ensureSideSpeaker(rec.id, side);
    });
  }

  public async deferToEconomy(meetingId: string): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    rec.mode = 'economy';
    rec.warning = 'Switched to economy mode. Remaining audio will be transcribed after stopping.';
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    return this.broadcastStatus(rec);
  }

  public async switchModel(meetingId: string, modelId: string): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (!this.deps.installer.getModelPath(modelId)) {
      throw new MeetingServiceError(
        'model_not_installed',
        `Model ${modelId} is not downloaded.`,
        400,
      );
    }
    const currentSettings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    this.deps.store.updateSettings({
      meeting: { ...currentSettings, activeModelId: modelId },
    });
    rec.modelId = modelId;
    rec.warning = null;
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    return this.broadcastStatus(rec);
  }

  public async stopMeeting(meetingId: string): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (rec.status === 'completed') {
      return this.buildStatusEvent(rec);
    }
    // A second click while finishing: nothing new to do.
    if (this.finishing.has(meetingId)) {
      return this.buildStatusEvent(rec);
    }
    this.finishing.add(meetingId);

    // Show "finishing" right away: before, nothing changed on screen until the chunk being
    // transcribed was done (up to ~20 s), which looked like the Stop button did not work.
    const wasRecording = rec.status === 'recording';
    if (wasRecording) {
      this.foldPause(rec);
      rec.status = 'transcribing';
      rec.warning = null;
      rec.updatedAt = new Date().toISOString();
      this.saveRecord(rec);
      this.broadcastStatus(rec);
    }
    // Recording is over: let Whisper use its normal share of the CPU to finish quickly.
    this.deps.sttProvider.setBackground?.(false);

    // Let the shell flush the audio since the last pause before the queue is drained.
    if (wasRecording && this.deps.capture?.available) {
      await this.deps.capture.stop(meetingId).catch(() => undefined);
    }

    this.stoppingMeetings.add(meetingId);
    try {
      const runningWorker = this.workers.get(meetingId);
      if (runningWorker) {
        await runningWorker.catch(() => undefined);
      }

      const fresh = this.readRecord(meetingId) ?? rec;
      fresh.status = 'transcribing';
      fresh.warning = null;
      fresh.error = null;
      fresh.updatedAt = new Date().toISOString();
      this.saveRecord(fresh);
      this.broadcastStatus(fresh);

      return await this.drainAndSummarize(meetingId);
    } finally {
      this.stoppingMeetings.delete(meetingId);
      this.finishing.delete(meetingId);
    }
  }

  public async resumePending(meetingId: string): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (rec.status === 'completed') {
      return this.buildStatusEvent(rec);
    }

    rec.status = 'transcribing';
    rec.error = null;
    rec.warning = null;
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    this.broadcastStatus(rec);
    this.deps.sttProvider.setBackground?.(false);

    return await this.drainAndSummarize(meetingId);
  }

  private async drainAndSummarize(meetingId: string): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }

    const pendingChunks = this.deps.db.sqlite
      .prepare(
        `SELECT * FROM meeting_chunks WHERE meeting_id = ? AND status = 'pending' ORDER BY seq ASC`,
      )
      .all(meetingId) as unknown as ChunkRow[];

    let sttPrepared = false;
    let allSucceeded = true;

    try {
      if (pendingChunks.length > 0) {
        await this.deps.sttProvider.prepare();
        sttPrepared = true;

        for (const chunk of pendingChunks) {
          const currentRec = this.readRecord(meetingId) ?? rec;
          const ok = await this.transcribeSingleChunk(currentRec, chunk, {
            switchEconomyOnCrash: false,
          });
          if (!ok) {
            allSucceeded = false;
            break;
          }
        }
      }
    } catch (err) {
      allSucceeded = false;
      const currentRec = this.readRecord(meetingId) ?? rec;
      currentRec.status = 'pending';
      currentRec.error = err instanceof Error ? err.message : 'Transcription failed.';
      currentRec.updatedAt = new Date().toISOString();
      this.saveRecord(currentRec);
      return this.broadcastStatus(currentRec);
    } finally {
      if (sttPrepared || rec.mode === 'live') {
        await this.deps.sttProvider.release().catch(() => undefined);
      }
    }

    const afterChunks = this.readRecord(meetingId) ?? rec;
    const stillPending = this.deps.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS cnt FROM meeting_chunks WHERE meeting_id = ? AND status = 'pending'`,
      )
      .get(meetingId) as { cnt: number };

    if (!allSucceeded || (stillPending?.cnt ?? 0) > 0) {
      afterChunks.status = 'pending';
      afterChunks.updatedAt = new Date().toISOString();
      this.saveRecord(afterChunks);
      return this.broadcastStatus(afterChunks);
    }

    // All chunks are persisted in order. Tell the other voices apart (optional engine), then write
    // the notes with the names that are known so far.
    await this.identifySpeakers(meetingId, afterChunks.participants ?? null);

    const forNotes = this.readRecord(meetingId) ?? afterChunks;
    forNotes.status = 'summarizing';
    forNotes.updatedAt = new Date().toISOString();
    this.saveRecord(forNotes);
    this.broadcastStatus(forNotes);

    const summary = await this.writeNotes(forNotes);

    // Audio stays only while the user still has to name the voices (or asked to keep it).
    if (!forNotes.keepAudio && !forNotes.speakersPending) {
      fs.rmSync(path.join(this.meetingsDir, meetingId), { recursive: true, force: true });
    }

    const done = this.readRecord(meetingId) ?? forNotes;
    done.status = 'completed';
    done.summary = summary;
    done.error = null;
    done.updatedAt = new Date().toISOString();
    this.saveRecord(done);
    const lang = this.deps.store.getSettings().language;
    this.deps.notify?.(
      lang === 'en' ? 'Meeting notes are ready' : 'Catatan meeting siap',
      lang === 'en'
        ? `${done.title}: open Atelier → Meeting notes.`
        : `${done.title}: buka Atelier → Catatan meeting.`,
    );
    return this.broadcastStatus(done);
  }

  // ---------------------------------------------------------------- notes

  /** Name shown for a speaker: the one the user gave, else the automatic label. */
  private speakerDisplay(sp: SpeakerRow | undefined): string | null {
    if (!sp) return null;
    return sp.name?.trim() || sp.label;
  }

  /** The request for the model that writes the notes (the transcript has times and names). */
  private buildNotesRequest(rec: StoredMeetingRecord): NotesRequest | null {
    const settings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    const speakers = new Map(this.readSpeakers(rec.id).map((sp) => [sp.id, sp]));
    const done = this.readChunks(rec.id).filter((c) => c.status === 'done');
    const sentences = this.buildTranscript(done, this.readSegments(rec.id)).map((seg) => ({
      startMs: seg.startMs,
      speaker: this.speakerDisplay(seg.speakerId ? speakers.get(seg.speakerId) : undefined),
      text: seg.text,
    }));
    const transcript = transcriptForNotes(sentences);
    if (!transcript) return null;
    const { system, prompt } = buildNotesRequest({
      title: rec.title,
      date: rec.createdAt.slice(0, 16).replace('T', ' '),
      notesLanguage: settings.notesLanguage,
      meetingLanguage: rec.language,
      template: settings.notesTemplate,
      transcript,
    });
    return { system, prompt, provider: settings.notesProvider, model: settings.notesModel };
  }

  /** Writes the notes; a failure becomes the notes text so the user sees why (and can retry). */
  private async writeNotes(
    rec: StoredMeetingRecord,
    override?: { provider: ModelProvider | null; model: string | null },
  ): Promise<string | null> {
    const request = this.buildNotesRequest(rec);
    if (!this.deps.summarize || !request) return null;
    if (override) {
      request.provider = override.provider;
      request.model = override.model;
    }
    const controller = new AbortController();
    this.activeAborts.set(rec.id, controller);
    const timer = setTimeout(() => controller.abort(), 180_000);
    timer.unref?.();
    try {
      return await this.deps.summarize(request, controller.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Summary generation failed.';
      return `Summary unavailable (${msg}).`;
    } finally {
      clearTimeout(timer);
      if (this.activeAborts.get(rec.id) === controller) this.activeAborts.delete(rec.id);
    }
  }

  /** Writes the notes again (other model, other template, or after naming the speakers). */
  public async regenerateNotes(
    meetingId: string,
    override?: { provider: ModelProvider | null; model: string | null },
  ): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    if (rec.status !== 'completed') {
      throw new MeetingServiceError('meeting_busy', 'Wait until the meeting is finished.', 409);
    }
    if (this.finishing.has(meetingId)) {
      throw new MeetingServiceError('meeting_busy', 'The notes are already being written.', 409);
    }
    this.finishing.add(meetingId);
    try {
      rec.status = 'summarizing';
      rec.updatedAt = new Date().toISOString();
      this.saveRecord(rec);
      this.broadcastStatus(rec);
      const summary = await this.writeNotes(rec, override);
      const fresh = this.readRecord(meetingId) ?? rec;
      fresh.status = 'completed';
      if (summary !== null) fresh.summary = summary;
      fresh.updatedAt = new Date().toISOString();
      this.saveRecord(fresh);
      return this.broadcastStatus(fresh);
    } finally {
      this.finishing.delete(meetingId);
    }
  }

  // ---------------------------------------------------------------- speakers

  /**
   * Runs the speaker engine over the whole recording and gives every sentence to a speaker.
   * Returns false (and keeps the plain "me" / "others" labels) when the engine is missing,
   * finds nobody, or fails: the meeting never fails because of this step.
   */
  private async identifySpeakers(meetingId: string, participants: number | null): Promise<boolean> {
    const diarizer = this.deps.diarizer;
    const settings = this.deps.store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;
    const rec = this.readRecord(meetingId);
    if (!rec || !diarizer?.available || !settings.speakerLabels || !rec.keepForSpeakers) return false;
    const chunks = this.readChunks(meetingId).filter((c) => c.audio_path && fs.existsSync(c.audio_path));
    if (chunks.length === 0) return false;

    rec.status = 'identifying';
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    this.broadcastStatus(rec);

    const merged = path.join(this.meetingsDir, meetingId, 'merged.wav');
    const controller = new AbortController();
    this.activeAborts.set(meetingId, controller);
    const timer = setTimeout(() => controller.abort(), 60 * 60 * 1000);
    timer.unref?.();
    try {
      mergeChunksToWav(
        chunks.map((c) => ({ path: c.audio_path as string, startMs: c.start_ms ?? 0 })),
        merged,
      );
      const turns = await diarizer.diarize(merged, {
        numSpeakers: participants,
        threads: settings.threads,
        signal: controller.signal,
      });
      if (turns.length === 0) return false;
      const others = this.applyDiarization(meetingId, turns);
      const fresh = this.readRecord(meetingId) ?? rec;
      fresh.speakersPending = others > 0;
      this.saveRecord(fresh);
      return true;
    } catch (err) {
      const fresh = this.readRecord(meetingId) ?? rec;
      fresh.warning = `Could not tell the speakers apart: ${err instanceof Error ? err.message : 'unknown error'}`;
      fresh.warningCode = 'speakers_failed';
      this.saveRecord(fresh);
      return false;
    } finally {
      clearTimeout(timer);
      if (this.activeAborts.get(meetingId) === controller) this.activeAborts.delete(meetingId);
      fs.rmSync(merged, { force: true });
    }
  }

  /** Stores the diarizer's verdict; returns how many other participants were found. */
  private applyDiarization(meetingId: string, turns: Array<{ startMs: number; endMs: number; speaker: number }>): number {
    const segments = this.readSegments(meetingId);
    const assignment = assignSpeakers(
      segments.map((seg) => ({
        key: `${seg.seq}:${seg.idx}`,
        startMs: seg.start_ms,
        endMs: seg.end_ms,
        side: (seg.side === 'me' || seg.side === 'others' ? seg.side : null) as 'me' | 'others' | null,
      })),
      turns,
    );
    const sqlite = this.deps.db.sqlite;
    sqlite.exec('BEGIN');
    try {
      const update = sqlite.prepare(
        `UPDATE meeting_segments SET speaker_id = ? WHERE meeting_id = ? AND seq = ? AND idx = ?`,
      );
      for (const seg of segments) {
        update.run(assignment.bySentence.get(`${seg.seq}:${seg.idx}`) ?? null, meetingId, seg.seq, seg.idx);
      }
      // A repeat run starts the other speakers over (names given before no longer fit).
      sqlite.prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ? AND id LIKE 'spk\\_%' ESCAPE '\\'`).run(meetingId);
      const insert = sqlite.prepare(
        `INSERT OR IGNORE INTO meeting_speakers (meeting_id, id, label, name, color, is_me, sort)
         VALUES (?, ?, ?, NULL, ?, 0, ?)`,
      );
      assignment.otherIds.forEach((id, i) => {
        insert.run(meetingId, id, this.speakerLabel('spk', i + 1), OTHER_COLORS[(i + 1) % OTHER_COLORS.length]!, i + 2);
      });
      const usesMe = [...assignment.bySentence.values()].includes('me');
      if (usesMe) this.ensureSideSpeaker(meetingId, 'me');
      if ([...assignment.bySentence.values()].includes('others')) this.ensureSideSpeaker(meetingId, 'others');
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
    return assignment.otherIds.length;
  }

  public renameSpeaker(meetingId: string, speakerId: string, name: string | null): MeetingStatusEvent {
    const rec = this.readRecord(meetingId);
    if (!rec) throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    const clean = name?.trim() ? name.trim().slice(0, 60) : null;
    const res = this.deps.db.sqlite
      .prepare(`UPDATE meeting_speakers SET name = ? WHERE meeting_id = ? AND id = ?`)
      .run(clean, meetingId, speakerId);
    if (Number(res.changes) === 0) {
      throw new MeetingServiceError('speaker_not_found', `Speaker ${speakerId} not found.`, 404);
    }
    return this.broadcastStatus(rec);
  }

  /** The same person was found twice: move one speaker's sentences to the other. */
  public mergeSpeakers(meetingId: string, fromId: string, intoId: string): MeetingStatusEvent {
    const rec = this.readRecord(meetingId);
    if (!rec) throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    if (fromId === intoId || fromId === 'me') {
      throw new MeetingServiceError('invalid_merge', 'Pick two different speakers; "me" cannot be merged away.', 400);
    }
    const ids = new Set(this.readSpeakers(meetingId).map((sp) => sp.id));
    if (!ids.has(fromId) || !ids.has(intoId)) {
      throw new MeetingServiceError('speaker_not_found', 'Speaker not found.', 404);
    }
    const sqlite = this.deps.db.sqlite;
    sqlite.prepare(`UPDATE meeting_segments SET speaker_id = ? WHERE meeting_id = ? AND speaker_id = ?`).run(intoId, meetingId, fromId);
    sqlite.prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ? AND id = ?`).run(meetingId, fromId);
    return this.broadcastStatus(rec);
  }

  /** A few seconds of this speaker's voice, to play in the naming dialog. */
  public speakerSample(meetingId: string, speakerId: string): Buffer | null {
    const rec = this.readRecord(meetingId);
    if (!rec || !this.audioKept(rec)) return null;
    const chunks = new Map(this.readChunks(meetingId).map((c) => [c.seq, c]));
    const sentences = this.readSegments(meetingId)
      .filter((seg) => seg.speaker_id === speakerId)
      .sort((a, b) => b.end_ms - b.start_ms - (a.end_ms - a.start_ms));
    for (const seg of sentences) {
      const chunk = chunks.get(seg.seq);
      if (!chunk?.audio_path) continue;
      let wav: Buffer;
      try {
        wav = fs.readFileSync(chunk.audio_path);
      } catch {
        continue;
      }
      const pcm = sliceChunkPcm(wav, chunk.start_ms ?? 0, seg.start_ms, Math.min(seg.end_ms, seg.start_ms + 6000));
      if (pcm.length >= 400 * 32) return buildWav(pcm);
    }
    return null;
  }

  /** Run the speaker engine again, optionally with the number of participants the user knows. */
  public async rediarize(meetingId: string, participants: number | null): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    if (!this.deps.diarizer?.available) {
      throw new MeetingServiceError('speakers_unavailable', 'Install the speaker engine in Settings → Meeting first.', 400);
    }
    if (rec.status !== 'completed' || !this.audioKept(rec)) {
      throw new MeetingServiceError('audio_gone', 'The audio of this meeting is no longer kept.', 409);
    }
    if (this.finishing.has(meetingId)) {
      throw new MeetingServiceError('meeting_busy', 'This meeting is busy.', 409);
    }
    this.finishing.add(meetingId);
    try {
      rec.participants = participants && participants > 0 ? Math.min(participants, 20) : null;
      rec.keepForSpeakers = true;
      rec.warning = null;
      rec.warningCode = null;
      this.saveRecord(rec);
      const ok = await this.identifySpeakers(meetingId, rec.participants);
      const fresh = this.readRecord(meetingId) ?? rec;
      fresh.status = 'completed';
      if (ok) fresh.speakersPending = true;
      fresh.updatedAt = new Date().toISOString();
      this.saveRecord(fresh);
      return this.broadcastStatus(fresh);
    } finally {
      this.finishing.delete(meetingId);
    }
  }

  /** The user is done naming: delete the audio kept for it (unless "keep audio" is on). */
  public async finishSpeakerNaming(meetingId: string, regenerate: boolean): Promise<MeetingStatusEvent> {
    const rec = this.readRecord(meetingId);
    if (!rec) throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    this.releaseSpeakerAudio(meetingId);
    const fresh = this.readRecord(meetingId) ?? rec;
    this.broadcastStatus(fresh);
    return regenerate && fresh.status === 'completed' ? this.regenerateNotes(meetingId) : this.buildStatusEvent(fresh);
  }

  /** Stops keeping audio for speaker naming. Quiet: also used when the app starts. */
  private releaseSpeakerAudio(meetingId: string): void {
    const rec = this.readRecord(meetingId);
    if (!rec) return;
    rec.speakersPending = false;
    rec.keepForSpeakers = false;
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    if (!rec.keepAudio) {
      // Nothing else lives in the meeting's folder: the notes and transcript are in the database.
      fs.rmSync(path.join(this.meetingsDir, meetingId), { recursive: true, force: true });
    }
  }

  /** Removes a finished (or abandoned) meeting: its notes, transcript and any kept audio. */
  public deleteMeeting(meetingId: string): void {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (
      rec.status === 'recording' ||
      rec.status === 'transcribing' ||
      rec.status === 'identifying' ||
      rec.status === 'summarizing'
    ) {
      throw new MeetingServiceError(
        'meeting_busy',
        'Stop the meeting and wait for its notes before deleting it.',
        409,
      );
    }
    this.removeMeetingData(meetingId);
  }

  /** Renames a meeting (the title shown in the list and the exported file). */
  public renameMeeting(meetingId: string, title: string): MeetingStatusEvent {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    rec.title = title.trim() || rec.title;
    rec.updatedAt = new Date().toISOString();
    this.saveRecord(rec);
    return this.broadcastStatus(rec);
  }

  public async shutdown(): Promise<void> {
    if (this.meterTimer) clearTimeout(this.meterTimer);
    if (this.deps.capture?.available) this.deps.capture.setMeter(false);
    // Stop capture first: the shell writes its last chunk to disk, which is adopted on next start.
    const active = this.getActiveMeetingStatus();
    if (active?.meeting.status === 'recording' && this.deps.capture?.available) {
      await this.deps.capture.stop(active.meeting.id).catch(() => undefined);
    }
    for (const id of this.workers.keys()) {
      this.stoppingMeetings.add(id);
    }
    for (const controller of this.activeAborts.values()) {
      controller.abort();
    }
    this.activeAborts.clear();
    await Promise.all([...this.workers.values()].map((p) => p.catch(() => undefined)));
  }
}
