import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderAuthStatus, RealProvider, Settings } from '@atelier/contracts';
import type { AtelierStore } from '../store.js';
import { execCliCapture, resolveCliBinary, spawnCli } from './cli-spawn.js';

interface ActiveLoginState {
  child: ChildProcess;
  authUrl: string | null;
  startedAt: number;
}

const PROVIDER_LABELS: Record<RealProvider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'ChatGPT (Codex)',
  antigravity: 'Antigravity (Google)',
  deepseek: 'DeepSeek (API)',
  opencode: 'OpenCode CLI',
};

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return `••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export class ProviderAuthManager {
  private readonly activeLogins = new Map<RealProvider, ActiveLoginState>();

  public async getStatus(
    provider: RealProvider,
    settings: Settings,
    store?: AtelierStore,
  ): Promise<ProviderAuthStatus> {
    if (provider === 'deepseek') {
      return this.checkDeepSeekStatus(store);
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
    if (provider === 'opencode') {
      return this.checkOpenCodeStatus(cliPath, activeLogin);
    }
    return this.checkAntigravityStatus(cliPath, activeLogin);
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

  private async checkAntigravityStatus(
    cliPath: string | null,
    activeLogin?: ActiveLoginState,
  ): Promise<ProviderAuthStatus> {
    const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    const hasCliSettings = fs.existsSync(settingsPath);
    if (!cliPath) {
      return {
        provider: 'antigravity',
        label: PROVIDER_LABELS.antigravity,
        cliInstalled: false,
        cliPath: null,
        authenticated: false,
        accountLabel: null,
        loginInProgress: Boolean(activeLogin),
        authUrl: activeLogin?.authUrl ?? null,
        message: 'Antigravity CLI (`agy`) not found on PATH. Install `agy` or set custom CLI path.',
      };
    }

    const verRes = await execCliCapture(cliPath, ['--version'], 3500);
    const versionLabel = verRes.stdout.trim().split(/\r?\n/)[0] || 'agy CLI';

    return {
      provider: 'antigravity',
      label: PROVIDER_LABELS.antigravity,
      cliInstalled: true,
      cliPath,
      authenticated: hasCliSettings,
      accountLabel: hasCliSettings ? `Google OAuth (${versionLabel})` : null,
      loginInProgress: Boolean(activeLogin),
      authUrl: activeLogin?.authUrl ?? null,
      message: hasCliSettings
        ? `Ready (${versionLabel})`
        : activeLogin
          ? 'Finish Google OAuth login in the opened Antigravity prompt.'
          : 'CLI found. Click Sign in to authenticate with Google OAuth.',
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

  private hasOpenCodeAuthFile(): boolean {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const candidates = [
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      path.join(appData, 'opencode', 'auth.json'),
      path.join(localAppData, 'opencode', 'auth.json'),
    ];
    for (const file of candidates) {
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

    const [verRes, listRes] = await Promise.all([
      execCliCapture(cliPath, ['--version'], 3500),
      execCliCapture(cliPath, ['auth', 'list'], 3500),
    ]);
    const versionLabel = verRes.stdout.trim().split(/\r?\n/)[0] || 'opencode CLI';
    const listOut = `${listRes.stdout}\n${listRes.stderr}`.trim();
    const hasListedCreds =
      listRes.exitCode === 0 &&
      listOut.length > 0 &&
      !/no\s+(credentials|providers|auth)|0\s+credentials/i.test(listOut);
    const hasEnvKey = Boolean(
      process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.OPENAI_API_KEY?.trim() ||
        process.env.DEEPSEEK_API_KEY?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim(),
    );
    const authenticated = this.hasOpenCodeAuthFile() || hasListedCreds || hasEnvKey;

    return {
      provider: 'opencode',
      label: PROVIDER_LABELS.opencode,
      authMode: 'cli',
      cliInstalled: true,
      cliPath,
      authenticated,
      accountLabel: authenticated ? versionLabel : null,
      loginInProgress: Boolean(activeLogin),
      authUrl: activeLogin?.authUrl ?? null,
      message: authenticated
        ? `Ready (${versionLabel})`
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
    if (provider === 'deepseek') {
      return this.getStatus('deepseek', settings, store);
    }

    const customPath = settings.cliPaths?.[provider];
    const cliPath = await resolveCliBinary(provider, customPath);
    if (!cliPath) {
      return this.getStatus(provider, settings, store);
    }

    // Return existing active login if already running
    if (this.activeLogins.has(provider)) {
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
      (provider === 'antigravity' || provider === 'opencode') && process.platform === 'win32'
        ? spawnCli(
            'cmd.exe',
            [
              '/c',
              'start',
              provider === 'opencode' ? 'OpenCode Login' : 'Antigravity Google Login',
              cliPath,
              ...args,
            ],
            { stdin: 'ignore' },
          )
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
        child.kill();
      }
    }, 180_000);

    child.once('close', () => {
      clearTimeout(timeout);
      if (this.activeLogins.get(provider) === state) {
        this.activeLogins.delete(provider);
      }
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
    if (provider === 'deepseek') {
      store?.setProviderSecret('deepseek', null);
      return this.getStatus('deepseek', settings, store);
    }

    const active = this.activeLogins.get(provider);
    if (active) {
      active.child.kill();
      this.activeLogins.delete(provider);
    }

    const customPath = settings.cliPaths?.[provider];
    const cliPath = await resolveCliBinary(provider, customPath);
    if (cliPath) {
      if (provider === 'claude' || provider === 'opencode') {
        await execCliCapture(cliPath, ['auth', 'logout'], 4000);
      } else if (provider === 'openai') {
        await execCliCapture(cliPath, ['logout'], 4000);
      }
    }

    return this.getStatus(provider, settings, store);
  }

  public shutdown(): void {
    for (const active of this.activeLogins.values()) {
      active.child.kill();
    }
    this.activeLogins.clear();
  }
}
