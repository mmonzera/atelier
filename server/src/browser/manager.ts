import crypto from 'node:crypto';
import type {
  BrowserApprovalRequest,
  BrowserSessionInfo,
  BrowserSessionStatus,
  BrowserStatusInfo,
  DetectedSitePreset,
  TestSiteCredentialResult,
} from '@atelier/contracts';
import { type BrowserContext, type CDPSession, type Page, chromium } from 'playwright-core';
import type { EventBus } from '../bus.js';
import type { AppConfig } from '../config.js';
import type { AtelierDb } from '../db.js';
import { detectLocalBrowser } from '../qa/browser-qa.js';
import type { AtelierStore } from '../store.js';
import type { CredentialStore } from './credentials.js';
import { detectLoginForm, findPresetForCredential, performSiteLogin } from './login.js';
import { isHostAllowed, redactSecrets } from './policy.js';

interface ProfileContextState {
  profileId: string;
  context: BrowserContext;
  headless: boolean;
  lastUsedAt: number;
  closing: boolean;
}

interface DeferredWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): DeferredWaiter {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface BrowserSessionState {
  id: string;
  agentId: string;
  profileId: string;
  profileName: string;
  page: Page;
  url: string;
  title: string;
  status: BrowserSessionStatus;
  live: boolean;
  takeoverReason: string | null;
  mutex: Promise<void>;
  cdp: CDPSession | null;
  watching: boolean;
  lastFrameSentAt: number;
  lastBlockedHost: string | null;
  takeoverWaiter: DeferredWaiter | null;
  pauseWaiter: DeferredWaiter | null;
}

interface PendingApproval {
  request: BrowserApprovalRequest;
  screenshot: Buffer | null;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export interface TurnTokenRecord {
  agentId: string;
  projectId: string | null;
  messageId: string | null;
  createdAt: number;
}

export class BrowserManager {
  public readonly db: AtelierDb;
  public readonly store: AtelierStore;
  public readonly bus: EventBus;
  public readonly config: AppConfig;
  public readonly credentials: CredentialStore;

  private readonly approvalTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxContexts: number;

  private readonly contexts = new Map<string, ProfileContextState>();
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly manualWindows = new Map<string, BrowserContext>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly testShots = new Map<string, { bytes: Buffer; expiresAt: number }>();
  private readonly turnTokens = new Map<string, TurnTokenRecord>();
  private readonly idleTimer: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(opts: {
    db: AtelierDb;
    store: AtelierStore;
    bus: EventBus;
    config: AppConfig;
    credentials: CredentialStore;
    approvalTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxContexts?: number;
  }) {
    this.db = opts.db;
    this.store = opts.store;
    this.bus = opts.bus;
    this.config = opts.config;
    this.credentials = opts.credentials;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 5 * 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
    this.maxContexts = opts.maxContexts ?? 3;

    this.idleTimer = setInterval(() => {
      void this.reapIdleContexts();
    }, 60_000);
    this.idleTimer.unref();
  }

  public getStatus(): BrowserStatusInfo {
    const detected = detectLocalBrowser();
    return {
      available: Boolean(detected),
      browserName: detected?.browserName ?? null,
      executablePath: detected?.executablePath ?? null,
    };
  }

  public redact(text: string): string {
    return redactSecrets(text, this.credentials.getAllActiveSecrets());
  }

  // ---------------------------------------------------------------- turn tokens

  public issueTurnToken(ctx: {
    agentId: string;
    projectId: string | null;
    messageId?: string | null;
  }): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.turnTokens.set(token, {
      agentId: ctx.agentId,
      projectId: ctx.projectId,
      messageId: ctx.messageId ?? null,
      createdAt: Date.now(),
    });
    return token;
  }

  public resolveTurnToken(token: string): TurnTokenRecord | null {
    return this.turnTokens.get(token) ?? null;
  }

  public revokeTurnToken(token: string): void {
    this.turnTokens.delete(token);
  }

  // ---------------------------------------------------------------- serialization & queries

  public toSessionInfo(s: BrowserSessionState): BrowserSessionInfo {
    return {
      id: s.id,
      agentId: s.agentId,
      profileId: s.profileId,
      profileName: s.profileName,
      url: s.url,
      title: s.title,
      status: s.status,
      live: s.live,
      ...(s.takeoverReason ? { takeoverReason: s.takeoverReason } : {}),
    };
  }

  public listSessions(): BrowserSessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.status !== 'closed')
      .map((s) => this.toSessionInfo(s));
  }

  public getSession(sessionId: string): BrowserSessionState | null {
    const s = this.sessions.get(sessionId);
    return s && s.status !== 'closed' ? s : null;
  }

  public findAgentSession(agentId: string, profileId?: string): BrowserSessionState | null {
    for (const s of this.sessions.values()) {
      if (s.status === 'closed' || s.agentId !== agentId) continue;
      if (!profileId || s.profileId === profileId) return s;
    }
    return null;
  }

  public listApprovals(): BrowserApprovalRequest[] {
    return [...this.approvals.values()].map((a) => a.request);
  }

  public getApprovalScreenshot(id: string): Buffer | null {
    return this.approvals.get(id)?.screenshot ?? null;
  }

  public getTestShot(id: string): Buffer | null {
    const entry = this.testShots.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.testShots.delete(id);
      return null;
    }
    return entry.bytes;
  }

  private saveTestShot(bytes: Buffer): string {
    const now = Date.now();
    for (const [k, v] of this.testShots) {
      if (v.expiresAt < now) this.testShots.delete(k);
    }
    const id = `shot_${crypto.randomUUID().slice(0, 10)}`;
    this.testShots.set(id, { bytes, expiresAt: now + 10 * 60_000 });
    return `/api/browser/test-shots/${id}`;
  }

  private emitSession(s: BrowserSessionState): void {
    this.bus.broadcast({ type: 'browser-session', payload: this.toSessionInfo(s) });
  }

  // ---------------------------------------------------------------- context lifecycle

  private requireBrowserExecutable(): string {
    const detected = detectLocalBrowser();
    if (!detected) {
      throw new Error(
        'Browser Chrome/Edge tidak ditemukan di komputer ini. Install Google Chrome atau Microsoft Edge, atau atur ATELIER_BROWSER_PATH.',
      );
    }
    return detected.executablePath;
  }

  private async closeManualWindow(profileId: string): Promise<void> {
    const manual = this.manualWindows.get(profileId);
    if (manual) {
      this.manualWindows.delete(profileId);
      await manual.close().catch(() => undefined);
    }
  }

  private async evictIdleContextIfNeeded(): Promise<void> {
    if (this.contexts.size < this.maxContexts) return;
    let oldest: ProfileContextState | null = null;
    for (const ctx of this.contexts.values()) {
      const busy = [...this.sessions.values()].some(
        (s) =>
          s.profileId === ctx.profileId &&
          s.status !== 'closed' &&
          (s.status === 'working' || s.status === 'waiting_user' || s.status === 'takeover'),
      );
      if (busy) continue;
      if (!oldest || ctx.lastUsedAt < oldest.lastUsedAt) {
        oldest = ctx;
      }
    }
    if (oldest) {
      await this.closeProfileContext(oldest.profileId);
    }
  }

  private async ensureProfileContext(profileId: string, headless = true): Promise<ProfileContextState> {
    if (this.shuttingDown) {
      throw new Error('Server sedang dimatikan.');
    }
    await this.closeManualWindow(profileId);

    const existing = this.contexts.get(profileId);
    if (existing && !existing.closing) {
      if (existing.headless === headless) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      await this.closeProfileContext(profileId, { keepSessions: true });
    }

    await this.evictIdleContextIfNeeded();
    const executablePath = this.requireBrowserExecutable();
    const profileDir = this.credentials.getProfileDir(profileId);

    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless,
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      args: ['--no-sandbox'],
    });

    const state: ProfileContextState = {
      profileId,
      context,
      headless,
      lastUsedAt: Date.now(),
      closing: false,
    };
    this.contexts.set(profileId, state);
    this.credentials.touchProfile(profileId);

    context.on('close', () => {
      if (this.contexts.get(profileId) === state) {
        this.contexts.delete(profileId);
      }
      if (!state.closing && !this.shuttingDown) {
        // User closed a headed window manually -> release any takeover session on this profile
        for (const s of this.sessions.values()) {
          if (s.profileId === profileId && s.status === 'takeover') {
            void this.releaseTakeover(s.id).catch(() => undefined);
          }
        }
      }
    });

    return state;
  }

  public async closeProfileContext(
    profileId: string,
    opts?: { keepSessions?: boolean },
  ): Promise<void> {
    const state = this.contexts.get(profileId);
    if (!state) return;
    state.closing = true;
    this.contexts.delete(profileId);

    for (const s of this.sessions.values()) {
      if (s.profileId !== profileId || s.status === 'closed') continue;
      await this.stopSessionWatch(s);
      if (!opts?.keepSessions) {
        s.status = 'closed';
        s.live = false;
        s.pauseWaiter?.resolve();
        s.takeoverWaiter?.resolve();
        this.emitSession(s);
        this.sessions.delete(s.id);
      }
    }

    await state.context.close().catch(() => undefined);
  }

  private async reapIdleContexts(): Promise<void> {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const ctx of [...this.contexts.values()]) {
      if (ctx.lastUsedAt > cutoff) continue;
      const busy = [...this.sessions.values()].some(
        (s) =>
          s.profileId === ctx.profileId &&
          s.status !== 'closed' &&
          (s.status === 'working' || s.status === 'waiting_user' || s.status === 'takeover'),
      );
      if (!busy) {
        await this.closeProfileContext(ctx.profileId);
      }
    }
  }

  // ---------------------------------------------------------------- sessions & page guards

  private attachPageGuards(session: BrowserSessionState, page: Page): void {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        session.url = frame.url();
        this.emitSession(session);
      }
    });

    page.on('load', async () => {
      try {
        session.url = page.url();
        session.title = await page.title().catch(() => '');
        this.emitSession(session);
      } catch {
        // ignore closed page
      }
    });

    page.on('popup', async (popup) => {
      const agent = this.store.getAgent(session.agentId);
      const allowed = agent?.browser?.allowedHosts ?? [];
      const popupUrl = popup.url();
      if (popupUrl && popupUrl !== 'about:blank' && !isHostAllowed(popupUrl, allowed)) {
        await popup.close().catch(() => undefined);
        return;
      }
      // Close unauthorized navigations inside popups too
      await popup
        .route('**/*', async (route) => {
          const req = route.request();
          if (req.isNavigationRequest() && req.frame() === popup.mainFrame()) {
            const latestAgent = this.store.getAgent(session.agentId);
            const hosts = latestAgent?.browser?.allowedHosts ?? [];
            if (!isHostAllowed(req.url(), hosts)) {
              session.lastBlockedHost = req.url();
              await route.abort('blockedbyclient');
              await popup.close().catch(() => undefined);
              return;
            }
          }
          await route.continue();
        })
        .catch(() => undefined);
    });

    void page
      .route('**/*', async (route) => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          const agent = this.store.getAgent(session.agentId);
          const hosts = agent?.browser?.allowedHosts ?? [];
          if (!isHostAllowed(req.url(), hosts)) {
            session.lastBlockedHost = req.url();
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      })
      .catch(() => undefined);
  }

  public async getOrCreateSession(
    agentId: string,
    requestedProfileId?: string,
  ): Promise<BrowserSessionState> {
    const agent = this.store.getAgent(agentId);
    const targetProfileId =
      requestedProfileId ??
      agent?.browser?.defaultProfileId ??
      this.credentials.ensureProfile(null, 'Default').id;

    const existing = this.findAgentSession(agentId, targetProfileId);
    if (existing && !existing.page.isClosed()) {
      const ctxState = this.contexts.get(existing.profileId);
      if (ctxState) ctxState.lastUsedAt = Date.now();
      return existing;
    }

    const profile = this.credentials.ensureProfile(targetProfileId, 'Default');
    const ctxState = await this.ensureProfileContext(profile.id, true);
    const page = await ctxState.context.newPage();

    const session: BrowserSessionState = {
      id: `bss_${crypto.randomUUID().slice(0, 8)}`,
      agentId,
      profileId: profile.id,
      profileName: profile.name,
      page,
      url: page.url(),
      title: '',
      status: 'idle',
      live: false,
      takeoverReason: null,
      mutex: Promise.resolve(),
      cdp: null,
      watching: false,
      lastFrameSentAt: 0,
      lastBlockedHost: null,
      takeoverWaiter: null,
      pauseWaiter: null,
    };

    this.attachPageGuards(session, page);
    this.sessions.set(session.id, session);
    this.emitSession(session);
    return session;
  }

  public async withSessionLock<T>(
    session: BrowserSessionState,
    fn: (page: Page) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let release!: () => void;
    const prev = session.mutex;
    session.mutex = new Promise<void>((res) => {
      release = res;
    });

    await prev;
    try {
      while (session.status === 'paused' || session.status === 'takeover') {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const waiter = session.status === 'takeover' ? session.takeoverWaiter : session.pauseWaiter;
        if (!waiter) break;
        await Promise.race([
          waiter.promise,
          new Promise<void>((_, reject) => {
            if (!signal) return;
            const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      }

      if (session.status === 'closed') {
        throw new Error('Sesi browser sudah ditutup.');
      }

      const ctx = this.contexts.get(session.profileId);
      if (ctx) ctx.lastUsedAt = Date.now();
      this.credentials.touchProfile(session.profileId);

      session.status = 'working';
      this.emitSession(session);

      const res = await fn(session.page);

      if (!session.page.isClosed()) {
        session.url = session.page.url();
        session.title = await session.page.title().catch(() => session.title);
      }
      if (session.status === 'working') {
        session.status = 'idle';
        this.emitSession(session);
      }
      return res;
    } catch (err) {
      if (session.status === 'working') {
        session.status = 'idle';
        this.emitSession(session);
      }
      throw err;
    } finally {
      release();
    }
  }

  public async closeSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await this.stopSessionWatch(s);
    s.status = 'closed';
    s.live = false;
    s.pauseWaiter?.resolve();
    s.takeoverWaiter?.resolve();
    this.emitSession(s);
    this.sessions.delete(sessionId);

    await s.page.close().catch(() => undefined);

    const anyLeft = [...this.sessions.values()].some(
      (other) => other.profileId === s.profileId && other.status !== 'closed',
    );
    if (!anyLeft) {
      await this.closeProfileContext(s.profileId);
    }
    return true;
  }

  public pauseSession(sessionId: string): BrowserSessionInfo | null {
    const s = this.getSession(sessionId);
    if (!s) return null;
    if (s.status !== 'paused' && s.status !== 'takeover') {
      s.status = 'paused';
      s.pauseWaiter = createDeferred();
      this.emitSession(s);
    }
    return this.toSessionInfo(s);
  }

  public resumeSession(sessionId: string): BrowserSessionInfo | null {
    const s = this.getSession(sessionId);
    if (!s) return null;
    if (s.status === 'paused') {
      s.status = 'idle';
      s.pauseWaiter?.resolve();
      s.pauseWaiter = null;
      this.emitSession(s);
    }
    return this.toSessionInfo(s);
  }

  // ---------------------------------------------------------------- screencast

  private async stopSessionWatch(s: BrowserSessionState): Promise<void> {
    s.watching = false;
    s.live = false;
    if (s.cdp) {
      const cdp = s.cdp;
      s.cdp = null;
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  public async watchSession(sessionId: string): Promise<BrowserSessionInfo | null> {
    const s = this.getSession(sessionId);
    if (!s) return null;
    if (s.status === 'takeover' || s.page.isClosed()) {
      return this.toSessionInfo(s);
    }
    if (!s.cdp) {
      const cdp = await s.page.context().newCDPSession(s.page);
      s.cdp = cdp;
      cdp.on('Page.screencastFrame', (params) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
        if (!s.watching) return;
        const now = Date.now();
        if (now - s.lastFrameSentAt < 200) return;
        s.lastFrameSentAt = now;
        this.bus.broadcast({
          type: 'browser-frame',
          payload: {
            sessionId: s.id,
            jpegBase64: params.data,
            width: params.metadata?.deviceWidth ?? 1280,
            height: params.metadata?.deviceHeight ?? 800,
          },
        });
      });
      await cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 60,
          maxWidth: 1280,
          maxHeight: 800,
          everyNthFrame: 2,
        })
        .catch(() => undefined);
    }
    s.watching = true;
    s.live = true;
    this.emitSession(s);

    // Send one immediate frame so static pages render right away in BrowserView
    try {
      const shot = await s.page.screenshot({ type: 'jpeg', quality: 60 });
      s.lastFrameSentAt = Date.now();
      this.bus.broadcast({
        type: 'browser-frame',
        payload: {
          sessionId: s.id,
          jpegBase64: shot.toString('base64'),
          width: 1280,
          height: 800,
        },
      });
    } catch {
      // ignore if page is navigating
    }

    return this.toSessionInfo(s);
  }

  public async unwatchSession(sessionId: string): Promise<BrowserSessionInfo | null> {
    const s = this.getSession(sessionId);
    if (!s) return null;
    await this.stopSessionWatch(s);
    this.emitSession(s);
    return this.toSessionInfo(s);
  }

  public async stopAllWatches(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.watching || s.live) {
        await this.stopSessionWatch(s);
        this.emitSession(s);
      }
    }
  }

  // ---------------------------------------------------------------- takeover

  public async startTakeover(sessionId: string, reason = 'Ambil alih manual'): Promise<BrowserSessionInfo | null> {
    const s = this.getSession(sessionId);
    if (!s) return null;
    if (s.status === 'takeover') {
      s.takeoverReason = reason;
      this.emitSession(s);
      return this.toSessionInfo(s);
    }

    const rememberUrl = !s.page.isClosed() ? s.page.url() : s.url;
    await this.stopSessionWatch(s);
    s.status = 'takeover';
    s.takeoverReason = reason;
    if (!s.takeoverWaiter) {
      s.takeoverWaiter = createDeferred();
    }
    this.emitSession(s);
    this.bus.broadcast({
      type: 'browser-takeover',
      payload: { sessionId: s.id, agentId: s.agentId, reason },
    });

    const otherSessions = [...this.sessions.values()].filter(
      (other) => other.profileId === s.profileId && other.id !== s.id && other.status !== 'closed',
    );
    const otherUrls = new Map(otherSessions.map((o) => [o.id, o.page.isClosed() ? o.url : o.page.url()]));

    const ctxState = await this.ensureProfileContext(s.profileId, false);
    const existingPages = ctxState.context.pages();
    const page = existingPages[0] ?? (await ctxState.context.newPage());
    s.page = page;
    this.attachPageGuards(s, page);
    if (rememberUrl && rememberUrl !== 'about:blank') {
      await page.goto(rememberUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    }
    s.url = page.url();
    s.title = await page.title().catch(() => '');

    for (const other of otherSessions) {
      const p = await ctxState.context.newPage();
      other.page = p;
      this.attachPageGuards(other, p);
      const u = otherUrls.get(other.id);
      if (u && u !== 'about:blank') {
        await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
      }
    }

    this.emitSession(s);
    return this.toSessionInfo(s);
  }

  public async waitForTakeoverRelease(sessionId: string, signal?: AbortSignal): Promise<void> {
    const s = this.getSession(sessionId);
    if (!s || s.status !== 'takeover' || !s.takeoverWaiter) return;
    await Promise.race([
      s.takeoverWaiter.promise,
      new Promise<void>((_, reject) => {
        if (!signal) return;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  }

  public async releaseTakeover(sessionId: string): Promise<BrowserSessionInfo | null> {
    const s = this.getSession(sessionId);
    if (!s) return null;

    const currentUrl = !s.page.isClosed() ? s.page.url() : s.url;
    const otherSessions = [...this.sessions.values()].filter(
      (other) => other.profileId === s.profileId && other.id !== s.id && other.status !== 'closed',
    );
    const otherUrls = new Map(otherSessions.map((o) => [o.id, o.page.isClosed() ? o.url : o.page.url()]));

    const ctxState = await this.ensureProfileContext(s.profileId, true);
    const existingPages = ctxState.context.pages();
    const page = existingPages[0] ?? (await ctxState.context.newPage());
    s.page = page;
    this.attachPageGuards(s, page);
    if (currentUrl && currentUrl !== 'about:blank') {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    }
    s.url = page.url();
    s.title = await page.title().catch(() => '');

    for (const other of otherSessions) {
      const p = await ctxState.context.newPage();
      other.page = p;
      this.attachPageGuards(other, p);
      const u = otherUrls.get(other.id);
      if (u && u !== 'about:blank') {
        await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
      }
    }

    s.status = 'idle';
    s.takeoverReason = null;
    const waiter = s.takeoverWaiter;
    s.takeoverWaiter = null;
    waiter?.resolve();
    this.emitSession(s);
    return this.toSessionInfo(s);
  }

  // ---------------------------------------------------------------- approvals

  public async requestApproval(opts: {
    session: BrowserSessionState;
    action: string;
    url: string;
    page?: Page;
    signal?: AbortSignal;
  }): Promise<boolean> {
    let screenshot: Buffer | null = null;
    if (opts.page && !opts.page.isClosed()) {
      screenshot = await opts.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
    }

    const id = `apr_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + this.approvalTimeoutMs).toISOString();
    const request: BrowserApprovalRequest = {
      id,
      sessionId: opts.session.id,
      agentId: opts.session.agentId,
      action: this.redact(opts.action),
      url: this.redact(opts.url),
      ...(screenshot ? { screenshotUrl: `/api/browser/approvals/${id}/screenshot` } : {}),
      expiresAt,
    };

    const prevStatus = opts.session.status;
    opts.session.status = 'waiting_user';
    this.emitSession(opts.session);

    return new Promise<boolean>((resolve) => {
      const cleanup = (allowed: boolean) => {
        const entry = this.approvals.get(id);
        if (!entry) return;
        this.approvals.delete(id);
        clearTimeout(entry.timer);
        if (opts.session.status === 'waiting_user') {
          opts.session.status = prevStatus === 'waiting_user' ? 'working' : prevStatus;
          this.emitSession(opts.session);
        }
        this.bus.broadcast({
          type: 'browser-approval-resolved',
          payload: { id, sessionId: opts.session.id, agentId: opts.session.agentId, allowed },
        });
        resolve(allowed);
      };

      const timer = setTimeout(() => cleanup(false), this.approvalTimeoutMs);
      timer.unref();

      if (opts.signal) {
        const onAbort = () => cleanup(false);
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.approvals.set(id, {
        request,
        screenshot,
        resolve: cleanup,
        timer,
      });

      this.bus.broadcast({ type: 'browser-approval', payload: request });
    });
  }

  public resolveApproval(id: string, allow: boolean): boolean {
    const entry = this.approvals.get(id);
    if (!entry) return false;
    entry.resolve(allow);
    return true;
  }

  // ---------------------------------------------------------------- settings / testing helpers

  public async openProfileWindow(profileId: string, initialUrl?: string): Promise<void> {
    const profile = this.credentials.getProfile(profileId);
    if (!profile) {
      throw new Error(`Profil browser ${profileId} tidak ditemukan.`);
    }

    // If any active session owns this profile, switch to takeover or close headless context first
    await this.closeProfileContext(profileId);
    await this.closeManualWindow(profileId);

    const executablePath = this.requireBrowserExecutable();
    const profileDir = this.credentials.getProfileDir(profileId);
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      args: ['--no-sandbox'],
    });
    this.manualWindows.set(profileId, context);
    this.credentials.touchProfile(profileId);

    context.on('close', () => {
      if (this.manualWindows.get(profileId) === context) {
        this.manualWindows.delete(profileId);
      }
    });

    if (initialUrl) {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
    }
  }

  public async testCredential(credentialId: string): Promise<TestSiteCredentialResult> {
    const cred = this.credentials.getCredential(credentialId);
    if (!cred) {
      throw new Error(`Kredensial ${credentialId} tidak ditemukan.`);
    }
    const preset = findPresetForCredential(this.store, cred);

    const existingCtx = this.contexts.get(cred.profileId);
    let tempContext: BrowserContext | null = null;
    let page: Page;

    if (existingCtx && !existingCtx.closing) {
      page = await existingCtx.context.newPage();
    } else {
      await this.closeManualWindow(cred.profileId);
      const executablePath = this.requireBrowserExecutable();
      const profileDir = this.credentials.getProfileDir(cred.profileId);
      tempContext = await chromium.launchPersistentContext(profileDir, {
        executablePath,
        headless: true,
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
        args: ['--no-sandbox'],
      });
      page = tempContext.pages()[0] ?? (await tempContext.newPage());
    }

    let screenshotUrl: string | undefined;
    try {
      const result = await performSiteLogin({
        page,
        credential: cred,
        preset,
        credentials: this.credentials,
      });
      const safeMsg = this.redact(result.message);
      const shotBytes = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      if (shotBytes) {
        screenshotUrl = this.saveTestShot(shotBytes);
      }
      const updated =
        this.credentials.updateLastLogin(cred.id, {
          at: new Date().toISOString(),
          status: result.status,
          message: safeMsg,
        }) ?? cred;

      this.credentials.touchProfile(cred.profileId);
      return {
        status: result.status,
        message: safeMsg,
        ...(screenshotUrl ? { screenshotUrl } : {}),
        credential: updated,
      };
    } catch (err) {
      const safeErr = this.redact(err instanceof Error ? err.message : String(err));
      const shotBytes = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      if (shotBytes) screenshotUrl = this.saveTestShot(shotBytes);
      const updated =
        this.credentials.updateLastLogin(cred.id, {
          at: new Date().toISOString(),
          status: 'error',
          message: safeErr,
        }) ?? cred;
      return {
        status: 'error',
        message: safeErr,
        ...(screenshotUrl ? { screenshotUrl } : {}),
        credential: updated,
      };
    } finally {
      if (tempContext) {
        await tempContext.close().catch(() => undefined);
      } else {
        await page.close().catch(() => undefined);
      }
    }
  }

  public async detectPreset(loginUrl: string): Promise<DetectedSitePreset> {
    const parsed = new URL(loginUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL login harus menggunakan http:// atau https://.');
    }
    const executablePath = this.requireBrowserExecutable();
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox'],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
      });
      const page = await context.newPage();
      await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(400);

      const detected = await detectLoginForm(page);
      const screenshotUrl = this.saveTestShot(detected.screenshotBytes);
      return {
        origin: detected.origin,
        loginUrl: detected.loginUrl,
        flow: detected.flow,
        selectors: detected.selectors,
        screenshotUrl,
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- shutdown

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.idleTimer);

    for (const entry of [...this.approvals.values()]) {
      entry.resolve(false);
    }
    this.approvals.clear();

    for (const s of [...this.sessions.values()]) {
      await this.stopSessionWatch(s);
      s.status = 'closed';
      s.pauseWaiter?.resolve();
      s.takeoverWaiter?.resolve();
    }
    this.sessions.clear();

    for (const ctx of [...this.contexts.values()]) {
      ctx.closing = true;
      await ctx.context.close().catch(() => undefined);
    }
    this.contexts.clear();

    for (const manual of [...this.manualWindows.values()]) {
      await manual.close().catch(() => undefined);
    }
    this.manualWindows.clear();
    this.turnTokens.clear();
  }
}
