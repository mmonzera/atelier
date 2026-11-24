import type {
  DetectedSitePreset,
  SiteCredential,
  SiteLoginStatus,
  SitePreset,
  SitePresetSelectors,
} from '@atelier/contracts';
import { SITE_PRESETS } from '@atelier/contracts';
import type { Locator, Page } from 'playwright-core';
import type { AtelierStore } from '../store.js';
import type { CredentialStore } from './credentials.js';

export interface LoginAttemptResult {
  status: SiteLoginStatus;
  message: string;
  url: string;
  alreadyLoggedIn?: boolean;
}

export function resolveAllPresets(store: AtelierStore): SitePreset[] {
  const custom = store.getSettings().sitePresets ?? [];
  const byId = new Map<string, SitePreset>();
  for (const p of SITE_PRESETS) byId.set(p.id, p);
  for (const p of custom) byId.set(p.id, p);
  return [...byId.values()];
}

export function findPresetForCredential(store: AtelierStore, cred: SiteCredential): SitePreset | null {
  const all = resolveAllPresets(store);
  if (cred.presetId) {
    const byId = all.find((p) => p.id === cred.presetId);
    if (byId) return byId;
  }
  return all.find((p) => p.origin === cred.origin) ?? null;
}

const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[type="text"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[name*="pass" i]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'form button:not([type="button"])',
];

async function findFirstVisible(page: Page, selectors: Array<string | undefined>): Promise<Locator | null> {
  for (const sel of selectors) {
    if (!sel?.trim()) continue;
    try {
      const loc = page.mainFrame().locator(sel);
      const count = await loc.count();
      for (let i = 0; i < Math.min(count, 6); i++) {
        const candidate = loc.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    } catch {
      // ignore invalid custom selector
    }
  }
  return null;
}

async function isAnyVisible(page: Page, selectors: Array<string | undefined>): Promise<boolean> {
  return (await findFirstVisible(page, selectors)) !== null;
}

async function hasVisibleCaptcha(page: Page): Promise<boolean> {
  const frameOrWidget = await isAnyVisible(page, [
    'iframe[src*="turnstile" i]',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    '.cf-turnstile',
    '.g-recaptcha',
    '.h-captcha',
    '[data-sitekey]',
  ]);
  if (frameOrWidget) return true;

  const text = await page
    .evaluate(() => (document.body?.innerText ?? '').slice(0, 4000))
    .catch(() => '');
  return /(verify you are human|just a moment|checking your browser|are you a robot|i am not a robot)/i.test(
    text,
  );
}

async function hasVisibleVerificationPrompt(
  page: Page,
  verifySelector?: string,
): Promise<boolean> {
  if (verifySelector && (await isAnyVisible(page, [verifySelector]))) {
    return true;
  }
  if (
    await isAnyVisible(page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[name*="token" i]',
      'input[name*="code" i]',
      'input[placeholder*="code" i]',
    ])
  ) {
    return true;
  }
  const hasPassword = await isAnyVisible(page, PASSWORD_SELECTORS);
  const text = await page
    .evaluate(() => (document.body?.innerText ?? '').slice(0, 3000))
    .catch(() => '');
  if (
    !hasPassword &&
    /(enter (the )?(login )?code|verification code|two-factor|2fa|authenticator app|check your email|magic link|we sent a code|kode verifikasi)/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

async function readVisibleErrorText(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const errSelectors = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '.error',
        '.alert-error',
        '[class*="error" i]',
      ];
      for (const sel of errSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const txt = htmlEl.innerText?.replace(/\s+/g, ' ').trim();
          if (
            txt &&
            txt.length >= 4 &&
            txt.length < 300 &&
            /(incorrect|invalid|wrong|salah|failed|not found|doesn.?t match|couldn.?t find|tidak valid|gagal)/i.test(
              txt,
            )
          ) {
            return txt;
          }
        }
      }
      return null;
    })
    .catch(() => null);
}

async function clickNextOrSubmit(
  page: Page,
  selectors: Array<string | undefined>,
  fallbackInput?: Locator | null,
): Promise<boolean> {
  const btn = await findFirstVisible(page, selectors);
  if (btn) {
    await btn.click({ timeout: 5000 });
    return true;
  }

  // Fallback: match visible button by label
  const matched = page
    .mainFrame()
    .locator('button, input[type="submit"], [role="button"]')
    .filter({ hasText: /^(continue|next|lanjut|sign in|log in|submit|masuk)$/i });
  const count = await matched.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 4); i++) {
    const c = matched.nth(i);
    if (await c.isVisible().catch(() => false)) {
      await c.click({ timeout: 5000 });
      return true;
    }
  }

  if (fallbackInput) {
    await fallbackInput.press('Enter').catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * Inspects visible login inputs & submit buttons on `page`, marks them with colored outlines
 * for an annotated preview JPEG, and returns a proposed SitePreset config.
 */
export async function detectLoginForm(page: Page): Promise<
  Omit<DetectedSitePreset, 'screenshotUrl'> & { screenshotBytes: Buffer }
> {
  const info = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const buildSelector = (el: Element | null): string | undefined => {
      if (!el) return undefined;
      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute('id');
      if (id && /^[a-zA-Z][\w-]*$/.test(id)) return `#${id}`;
      const name = el.getAttribute('name');
      if (name && /^[a-zA-Z0-9_.-]+$/.test(name)) return `${tag}[name="${name}"]`;
      const auto = el.getAttribute('autocomplete');
      if (auto && /^[a-zA-Z0-9_-]+$/.test(auto)) return `${tag}[autocomplete="${auto}"]`;
      const type = el.getAttribute('type');
      if (type && /^[a-zA-Z0-9_-]+$/.test(type)) return `${tag}[type="${type}"]`;
      return tag;
    };

    const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
    const usernameEl =
      inputs.find((i) => i.type === 'email' || i.autocomplete === 'username' || /email|user/i.test(i.name)) ??
      inputs.find((i) => i.type === 'text') ??
      null;
    const passwordEl = inputs.find((i) => i.type === 'password') ?? null;

    const buttons = Array.from(
      document.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ).filter(isVisible);
    const submitEl =
      buttons.find((b) => b.getAttribute('type') === 'submit') ??
      buttons.find((b) => /(continue|next|sign in|log in|submit|masuk|lanjut)/i.test(b.textContent ?? '')) ??
      null;

    const marked: Array<{ el: HTMLElement; prevOutline: string }> = [];
    const highlight = (el: Element | null, color: string) => {
      if (!el) return;
      const htmlEl = el as HTMLElement;
      marked.push({ el: htmlEl, prevOutline: htmlEl.style.outline });
      htmlEl.style.outline = `3px solid ${color}`;
    };

    highlight(usernameEl, '#38bdf8');
    highlight(passwordEl, '#a78bfa');
    highlight(submitEl, '#4ade80');

    (window as unknown as { __atelierRestoreOutlines?: () => void }).__atelierRestoreOutlines = () => {
      for (const m of marked) m.el.style.outline = m.prevOutline;
    };

    const flow: 'single' | 'two_step' = usernameEl && !passwordEl ? 'two_step' : 'single';
    const submitSel = buildSelector(submitEl);
    const selectors: SitePresetSelectors = {
      ...(usernameEl ? { username: buildSelector(usernameEl) } : {}),
      ...(passwordEl ? { password: buildSelector(passwordEl) } : {}),
      ...(flow === 'two_step' && submitSel ? { next: submitSel } : {}),
      ...(submitSel ? { submit: submitSel } : {}),
    };

    return {
      origin: window.location.origin,
      loginUrl: window.location.href,
      flow,
      selectors,
    };
  });

  const screenshotBytes = await page.screenshot({ type: 'jpeg', quality: 80 });
  await page
    .evaluate(() => {
      const fn = (window as unknown as { __atelierRestoreOutlines?: () => void }).__atelierRestoreOutlines;
      fn?.();
      delete (window as unknown as { __atelierRestoreOutlines?: () => void }).__atelierRestoreOutlines;
    })
    .catch(() => undefined);

  return {
    origin: info.origin,
    loginUrl: info.loginUrl,
    flow: info.flow,
    selectors: info.selectors,
    screenshotBytes,
  };
}

function isProbablyLoggedInUrl(currentUrl: string, loginUrl: string, preset?: SitePreset | null): boolean {
  if (preset?.successUrlIncludes && currentUrl.includes(preset.successUrlIncludes)) {
    return true;
  }
  try {
    const cur = new URL(currentUrl);
    const login = new URL(loginUrl);
    if (cur.origin !== login.origin) return false;
    const curPath = cur.pathname.toLowerCase();
    const loginPath = login.pathname.toLowerCase();
    if (curPath !== loginPath && !/(login|signin|sign-in|auth|verify)/i.test(curPath)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function performSiteLogin(opts: {
  page: Page;
  credential: SiteCredential;
  preset?: SitePreset | null;
  credentials: CredentialStore;
  timeoutMs?: number;
}): Promise<LoginAttemptResult> {
  const { page, credential, preset, credentials, timeoutMs = 20_000 } = opts;
  const verifySelector = preset?.verifySelector;

  await page.goto(credential.loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(350);

  // Check if already logged in via persistent session cookies
  if (
    (preset?.successSelector && (await isAnyVisible(page, [preset.successSelector]))) ||
    (isProbablyLoggedInUrl(page.url(), credential.loginUrl, preset) &&
      !(await isAnyVisible(page, PASSWORD_SELECTORS)) &&
      !(await isAnyVisible(page, USERNAME_SELECTORS)))
  ) {
    return {
      status: 'ok',
      message: 'Sudah masuk menggunakan sesi tersimpan.',
      url: page.url(),
      alreadyLoggedIn: true,
    };
  }

  if (await hasVisibleCaptcha(page)) {
    return {
      status: 'blocked',
      message: 'Situs menampilkan captcha atau pengecekan bot. Gunakan Ambil alih untuk login manual.',
      url: page.url(),
    };
  }

  // Locate visible username field (or click "Continue with email" trigger if shown first)
  let usernameLoc = await findFirstVisible(page, [
    credential.selectors?.username,
    preset?.selectors.username,
    ...USERNAME_SELECTORS,
  ]);

  if (!usernameLoc && !(await isAnyVisible(page, PASSWORD_SELECTORS))) {
    const emailToggle = page
      .mainFrame()
      .locator('button, a, [role="button"]')
      .filter({ hasText: /(continue with email|sign in with email|log in with email|use email|masuk dengan email)/i });
    const cnt = await emailToggle.count().catch(() => 0);
    for (let i = 0; i < Math.min(cnt, 3); i++) {
      const cand = emailToggle.nth(i);
      if (await cand.isVisible().catch(() => false)) {
        await cand.click({ timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        break;
      }
    }
    usernameLoc = await findFirstVisible(page, [
      credential.selectors?.username,
      preset?.selectors.username,
      ...USERNAME_SELECTORS,
    ]);
  }

  if (usernameLoc) {
    await usernameLoc.fill(credential.username, { timeout: 5000 });
  }

  // Check if password input is already visible; if not, handle two-step flow
  let passwordLoc = await findFirstVisible(page, [
    credential.selectors?.password,
    preset?.selectors.password,
    ...PASSWORD_SELECTORS,
  ]);

  if (!passwordLoc && (usernameLoc || preset?.flow === 'two_step')) {
    await clickNextOrSubmit(
      page,
      [
        preset?.selectors.next,
        credential.selectors?.submit,
        preset?.selectors.submit,
        ...SUBMIT_SELECTORS,
      ],
      usernameLoc,
    );

    // Wait up to 6s for password input, verification prompt, captcha, or error
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(250);
      passwordLoc = await findFirstVisible(page, [
        credential.selectors?.password,
        preset?.selectors.password,
        ...PASSWORD_SELECTORS,
      ]);
      if (passwordLoc) break;
      if (await hasVisibleCaptcha(page)) {
        return {
          status: 'blocked',
          message: 'Situs menampilkan captcha setelah memasukkan email.',
          url: page.url(),
        };
      }
      if (await hasVisibleVerificationPrompt(page, verifySelector)) {
        return {
          status: 'needs_verification',
          message: 'Situs meminta kode verifikasi / magic link.',
          url: page.url(),
        };
      }
      const errTxt = await readVisibleErrorText(page);
      if (errTxt) {
        return { status: 'error', message: errTxt, url: page.url() };
      }
      if (isProbablyLoggedInUrl(page.url(), credential.loginUrl, preset)) {
        return { status: 'ok', message: 'Berhasil masuk.', url: page.url() };
      }
    }
  }

  if (await hasVisibleCaptcha(page)) {
    return {
      status: 'blocked',
      message: 'Situs menampilkan captcha atau verifikasi bot.',
      url: page.url(),
    };
  }

  if (!passwordLoc) {
    if (await hasVisibleVerificationPrompt(page, verifySelector)) {
      return {
        status: 'needs_verification',
        message: 'Situs meminta kode verifikasi / 2FA.',
        url: page.url(),
      };
    }
    return {
      status: 'error',
      message: 'Field password tidak ditemukan di halaman login.',
      url: page.url(),
    };
  }

  // Strictly bind decryption to matching main-frame origin!
  const currentUrl = page.mainFrame().url();
  const { password } = credentials.getSecretForOrigin(credential.id, currentUrl);

  await passwordLoc.fill(password, { timeout: 5000 });
  const prevUrl = page.url();
  await clickNextOrSubmit(
    page,
    [credential.selectors?.submit, preset?.selectors.submit, ...SUBMIT_SELECTORS],
    passwordLoc,
  );

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => undefined),
    page.waitForTimeout(2500),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
  await page.waitForTimeout(400);

  if (await hasVisibleCaptcha(page)) {
    return {
      status: 'blocked',
      message: 'Situs meminta captcha setelah submit login.',
      url: page.url(),
    };
  }

  if (await hasVisibleVerificationPrompt(page, verifySelector)) {
    return {
      status: 'needs_verification',
      message: 'Login membutuhkan kode verifikasi / 2FA.',
      url: page.url(),
    };
  }

  const errTxt = await readVisibleErrorText(page);
  if (errTxt) {
    return {
      status: 'wrong_password',
      message: errTxt,
      url: page.url(),
    };
  }

  const stillHasPassword = await isAnyVisible(page, [
    credential.selectors?.password,
    preset?.selectors.password,
    ...PASSWORD_SELECTORS,
  ]);
  if (
    (preset?.successSelector && (await isAnyVisible(page, [preset.successSelector]))) ||
    isProbablyLoggedInUrl(page.url(), credential.loginUrl, preset) ||
    (!stillHasPassword && page.url() !== prevUrl) ||
    !stillHasPassword
  ) {
    return {
      status: 'ok',
      message: 'Berhasil masuk.',
      url: page.url(),
    };
  }

  return {
    status: 'error',
    message: 'Halaman login tidak berpindah setelah submit. Periksa selector preset atau ambil alih manual.',
    url: page.url(),
  };
}
