import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BrowserProfile,
  CreateSiteCredentialInput,
  SiteCredential,
  SiteCredentialLastLogin,
  UpdateSiteCredentialInput,
} from '@atelier/contracts';
import type { AtelierDb } from '../db.js';
import { openBuffer, sealBuffer } from '../security/machine-key.js';

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function maskUsername(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return '…';
  const at = trimmed.indexOf('@');
  if (at > 0) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return `${visible}…@${domain}`;
  }
  if (trimmed.length <= 3) return `${trimmed.slice(0, 1)}…`;
  return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)}`;
}

function normalizeOrigin(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Origin harus menggunakan protokol http:// atau https://.');
  }
  return parsed.origin;
}

function normalizeHttpUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL harus menggunakan protokol http:// atau https://.');
  }
  return parsed.toString();
}

async function rmWithRetry(target: string, recursive: boolean): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(target, { recursive, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') && attempt < 4) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

export class CredentialStore {
  private readonly profilesRoot: string;

  constructor(
    private readonly db: AtelierDb,
    private readonly dataDir: string,
  ) {
    this.profilesRoot = path.resolve(dataDir, 'browser-profiles');
  }

  public getProfileDir(profileId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
      throw new Error(`Invalid browser profile ID: ${profileId}`);
    }
    const dir = path.resolve(this.profilesRoot, profileId);
    if (!dir.startsWith(this.profilesRoot + path.sep)) {
      throw new Error('Invalid browser profile path.');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------------------------------------------------------------- profiles

  public listProfiles(): BrowserProfile[] {
    const rows = this.db.sqlite
      .prepare(`SELECT data FROM browser_profiles ORDER BY id ASC`)
      .all() as Array<{ data: string }>;
    return rows
      .map((r) => JSON.parse(r.data) as BrowserProfile)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public getProfile(id: string): BrowserProfile | null {
    const row = this.db.sqlite
      .prepare(`SELECT data FROM browser_profiles WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as BrowserProfile) : null;
  }

  public createProfile(name: string): BrowserProfile {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Nama profil browser wajib diisi.');
    const profile: BrowserProfile = {
      id: newId('bpr'),
      name: trimmed.slice(0, 60),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.db.sqlite
      .prepare(`INSERT INTO browser_profiles (id, data) VALUES (?, ?)`)
      .run(profile.id, JSON.stringify(profile));
    fs.mkdirSync(this.getProfileDir(profile.id), { recursive: true });
    return profile;
  }

  public updateProfile(id: string, patch: { name?: string }): BrowserProfile | null {
    const existing = this.getProfile(id);
    if (!existing) return null;
    const next: BrowserProfile = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim().slice(0, 60) || existing.name : existing.name,
    };
    this.db.sqlite
      .prepare(`UPDATE browser_profiles SET data = ? WHERE id = ?`)
      .run(JSON.stringify(next), id);
    return next;
  }

  public touchProfile(id: string): void {
    const existing = this.getProfile(id);
    if (!existing) return;
    const next: BrowserProfile = { ...existing, lastUsedAt: new Date().toISOString() };
    this.db.sqlite
      .prepare(`UPDATE browser_profiles SET data = ? WHERE id = ?`)
      .run(JSON.stringify(next), id);
  }

  public async clearProfileCookies(id: string): Promise<boolean> {
    const existing = this.getProfile(id);
    if (!existing) return false;
    const dir = this.getProfileDir(id);
    if (fs.existsSync(dir)) {
      await rmWithRetry(dir, true);
    }
    fs.mkdirSync(dir, { recursive: true });
    return true;
  }

  public async deleteProfile(id: string): Promise<boolean> {
    const existing = this.getProfile(id);
    if (!existing) return false;
    this.db.sqlite.prepare(`DELETE FROM browser_profiles WHERE id = ?`).run(id);
    const dir = path.resolve(this.profilesRoot, id);
    if (dir.startsWith(this.profilesRoot + path.sep) && fs.existsSync(dir)) {
      await rmWithRetry(dir, true);
    }
    return true;
  }

  public ensureProfile(profileId?: string | null, defaultName = 'Default'): BrowserProfile {
    if (profileId) {
      const existing = this.getProfile(profileId);
      if (existing) return existing;
    }
    const existingByName = this.listProfiles().find(
      (p) => p.name.toLowerCase() === defaultName.trim().toLowerCase(),
    );
    if (existingByName) return existingByName;
    return this.createProfile(defaultName);
  }

  // ---------------------------------------------------------------- credentials

  private sanitizeCredential(cred: SiteCredential): SiteCredential {
    return {
      ...cred,
      maskedUsername: maskUsername(cred.username),
    };
  }

  public listCredentials(): SiteCredential[] {
    const rows = this.db.sqlite
      .prepare(`SELECT data FROM site_credentials ORDER BY id ASC`)
      .all() as Array<{ data: string }>;
    return rows
      .map((r) => this.sanitizeCredential(JSON.parse(r.data) as SiteCredential))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public getCredential(id: string): SiteCredential | null {
    const row = this.db.sqlite
      .prepare(`SELECT data FROM site_credentials WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? this.sanitizeCredential(JSON.parse(row.data) as SiteCredential) : null;
  }

  public findCredentialBySite(siteRef: string, allowedCredentialIds?: string[]): SiteCredential | null {
    const needle = siteRef.trim().toLowerCase();
    if (!needle) return null;
    let all = this.listCredentials();
    if (allowedCredentialIds) {
      const allow = new Set(allowedCredentialIds);
      all = all.filter((c) => allow.has(c.id));
    }
    return (
      all.find((c) => c.id.toLowerCase() === needle) ??
      all.find((c) => (c.presetId ?? '').toLowerCase() === needle) ??
      all.find((c) => c.label.toLowerCase() === needle) ??
      all.find((c) => c.origin.toLowerCase().includes(needle) || c.label.toLowerCase().includes(needle)) ??
      null
    );
  }

  public createCredential(input: CreateSiteCredentialInput): SiteCredential {
    const label = input.label.trim();
    const username = input.username.trim();
    const password = input.password;
    if (!label) throw new Error('Label situs wajib diisi.');
    if (!username) throw new Error('Email / username wajib diisi.');
    if (!password) throw new Error('Password wajib diisi.');

    const loginUrl = normalizeHttpUrl(input.loginUrl);
    const origin = normalizeOrigin(input.origin || loginUrl);
    const profile = this.ensureProfile(input.profileId, label);
    const now = new Date().toISOString();

    const credential: SiteCredential = {
      id: newId('crd'),
      label: label.slice(0, 80),
      presetId: input.presetId ?? null,
      origin,
      loginUrl,
      username,
      profileId: profile.id,
      ...(input.selectors ? { selectors: input.selectors } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const sealed = sealBuffer(this.dataDir, Buffer.from(password, 'utf8'));
    this.db.sqlite
      .prepare(`INSERT INTO site_credentials (id, data, secret) VALUES (?, ?, ?)`)
      .run(credential.id, JSON.stringify(credential), sealed);

    return this.sanitizeCredential(credential);
  }

  public updateCredential(id: string, patch: UpdateSiteCredentialInput): SiteCredential | null {
    const row = this.db.sqlite
      .prepare(`SELECT data, secret FROM site_credentials WHERE id = ?`)
      .get(id) as { data: string; secret: Uint8Array } | undefined;
    if (!row) return null;

    const current = JSON.parse(row.data) as SiteCredential;
    const nextLoginUrl =
      patch.loginUrl !== undefined ? normalizeHttpUrl(patch.loginUrl) : current.loginUrl;
    const nextOrigin =
      patch.origin !== undefined ? normalizeOrigin(patch.origin) : current.origin;

    let nextProfileId = current.profileId;
    if (patch.profileId !== undefined && patch.profileId !== current.profileId) {
      if (!this.getProfile(patch.profileId)) {
        throw new Error(`Profil browser ${patch.profileId} tidak ditemukan.`);
      }
      nextProfileId = patch.profileId;
    }

    const updated: SiteCredential = {
      ...current,
      label: patch.label !== undefined ? patch.label.trim().slice(0, 80) || current.label : current.label,
      presetId: patch.presetId !== undefined ? patch.presetId : current.presetId,
      origin: nextOrigin,
      loginUrl: nextLoginUrl,
      username: patch.username !== undefined ? patch.username.trim() || current.username : current.username,
      profileId: nextProfileId,
      selectors: patch.selectors !== undefined ? patch.selectors : current.selectors,
      updatedAt: new Date().toISOString(),
    };

    const nextSecret =
      typeof patch.password === 'string' && patch.password.length > 0
        ? sealBuffer(this.dataDir, Buffer.from(patch.password, 'utf8'))
        : Buffer.from(row.secret);

    this.db.sqlite
      .prepare(`UPDATE site_credentials SET data = ?, secret = ? WHERE id = ?`)
      .run(JSON.stringify(updated), nextSecret, id);

    return this.sanitizeCredential(updated);
  }

  public updateLastLogin(id: string, lastLogin: SiteCredentialLastLogin): SiteCredential | null {
    const row = this.db.sqlite
      .prepare(`SELECT data FROM site_credentials WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    const current = JSON.parse(row.data) as SiteCredential;
    const updated: SiteCredential = {
      ...current,
      lastLogin,
      updatedAt: new Date().toISOString(),
    };
    this.db.sqlite
      .prepare(`UPDATE site_credentials SET data = ? WHERE id = ?`)
      .run(JSON.stringify(updated), id);
    return this.sanitizeCredential(updated);
  }

  public deleteCredential(id: string): boolean {
    const res = this.db.sqlite.prepare(`DELETE FROM site_credentials WHERE id = ?`).run(id);
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * Decrypts the password ONLY when `currentUrlOrOrigin` matches `credential.origin` exactly.
   * Never expose the returned password outside `login.ts`.
   */
  public getSecretForOrigin(
    id: string,
    currentUrlOrOrigin: string,
  ): { credential: SiteCredential; password: string } {
    const row = this.db.sqlite
      .prepare(`SELECT data, secret FROM site_credentials WHERE id = ?`)
      .get(id) as { data: string; secret: Uint8Array } | undefined;
    if (!row) {
      throw new Error(`Kredensial ${id} tidak ditemukan.`);
    }
    const credential = JSON.parse(row.data) as SiteCredential;

    let actualOrigin: string;
    try {
      actualOrigin = new URL(currentUrlOrOrigin).origin;
    } catch {
      throw new Error('Origin halaman saat ini tidak valid.');
    }

    const expectedOrigin = new URL(credential.origin).origin;
    if (actualOrigin !== expectedOrigin) {
      throw new Error(
        `Origin halaman (${actualOrigin}) tidak cocok dengan origin kredensial (${expectedOrigin}).`,
      );
    }

    const rawSecret = Buffer.from(row.secret);
    if (rawSecret.length === 0) {
      throw new Error('Password kosong atau perlu diisi ulang di Settings → Browser & Login.');
    }
    const plain = openBuffer(this.dataDir, rawSecret);
    if (!plain || plain.length === 0) {
      throw new Error('Password tidak dapat didekripsi. Isi ulang password di Settings → Browser & Login.');
    }
    return { credential: this.sanitizeCredential(credential), password: plain.toString('utf8') };
  }

  /**
   * Used exclusively by `policy.redactSecrets()` to strip any credential secret from tool outputs.
   */
  public getAllActiveSecrets(): string[] {
    const rows = this.db.sqlite
      .prepare(`SELECT secret FROM site_credentials`)
      .all() as Array<{ secret: Uint8Array }>;
    const secrets: string[] = [];
    for (const row of rows) {
      const raw = Buffer.from(row.secret);
      if (raw.length === 0) continue;
      const plain = openBuffer(this.dataDir, raw);
      if (plain && plain.length > 0) {
        secrets.push(plain.toString('utf8'));
      }
    }
    return secrets;
  }
}
