import type { BrowserScreenshotSummary } from '@atelier/contracts';
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import type { BrowserManager, BrowserSessionState } from './manager.js';
import { findPresetForCredential, performSiteLogin } from './login.js';
import { isHostAllowed, isSensitiveAction, wrapUntrustedPageContent } from './policy.js';
import { capturePageSnapshot } from './snapshot.js';

const MAX_PNG_ARTIFACT_BYTES = 3_800_000;

export interface BrowserToolContext {
  agentId: string;
  projectId: string | null;
  messageId?: string | null;
  signal?: AbortSignal;
}

export interface BrowserToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  jsonSchema: Record<string, unknown>;
}

const EmptySchema = z.object({});
const SiteSchema = z.object({
  site: z.string().trim().min(1).describe('ID, presetId (mis. "mobbin"), atau label kredensial'),
});
const OpenSchema = z.object({
  url: z.string().trim().min(1).describe('URL halaman web (http:// atau https://)'),
});
const SnapshotSchema = z.object({
  maxChars: z.number().int().min(500).max(20000).optional().describe('Batas karakter teks halaman'),
});
const ClickSchema = z.object({
  ref: z.string().trim().optional().describe('Referensi elemen dari browser_snapshot (mis. "e12")'),
  text: z.string().trim().optional().describe('Teks tombol/tautan jika ref tidak dipakai'),
});
const TypeSchema = z.object({
  ref: z.string().trim().min(1).describe('Referensi elemen input dari browser_snapshot'),
  text: z.string().describe('Teks yang akan diketik'),
  submit: z.boolean().optional().describe('Tekan Enter setelah mengetik'),
});
const SelectSchema = z.object({
  ref: z.string().trim().min(1).describe('Referensi elemen <select> dari browser_snapshot'),
  value: z.string().describe('Nilai atau label opsi yang dipilih'),
});
const PressSchema = z.object({
  key: z.string().trim().min(1).describe('Tombol keyboard, mis. "Enter", "Escape", "Tab"'),
});
const ScrollSchema = z.object({
  direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Arah scroll'),
  amount: z.number().int().min(100).max(5000).optional().describe('Jarak scroll dalam piksel'),
});
const WaitSchema = z.object({
  text: z.string().optional().describe('Tunggu hingga teks ini muncul di halaman'),
  ms: z.number().int().min(100).max(15000).optional().describe('Durasi tunggu maksimal (ms)'),
});
const ScreenshotSchema = z.object({
  fullPage: z.boolean().optional().describe('Ambil seluruh tinggi halaman'),
  label: z.string().trim().max(120).optional().describe('Label singkat screenshot untuk Library'),
});
const TakeoverSchema = z.object({
  reason: z.string().trim().min(1).max(400).describe('Alasan meminta pengguna mengambil alih'),
});

export const BROWSER_TOOL_DEFS: BrowserToolDefinition[] = [
  {
    name: 'browser_list_logins',
    description: 'Lihat daftar akun login situs yang diizinkan untuk agent ini (tanpa password).',
    schema: EmptySchema,
    jsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_login',
    description:
      'Masuk ke situs menggunakan kredensial tersimpan di server Atelier. Password tidak pernah terlihat oleh model.',
    schema: SiteSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'ID, presetId (mis. "mobbin"), atau label kredensial' },
      },
      required: ['site'],
    },
  },
  {
    name: 'browser_open',
    description: 'Buka URL di browser agent. Host harus termasuk dalam daftar situs yang diizinkan.',
    schema: OpenSchema,
    jsonSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL http:// atau https://' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Ambil ringkasan teks halaman dan daftar elemen interaktif beserta ref (mis. e1, e2) untuk diklik/diketik.',
    schema: SnapshotSchema,
    jsonSchema: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: 'Maksimal karakter teks (default 6000)' } },
    },
  },
  {
    name: 'browser_click',
    description: 'Klik elemen berdasarkan ref dari browser_snapshot atau teks yang terlihat.',
    schema: ClickSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Referensi elemen, mis. "e12"' },
        text: { type: 'string', description: 'Teks elemen jika ref tidak diberikan' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Ketik teks ke input yang bukan field password (gunakan browser_login untuk password).',
    schema: TypeSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Referensi elemen dari browser_snapshot' },
        text: { type: 'string', description: 'Teks yang diketik' },
        submit: { type: 'boolean', description: 'Tekan Enter setelah selesai mengetik' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select',
    description: 'Pilih opsi di elemen dropdown <select>.',
    schema: SelectSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Referensi elemen <select>' },
        value: { type: 'string', description: 'Value atau label opsi' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_press',
    description: 'Tekan tombol keyboard (mis. Enter, Escape, Tab, ArrowDown).',
    schema: PressSchema,
    jsonSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Nama tombol keyboard' } },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll halaman ke atas, bawah, paling atas, atau paling bawah.',
    schema: ScrollSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'number', description: 'Piksel untuk up/down (default 600)' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Tunggu beberapa milidetik atau hingga teks tertentu muncul di halaman (maks 15 detik).',
    schema: WaitSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Teks yang ditunggu' },
        ms: { type: 'number', description: 'Waktu tunggu dalam ms (maks 15000)' },
      },
    },
  },
  {
    name: 'browser_back',
    description: 'Kembali ke halaman sebelumnya di riwayat browser.',
    schema: EmptySchema,
    jsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: 'Ambil screenshot halaman saat ini dan simpan ke chat & Library (Designs).',
    schema: ScreenshotSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Tangkap seluruh halaman' },
        label: { type: 'string', description: 'Label gambar di Library' },
      },
    },
  },
  {
    name: 'browser_request_takeover',
    description:
      'Jeda sesi dan minta pengguna mengambil alih di jendela browser (mis. untuk captcha, 2FA, atau verifikasi manual).',
    schema: TakeoverSchema,
    jsonSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Alasan ambil alih' } },
      required: ['reason'],
    },
  },
  {
    name: 'browser_close',
    description: 'Tutup tab sesi browser saat ini (profil dan cookie tetap tersimpan).',
    schema: EmptySchema,
    jsonSchema: { type: 'object', properties: {} },
  },
];

export function browserToolsAsOpenAiFunctions(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return BROWSER_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    },
  }));
}

export function browserToolsForMcpList(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return BROWSER_TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  }));
}

async function resolveTargetLocator(
  page: Page,
  args: { ref?: string; text?: string },
): Promise<Locator> {
  if (args.ref) {
    const loc = page.locator(`[data-atelier-ref="${args.ref}"]`).first();
    if ((await loc.count()) === 0) {
      throw new Error(`Elemen ref "${args.ref}" tidak ditemukan. Ambil browser_snapshot terlebih dahulu.`);
    }
    return loc;
  }
  if (args.text) {
    const loc = page.getByText(args.text, { exact: false }).first();
    if ((await loc.count()) === 0) {
      throw new Error(`Elemen dengan teks "${args.text}" tidak ditemukan.`);
    }
    return loc;
  }
  throw new Error('Berikan ref atau text elemen yang akan diklik.');
}

async function inspectElementMeta(locator: Locator): Promise<{
  tag: string;
  type: string;
  autocomplete: string;
  label: string;
  hasPaymentOrOtpFields: boolean;
}> {
  return locator.evaluate((el) => {
    const htmlEl = el as HTMLElement;
    const inputEl = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (inputEl.type || 'text').toLowerCase() : '';
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      htmlEl.innerText,
      inputEl.value,
      el.getAttribute('name'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    const form = el.closest('form');
    let hasPaymentOrOtpFields = false;
    if (form) {
      const formInputs = Array.from(form.querySelectorAll('input'));
      hasPaymentOrOtpFields = formInputs.some((inp) => {
        const auto = (inp.getAttribute('autocomplete') ?? '').toLowerCase();
        const name = `${inp.name} ${inp.id} ${inp.placeholder}`.toLowerCase();
        return (
          auto.startsWith('cc-') ||
          auto === 'one-time-code' ||
          /(card|cvv|cvc|iban|routing|rekening|otp|kartu)/i.test(name)
        );
      });
    }

    return { tag, type, autocomplete, label, hasPaymentOrOtpFields };
  });
}

function recordSafeActivity(
  manager: BrowserManager,
  ctx: BrowserToolContext,
  label: string,
  detail?: string,
  kind: 'tool' | 'error' = 'tool',
): void {
  manager.store.addActivity({
    projectId: ctx.projectId,
    agentId: ctx.agentId,
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    kind,
    label: manager.redact(label),
    ...(detail ? { detail: manager.redact(detail) } : {}),
  });
}

async function runToolImpl(
  manager: BrowserManager,
  toolName: string,
  rawArgs: unknown,
  ctx: BrowserToolContext,
): Promise<string> {
  const agent = manager.store.getAgent(ctx.agentId);
  if (!agent) {
    throw new Error(`Agent ${ctx.agentId} tidak ditemukan.`);
  }
  if (!agent.browser?.enabled) {
    throw new Error('Akses browser tidak diaktifkan untuk agent ini.');
  }

  const allowedCredentialIds = agent.browser.credentialIds ?? [];
  const allowedHosts = agent.browser.allowedHosts ?? [];
  const confirmSensitive = agent.browser.confirmSensitive ?? true;

  if (toolName === 'browser_list_logins') {
    EmptySchema.parse(rawArgs ?? {});
    const allowedSet = new Set(allowedCredentialIds);
    const items = manager.credentials
      .listCredentials()
      .filter((c) => allowedSet.has(c.id))
      .map((c) => ({
        id: c.id,
        site: c.presetId ?? c.label,
        label: c.label,
        origin: c.origin,
        username: c.maskedUsername ?? c.username,
        status: c.lastLogin?.status ?? null,
      }));
    return JSON.stringify({ logins: items }, null, 2);
  }

  if (toolName === 'browser_login') {
    const { site } = SiteSchema.parse(rawArgs);
    const cred = manager.credentials.findCredentialBySite(site, allowedCredentialIds);
    if (!cred) {
      throw new Error(
        `Login "${site}" tidak ditemukan atau tidak diizinkan untuk agent ini. Aktifkan di Edit Agent → Browser.`,
      );
    }

    // Also allow the credential's origin temporarily check: must be in allowedHosts if allowedHosts is non-empty
    if (!isHostAllowed(cred.loginUrl, allowedHosts)) {
      throw new Error(`Host ${new URL(cred.loginUrl).hostname} tidak ada dalam daftar situs yang diizinkan.`);
    }

    const session = await manager.getOrCreateSession(ctx.agentId, cred.profileId);
    const preset = findPresetForCredential(manager.store, cred);
    const host = new URL(cred.origin).hostname;
    recordSafeActivity(
      manager,
      ctx,
      `🔐 Masuk ke ${host} sebagai ${cred.maskedUsername ?? cred.username}`,
    );

    const res = await manager.withSessionLock(
      session,
      async (page) =>
        performSiteLogin({
          page,
          credential: cred,
          preset,
          credentials: manager.credentials,
        }),
      ctx.signal,
    );

    const safeMessage = manager.redact(res.message);
    manager.credentials.updateLastLogin(cred.id, {
      at: new Date().toISOString(),
      status: res.status,
      message: safeMessage,
    });

    if (res.status === 'needs_verification' || res.status === 'blocked') {
      await manager.startTakeover(session.id, `${cred.label}: ${safeMessage}`);
      await manager.waitForTakeoverRelease(session.id, ctx.signal);
      const after = manager.getSession(session.id);
      return JSON.stringify(
        {
          status: 'ok',
          message: 'Pengguna selesai melakukan verifikasi manual.',
          url: after?.url ?? res.url,
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        status: res.status,
        message: safeMessage,
        url: res.url,
        ...(res.alreadyLoggedIn ? { alreadyLoggedIn: true } : {}),
      },
      null,
      2,
    );
  }

  if (toolName === 'browser_close') {
    EmptySchema.parse(rawArgs ?? {});
    const existing = manager.findAgentSession(ctx.agentId);
    if (!existing) return JSON.stringify({ closed: false, message: 'Tidak ada sesi aktif.' });
    await manager.closeSession(existing.id);
    return JSON.stringify({ closed: true });
  }

  // All remaining tools operate on an active session
  const session: BrowserSessionState =
    manager.findAgentSession(ctx.agentId) ?? (await manager.getOrCreateSession(ctx.agentId));

  switch (toolName) {
    case 'browser_open': {
      const { url } = OpenSchema.parse(rawArgs);
      if (!isHostAllowed(url, allowedHosts)) {
        throw new Error('Situs ini tidak diizinkan untuk agent ini.');
      }
      return manager.withSessionLock(
        session,
        async (page) => {
          session.lastBlockedHost = null;
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
          } catch (err) {
            if (session.lastBlockedHost) {
              throw new Error('Situs ini tidak diizinkan untuk agent ini (redirect diblokir).');
            }
            throw err;
          }
          if (session.lastBlockedHost || !isHostAllowed(page.url(), allowedHosts)) {
            throw new Error('Situs ini tidak diizinkan untuk agent ini.');
          }
          const title = await page.title().catch(() => '');
          return wrapUntrustedPageContent(
            'browser_open',
            JSON.stringify({ url: page.url(), title }, null, 2),
          );
        },
        ctx.signal,
      );
    }

    case 'browser_snapshot': {
      const { maxChars } = SnapshotSchema.parse(rawArgs ?? {});
      return manager.withSessionLock(
        session,
        async (page) => {
          const snap = await capturePageSnapshot(page, maxChars ?? 6000);
          return wrapUntrustedPageContent('browser_snapshot', snap.formatted);
        },
        ctx.signal,
      );
    }

    case 'browser_click': {
      const args = ClickSchema.parse(rawArgs);
      return manager.withSessionLock(
        session,
        async (page) => {
          const loc = await resolveTargetLocator(page, args);
          const meta = await inspectElementMeta(loc).catch(() => ({
            tag: '',
            type: '',
            autocomplete: '',
            label: args.text ?? args.ref ?? 'elemen',
            hasPaymentOrOtpFields: false,
          }));

          const sensitive =
            confirmSensitive &&
            isSensitiveAction({
              label: meta.label,
              text: args.text,
              hasPaymentOrOtpFields: meta.hasPaymentOrOtpFields,
            });

          if (sensitive) {
            const actionLabel = `Klik '${meta.label || args.text || args.ref}'`;
            const allowed = await manager.requestApproval({
              session,
              action: actionLabel,
              url: page.url(),
              page,
              signal: ctx.signal,
            });
            if (!allowed) {
              return 'Pengguna menolak aksi ini.';
            }
          }

          session.lastBlockedHost = null;
          await loc.click({ timeout: 8000 });
          await page.waitForTimeout(450);
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined);

          if (session.lastBlockedHost || !isHostAllowed(page.url(), allowedHosts)) {
            throw new Error('Navigasi hasil klik diblokir karena host tidak diizinkan.');
          }

          return wrapUntrustedPageContent(
            'browser_click',
            JSON.stringify({
              clicked: meta.label || args.text || args.ref,
              url: page.url(),
              title: await page.title().catch(() => ''),
            }),
          );
        },
        ctx.signal,
      );
    }

    case 'browser_type': {
      const args = TypeSchema.parse(rawArgs);
      return manager.withSessionLock(
        session,
        async (page) => {
          const loc = await resolveTargetLocator(page, { ref: args.ref });
          const meta = await inspectElementMeta(loc);
          if (
            meta.type === 'password' ||
            meta.autocomplete === 'current-password' ||
            meta.autocomplete === 'new-password'
          ) {
            throw new Error(
              'Ditolak: tidak boleh mengetik ke field password secara manual. Gunakan browser_login.',
            );
          }

          await loc.fill(args.text, { timeout: 6000 });
          if (args.submit) {
            if (confirmSensitive && meta.hasPaymentOrOtpFields) {
              const allowed = await manager.requestApproval({
                session,
                action: `Submit form '${meta.label || args.ref}'`,
                url: page.url(),
                page,
                signal: ctx.signal,
              });
              if (!allowed) return 'Pengguna menolak aksi ini.';
            }
            await loc.press('Enter');
            await page.waitForTimeout(500);
          }

          return JSON.stringify({
            typed: true,
            ref: args.ref,
            url: page.url(),
          });
        },
        ctx.signal,
      );
    }

    case 'browser_select': {
      const args = SelectSchema.parse(rawArgs);
      return manager.withSessionLock(
        session,
        async (page) => {
          const loc = await resolveTargetLocator(page, { ref: args.ref });
          await loc.selectOption(args.value, { timeout: 5000 }).catch(async () => {
            await loc.selectOption({ label: args.value }, { timeout: 5000 });
          });
          return JSON.stringify({ selected: args.value, ref: args.ref });
        },
        ctx.signal,
      );
    }

    case 'browser_press': {
      const args = PressSchema.parse(rawArgs);
      return manager.withSessionLock(
        session,
        async (page) => {
          await page.keyboard.press(args.key);
          await page.waitForTimeout(300);
          return JSON.stringify({ pressed: args.key, url: page.url() });
        },
        ctx.signal,
      );
    }

    case 'browser_scroll': {
      const args = ScrollSchema.parse(rawArgs);
      return manager.withSessionLock(
        session,
        async (page) => {
          const amount = args.amount ?? 600;
          await page.evaluate(
            ({ dir, amt }: { dir: string; amt: number }) => {
              if (dir === 'top') window.scrollTo(0, 0);
              else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
              else if (dir === 'up') window.scrollBy(0, -amt);
              else window.scrollBy(0, amt);
            },
            { dir: args.direction, amt: amount },
          );
          await page.waitForTimeout(250);
          return JSON.stringify({ scrolled: args.direction });
        },
        ctx.signal,
      );
    }

    case 'browser_wait': {
      const args = WaitSchema.parse(rawArgs ?? {});
      return manager.withSessionLock(
        session,
        async (page) => {
          const timeout = Math.min(15_000, Math.max(100, args.ms ?? 5000));
          if (args.text) {
            await page.getByText(args.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
            return JSON.stringify({ found: true, text: args.text });
          }
          await page.waitForTimeout(Math.min(15_000, Math.max(100, args.ms ?? 1000)));
          return JSON.stringify({ waitedMs: args.ms ?? 1000 });
        },
        ctx.signal,
      );
    }

    case 'browser_back': {
      EmptySchema.parse(rawArgs ?? {});
      return manager.withSessionLock(
        session,
        async (page) => {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
          return JSON.stringify({ url: page.url(), title: await page.title().catch(() => '') });
        },
        ctx.signal,
      );
    }

    case 'browser_screenshot': {
      const args = ScreenshotSchema.parse(rawArgs ?? {});
      return manager.withSessionLock(
        session,
        async (page) => {
          const fullPage = Boolean(args.fullPage);
          let bytes = await page.screenshot({ type: 'png', fullPage });
          let mime = 'image/png';
          if (bytes.length > MAX_PNG_ARTIFACT_BYTES) {
            bytes = await page.screenshot({ type: 'jpeg', quality: 85, fullPage });
            mime = 'image/jpeg';
          }

          let host = 'web';
          try {
            host = new URL(page.url()).hostname || 'web';
          } catch {
            // keep default
          }
          const cleanLabel = args.label?.trim() || `Screenshot · ${host}`;
          const artifact = manager.store.createArtifact(
            {
              projectId: ctx.projectId,
              ...(ctx.messageId ? { sourceMessageId: ctx.messageId } : {}),
              kind: 'image',
              label: cleanLabel,
              mime,
            },
            bytes,
          );

          const scope = encodeURIComponent(ctx.projectId ?? 'direct');
          const url = `/api/projects/${scope}/library/artifacts/${artifact.id}`;
          const summary: BrowserScreenshotSummary = {
            artifactId: artifact.id,
            label: cleanLabel,
            url,
            pageUrl: page.url(),
            createdAt: artifact.createdAt,
          };
          if (ctx.messageId) {
            manager.store.addMessageBrowserScreenshot(ctx.messageId, summary);
          }

          return JSON.stringify(
            {
              artifactId: artifact.id,
              label: cleanLabel,
              url,
              pageUrl: page.url(),
            },
            null,
            2,
          );
        },
        ctx.signal,
      );
    }

    case 'browser_request_takeover': {
      const { reason } = TakeoverSchema.parse(rawArgs);
      await manager.startTakeover(session.id, reason);
      await manager.waitForTakeoverRelease(session.id, ctx.signal);
      const after = manager.getSession(session.id);
      return JSON.stringify({
        resumed: true,
        url: after?.url ?? session.url,
        title: after?.title ?? session.title,
      });
    }

    default:
      throw new Error(`Tool browser tidak dikenal: ${toolName}`);
  }
}

export async function executeBrowserTool(
  manager: BrowserManager,
  toolName: string,
  rawArgs: unknown,
  ctx: BrowserToolContext,
): Promise<{ text: string; isError: boolean }> {
  try {
    const out = await runToolImpl(manager, toolName, rawArgs, ctx);
    return { text: manager.redact(out), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: manager.redact(msg), isError: true };
  }
}
