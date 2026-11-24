import crypto from 'node:crypto';
import type { AuthStatus } from '@atelier/contracts';
import type { AtelierDb } from '../db.js';

/**
 * Optional local app lock.
 *
 * - Off by default; the first-run experience stays frictionless.
 * - Passwords and the one-time recovery key are hashed with Node's built-in scrypt + random salt.
 * - Sessions are random tokens kept in memory only (a restart always requires a fresh login),
 *   delivered as an `HttpOnly; SameSite=Strict` cookie and expired after an idle timeout.
 * - The lock config lives in the machine-local `app_lock` table, which is never exported in
 *   backups nor overwritten by an import.
 */

export const SESSION_COOKIE = 'atelier_session';
export const DEFAULT_IDLE_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 8;

// scrypt cost: N=2^15, r=8 -> ~32 MiB of memory, roughly 50-100 ms per hash on a laptop.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 } as const;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

interface ScryptHash {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  hash: string; // base64
}

interface LockRecord {
  enabled: boolean;
  password: ScryptHash;
  recovery: ScryptHash;
  idleMinutes: number;
  createdAt: string;
  updatedAt: string;
}

interface Session {
  lastSeen: number;
  createdAt: number;
}

export class VaultError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 401 | 403 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

function scryptAsync(secret: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      secret.normalize('NFKC'),
      salt,
      SCRYPT.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashSecret(secret: string): Promise<ScryptHash> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(secret, salt, SCRYPT);
  return {
    algo: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
  };
}

export async function verifySecret(secret: string, stored: ScryptHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await scryptAsync(secret, Buffer.from(stored.salt, 'base64'), stored);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** 25 random chars from a 32-symbol alphabet = 125 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateRecoveryKey(): string {
  const bytes = crypto.randomBytes(25);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % 32]);
  const groups: string[] = [];
  for (let i = 0; i < 25; i += 5) groups.push(chars.slice(i, i + 5).join(''));
  return groups.join('-');
}

export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function parseCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export class LocalVault {
  private readonly sessions = new Map<string, Session>();
  private readonly revokeListeners = new Set<(token: string) => void>();
  private failedAttempts = 0;
  private lockedUntil = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly db: AtelierDb) {
    this.sweeper = setInterval(() => this.sweepExpired(), 30_000);
    this.sweeper.unref();
  }

  // ---------- persistence ----------

  private readRecord(): LockRecord | null {
    const row = this.db.sqlite.prepare(`SELECT data FROM app_lock WHERE id = 1`).get() as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as LockRecord;
    } catch {
      return null;
    }
  }

  private writeRecord(record: LockRecord | null): void {
    if (!record) {
      this.db.sqlite.prepare(`DELETE FROM app_lock WHERE id = 1`).run();
      return;
    }
    this.db.sqlite
      .prepare(
        `INSERT INTO app_lock (id, data) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(JSON.stringify(record));
  }

  public isEnabled(): boolean {
    return this.readRecord()?.enabled === true;
  }

  public getIdleMinutes(): number {
    return this.readRecord()?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  }

  // ---------- sessions ----------

  public onRevoke(listener: (token: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private revoke(token: string): void {
    if (this.sessions.delete(token)) {
      for (const l of this.revokeListeners) l(token);
    }
  }

  public revokeAll(): void {
    for (const token of [...this.sessions.keys()]) this.revoke(token);
  }

  private createSession(): string {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, { lastSeen: now, createdAt: now });
    return token;
  }

  private sweepExpired(): void {
    const idleMs = this.getIdleMinutes() * 60_000;
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (now - s.lastSeen > idleMs) this.revoke(token);
    }
  }

  /** Validates a session token. `touch` extends the idle timer (HTTP requests and heartbeats). */
  public checkSession(token: string | null, touch = true): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() - session.lastSeen > this.getIdleMinutes() * 60_000) {
      this.revoke(token);
      return false;
    }
    if (touch) session.lastSeen = Date.now();
    return true;
  }

  /** True when the request may proceed: lock disabled, or a valid session. */
  public isAuthorized(token: string | null, touch = true): boolean {
    if (!this.isEnabled()) return true;
    return this.checkSession(token, touch);
  }

  public status(token: string | null): AuthStatus {
    const record = this.readRecord();
    const enabled = record?.enabled === true;
    return {
      enabled,
      authenticated: enabled ? this.checkSession(token, false) : true,
      idleMinutes: record?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      retryAfterSeconds: this.retryAfterSeconds(),
    };
  }

  // ---------- brute-force throttle ----------

  private retryAfterSeconds(): number {
    const ms = this.lockedUntil - Date.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  private assertNotThrottled(): void {
    const wait = this.retryAfterSeconds();
    if (wait > 0) {
      throw new VaultError('too_many_attempts', `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`, 429);
    }
  }

  private registerFailure(): void {
    this.failedAttempts += 1;
    if (this.failedAttempts >= 5) {
      // 5 fails -> 30 s, then doubles up to 15 min.
      const exp = Math.min(this.failedAttempts - 5, 5);
      this.lockedUntil = Date.now() + Math.min(30_000 * 2 ** exp, 15 * 60_000);
    }
  }

  private resetFailures(): void {
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }

  private static assertPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new VaultError('weak_password', `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`);
    }
    if (password.length > 256) {
      throw new VaultError('weak_password', 'Password terlalu panjang (maks 256 karakter).');
    }
  }

  private static clampIdle(minutes: number | undefined): number {
    const m = Math.round(Number(minutes ?? DEFAULT_IDLE_MINUTES));
    if (!Number.isFinite(m)) return DEFAULT_IDLE_MINUTES;
    return Math.min(Math.max(m, 1), 24 * 60);
  }

  // ---------- commands ----------

  public async enable(password: string, idleMinutes?: number): Promise<{ token: string; recoveryKey: string }> {
    if (this.isEnabled()) throw new VaultError('already_enabled', 'App lock sudah aktif.', 409);
    LocalVault.assertPassword(password);
    const recoveryKey = generateRecoveryKey();
    const now = new Date().toISOString();
    this.writeRecord({
      enabled: true,
      password: await hashSecret(password),
      recovery: await hashSecret(normalizeRecoveryKey(recoveryKey)),
      idleMinutes: LocalVault.clampIdle(idleMinutes),
      createdAt: now,
      updatedAt: now,
    });
    this.revokeAll();
    return { token: this.createSession(), recoveryKey };
  }

  public async login(password: string): Promise<string> {
    const record = this.readRecord();
    if (!record?.enabled) throw new VaultError('not_enabled', 'App lock tidak aktif.', 409);
    this.assertNotThrottled();
    if (typeof password !== 'string' || !(await verifySecret(password, record.password))) {
      this.registerFailure();
      throw new VaultError('invalid_password', 'Password salah.', 401);
    }
    this.resetFailures();
    return this.createSession();
  }

  public logout(token: string | null): void {
    if (token) this.revoke(token);
  }

  private async requirePassword(password: string): Promise<LockRecord> {
    const record = this.readRecord();
    if (!record?.enabled) throw new VaultError('not_enabled', 'App lock tidak aktif.', 409);
    this.assertNotThrottled();
    if (typeof password !== 'string' || !(await verifySecret(password, record.password))) {
      this.registerFailure();
      throw new VaultError('invalid_password', 'Password salah.', 401);
    }
    this.resetFailures();
    return record;
  }

  public async disable(password: string): Promise<void> {
    await this.requirePassword(password);
    this.writeRecord(null);
    this.revokeAll();
  }

  public async changePassword(current: string, next: string): Promise<string> {
    const record = await this.requirePassword(current);
    LocalVault.assertPassword(next);
    this.writeRecord({
      ...record,
      password: await hashSecret(next),
      updatedAt: new Date().toISOString(),
    });
    this.revokeAll();
    return this.createSession();
  }

  public async regenerateRecoveryKey(password: string): Promise<string> {
    const record = await this.requirePassword(password);
    const recoveryKey = generateRecoveryKey();
    this.writeRecord({
      ...record,
      recovery: await hashSecret(normalizeRecoveryKey(recoveryKey)),
      updatedAt: new Date().toISOString(),
    });
    return recoveryKey;
  }

  /** Resets the password with the one-time recovery key, which is then rotated. */
  public async recover(
    recoveryKey: string,
    newPassword: string,
  ): Promise<{ token: string; recoveryKey: string }> {
    const record = this.readRecord();
    if (!record?.enabled) throw new VaultError('not_enabled', 'App lock tidak aktif.', 409);
    this.assertNotThrottled();
    LocalVault.assertPassword(newPassword);
    if (
      typeof recoveryKey !== 'string' ||
      !(await verifySecret(normalizeRecoveryKey(recoveryKey), record.recovery))
    ) {
      this.registerFailure();
      throw new VaultError('invalid_recovery_key', 'Recovery key salah.', 401);
    }
    this.resetFailures();
    const nextKey = generateRecoveryKey();
    this.writeRecord({
      ...record,
      password: await hashSecret(newPassword),
      recovery: await hashSecret(normalizeRecoveryKey(nextKey)),
      updatedAt: new Date().toISOString(),
    });
    this.revokeAll();
    return { token: this.createSession(), recoveryKey: nextKey };
  }

  public setIdleMinutes(minutes: number): number {
    const record = this.readRecord();
    if (!record?.enabled) throw new VaultError('not_enabled', 'App lock tidak aktif.', 409);
    const idleMinutes = LocalVault.clampIdle(minutes);
    this.writeRecord({ ...record, idleMinutes, updatedAt: new Date().toISOString() });
    return idleMinutes;
  }

  /** Lock every open session now (tray "Lock now", or after an import). */
  public lockNow(): void {
    this.revokeAll();
  }

  public shutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.sessions.clear();
  }
}

/** Used by the local CLI (`npm run lock:reset`) when the password and recovery key are both lost. */
export function resetLockDirect(db: AtelierDb): boolean {
  const had = Boolean(db.sqlite.prepare(`SELECT 1 AS x FROM app_lock WHERE id = 1`).get());
  db.sqlite.prepare(`DELETE FROM app_lock WHERE id = 1`).run();
  return had;
}
