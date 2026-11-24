import type { ApiErrorResponse } from '@atelier/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { BackupError, type BackupService } from '../backup/service.js';
import { BackupFormatError } from '../backup/format.js';
import type { EventBus } from '../bus.js';
import { type LocalVault, SESSION_COOKIE, VaultError } from './vault.js';

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Routes reachable while locked (the lock screen itself, health probe, OAuth redirect target). */
const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/status',
  '/auth/login',
  '/auth/logout',
  '/auth/recover',
  // The OAuth provider redirects the popup here from a third-party site, so a SameSite=Strict
  // cookie is never sent. The handler is protected by the one-time PKCE `state` instead.
  '/mcp/oauth/callback',
]);

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/' });
}

function relativePath(c: Context): string {
  return c.req.path.replace(/^\/api(?=\/|$)/, '') || '/';
}

/** Blocks every `/api/*` route (except PUBLIC_PATHS) while the app lock is on and the caller has no valid session. */
export function lockGate(vault: LocalVault): MiddlewareHandler {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(relativePath(c))) return next();
    // touch=false: background polling must not keep an idle session alive; only real user
    // activity (heartbeat) and WebSocket connects extend the idle timer.
    if (!vault.isAuthorized(getCookie(c, SESSION_COOKIE) ?? null, false)) {
      return c.json(apiError('locked', 'Atelier terkunci. Masukkan password untuk membuka.'), 401);
    }
    return next();
  };
}

function handleError(c: Context, err: unknown) {
  if (err instanceof VaultError) {
    if (err.status === 429) c.header('Retry-After', String(30));
    return c.json(apiError(err.code, err.message), err.status);
  }
  if (err instanceof BackupFormatError) {
    return c.json(apiError(err.code, err.message), 400);
  }
  if (err instanceof BackupError) {
    return c.json(apiError(err.code, err.message), err.status);
  }
  console.error('[atelier] security route failed:', err);
  return c.json(apiError('internal_error', err instanceof Error ? err.message : 'Unexpected error.'), 500);
}

export function createSecurityRoutes(deps: {
  vault: LocalVault;
  backup: BackupService;
  bus: EventBus;
}): Hono {
  const { vault, backup, bus } = deps;
  const api = new Hono();
  const token = (c: Context) => getCookie(c, SESSION_COOKIE) ?? null;
  const password = z.string().min(1).max(256);

  // ---------------------------------------------------------------- auth
  api.get('/auth/status', (c) => c.json(vault.status(token(c))));

  api.post('/auth/login', async (c) => {
    const parsed = z.object({ password }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Password wajib diisi.'), 400);
    try {
      setSessionCookie(c, await vault.login(parsed.data.password));
      return c.json({ ok: true, status: vault.status(null) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/logout', (c) => {
    vault.logout(token(c));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  api.post('/auth/heartbeat', (c) => {
    if (vault.isEnabled()) vault.checkSession(token(c), true);
    return c.json({ ok: true });
  });

  api.post('/auth/recover', async (c) => {
    const parsed = z
      .object({ recoveryKey: z.string().min(1).max(200), newPassword: password })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Recovery key dan password baru wajib diisi.'), 400);
    try {
      const out = await vault.recover(parsed.data.recoveryKey, parsed.data.newPassword);
      setSessionCookie(c, out.token);
      return c.json({ ok: true, recoveryKey: out.recoveryKey });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/enable', async (c) => {
    const parsed = z
      .object({ password, idleMinutes: z.number().int().min(1).max(1440).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Input tidak valid.'), 400);
    try {
      const out = await vault.enable(parsed.data.password, parsed.data.idleMinutes);
      // Every other open tab/window must now authenticate.
      bus.disconnectAll();
      setSessionCookie(c, out.token);
      return c.json({ ok: true, recoveryKey: out.recoveryKey });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/disable', async (c) => {
    const parsed = z.object({ password }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Password wajib diisi.'), 400);
    try {
      await vault.disable(parsed.data.password);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/change-password', async (c) => {
    const parsed = z
      .object({ currentPassword: password, newPassword: password })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Input tidak valid.'), 400);
    try {
      setSessionCookie(c, await vault.changePassword(parsed.data.currentPassword, parsed.data.newPassword));
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/recovery-key', async (c) => {
    const parsed = z.object({ password }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Password wajib diisi.'), 400);
    try {
      return c.json({ ok: true, recoveryKey: await vault.regenerateRecoveryKey(parsed.data.password) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.patch('/auth/settings', async (c) => {
    const parsed = z
      .object({ idleMinutes: z.number().int().min(1).max(1440) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Idle timeout 1–1440 menit.'), 400);
    try {
      vault.setIdleMinutes(parsed.data.idleMinutes);
      return c.json(vault.status(token(c)));
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/auth/lock-now', (c) => {
    vault.lockNow();
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- backup
  api.post('/backup/export', async (c) => {
    const parsed = z
      .object({
        passphrase: z.string().max(512).nullable().optional(),
        includeSecrets: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Input tidak valid.'), 400);
    try {
      const { filename, bytes } = backup.exportBackup(parsed.data);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
          'X-Atelier-Filename': filename,
        },
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/backup/import', async (c) => {
    try {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) {
        return c.json(apiError('file_required', 'Pilih file .atelier-backup.'), 400);
      }
      if (file.size > MAX_IMPORT_BYTES) {
        return c.json(apiError('file_too_large', 'File backup lebih dari 1 GB.'), 400);
      }
      const passphrase = typeof form.passphrase === 'string' && form.passphrase.length > 0 ? form.passphrase : null;
      const result = await backup.importBackup(Buffer.from(await file.arrayBuffer()), passphrase);
      return c.json(result);
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.get('/backup/relink', (c) => c.json({ relink: backup.getRelinkCandidates() }));

  api.get('/backup/auto', (c) => c.json({ config: backup.getAutoConfig() }));

  api.put('/backup/auto', async (c) => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        folder: z.string().max(1024).nullable().optional(),
        intervalHours: z.number().min(1).max(168).optional(),
        keep: z.number().int().min(1).max(100).optional(),
        includeSecrets: z.boolean().optional(),
        passphrase: z.string().max(512).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_input', 'Input auto-backup tidak valid.'), 400);
    try {
      return c.json({ config: backup.updateAutoConfig(parsed.data) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  api.post('/backup/auto/run', async (c) => {
    try {
      return c.json({ config: await backup.runAutoBackup('manual') });
    } catch (err) {
      if (err instanceof Error && !(err instanceof BackupError)) {
        return c.json(
          { ...apiError('backup_failed', err.message), config: backup.getAutoConfig() },
          500,
        );
      }
      return handleError(c, err);
    }
  });

  api.get('/backup/cloud-folders', (c) => c.json({ folders: backup.detectCloudFolders() }));

  return api;
}
