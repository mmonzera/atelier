import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AutoBackupConfig,
  AutoBackupConfigInput,
  BackupImportResult,
  CloudFolderCandidate,
  RelinkCandidate,
} from '@atelier/contracts';
import type { AppConfig } from '../config.js';
import type { AtelierDb } from '../db.js';
import type { AtelierStore } from '../store.js';
import {
  BACKUP_EXTENSION,
  type BackupManifest,
  MIN_PASSPHRASE_LENGTH,
  decodeBackup,
  encodeBackup,
} from './format.js';

/** Tables that describe *this machine* (lock password, auto-backup target): never exported/imported. */
const MACHINE_LOCAL_TABLES = new Set(['app_lock', 'backup_config']);
/** Tables holding credentials: stripped unless the user opts in to an encrypted export. */
const SECRET_TABLES = ['provider_secrets', 'mcp_oauth'];
const SECRET_FIELD_RE = /auth|token|secret|password|passwd|key|cookie|bearer|credential/i;

const APP_VERSION = process.env.ATELIER_APP_VERSION || '0.1.0';
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 7;

export class BackupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

interface StoredAutoBackup {
  enabled: boolean;
  folder: string | null;
  intervalHours: number;
  keep: number;
  includeSecrets: boolean;
  passphraseEnc: string | null; // AES-GCM with the machine key (iv.tag.ct, base64)
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastFile: string | null;
  lastSeq: number | null;
}

const DEFAULT_AUTO: StoredAutoBackup = {
  enabled: false,
  folder: null,
  intervalHours: 6,
  keep: 10,
  includeSecrets: false,
  passphraseEnc: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastFile: null,
  lastSeq: null,
};

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function hostSlug(): string {
  return (os.hostname() || 'pc').replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 40).toLowerCase();
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function scrubSecretValues(record: unknown): Record<string, string> | unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    out[k] = SECRET_FIELD_RE.test(k) ? '' : String(v ?? '');
  }
  return out;
}

export class BackupService {
  private readonly tmpDir: string;
  private readonly machineKeyPath: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly db: AtelierDb,
    private readonly store: AtelierStore,
    private readonly config: AppConfig,
    private readonly hooks: { beforeImport?: () => Promise<void> } = {},
  ) {
    this.tmpDir = path.join(config.dataDir, 'tmp');
    this.machineKeyPath = path.join(config.dataDir, '.atelier-machine.key');
  }

  // ------------------------------------------------------------------ snapshot

  /**
   * Consistent point-in-time copy via `VACUUM INTO` (safe while the live DB is in WAL mode —
   * the WAL file is never copied by hand), then scrubbed and vacuumed again so deleted secrets
   * do not survive in free pages.
   */
  public createSnapshotBytes(opts: { includeSecrets: boolean }): { bytes: Buffer; manifest: BackupManifest } {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `snapshot-${crypto.randomUUID()}.db`);
    try {
      this.db.sqlite.exec(`VACUUM INTO ${sqlString(tmp)}`);
      const snap = new DatabaseSync(tmp);
      try {
        snap.exec('PRAGMA journal_mode = DELETE;');
        for (const t of MACHINE_LOCAL_TABLES) snap.exec(`DELETE FROM ${quoteIdent(t)};`);
        if (!opts.includeSecrets) {
          for (const t of SECRET_TABLES) snap.exec(`DELETE FROM ${quoteIdent(t)};`);
          const row = snap.prepare(`SELECT data FROM settings WHERE id = 1`).get() as { data: string } | undefined;
          if (row) {
            const settings = JSON.parse(row.data) as { mcpServers?: Array<Record<string, unknown>> };
            if (Array.isArray(settings.mcpServers)) {
              settings.mcpServers = settings.mcpServers.map((s) => ({
                ...s,
                headers: scrubSecretValues(s.headers),
                env: scrubSecretValues(s.env),
              }));
              snap.prepare(`UPDATE settings SET data = ? WHERE id = 1`).run(JSON.stringify(settings));
            }
          }
        }
        snap.exec('VACUUM;');
        const projects = (snap.prepare(`SELECT data FROM projects`).all() as Array<{ data: string }>).map((r) => {
          const p = JSON.parse(r.data) as { id: string; name: string; repo?: { fullName?: string; localPath?: string } | null };
          return {
            id: p.id,
            name: p.name,
            repoFullName: p.repo?.fullName ?? null,
            repoLocalPath: p.repo?.localPath ?? null,
          };
        });
        snap.close();
        const bytes = fs.readFileSync(tmp);
        return {
          bytes,
          manifest: {
            app: 'atelier',
            appVersion: APP_VERSION,
            createdAt: new Date().toISOString(),
            sourceHostname: os.hostname(),
            includesSecrets: opts.includeSecrets,
            dbSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            dbBytes: bytes.length,
            projects,
          },
        };
      } catch (err) {
        try {
          snap.close();
        } catch {
          /* already closed */
        }
        throw err;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-journal`, { force: true });
    }
  }

  public exportBackup(opts: { passphrase?: string | null; includeSecrets?: boolean }): {
    filename: string;
    bytes: Buffer;
  } {
    const passphrase = opts.passphrase?.length ? opts.passphrase : null;
    if (passphrase && passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new BackupError('weak_passphrase', `Passphrase minimal ${MIN_PASSPHRASE_LENGTH} karakter.`);
    }
    if (opts.includeSecrets && !passphrase) {
      throw new BackupError(
        'passphrase_required',
        'API key & token OAuth hanya bisa ikut di-backup kalau file dienkripsi passphrase.',
      );
    }
    const { bytes, manifest } = this.createSnapshotBytes({ includeSecrets: Boolean(opts.includeSecrets && passphrase) });
    return {
      filename: `atelier-${hostSlug()}-${stamp()}${BACKUP_EXTENSION}`,
      bytes: encodeBackup({ manifest, dbBytes: bytes, passphrase }),
    };
  }

  // ------------------------------------------------------------------ import

  public async importBackup(file: Buffer, passphrase: string | null): Promise<BackupImportResult> {
    const { manifest, dbBytes } = decodeBackup(file, passphrase);

    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `import-${crypto.randomUUID()}.db`);
    fs.writeFileSync(tmp, dbBytes);
    try {
      // Validate before touching the live DB.
      const check = new DatabaseSync(tmp, { readOnly: true });
      try {
        const integrity = check.prepare('PRAGMA integrity_check').get() as Record<string, string>;
        if (Object.values(integrity)[0] !== 'ok') {
          throw new BackupError('corrupt_backup', 'Database di dalam backup gagal integrity check.');
        }
        const tables = new Set(
          (check.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
            (r) => r.name,
          ),
        );
        for (const required of ['projects', 'agents', 'settings']) {
          if (!tables.has(required)) {
            throw new BackupError('corrupt_backup', `Backup tidak berisi tabel ${required}.`);
          }
        }
      } finally {
        check.close();
      }

      const safetyCopy = this.writeSafetyCopy();
      await this.hooks.beforeImport?.();
      this.replaceContentsFrom(tmp, { keepLocalSecrets: !manifest.includesSecrets });
      this.store.recoverOnStartup();
      this.store.broadcastSnapshot();

      return {
        ok: true,
        sourceHostname: manifest.sourceHostname,
        createdAt: manifest.createdAt,
        includesSecrets: manifest.includesSecrets,
        projectCount: manifest.projects.length,
        safetyCopy,
        relink: this.getRelinkCandidates(),
      };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** Keeps the last 3 pre-import copies in data/backups so an import can always be undone. */
  private writeSafetyCopy(): string {
    const dir = path.join(this.config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `pre-import-${stamp()}-${crypto.randomBytes(3).toString('hex')}.db`);
    this.db.sqlite.exec(`VACUUM INTO ${sqlString(target)}`);
    const old = fs
      .readdirSync(dir)
      .filter((f) => /^pre-import-.*\.db$/.test(f))
      .sort()
      .reverse()
      .slice(3);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return target;
  }

  /**
   * Swaps table contents inside the open connection (ATTACH + copy in one transaction) instead of
   * replacing the DB file under a live WAL handle. Machine-local tables are untouched.
   */
  private replaceContentsFrom(importPath: string, opts: { keepLocalSecrets: boolean }): void {
    const sqlite = this.db.sqlite;
    const keep = new Set(MACHINE_LOCAL_TABLES);
    if (opts.keepLocalSecrets) for (const t of SECRET_TABLES) keep.add(t);

    sqlite.exec(`ATTACH DATABASE ${sqlString(importPath)} AS imp`);
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    try {
      const mainTables = (
        sqlite
          .prepare(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      const impTables = new Set(
        (
          sqlite
            .prepare(`SELECT name FROM imp.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );

      sqlite.exec('BEGIN IMMEDIATE;');
      try {
        for (const table of mainTables) {
          if (keep.has(table)) continue;
          const t = quoteIdent(table);
          sqlite.exec(`DELETE FROM main.${t};`);
          if (!impTables.has(table)) continue;
          const mainCols = (sqlite.prepare(`PRAGMA main.table_info(${t})`).all() as Array<{ name: string }>).map(
            (c) => c.name,
          );
          const impCols = new Set(
            (sqlite.prepare(`PRAGMA imp.table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name),
          );
          const cols = mainCols.filter((c) => impCols.has(c)).map(quoteIdent).join(', ');
          if (cols) sqlite.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM imp.${t};`);
        }
        sqlite.exec('COMMIT;');
      } catch (err) {
        sqlite.exec('ROLLBACK;');
        throw err;
      }
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON;');
      sqlite.exec('DETACH DATABASE imp');
    }
  }

  // ------------------------------------------------------------------ relink

  public getRelinkCandidates(): RelinkCandidate[] {
    const out: RelinkCandidate[] = [];
    for (const project of this.store.listProjects()) {
      if (!project.repo) continue;
      const exists = Boolean(project.repo.localPath) && fs.existsSync(project.repo.localPath);
      if (exists) continue;
      out.push({
        projectId: project.id,
        projectName: project.name,
        repoFullName: project.repo.fullName,
        previousPath: project.repo.localPath,
        canClone: /^[\w.-]+\/[\w.-]+$/.test(project.repo.fullName),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ machine key

  private machineKey(): Buffer {
    if (fs.existsSync(this.machineKeyPath)) {
      const key = Buffer.from(fs.readFileSync(this.machineKeyPath, 'utf8').trim(), 'base64');
      if (key.length === 32) return key;
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.machineKeyPath), { recursive: true });
    fs.writeFileSync(this.machineKeyPath, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  private sealLocal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.machineKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
  }

  private openLocal(sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.machineKey(), iv!);
      decipher.setAuthTag(tag!);
      return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8');
    } catch {
      return null; // machine key changed (e.g. DB copied to another PC) -> needs re-entry
    }
  }

  // ------------------------------------------------------------------ auto-backup config

  private readAuto(): StoredAutoBackup {
    const row = this.db.sqlite.prepare(`SELECT data FROM backup_config WHERE id = 1`).get() as
      | { data: string }
      | undefined;
    if (!row) return { ...DEFAULT_AUTO };
    try {
      return { ...DEFAULT_AUTO, ...(JSON.parse(row.data) as Partial<StoredAutoBackup>) };
    } catch {
      return { ...DEFAULT_AUTO };
    }
  }

  private writeAuto(cfg: StoredAutoBackup): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO backup_config (id, data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(JSON.stringify(cfg));
  }

  public getAutoConfig(): AutoBackupConfig {
    const cfg = this.readAuto();
    const passphraseUsable = Boolean(this.openLocal(cfg.passphraseEnc));
    let nextRunAt: string | null = null;
    if (cfg.enabled) {
      const base = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : Date.now();
      nextRunAt = new Date(base + cfg.intervalHours * 3_600_000).toISOString();
    }
    return {
      enabled: cfg.enabled,
      folder: cfg.folder,
      intervalHours: cfg.intervalHours,
      keep: cfg.keep,
      includeSecrets: cfg.includeSecrets,
      passphraseSet: passphraseUsable,
      lastRunAt: cfg.lastRunAt,
      lastStatus: cfg.lastStatus,
      lastError: cfg.lastError,
      lastFile: cfg.lastFile,
      nextRunAt,
    };
  }

  public updateAutoConfig(input: AutoBackupConfigInput): AutoBackupConfig {
    const cfg = this.readAuto();
    const next: StoredAutoBackup = { ...cfg };

    if (input.folder !== undefined) {
      const folder = input.folder?.trim() || null;
      if (folder) {
        const resolved = path.resolve(folder);
        try {
          fs.mkdirSync(resolved, { recursive: true });
          fs.accessSync(resolved, fs.constants.W_OK);
        } catch {
          throw new BackupError('folder_not_writable', `Folder tidak bisa ditulisi: ${resolved}`);
        }
        next.folder = resolved;
      } else {
        next.folder = null;
      }
    }
    if (input.intervalHours !== undefined) {
      next.intervalHours = Math.min(Math.max(Math.round(input.intervalHours), MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
    }
    if (input.keep !== undefined) next.keep = Math.min(Math.max(Math.round(input.keep), 1), 100);
    if (input.includeSecrets !== undefined) next.includeSecrets = input.includeSecrets;
    if (input.passphrase !== undefined) {
      if (input.passphrase && input.passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new BackupError('weak_passphrase', `Passphrase minimal ${MIN_PASSPHRASE_LENGTH} karakter.`);
      }
      next.passphraseEnc = input.passphrase ? this.sealLocal(input.passphrase) : null;
    }
    if (input.enabled !== undefined) next.enabled = input.enabled;

    if (next.enabled) {
      if (!next.folder) throw new BackupError('folder_required', 'Pilih folder cloud drive dulu.');
      if (!this.openLocal(next.passphraseEnc)) {
        throw new BackupError(
          'passphrase_required',
          'Auto-backup ke cloud selalu dienkripsi — isi passphrase dulu.',
        );
      }
    }
    if (next.enabled && !cfg.enabled) next.lastSeq = null; // force a first run soon
    this.writeAuto(next);
    return this.getAutoConfig();
  }

  // ------------------------------------------------------------------ auto-backup runs

  private currentSeq(): number {
    const row = this.db.sqlite.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM events`).get() as { s: number };
    return row.s;
  }

  /** Writes one encrypted snapshot to the cloud folder (tmp file + rename, then rotation). */
  public async runAutoBackup(reason: 'schedule' | 'manual' | 'close'): Promise<AutoBackupConfig> {
    if (this.running) await this.running.catch(() => undefined);
    const job = (async () => {
      const cfg = this.readAuto();
      if (reason !== 'manual' && !cfg.enabled) return;
      if (!cfg.folder) throw new BackupError('folder_required', 'Folder auto-backup belum diatur.');
      const passphrase = this.openLocal(cfg.passphraseEnc);
      if (!passphrase) {
        throw new BackupError('passphrase_required', 'Passphrase auto-backup belum diisi di perangkat ini.');
      }
      const seq = this.currentSeq();
      try {
        fs.mkdirSync(cfg.folder, { recursive: true });
        const { manifest, bytes } = this.createSnapshotBytes({ includeSecrets: cfg.includeSecrets });
        const file = encodeBackup({ manifest, dbBytes: bytes, passphrase });
        const prefix = `atelier-auto-${hostSlug()}-`;
        const name = `${prefix}${stamp()}${BACKUP_EXTENSION}`;
        const target = path.join(cfg.folder, name);
        const partial = `${target}.partial`;
        fs.writeFileSync(partial, file);
        fs.renameSync(partial, target);

        const old = fs
          .readdirSync(cfg.folder)
          .filter((f) => f.startsWith(prefix) && f.endsWith(BACKUP_EXTENSION))
          .sort()
          .reverse()
          .slice(cfg.keep);
        for (const f of old) fs.rmSync(path.join(cfg.folder, f), { force: true });

        this.writeAuto({
          ...this.readAuto(),
          lastRunAt: new Date().toISOString(),
          lastStatus: 'ok',
          lastError: null,
          lastFile: target,
          lastSeq: seq,
        });
      } catch (err) {
        this.writeAuto({
          ...this.readAuto(),
          lastRunAt: new Date().toISOString(),
          lastStatus: 'error',
          lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })();
    this.running = job;
    try {
      await job;
    } finally {
      this.running = null;
    }
    return this.getAutoConfig();
  }

  private isDue(): boolean {
    const cfg = this.readAuto();
    if (!cfg.enabled || !cfg.folder) return false;
    if (cfg.lastSeq !== null && cfg.lastSeq === this.currentSeq() && cfg.lastStatus === 'ok') return false;
    if (!cfg.lastRunAt) return true;
    return Date.now() - Date.parse(cfg.lastRunAt) >= cfg.intervalHours * 3_600_000;
  }

  public startScheduler(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running || !this.isDue()) return;
      this.runAutoBackup('schedule').catch((err) => {
        console.warn('[atelier] auto-backup failed:', err instanceof Error ? err.message : err);
      });
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    setTimeout(tick, 15_000).unref();
  }

  /** Called while the app shuts down: snapshot only if something changed since the last backup. */
  public async runOnClose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const cfg = this.readAuto();
    if (!cfg.enabled || !cfg.folder) return;
    if (cfg.lastStatus === 'ok' && cfg.lastSeq === this.currentSeq()) return;
    try {
      await this.runAutoBackup('close');
    } catch (err) {
      console.warn('[atelier] auto-backup on close failed:', err instanceof Error ? err.message : err);
    }
  }

  // ------------------------------------------------------------------ cloud folder detection

  public detectCloudFolders(): CloudFolderCandidate[] {
    const home = os.homedir();
    const seen = new Set<string>();
    const out: CloudFolderCandidate[] = [];
    const add = (provider: CloudFolderCandidate['provider'], label: string, root: string | undefined | null) => {
      if (!root) return;
      const resolved = path.resolve(root);
      const key = resolved.toLowerCase();
      if (seen.has(key)) return;
      try {
        if (!fs.statSync(resolved).isDirectory()) return;
      } catch {
        return;
      }
      seen.add(key);
      out.push({ provider, label, root: resolved, suggestedPath: path.join(resolved, 'Atelier Backups') });
    };

    add('onedrive', 'OneDrive', process.env.OneDriveConsumer);
    add('onedrive', 'OneDrive (Work/School)', process.env.OneDriveCommercial);
    add('onedrive', 'OneDrive', process.env.OneDrive);
    add('onedrive', 'OneDrive', path.join(home, 'OneDrive'));

    for (const infoBase of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      if (!infoBase) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(infoBase, 'Dropbox', 'info.json'), 'utf8')) as Record<
          string,
          { path?: string }
        >;
        add('dropbox', 'Dropbox', info.personal?.path);
        add('dropbox', 'Dropbox (Business)', info.business?.path);
      } catch {
        /* not installed */
      }
    }
    add('dropbox', 'Dropbox', path.join(home, 'Dropbox'));

    add('gdrive', 'Google Drive', path.join(home, 'Google Drive'));
    add('gdrive', 'Google Drive', path.join(home, 'My Drive'));
    if (process.platform === 'win32') {
      for (const letter of 'GHIJKLMNOPQRSTUVWXYZ') {
        for (const name of ['My Drive', 'Drive Saya']) {
          add('gdrive', `Google Drive (${letter}:)`, `${letter}:\\${name}`);
        }
      }
    }
    return out;
  }

  public shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
