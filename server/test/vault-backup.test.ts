import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AutoBackupConfig, BackupImportResult } from '@atelier/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { decodeBackup } from '../src/backup/format.js';
import { runResetLock } from '../src/cli/reset-lock.js';
import { AtelierDb } from '../src/db.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';
import { LocalVault } from '../src/security/vault.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function boot(label: string): Promise<{ handle: AtelierServerHandle; base: string; dir: string }> {
  const dir = makeTempDir(`atelier-${label}-`);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
    },
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dir };
}

function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  expect(raw).toMatch(/HttpOnly/i);
  expect(raw).toMatch(/SameSite=Strict/i);
  return raw.split(';')[0]!;
}

function wsOpens(port: number, cookie?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: cookie ? { cookie } : {},
    });
    ws.on('message', () => {
      ws.close();
      resolve(true);
    });
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', () => resolve(false));
  });
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Local app lock (scrypt + HttpOnly session + idle timeout)', () => {
  it('is off by default, then protects /api/* and /ws once enabled, with recovery + CLI reset', async () => {
    const { handle, base } = await boot('lock');

    // Default: frictionless.
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toMatchObject({ enabled: false, authenticated: true });
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect(await wsOpens(handle.port)).toBe(true);

    // Weak password rejected.
    expect((await fetch(`${base}/api/auth/enable`, json({ password: 'short' }))).status).toBe(400);

    const enable = await fetch(`${base}/api/auth/enable`, json({ password: 'correct horse', idleMinutes: 5 }));
    expect(enable.status).toBe(200);
    const session = cookieFrom(enable);
    const { recoveryKey } = (await enable.json()) as { recoveryKey: string };
    expect(recoveryKey).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/);

    // Hash only — no plaintext stored.
    const lockRow = handle.db.sqlite.prepare(`SELECT data FROM app_lock`).get() as { data: string };
    expect(lockRow.data).not.toContain('correct horse');
    expect(lockRow.data).not.toContain(recoveryKey);
    expect(JSON.parse(lockRow.data).password.algo).toBe('scrypt');

    // Locked without cookie: API + WS. Public lock-screen routes still answer.
    const locked = await fetch(`${base}/api/state`);
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('locked');
    expect((await fetch(`${base}/api/backup/auto`)).status).toBe(401);
    expect(await wsOpens(handle.port)).toBe(false);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);

    // With cookie: OK.
    expect((await fetch(`${base}/api/state`, { headers: { cookie: session } })).status).toBe(200);
    expect(await wsOpens(handle.port, session)).toBe(true);

    // Wrong password.
    expect((await fetch(`${base}/api/auth/login`, json({ password: 'nope nope' }))).status).toBe(401);
    const login = await fetch(`${base}/api/auth/login`, json({ password: 'correct horse' }));
    expect(login.status).toBe(200);
    const session2 = cookieFrom(login);

    // Lock now revokes every session (and kicks its socket).
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, { headers: { cookie: session2 } });
    const closeCode = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((r) => ws.once('message', r));
    await fetch(`${base}/api/auth/lock-now`, { method: 'POST', headers: { cookie: session2 } });
    expect(await closeCode).toBe(4401);
    expect((await fetch(`${base}/api/state`, { headers: { cookie: session } })).status).toBe(401);

    // Recovery key resets the password and rotates the key (old key is single-use).
    const recover = await fetch(
      `${base}/api/auth/recover`,
      json({ recoveryKey: recoveryKey.toLowerCase(), newPassword: 'battery staple' }),
    );
    expect(recover.status).toBe(200);
    const { recoveryKey: rotated } = (await recover.json()) as { recoveryKey: string };
    expect(rotated).not.toBe(recoveryKey);
    expect(
      (await fetch(`${base}/api/auth/recover`, json({ recoveryKey, newPassword: 'whatever123' }))).status,
    ).toBe(401);
    expect((await fetch(`${base}/api/auth/login`, json({ password: 'battery staple' }))).status).toBe(200);

    // CLI reset (password and key both lost).
    const dataDir = handle.config.dataDir;
    await handle.close();
    handles.pop();
    expect(runResetLock(dataDir).removed).toBe(true);
    const db = new AtelierDb(path.join(dataDir, 'atelier.db'));
    expect(new LocalVault(db).isEnabled()).toBe(false);
    db.close();
  });

  it('expires idle sessions and throttles brute force', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = makeTempDir('atelier-vault-');
    const db = new AtelierDb(path.join(dir, 'a.db'));
    const vault = new LocalVault(db);
    try {
      const { token } = await vault.enable('long enough pw', 2);
      const revoked: string[] = [];
      vault.onRevoke((t) => revoked.push(t));
      expect(vault.isAuthorized(token)).toBe(true);
      vi.advanceTimersByTime(90_000);
      expect(vault.isAuthorized(token)).toBe(true); // touch resets idle timer
      vi.advanceTimersByTime(121_000);
      expect(vault.isAuthorized(token)).toBe(false);
      expect(revoked).toEqual([token]);

      for (let i = 0; i < 5; i++) await expect(vault.login('wrong')).rejects.toMatchObject({ code: 'invalid_password' });
      await expect(vault.login('long enough pw')).rejects.toMatchObject({ code: 'too_many_attempts' });
      vi.advanceTimersByTime(31_000);
      await expect(vault.login('long enough pw')).resolves.toBeTypeOf('string');
    } finally {
      vault.shutdown();
      db.close();
    }
  });
});

describe('Portable migration (.atelier-backup)', () => {
  it('exports a VACUUM INTO snapshot, strips secrets unless encrypted, and imports with relink candidates', async () => {
    const a = await boot('src');
    const project = a.handle.store.createProject({ name: 'Moving Day', starterAgents: [{ name: 'Bot', role: 'Eng' }] })
      .project;
    a.handle.store.updateProject(project.id, {
      repo: { fullName: 'acme/web', defaultBranch: 'main', localPath: 'Z:\\gone\\acme-web' },
    });
    a.handle.store.setProviderSecret('deepseek', 'sk-super-secret-123');
    a.handle.store.setMcpOAuth('srv1', JSON.stringify({ accessToken: 'oauth-tok-xyz' }));

    // Lock on the source machine must not travel with the backup.
    const en = await fetch(`${a.base}/api/auth/enable`, json({ password: 'source machine pw' }));
    const cookie = cookieFrom(en);
    const authed = (body: unknown) => ({ ...json(body), headers: { 'Content-Type': 'application/json', cookie } });

    // includeSecrets without a passphrase is refused.
    expect((await fetch(`${a.base}/api/backup/export`, authed({ includeSecrets: true }))).status).toBe(400);

    // 1) Plain export: no secrets inside.
    const plainRes = await fetch(`${a.base}/api/backup/export`, authed({}));
    expect(plainRes.status).toBe(200);
    expect(plainRes.headers.get('content-disposition')).toMatch(/\.atelier-backup"/);
    const plain = Buffer.from(await plainRes.arrayBuffer());
    const decodedPlain = decodeBackup(plain, null);
    expect(decodedPlain.manifest.includesSecrets).toBe(false);
    expect(decodedPlain.dbBytes.includes(Buffer.from('sk-super-secret-123'))).toBe(false);
    expect(decodedPlain.dbBytes.includes(Buffer.from('oauth-tok-xyz'))).toBe(false);

    // 2) Encrypted export with secrets.
    const encRes = await fetch(
      `${a.base}/api/backup/export`,
      authed({ passphrase: 'pindah laptop 2026', includeSecrets: true }),
    );
    const enc = Buffer.from(await encRes.arrayBuffer());
    expect(enc.includes(Buffer.from('Moving Day'))).toBe(false); // nothing readable at rest
    expect(() => decodeBackup(enc, null)).toThrow(/terenkripsi/);
    expect(() => decodeBackup(enc, 'wrong passphrase')).toThrow(/Passphrase salah/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 40] ^= 0xff;
    expect(() => decodeBackup(tampered, 'pindah laptop 2026')).toThrow();
    const snap = decodeBackup(enc, 'pindah laptop 2026');
    const snapPath = path.join(a.dir, 'peek.db');
    fs.writeFileSync(snapPath, snap.dbBytes);
    const peek = new DatabaseSync(snapPath);
    expect(peek.prepare(`SELECT COUNT(*) AS n FROM app_lock`).get()).toEqual({ n: 0 });
    expect(peek.prepare(`SELECT data FROM provider_secrets WHERE provider='deepseek'`).get()).toEqual({
      data: 'sk-super-secret-123',
    });
    peek.close();

    // 3) Import on a "new laptop".
    const b = await boot('dst');
    b.handle.store.setProviderSecret('openai', 'sk-local-only');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(enc)]), 'x.atelier-backup');
    const missing = await fetch(`${b.base}/api/backup/import`, { method: 'POST', body: form });
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('passphrase_required');

    form.set('passphrase', 'pindah laptop 2026');
    const imp = await fetch(`${b.base}/api/backup/import`, { method: 'POST', body: form });
    expect(imp.status).toBe(200);
    const result = (await imp.json()) as BackupImportResult;
    expect(result.includesSecrets).toBe(true);
    expect(fs.existsSync(result.safetyCopy)).toBe(true);
    expect(result.relink).toEqual([
      expect.objectContaining({ projectId: project.id, repoFullName: 'acme/web', canClone: true }),
    ]);
    expect(b.handle.store.listProjects().map((p) => p.name)).toEqual(['Moving Day']);
    expect(b.handle.store.getProviderSecret('deepseek')).toBe('sk-super-secret-123');
    // Destination stays unlocked: app_lock is machine-local.
    expect((await fetch(`${b.base}/api/state`)).status).toBe(200);

    // 4) Importing a secret-less backup keeps this machine's own secrets.
    const form2 = new FormData();
    form2.set('file', new Blob([new Uint8Array(plain)]), 'p.atelier-backup');
    b.handle.store.setProviderSecret('openai', 'sk-local-only');
    expect((await fetch(`${b.base}/api/backup/import`, { method: 'POST', body: form2 })).status).toBe(200);
    expect(b.handle.store.getProviderSecret('openai')).toBe('sk-local-only');

    // 5) Relink via the existing repo endpoint clears the candidate.
    const repoDir = makeTempDir('atelier-relink-');
    const link = await fetch(`${b.base}/api/projects/${project.id}/repo`, json({ localPath: repoDir, fullName: 'acme/web' }));
    expect(link.status).toBe(200);
    expect(((await (await fetch(`${b.base}/api/backup/relink`)).json()) as { relink: unknown[] }).relink).toEqual([]);
  });

  it('auto-backs up encrypted snapshots to a cloud folder with atomic writes and rotation', async () => {
    const { base, dir, handle } = await boot('auto');
    const cloud = path.join(dir, 'OneDrive', 'Atelier Backups');

    const noPass = await fetch(`${base}/api/backup/auto`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, folder: cloud }),
    });
    expect(noPass.status).toBe(400);

    const put = await fetch(`${base}/api/backup/auto`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, folder: cloud, passphrase: 'cloud passphrase', keep: 2 }),
    });
    const { config } = (await put.json()) as { config: AutoBackupConfig };
    expect(config).toMatchObject({ enabled: true, passphraseSet: true, keep: 2 });
    expect(JSON.stringify(config)).not.toContain('cloud passphrase');
    const stored = handle.db.sqlite.prepare(`SELECT data FROM backup_config`).get() as { data: string };
    expect(stored.data).not.toContain('cloud passphrase');

    for (let i = 0; i < 3; i++) {
      handle.store.createProject({ name: `P${i}` });
      const run = await fetch(`${base}/api/backup/auto/run`, { method: 'POST' });
      expect(run.status).toBe(200);
      await new Promise((r) => setTimeout(r, 1100)); // distinct timestamps in filenames
    }
    const files = fs.readdirSync(cloud);
    expect(files.filter((f) => f.endsWith('.atelier-backup'))).toHaveLength(2);
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);
    const latest = files.sort().at(-1)!;
    const decoded = decodeBackup(fs.readFileSync(path.join(cloud, latest)), 'cloud passphrase');
    expect(decoded.manifest.projects.map((p) => p.name)).toContain('P2');
  });
});
