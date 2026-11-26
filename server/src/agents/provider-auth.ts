import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry, ProviderAuthStatus, RealProvider, Settings } from '@atelier/contracts';
import type { AtelierStore } from '../store.js';
import {
  buildWindowsCmdCommand,
  cleanAntigravityEnv,
  execCliCapture,
  getOpenCodeCliCapabilities,
  killProcessTree,
  resolveCliBinary,
  spawnCli,
  unwrapWindowsCmdShim,
} from './cli-spawn.js';
import { invalidateModelCatalog, parseAntigravityModelsOutput } from './model-catalog.js';

interface ActiveLoginState {
  child: ChildProcess;
  authUrl: string | null;
  startedAt: number;
}

interface ActiveLogoutState {
  child: ChildProcess;
  startedAt: number;
}

interface AntigravityProbe {
  authenticated: boolean;
  models: ModelEntry[];
  versionLabel: string;
}

const PROVIDER_LABELS: Record<RealProvider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'ChatGPT (Codex)',
  antigravity: 'Antigravity (Google)',
  deepseek: 'DeepSeek (API)',
  opencode: 'OpenCode CLI',
  openrouter: 'OpenRouter (API)',
};

const AGY_PROBE_CACHE_MS = 20_000;
const AGY_UNAUTH_RE = /not\s+logged\s+in|unauthenticated|unauthorized|invalid_grant|please\s+sign\s+in|secret\s+keyring\s+is\s+locked/i;

function ensureAgyOAuthSettingsFile(): string {
  const filePath = path.join(os.tmpdir(), 'atelier-agy-oauth.json');
  fs.writeFileSync(filePath, '{"modelProvider":""}\n', 'utf8');
  return filePath;
}

function spawnInteractiveCliWindow(
  title: string,
  cliPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  let child: ChildProcess;
  if (process.platform === 'win32' && !process.env.VITEST) {
    const isWindowsBatch = /\.(cmd|bat)$/i.test(cliPath);
    const unwrapped = isWindowsBatch ? unwrapWindowsCmdShim(cliPath) : null;
    const targetCmd = unwrapped ? unwrapped.command : cliPath;
    const targetArgs = unwrapped ? [...unwrapped.prefixArgs, ...args] : args;
    child = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', buildWindowsCmdCommand('start', [title, '/wait', targetCmd, ...targetArgs])],
      {
        env: env ?? process.env,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: true,
      },
    );
  } else if (process.platform === 'darwin' && !process.env.VITEST) {
    const cmdLine = [cliPath, ...args]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    child = spawn(
      'osascript',
      [
        '-e',
        `tell application "Terminal" to do script ${JSON.stringify(cmdLine)}`,
        '-e',
        'tell application "Terminal" to activate',
      ],
      {
        env: env ?? process.env,
        stdio: 'ignore',
      },
    );
  } else {
    child = spawnCli(cliPath, args, { env, stdin: 'ignore' });
  }
  child.on('error', () => {});
  return child;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

const OPENCODE_EMPTY_AUTH_RE = /no\s+(?:credentials|providers|auth|authenticated\s+integrations|integrations)|0\s+credentials/i;

function getOpenCodeAuthPaths(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(appData, 'opencode', 'auth.json'),
    path.join(localAppData, 'opencode', 'auth.json'),
  ];
}

/**
 * In OpenCode v1, `opencode` and `opencode-go` are stored as separate keys in `auth.json`.
 * Mirrors the API key between both entries whenever one exists without the other.
 */
export function syncLegacyOpenCodeGoKey(paths: string[] = getOpenCodeAuthPaths()): void {
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const oc = parsed.opencode as { type?: unknown; key?: unknown } | undefined;
      const go = parsed['opencode-go'] as { type?: unknown; key?: unknown } | undefined;
      let changed = false;
      if (oc && typeof oc.key === 'string' && oc.key.trim() && !go) {
        parsed['opencode-go'] = { type: 'api', key: oc.key.trim() };
        changed = true;
      } else if (go && typeof go.key === 'string' && go.key.trim() && !oc) {
        parsed.opencode = { type: 'api', key: go.key.trim() };
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      // ignore malformed auth.json
    }
  }
}

/** Extracts connected integration names from `opencode auth list` output. */
export function parseOpenCodeAuthList(stdout: string): string[] {
  const clean = stdout.replace(ANSI_ESCAPE_RE, '');
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (OPENCODE_EMPTY_AUTH_RE.test(line)) continue;
    if (/^[-─=_]+$/.test(line) || /^(provider|integration|name)\s{2,}/i.test(line)) continue;
    const col1 = line.split(/\s{2,}/)[0]?.trim();
    if (col1 && !seen.has(col1)) {
      seen.add(col1);
      names.push(col1);
    }
  }
  return names;
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return `••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export class ProviderAuthManager {
  private readonly activeLogins = new Map<RealProvider, ActiveLoginState>();
  private readonly activeLogouts = new Map<RealProvider, ActiveLogoutState>();
  private readonly agyProbeCache = new Map<string, { at: number } & AntigravityProbe>();
  private readonly agyVersionCache = new Map<string, string>();
  private latestAntigravityModels: ModelEntry[] = [];

  public getDiscoveredAntigravityModels(): ModelEntry[] {
    return this.latestAntigravityModels;
  }

  public invalidateAntigravityCache(): void {
    this.agyProbeCache.clear();
  }

  public async getStatus(
    provider: RealProvider,
    settings: Settings,
    store?: AtelierStore,
  ): Promise<ProviderAuthStatus> {
    if (provider === 'deepseek') {
      return this.checkDeepSeekStatus(store);
    }
    if (provider === 'openrouter') {
      return this.checkOpenRouterStatus(store);
    }

    const customPath = settings.cliPaths?.[provider];
    const cliPath = await resolveCliBinary(provider, customPath);
    const activeLogin = this.activeLogins.get(provider);

    if (provider === 'claude') {
      return this.checkClaudeStatus(cliPath, activeLogin);
    }
    if (provider === 'openai') {
      return this.checkOpenAiStatus(cliPath, activeLogin);
    }
    if (provider === 'antigravity') {
      return this.checkAntigravityStatus(cliPath, activeLogin, this.activeLogouts.get('antigravity'));
    }
    return this.checkOpenCodeStatus(cliPath, activeLogin);
  }

  public async getStatuses(
    settings: Settings,
    store?: AtelierStore,
  ): Promise<ProviderAuthStatus[]> {
    return Promise.all([
      this.getStatus('claude', settings, store),
      this.getStatus('openai', settings, store),
      this.getStatus('antigravity', settings, store),
      this.getStatus('deepseek', settings, store),
      this.getStatus('opencode', settings, store),
      this.getStatus('openrouter', settings, store),
    ]);
  }

  private async checkClaudeStatus(
    cliPath: string | null,
    activeLogin?: ActiveLoginState,
  ): Promise<ProviderAuthStatus> {
    const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    if (!cliPath) {
      return {
        provider: 'claude',
        label: PROVIDER_LABELS.claude,
        cliInstalled: false,
        cliPath: null,
        authenticated: hasApiKey,
        accountLabel: hasApiKey ? 'ANTHROPIC_API_KEY' : null,
        loginInProgress: Boolean(activeLogin),
        authUrl: activeLogin?.authUrl ?? null,
        message: hasApiKey
          ? 'Using ANTHROPIC_API_KEY (Claude Code CLI not found).'
          : 'Claude Code CLI not found on PATH.',
      };
    }

    const res = await execCliCapture(cliPath, ['auth', 'status', '--json'], 4000);
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    try {
      const parsed = JSON.parse(res.stdout.trim()) as {
        loggedIn?: boolean;
        email?: string;
        authMethod?: string;
        subscriptionType?: string;
      };
      if (parsed.loggedIn) {
        const account = parsed.email || parsed.subscriptionType || parsed.authMethod || 'Signed in';
        return {
          provider: 'claude',
          label: PROVIDER_LABELS.claude,
          cliInstalled: true,
          cliPath,
          authenticated: true,
          accountLabel: account,
          loginInProgress: Boolean(activeLogin),
          authUrl: activeLogin?.authUrl ?? null,
          message: `Signed in (${account})`,
        };
      }
    } catch {
      if (res.exitCode === 0 && /logged in|authenticated/i.test(combined)) {
        return {
          provider: 'claude',
          label: PROVIDER_LABELS.claude,
          cliInstalled: true,
          cliPath,
          authenticated: true,
          accountLabel: 'Claude account',
          loginInProgress: Boolean(activeLogin),
          authUrl: activeLogin?.authUrl ?? null,
          message: 'Signed in via Claude CLI.',
        };
      }
    }

    return {
      provider: 'claude',
      label: PROVIDER_LABELS.claude,
      cliInstalled: true,
      cliPath,
      authenticated: hasApiKey,
      accountLabel: hasApiKey ? 'ANTHROPIC_API_KEY' : null,
      loginInProgress: Boolean(activeLogin),
      authUrl: activeLogin?.authUrl ?? null,
      message: activeLogin
        ? 'Waiting for browser sign-in to complete…'
        : hasApiKey
          ? 'Authenticated via ANTHROPIC_API_KEY.'
          : 'Not signed in. Click Sign in to open Anthropic OAuth.',
    };
  }

  private async checkOpenAiStatus(
    cliPath: string | null,
    activeLogin?: ActiveLoginState,
  ): Promise<ProviderAuthStatus> {
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
    if (!cliPath) {
      return {
        provider: 'openai',
        label: PROVIDER_LABELS.openai,
        cliInstalled: false,
        cliPath: null,
        authenticated: false,
        accountLabel: null,
        loginInProgress: Boolean(activeLogin),
        authUrl: activeLogin?.authUrl ?? null,
        message: 'Codex CLI not found. Install `@openai/codex` or set custom CLI path.',
      };
    }

    const res = await execCliCapture(cliPath, ['login', 'status'], 4000);
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    const loggedIn = res.exitCode === 0 && !/not logged in/i.test(combined);
    const labelMatch = combined.match(/Logged in using (.+)/i);

    return {
      provider: 'openai',
      label: PROVIDER_LABELS.openai,
      cliInstalled: true,
      cliPath,
      authenticated: loggedIn || hasApiKey,
      accountLabel: loggedIn
        ? labelMatch?.[1]?.trim() || 'ChatGPT account'
        : hasApiKey
          ? 'OPENAI_API_KEY'
          : null,
      loginInProgress: Boolean(activeLogin),
      authUrl: activeLogin?.authUrl ?? null,
      message: loggedIn
        ? combined || 'Signed in with ChatGPT.'
        : activeLogin
          ? 'Waiting for ChatGPT browser sign-in…'
          : hasApiKey
            ? 'Authenticated via OPENAI_API_KEY.'
            : 'Not signed in. Click Sign in to log in with ChatGPT.',
    };
  }

  private async probeAntigravityAuth(
    cliPath: string,
    bypassCache: boolean,
  ): Promise<AntigravityProbe> {
    const cached = this.agyProbeCache.get(cliPath);
    if (!bypassCache && cached && Date.now() - cached.at < AGY_PROBE_CACHE_MS) {
      return {
        authenticated: cached.authenticated,
        models: cached.models,
        versionLabel: cached.versionLabel,
      };
    }

    const agyEnv = cleanAntigravityEnv();
    let versionLabel = this.agyVersionCache.get(cliPath);
    if (!versionLabel) {
      const verRes = await execCliCapture(cliPath, ['--version'], 3500, agyEnv);
      const rawVer = verRes.stdout.trim().split(/\r?\n/)[0]?.trim() || '';
      versionLabel = rawVer ? (rawVer.startsWith('agy') ? rawVer : `agy ${rawVer}`) : 'agy CLI';
      this.agyVersionCache.set(cliPath, versionLabel);
    }

    const res = await execCliCapture(cliPath, ['models'], 7000, agyEnv);
    const models = parseAntigravityModelsOutput(res.stdout);
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    const authenticated =
      res.exitCode === 0 && models.length > 0 && !AGY_UNAUTH_RE.test(combined);

    this.latestAntigravityModels = authenticated ? models : [];
    const probe: AntigravityProbe = { authenticated, models, versionLabel };
    this.agyProbeCache.set(cliPath, { at: Date.now(), ...probe });
    return probe;
  }

  private async checkAntigravityStatus(
    cliPath: string | null,
    activeLogin?: ActiveLoginState,
    activeLogout?: ActiveLogoutState,
  ): Promise<ProviderAuthStatus> {
    if (!cliPath) {
      return {
        provider: 'antigravity',
        label: PROVIDER_LABELS.antigravity,
        authMode: 'cli',
        cliInstalled: false,
        cliPath: null,
        authenticated: false,
        accountLabel: null,
        loginInProgress: false,
        authUrl: null,
        message: 'Antigravity CLI (`agy`) not found on PATH. Install `agy` or set custom CLI path.',
      };
    }

    const probe = await this.probeAntigravityAuth(cliPath, Boolean(activeLogin || activeLogout));
    let nextLogin = activeLogin;
    let nextLogout = activeLogout;

    if (nextLogin && probe.authenticated) {
      this.activeLogins.delete('antigravity');
      const loginChild = nextLogin.child;
      const closeTimer = setTimeout(() => killProcessTree(loginChild), 600);
      closeTimer.unref?.();
      invalidateModelCatalog('antigravity');
      nextLogin = undefined;
    }

    if (nextLogout && !probe.authenticated) {
      this.activeLogouts.delete('antigravity');
      killProcessTree(nextLogout.child);
      invalidateModelCatalog('antigravity');
      nextLogout = undefined;
    }

    const loginInProgress = Boolean(nextLogin || nextLogout);
    const message = nextLogout
      ? 'Signing out of Antigravity CLI…'
      : probe.authenticated
        ? `Signed in (${probe.versionLabel} · ${probe.models.length} models)`
        : nextLogin
          ? 'Finish Google sign-in in the opened Antigravity CLI window…'
          : 'CLI found. Click Sign in to authenticate with Google OAuth.';

    return {
      provider: 'antigravity',
      label: PROVIDER_LABELS.antigravity,
      authMode: 'cli',
      cliInstalled: true,
      cliPath,
      authenticated: probe.authenticated,
      accountLabel: probe.authenticated ? `Google OAuth (${probe.versionLabel})` : null,
      loginInProgress,
      authUrl: nextLogin?.authUrl ?? null,
      message,
    };
  }

  private checkDeepSeekStatus(store?: AtelierStore): ProviderAuthStatus {
    const savedKey = store?.getProviderSecret('deepseek')?.trim() || null;
    const envKey = process.env.DEEPSEEK_API_KEY?.trim() || null;
    const effective = savedKey || envKey;

    return {
      provider: 'deepseek',
      label: PROVIDER_LABELS.deepseek,
      authMode: 'api_key',
      cliInstalled: true,
      cliPath: null,
      authenticated: Boolean(effective),
      accountLabel: savedKey ? maskApiKey(savedKey) : envKey ? 'DEEPSEEK_API_KEY' : null,
      loginInProgress: false,
      authUrl: null,
      message: savedKey
        ? `API key saved locally (${maskApiKey(savedKey)}).`
        : envKey
          ? 'Authenticated via DEEPSEEK_API_KEY.'
          : 'Not configured. Click API key to enter your DeepSeek key.',
    };
  }

  private checkOpenRouterStatus(store?: AtelierStore): ProviderAuthStatus {
    const savedKey = store?.getProviderSecret('openrouter')?.trim() || null;
    const envKey = process.env.OPENROUTER_API_KEY?.trim() || null;
    const effective = savedKey || envKey;

    return {
      provider: 'openrouter',
      label: PROVIDER_LABELS.openrouter,
      authMode: 'api_key',
      cliInstalled: true,
      cliPath: null,
      authenticated: Boolean(effective),
      accountLabel: savedKey ? maskApiKey(savedKey) : envKey ? 'OPENROUTER_API_KEY' : null,
      loginInProgress: false,
      authUrl: null,
      message: savedKey
        ? `API key saved locally (${maskApiKey(savedKey)}).`
        : envKey
          ? 'Authenticated via OPENROUTER_API_KEY.'
          : 'Not configured. Click API key to enter your OpenRouter key.',
    };
  }

  private hasOpenCodeAuthFile(): boolean {
    syncLegacyOpenCodeGoKey();
    for (const file of getOpenCodeAuthPaths()) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return true;
        }
      } catch {
        // ignore unreadable auth cache
      }
    }
    return false;
  }

  /**
   * Saves an OpenCode / OpenCode Go API key directly into OpenCode CLI (v2 `auth import` and v1 `auth.json`)
   * so OpenCode Go models become immediately available without manual terminal setup.
   */
  public async saveOpenCodeApiKey(
    apiKey: string,
    settings: Settings,
    store?: AtelierStore,
    opts?: { legacyAuthPath?: string },
  ): Promise<ProviderAuthStatus> {
    const cleanKey = apiKey.trim();
    if (!cleanKey) {
      throw new Error('OpenCode API key is required.');
    }
    const cliPath = await resolveCliBinary('opencode', settings.cliPaths?.opencode);
    if (!cliPath) {
      throw new Error('OpenCode CLI is not installed yet. Click Install CLI first.');
    }

    const { major, standaloneArgs } = await getOpenCodeCliCapabilities(cliPath);
    if (major >= 2) {
      let existingCredId = `cred_atelier_${Date.now().toString(36)}`;
      try {
        const exported = await execCliCapture(cliPath, [...standaloneArgs, 'auth', 'export'], 5000);
        if (exported.exitCode === 0 && exported.stdout.trim()) {
          const arr = JSON.parse(exported.stdout.replace(/^\uFEFF/, '').trim());
          if (Array.isArray(arr)) {
            const match = arr.find(
              (item) =>
                item &&
                typeof item === 'object' &&
                String((item as Record<string, unknown>).integrationID ?? '').toLowerCase() === 'opencode',
            ) as Record<string, unknown> | undefined;
            if (match && typeof match.id === 'string' && match.id.trim()) {
              existingCredId = match.id.trim();
            }
          }
        }
      } catch {
        // ignore auth export failure; fall back to fresh cred id
      }

      const tmpFile = path.join(os.tmpdir(), `atelier-oc-auth-${Date.now()}.json`);
      const payload = [
        {
          id: existingCredId,
          integrationID: 'opencode',
          active: true,
          value: { type: 'key', key: cleanKey },
        },
      ];
      fs.writeFileSync(tmpFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      try {
        const imported = await execCliCapture(cliPath, [...standaloneArgs, 'auth', 'import', tmpFile], 8000);
        if (imported.exitCode !== 0) {
          const msg = `${imported.stderr}\n${imported.stdout}`.trim();
          throw new Error(msg || `opencode auth import failed (exit ${imported.exitCode})`);
        }
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }
    }

    // Also populate v1 auth.json for OpenCode v1 compatibility
    const v1AuthPath = opts?.legacyAuthPath ?? getOpenCodeAuthPaths()[0]!;
    try {
      fs.mkdirSync(path.dirname(v1AuthPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(v1AuthPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(v1AuthPath, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing = parsed as Record<string, unknown>;
          }
        } catch {
          // overwrite malformed file
        }
      }
      existing.opencode = { type: 'api', key: cleanKey };
      existing['opencode-go'] = { type: 'api', key: cleanKey };
      fs.writeFileSync(v1AuthPath, `${JSON.stringify(existing, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // ignore if v2 auth import already succeeded
    }

    invalidateModelCatalog('opencode');
    return this.getStatus('opencode', settings, store);
  }

  private async checkOpenCodeStatus(
    cliPath: string | null,
    activeLogin?: ActiveLoginState,
  ): Promise<ProviderAuthStatus> {
    if (!cliPath) {
      return {
        provider: 'opencode',
        label: PROVIDER_LABELS.opencode,
        authMode: 'cli',
        cliInstalled: false,
        cliPath: null,
        authenticated: false,
        accountLabel: null,
        loginInProgress: Boolean(activeLogin),
        authUrl: activeLogin?.authUrl ?? null,
        message: 'OpenCode CLI not found. Install `opencode` or set custom CLI path.',
      };
    }

    const { standaloneArgs } = await getOpenCodeCliCapabilities(cliPath);
    const [verRes, listRes] = await Promise.all([
      execCliCapture(cliPath, ['--version'], 3500),
      execCliCapture(cliPath, [...standaloneArgs, 'auth', 'list'], 3500),
    ]);
    const versionLabel = verRes.stdout.trim().split(/\r?\n/)[0] || 'opencode CLI';
    const listOut = `${listRes.stdout}\n${listRes.stderr}`.trim();
    const connectedNames = listRes.exitCode === 0 ? parseOpenCodeAuthList(listRes.stdout) : [];
    const hasListedCreds =
      connectedNames.length > 0 ||
      (listRes.exitCode === 0 &&
        listOut.length > 0 &&
        !OPENCODE_EMPTY_AUTH_RE.test(listOut));
    const hasEnvKey = Boolean(
      process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.OPENAI_API_KEY?.trim() ||
        process.env.DEEPSEEK_API_KEY?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim() ||
        process.env.OPENCODE_API_KEY?.trim() ||
        process.env.OPENCODE_ZEN_API_KEY?.trim(),
    );
    const authenticated = this.hasOpenCodeAuthFile() || hasListedCreds || hasEnvKey;

    return {
      provider: 'opencode',
      label: PROVIDER_LABELS.opencode,
      authMode: 'cli',
      cliInstalled: true,
      cliPath,
      authenticated,
      accountLabel: authenticated
        ? connectedNames.length > 0
          ? `${connectedNames.join(', ')} (${versionLabel})`
          : versionLabel
        : null,
      loginInProgress: Boolean(activeLogin),
      authUrl: activeLogin?.authUrl ?? null,
      message: authenticated
        ? connectedNames.length > 0
          ? `Connected: ${connectedNames.join(', ')} (${versionLabel})`
          : `Ready (${versionLabel})`
        : activeLogin
          ? 'Complete OpenCode authentication in the opened window…'
          : 'CLI found. Click Sign in or configure a provider inside OpenCode.',
    };
  }

  public async startLogin(
    provider: RealProvider,
    settings: Settings,
    store?: AtelierStore,
  ): Promise<ProviderAuthStatus> {
    if (provider === 'deepseek' || provider === 'openrouter') {
      return this.getStatus(provider, settings, store);
    }

    const customPath = settings.cliPaths?.[provider];
    const cliPath = await resolveCliBinary(provider, customPath);
    if (!cliPath) {
      return this.getStatus(provider, settings, store);
    }

    if (provider === 'antigravity') {
      store?.setProviderSecret('antigravity', null);
      const pendingLogout = this.activeLogouts.get('antigravity');
      if (pendingLogout) {
        killProcessTree(pendingLogout.child);
        this.activeLogouts.delete('antigravity');
      }
      const existing = this.activeLogins.get('antigravity');
      if (existing) {
        if (Date.now() - existing.startedAt <= 3000) {
          return this.getStatus(provider, settings, store);
        }
        killProcessTree(existing.child);
        this.activeLogins.delete('antigravity');
      }
      this.agyProbeCache.clear();
      invalidateModelCatalog('antigravity');

      const child = spawnInteractiveCliWindow(
        'Antigravity Google Login',
        cliPath,
        [`--settings=${ensureAgyOAuthSettingsFile()}`],
        cleanAntigravityEnv(),
      );
      const state: ActiveLoginState = {
        child,
        authUrl: null,
        startedAt: Date.now(),
      };
      this.activeLogins.set('antigravity', state);

      const timeout = setTimeout(() => {
        if (this.activeLogins.get('antigravity') === state) {
          this.activeLogins.delete('antigravity');
          killProcessTree(child);
        }
      }, 180_000);
      timeout.unref?.();

      child.once('close', () => {
        clearTimeout(timeout);
        if (this.activeLogins.get('antigravity') === state) {
          this.activeLogins.delete('antigravity');
        }
      });

      await new Promise((r) => setTimeout(r, 450));
      return this.getStatus('antigravity', settings, store);
    }

    // Return existing active login if already running (OpenCode allows launching multiple times to add providers)
    if (provider !== 'opencode' && this.activeLogins.has(provider)) {
      return this.getStatus(provider, settings, store);
    }

    const args =
      provider === 'claude'
        ? ['auth', 'login']
        : provider === 'openai'
          ? ['login']
          : provider === 'opencode'
            ? ['auth', 'login']
            : [];

    const child =
      provider === 'opencode' && process.platform === 'win32'
        ? spawnInteractiveCliWindow('OpenCode Login', cliPath, args)
        : spawnCli(cliPath, args, { stdin: 'ignore' });

    const state: ActiveLoginState = {
      child,
      authUrl: null,
      startedAt: Date.now(),
    };
    this.activeLogins.set(provider, state);

    const captureUrl = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[^\s"'<>]+/i);
      if (match && !state.authUrl) {
        state.authUrl = match[0];
      }
    };

    child.stdout?.on('data', captureUrl);
    child.stderr?.on('data', captureUrl);

    const timeout = setTimeout(() => {
      if (this.activeLogins.get(provider) === state) {
        this.activeLogins.delete(provider);
        killProcessTree(child);
      }
    }, 180_000);
    timeout.unref?.();

    child.once('close', () => {
      clearTimeout(timeout);
      if (this.activeLogins.get(provider) === state) {
        this.activeLogins.delete(provider);
      }
      invalidateModelCatalog(provider);
    });

    // Wait briefly so stdout URL has a chance to arrive
    await new Promise((r) => setTimeout(r, 450));
    return this.getStatus(provider, settings, store);
  }

  public async logout(
    provider: RealProvider,
    settings: Settings,
    store?: AtelierStore,
  ): Promise<ProviderAuthStatus> {
    if (provider === 'deepseek' || provider === 'openrouter') {
      store?.setProviderSecret(provider, null);
      return this.getStatus(provider, settings, store);
    }

    const active = this.activeLogins.get(provider);
    if (active) {
      killProcessTree(active.child);
      this.activeLogins.delete(provider);
    }

    const customPath = settings.cliPaths?.[provider];
    const cliPath = await resolveCliBinary(provider, customPath);

    if (provider === 'antigravity') {
      store?.setProviderSecret('antigravity', null);
      const prevLogout = this.activeLogouts.get('antigravity');
      if (prevLogout) {
        killProcessTree(prevLogout.child);
        this.activeLogouts.delete('antigravity');
      }
      this.agyProbeCache.clear();
      invalidateModelCatalog('antigravity');

      if (cliPath) {
        const child = spawnInteractiveCliWindow(
          'Antigravity Logout',
          cliPath,
          [`--settings=${ensureAgyOAuthSettingsFile()}`, '--prompt-interactive=/logout'],
          cleanAntigravityEnv(),
        );
        const logoutState: ActiveLogoutState = { child, startedAt: Date.now() };
        this.activeLogouts.set('antigravity', logoutState);

        const timeout = setTimeout(() => {
          if (this.activeLogouts.get('antigravity') === logoutState) {
            this.activeLogouts.delete('antigravity');
            killProcessTree(child);
          }
        }, 60_000);
        timeout.unref?.();

        child.once('close', () => {
          clearTimeout(timeout);
          if (this.activeLogouts.get('antigravity') === logoutState) {
            this.activeLogouts.delete('antigravity');
          }
        });

        const waits = process.env.VITEST ? [80, 120, 150] : [700, 1000, 1200];
        for (const ms of waits) {
          await new Promise((r) => setTimeout(r, ms));
          if (this.activeLogouts.get('antigravity') !== logoutState) break;
          const probe = await this.probeAntigravityAuth(cliPath, true);
          if (!probe.authenticated) {
            this.activeLogouts.delete('antigravity');
            clearTimeout(timeout);
            killProcessTree(child);
            break;
          }
        }
      }

      return this.getStatus('antigravity', settings, store);
    }

    if (cliPath) {
      if (provider === 'claude') {
        await execCliCapture(cliPath, ['auth', 'logout'], 4000);
      } else if (provider === 'opencode') {
        if (process.platform === 'win32') {
          spawnInteractiveCliWindow('OpenCode Logout', cliPath, ['auth', 'logout']);
          await new Promise((r) => setTimeout(r, 300));
        } else {
          await execCliCapture(cliPath, ['auth', 'logout'], 4000);
        }
      } else if (provider === 'openai') {
        await execCliCapture(cliPath, ['logout'], 4000);
      }
      invalidateModelCatalog(provider);
    }

    return this.getStatus(provider, settings, store);
  }

  public shutdown(): void {
    for (const active of this.activeLogins.values()) {
      killProcessTree(active.child);
    }
    this.activeLogins.clear();
    for (const active of this.activeLogouts.values()) {
      killProcessTree(active.child);
    }
    this.activeLogouts.clear();
  }
}
