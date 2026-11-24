import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MEETING_SETTINGS,
  type MeetingAppEvent,
  type MeetingMode,
  type MeetingSession,
  type MeetingStatus,
  type MeetingStatusEvent,
  type MeetingTranscriptSegment,
  type SttLanguage,
} from '@atelier/contracts';
import type { EventBus } from '../bus.js';
import type { AppConfig } from '../config.js';
import type { AtelierDb } from '../db.js';
import type { AtelierStore } from '../store.js';
import { getSmallerInstalledModel } from '../stt/catalog.js';
import type { SttInstaller } from '../stt/installer.js';
import { WhisperFatalCrashError } from '../stt/local-whisper.js';
import type { MeetingAudioCapture } from './capture.js';
import type { SttProvider } from './stt.js';

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
}

interface ChunkRow {
  meeting_id: string;
  seq: number;
  status: string;
  text: string | null;
  audio_path: string | null;
  created_at: string;
  updated_at: string;
}

export type SummarizeMeetingFn = (transcript: string, signal: AbortSignal) => Promise<string | null>;

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
      /** Desktop-shell audio capture; absent in tests and plain dev servers (audio comes over HTTP). */
      capture?: MeetingAudioCapture;
      /** Native notification (desktop shell only), shown when the window is not focused. */
      notify?: (title: string, body: string) => void;
    },
  ) {
    this.meetingsDir = path.join(deps.config.dataDir, 'meetings');
    deps.capture?.setHandlers({
      onChunk: (meetingId, filePath) => this.enqueueChunkFile(meetingId, filePath),
      onError: (meetingId, message, fatal) => this.handleCaptureError(meetingId, message, fatal),
      // Not stored: only drives the live waveform while recording.
      onLevel: (meetingId, levels) =>
        this.deps.bus.broadcast({ type: 'meeting-level', payload: { meetingId, levels } }),
    });
    this.recoverInterruptedMeetings();
  }

  public get captureAvailable(): boolean {
    return Boolean(this.deps.capture?.available);
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
        this.insertChunk(meetingId, fs.readFileSync(full));
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

    const transcript: MeetingTranscriptSegment[] = completed.map((c) => ({
      seq: c.seq,
      text: c.text ?? '',
      createdAt: c.updated_at,
    }));

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
    };

    return {
      meeting: session,
      canSwitchSmallerModel: Boolean(isLagging && smallerModelId),
      smallerModelId,
      warning,
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
        await this.deps.capture.start(id, incomingDir);
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

  private handleCaptureError(meetingId: string, message: string, fatal: boolean): void {
    const rec = this.readRecord(meetingId);
    if (!rec || rec.status !== 'recording') return;
    rec.warning = fatal
      ? `Audio capture stopped: ${message}. Press Stop to transcribe what was recorded.`
      : `Audio capture: ${message}`;
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

  public enqueueChunk(meetingId: string, wav: Buffer): MeetingStatusEvent {
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

    const now = this.insertChunk(meetingId, wav);
    rec.updatedAt = now;
    this.saveRecord(rec);
    const statusEvent = this.broadcastStatus(rec);

    if (rec.mode === 'live') {
      this.ensureLiveWorker(meetingId);
    }
    return statusEvent;
  }

  /** A chunk WAV written by the desktop shell. The file is moved into the queue and removed. */
  public enqueueChunkFile(meetingId: string, filePath: string): void {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.getIncomingDir(meetingId)) + path.sep)) {
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
    if (rec.status === 'recording') {
      this.enqueueChunk(meetingId, wav);
    } else {
      // Arrived after Stop began (last flush): keep it so the drain still transcribes it.
      this.insertChunk(meetingId, wav);
    }
    fs.rmSync(resolved, { force: true });
  }

  /** Stores a chunk WAV under the next sequence number and returns the timestamp used. */
  private insertChunk(meetingId: string, wav: Buffer): string {
    const row = this.deps.db.sqlite
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM meeting_chunks WHERE meeting_id = ?`)
      .get(meetingId) as { maxSeq: number };
    const seq = (row?.maxSeq ?? 0) + 1;

    const pendingDir = this.getPendingDir(meetingId);
    fs.mkdirSync(pendingDir, { recursive: true });
    const audioPath = path.join(pendingDir, `${String(seq).padStart(5, '0')}.wav`);
    fs.writeFileSync(audioPath, wav);

    const now = new Date().toISOString();
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO meeting_chunks (meeting_id, seq, status, text, audio_path, created_at, updated_at)
         VALUES (?, ?, 'pending', NULL, ?, ?, ?)`,
      )
      .run(meetingId, seq, audioPath, now, now);
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

      if (!rec.keepAudio) {
        fs.rmSync(audioPath, { force: true });
      }

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

    // All chunks are persisted in order: generate final summary now.
    afterChunks.status = 'summarizing';
    afterChunks.updatedAt = new Date().toISOString();
    this.saveRecord(afterChunks);
    this.broadcastStatus(afterChunks);

    const allDone = this.readChunks(meetingId);
    const fullTranscript = allDone
      .map((c) => c.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n\n');

    let summary: string | null = null;
    if (this.deps.summarize && fullTranscript) {
      const controller = new AbortController();
      this.activeAborts.set(meetingId, controller);
      const timer = setTimeout(() => controller.abort(), 120_000);
      timer.unref?.();
      try {
        summary = await this.deps.summarize(fullTranscript, controller.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Summary generation failed.';
        summary = `Summary unavailable (${msg}).`;
      } finally {
        clearTimeout(timer);
        if (this.activeAborts.get(meetingId) === controller) {
          this.activeAborts.delete(meetingId);
        }
      }
    }

    if (!afterChunks.keepAudio) {
      fs.rmSync(path.join(this.meetingsDir, meetingId), { recursive: true, force: true });
    }

    afterChunks.status = 'completed';
    afterChunks.summary = summary;
    afterChunks.error = null;
    afterChunks.updatedAt = new Date().toISOString();
    this.saveRecord(afterChunks);
    const lang = this.deps.store.getSettings().language;
    this.deps.notify?.(
      lang === 'en' ? 'Meeting notes are ready' : 'Catatan meeting siap',
      lang === 'en'
        ? `${afterChunks.title}: open Atelier → Meeting notes.`
        : `${afterChunks.title}: buka Atelier → Catatan meeting.`,
    );
    return this.broadcastStatus(afterChunks);
  }

  /** Removes a finished (or abandoned) meeting: its notes, transcript and any kept audio. */
  public deleteMeeting(meetingId: string): void {
    const rec = this.readRecord(meetingId);
    if (!rec) {
      throw new MeetingServiceError('meeting_not_found', `Meeting ${meetingId} not found.`, 404);
    }
    if (rec.status === 'recording' || rec.status === 'transcribing' || rec.status === 'summarizing') {
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
