import type { ApiErrorResponse } from '@atelier/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { CredentialStore } from './credentials.js';
import type { ChromeExtensionBridge } from './chrome-bridge.js';
import { resolveAllPresets } from './login.js';
import type { BrowserManager } from './manager.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

const selectorsSchema = z
  .object({
    username: z.string().max(240).optional(),
    password: z.string().max(240).optional(),
    next: z.string().max(240).optional(),
    submit: z.string().max(240).optional(),
    emailStepButton: z.string().max(240).optional(),
  })
  .optional();

export function createBrowserRoutes(deps: {
  browserManager: BrowserManager;
  credentials: CredentialStore;
  chromeBridge?: ChromeExtensionBridge;
}): Hono {
  const { browserManager, credentials, chromeBridge } = deps;
  const api = new Hono();

  api.get('/browser/status', (c) => {
    return c.json(browserManager.getStatus());
  });

  api.get('/browser/extension/status', (c) => {
    if (!chromeBridge) {
      return c.json(apiError('bridge_unavailable', 'Chrome Extension bridge tidak aktif.'), 404);
    }
    return c.json(chromeBridge.getStatus());
  });

  api.post('/browser/extension/pair/start', (c) => {
    if (!chromeBridge) {
      return c.json(apiError('bridge_unavailable', 'Chrome Extension bridge tidak aktif.'), 404);
    }
    try {
      const pairing = chromeBridge.startPairing();
      return c.json({ ...pairing, status: chromeBridge.getStatus() });
    } catch (err) {
      return c.json(
        apiError('pair_failed', err instanceof Error ? err.message : 'Gagal membuat kode pairing.'),
        423,
      );
    }
  });

  api.post('/browser/extension/unpair', (c) => {
    if (!chromeBridge) {
      return c.json(apiError('bridge_unavailable', 'Chrome Extension bridge tidak aktif.'), 404);
    }
    chromeBridge.unpair();
    return c.json({ ok: true, status: chromeBridge.getStatus() });
  });

  api.get('/browser/presets', (c) => {
    return c.json({ presets: resolveAllPresets(browserManager.store) });
  });

  api.post('/browser/presets/detect', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ loginUrl: z.string().trim().url() }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_url', 'Masukkan URL halaman login yang valid.'), 400);
    }
    try {
      const detected = await browserManager.detectPreset(parsed.data.loginUrl);
      return c.json({ detected });
    } catch (err) {
      return c.json(
        apiError('detect_failed', err instanceof Error ? err.message : 'Gagal mendeteksi form login.'),
        400,
      );
    }
  });

  // ---------------------------------------------------------------- profiles

  api.get('/browser/profiles', (c) => {
    return c.json({ profiles: credentials.listProfiles() });
  });

  api.post('/browser/profiles', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_profile', 'Nama profil browser wajib diisi.'), 400);
    }
    const profile = credentials.createProfile(parsed.data.name);
    return c.json({ profile }, 201);
  });

  api.patch('/browser/profiles/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_profile', 'Nama profil tidak valid.'), 400);
    }
    const profile = credentials.updateProfile(c.req.param('id'), { name: parsed.data.name });
    if (!profile) return c.json(apiError('not_found', 'Profil browser tidak ditemukan.'), 404);
    return c.json({ profile });
  });

  api.delete('/browser/profiles/:id', async (c) => {
    const id = c.req.param('id');
    await browserManager.closeProfileContext(id);
    const ok = await credentials.deleteProfile(id);
    if (!ok) return c.json(apiError('not_found', 'Profil browser tidak ditemukan.'), 404);
    return c.json({ ok: true, id });
  });

  api.post('/browser/profiles/:id/clear-cookies', async (c) => {
    const id = c.req.param('id');
    await browserManager.closeProfileContext(id);
    const ok = await credentials.clearProfileCookies(id);
    if (!ok) return c.json(apiError('not_found', 'Profil browser tidak ditemukan.'), 404);
    return c.json({ ok: true });
  });

  api.post('/browser/profiles/:id/open', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ url: z.string().trim().url().optional() }).safeParse(body ?? {});
    try {
      await browserManager.openProfileWindow(id, parsed.success ? parsed.data.url : undefined);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        apiError('open_failed', err instanceof Error ? err.message : 'Gagal membuka jendela browser.'),
        400,
      );
    }
  });

  // ---------------------------------------------------------------- credentials

  api.get('/browser/credentials', (c) => {
    return c.json({ credentials: credentials.listCredentials() });
  });

  api.post('/browser/credentials', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        label: z.string().trim().min(1).max(80),
        presetId: z.string().trim().nullable().optional(),
        origin: z.string().trim().url(),
        loginUrl: z.string().trim().url(),
        username: z.string().trim().min(1).max(200),
        password: z.string().min(1).max(512),
        profileId: z.string().trim().nullable().optional(),
        selectors: selectorsSchema,
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_credential', 'Lengkapi data login dengan benar.'), 400);
    }
    try {
      const credential = credentials.createCredential(parsed.data);
      return c.json({ credential }, 201);
    } catch (err) {
      return c.json(
        apiError('invalid_credential', err instanceof Error ? err.message : 'Gagal menyimpan login.'),
        400,
      );
    }
  });

  api.patch('/browser/credentials/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        label: z.string().trim().min(1).max(80).optional(),
        presetId: z.string().trim().nullable().optional(),
        origin: z.string().trim().url().optional(),
        loginUrl: z.string().trim().url().optional(),
        username: z.string().trim().min(1).max(200).optional(),
        password: z.string().max(512).optional(),
        profileId: z.string().trim().min(1).optional(),
        selectors: selectorsSchema,
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_credential', 'Data perubahan login tidak valid.'), 400);
    }
    try {
      const credential = credentials.updateCredential(id, parsed.data);
      if (!credential) return c.json(apiError('not_found', 'Login tidak ditemukan.'), 404);
      return c.json({ credential });
    } catch (err) {
      return c.json(
        apiError('invalid_credential', err instanceof Error ? err.message : 'Gagal memperbarui login.'),
        400,
      );
    }
  });

  api.delete('/browser/credentials/:id', (c) => {
    const id = c.req.param('id');
    const ok = credentials.deleteCredential(id);
    if (!ok) return c.json(apiError('not_found', 'Login tidak ditemukan.'), 404);
    return c.json({ ok: true, id });
  });

  api.post('/browser/credentials/:id/test', async (c) => {
    const id = c.req.param('id');
    const cred = credentials.getCredential(id);
    if (!cred) return c.json(apiError('not_found', 'Login tidak ditemukan.'), 404);
    try {
      const result = await browserManager.testCredential(id);
      return c.json(result);
    } catch (err) {
      return c.json(
        apiError('test_failed', err instanceof Error ? err.message : 'Gagal mengetes login.'),
        400,
      );
    }
  });

  api.get('/browser/test-shots/:id', (c) => {
    const bytes = browserManager.getTestShot(c.req.param('id'));
    if (!bytes) return c.json(apiError('not_found', 'Screenshot tes tidak ditemukan.'), 404);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // ---------------------------------------------------------------- sessions & approvals

  api.get('/browser/sessions', (c) => {
    return c.json({ sessions: browserManager.listSessions() });
  });

  api.post('/browser/sessions/:id/watch', async (c) => {
    const session = await browserManager.watchSession(c.req.param('id'));
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/unwatch', async (c) => {
    const session = await browserManager.unwatchSession(c.req.param('id'));
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/takeover', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ reason: z.string().trim().max(400).optional() }).safeParse(body ?? {});
    const session = await browserManager.startTakeover(
      c.req.param('id'),
      parsed.success ? parsed.data.reason : undefined,
    );
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/release', async (c) => {
    const session = await browserManager.releaseTakeover(c.req.param('id'));
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/pause', (c) => {
    const session = browserManager.pauseSession(c.req.param('id'));
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/resume', (c) => {
    const session = browserManager.resumeSession(c.req.param('id'));
    if (!session) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ session });
  });

  api.post('/browser/sessions/:id/close', async (c) => {
    const ok = await browserManager.closeSession(c.req.param('id'));
    if (!ok) return c.json(apiError('not_found', 'Sesi browser tidak ditemukan.'), 404);
    return c.json({ ok: true });
  });

  api.get('/browser/approvals', (c) => {
    return c.json({ approvals: browserManager.listApprovals() });
  });

  api.post('/browser/approvals/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ allow: z.boolean() }).safeParse(body);
    if (!parsed.success) return c.json(apiError('invalid_input', 'Nilai allow wajib boolean.'), 400);
    const ok = browserManager.resolveApproval(c.req.param('id'), parsed.data.allow);
    if (!ok) return c.json(apiError('not_found', 'Permintaan konfirmasi tidak ditemukan.'), 404);
    return c.json({ ok: true });
  });

  api.get('/browser/approvals/:id/screenshot', (c) => {
    const bytes = browserManager.getApprovalScreenshot(c.req.param('id'));
    if (!bytes) return c.json(apiError('not_found', 'Screenshot konfirmasi tidak ditemukan.'), 404);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return api;
}
