import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { CliInstallProgressEvent, RealProvider } from '@atelier/contracts';
import type { AtelierStore } from '../store.js';
import { execCliCapture, resolveCliBinary } from './cli-spawn.js';
import { invalidateModelCatalog } from './model-catalog.js';
import type { ProviderAuthManager } from './provider-auth.js';

const execFileAsync = promisify(execFile);

export class CliInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

const SUPPORTED_INSTALLERS = new Set<RealProvider>(['claude', 'openai', 'opencode', 'antigravity']);
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';

function isAllowedTarballUrl(rawUrl: string, registryBaseUrl?: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return (
        parsed.hostname === 'registry.npmjs.org' ||
        parsed.hostname.endsWith('.npmjs.org') ||
        parsed.hostname === 'npmjs.org'
      );
    }
    if (registryBaseUrl) {
      const base = new URL(registryBaseUrl);
      if (parsed.origin === base.origin && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function findFileRecursive(rootDir: string, filenames: string[]): string | null {
  if (!fs.existsSync(rootDir)) return null;
  const targets = new Set(filenames.map((f) => f.toLowerCase()));
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isFile() && targets.has(entry.name.toLowerCase())) {
      return full;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = findFileRecursive(path.join(rootDir, entry.name), filenames);
    if (hit) return hit;
  }
  return null;
}

function parseNpmAliasSpec(spec: string): { pkg: string; version: string } | null {
  // Matches "npm:@openai/codex@0.172.0-win32-x64"
  const m = spec.trim().match(/^npm:(@?[^@]+)@(.+)$/);
  return m ? { pkg: m[1]!, version: m[2]! } : null;
}

function resolvePlatformTarget(): {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  codexOptKey: string;
  codexTriple: string;
  openCodeOptKey: string;
} {
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const rawArch =
    plat === 'win32' && os.arch() === 'x64' && process.env.PROCESSOR_IDENTIFIER?.startsWith('ARM')
      ? 'arm64'
      : os.arch() === 'arm64'
        ? 'arm64'
        : 'x64';
  const osName = plat === 'win32' ? 'windows' : plat;
  const codexTriple =
    plat === 'win32'
      ? `x86_64-pc-windows-msvc`.replace('x86_64', rawArch === 'arm64' ? 'aarch64' : 'x86_64')
      : plat === 'darwin'
        ? `${rawArch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
        : `${rawArch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  return {
    platform: plat,
    arch: rawArch,
    codexOptKey: `@openai/codex-${plat}-${rawArch}`,
    codexTriple,
    openCodeOptKey: `@opencode/cli-${osName}-${rawArch}`,
  };
}

/**
 * Installs standalone official provider CLIs into `<dataDir>/cli/` (or official installer locations)
 * so laptops without Node.js/npm can install CLIs in 1 click directly from Models & Providers.
 */
export class CliInstaller {
  private readonly activeInstalls = new Map<RealProvider, CliInstallProgressEvent>();
  private readonly registryBaseUrl: string;

  constructor(
    private readonly opts: {
      dataDir: string;
      store: AtelierStore;
      authManager: ProviderAuthManager;
      onProgress?: (ev: CliInstallProgressEvent) => void;
      registryBaseUrl?: string;
      scriptRunner?: (provider: 'claude' | 'antigravity') => Promise<string | null>;
    },
  ) {
    this.registryBaseUrl = (opts.registryBaseUrl || DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
  }

  public getActiveInstall(provider: RealProvider): CliInstallProgressEvent | null {
    return this.activeInstalls.get(provider) ?? null;
  }

  public startInstall(provider: RealProvider): CliInstallProgressEvent {
    if (!SUPPORTED_INSTALLERS.has(provider)) {
      throw new CliInstallError('unsupported_installer', 'This provider uses an API key, not a CLI.', 400);
    }
    if (this.activeInstalls.has(provider)) {
      throw new CliInstallError('install_in_progress', `Already installing ${provider} CLI.`, 409);
    }

    const initial: CliInstallProgressEvent = {
      provider,
      status: 'downloading',
      percent: provider === 'claude' || provider === 'antigravity' ? null : 0,
      message: 'Starting CLI installation…',
    };
    this.emit(initial);
    void this.runInstall(provider);
    return initial;
  }

  private emit(ev: CliInstallProgressEvent): void {
    if (ev.status === 'done' || ev.status === 'error') {
      this.activeInstalls.delete(ev.provider);
    } else {
      this.activeInstalls.set(ev.provider, ev);
    }
    this.opts.onProgress?.(ev);
  }

  private async fetchJson<T>(pkgName: string, versionOrTag: string): Promise<T> {
    const encodedPkg = pkgName.startsWith('@') ? `@${encodeURIComponent(pkgName.slice(1))}` : encodeURIComponent(pkgName);
    const url = `${this.registryBaseUrl}/${encodedPkg}/${encodeURIComponent(versionOrTag)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`Registry returned ${res.status} for ${pkgName}@${versionOrTag}`);
    }
    return (await res.json()) as T;
  }

  private async resolveTarballUrl(provider: 'openai' | 'opencode'): Promise<string> {
    const target = resolvePlatformTarget();
    if (provider === 'openai') {
      const rootMeta = await this.fetchJson<{ optionalDependencies?: Record<string, string> }>(
        '@openai/codex',
        'latest',
      );
      const spec = rootMeta.optionalDependencies?.[target.codexOptKey];
      const parsed = spec ? parseNpmAliasSpec(spec) : null;
      if (!parsed) {
        throw new Error(`No prebuilt Codex CLI binary found for ${target.platform}-${target.arch}`);
      }
      const platMeta = await this.fetchJson<{ dist?: { tarball?: string } }>(parsed.pkg, parsed.version);
      if (!platMeta.dist?.tarball) {
        throw new Error(`Missing tarball URL for ${parsed.pkg}@${parsed.version}`);
      }
      return platMeta.dist.tarball;
    }

    const rootMeta = await this.fetchJson<{ optionalDependencies?: Record<string, string> }>(
      '@opencode/cli',
      'latest',
    );
    const version = rootMeta.optionalDependencies?.[target.openCodeOptKey];
    if (!version) {
      throw new Error(`No prebuilt OpenCode CLI binary found for ${target.platform}-${target.arch}`);
    }
    const platMeta = await this.fetchJson<{ dist?: { tarball?: string } }>(target.openCodeOptKey, version);
    if (!platMeta.dist?.tarball) {
      throw new Error(`Missing tarball URL for ${target.openCodeOptKey}@${version}`);
    }
    return platMeta.dist.tarball;
  }

  private async installFromNpmTarball(provider: 'openai' | 'opencode'): Promise<string> {
    const tarballUrl = await this.resolveTarballUrl(provider);
    if (!isAllowedTarballUrl(tarballUrl, this.opts.registryBaseUrl)) {
      throw new Error(`Blocked untrusted CLI download URL: ${tarballUrl}`);
    }

    const cliRoot = path.join(this.opts.dataDir, 'cli');
    const tmpDir = path.join(cliRoot, '.tmp');
    const stageDir = path.join(cliRoot, `${provider}-next`);
    const finalDir = path.join(cliRoot, provider);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });

    const tmpTgz = path.join(tmpDir, `${provider}-${Date.now()}.tgz`);
    try {
      const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed (${res.status} ${res.statusText})`);
      }

      const totalBytes = Number(res.headers.get('content-length') ?? 0);
      let downloaded = 0;
      let lastPct = -1;
      const bodyStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
      bodyStream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        if (totalBytes > 0) {
          const pct = Math.min(85, Math.round((downloaded / totalBytes) * 85));
          if (pct >= lastPct + 4 || pct === 85) {
            lastPct = pct;
            this.emit({
              provider,
              status: 'downloading',
              percent: pct,
              message: `Downloading ${provider === 'openai' ? 'Codex' : 'OpenCode'} CLI (${pct}%)…`,
            });
          }
        }
      });

      await pipeline(bodyStream, fs.createWriteStream(tmpTgz));

      this.emit({
        provider,
        status: 'extracting',
        percent: 90,
        message: 'Extracting CLI binary…',
      });
      await execFileAsync('tar', ['-xzf', tmpTgz, '-C', stageDir], {
        timeout: 120_000,
        windowsHide: true,
      });

      const expectedNames =
        provider === 'openai'
          ? process.platform === 'win32'
            ? ['codex.exe', 'codex.cmd']
            : ['codex']
          : process.platform === 'win32'
            ? ['opencode.exe', 'opencode.cmd']
            : ['opencode'];
      const stagedExe = findFileRecursive(stageDir, expectedNames);
      if (!stagedExe) {
        throw new Error(`Extracted archive did not contain ${expectedNames[0]}.`);
      }

      if (process.platform !== 'win32') {
        fs.chmodSync(stagedExe, 0o755);
      }

      this.emit({
        provider,
        status: 'verifying',
        percent: 96,
        message: 'Verifying CLI executable…',
      });
      const ver = await execCliCapture(stagedExe, ['--version'], 10_000);
      if (ver.exitCode !== 0 && !ver.stdout.trim()) {
        throw new Error(ver.stderr.trim() || `Verification failed (exit ${ver.exitCode})`);
      }

      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(stageDir, finalDir);
      const finalExe = path.join(finalDir, path.relative(stageDir, stagedExe));
      return finalExe;
    } finally {
      fs.rmSync(tmpTgz, { force: true });
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async installViaOfficialScript(provider: 'claude' | 'antigravity'): Promise<string> {
    if (this.opts.scriptRunner) {
      const customExe = await this.opts.scriptRunner(provider);
      if (customExe) return customExe;
    }

    const scriptUrl =
      provider === 'claude'
        ? process.platform === 'win32'
          ? 'https://claude.ai/install.ps1'
          : 'https://claude.ai/install.sh'
        : process.platform === 'win32'
          ? 'https://antigravity.google/cli/install.ps1'
          : 'https://antigravity.google/cli/install.sh';

    this.emit({
      provider,
      status: 'downloading',
      percent: null,
      message: `Installing ${provider === 'claude' ? 'Claude Code' : 'Antigravity'} CLI via official installer…`,
    });

    if (process.platform === 'win32') {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `irm '${scriptUrl}' | iex`,
        ],
        { timeout: 5 * 60_000, windowsHide: true },
      );
    } else {
      await execFileAsync(
        'bash',
        ['-c', `curl -fsSL '${scriptUrl}' | bash`],
        { timeout: 5 * 60_000 },
      );
    }

    this.emit({
      provider,
      status: 'verifying',
      percent: 95,
      message: 'Verifying CLI executable…',
    });

    const detected = await resolveCliBinary(provider);
    if (!detected) {
      throw new Error(`Installer finished but ${provider} binary was not found on PATH or default locations.`);
    }
    const ver = await execCliCapture(detected, ['--version'], 10_000);
    if (ver.exitCode !== 0 && !ver.stdout.trim()) {
      throw new Error(ver.stderr.trim() || `${provider} --version failed.`);
    }
    return detected;
  }

  private async runInstall(provider: RealProvider): Promise<void> {
    try {
      const cliPath =
        provider === 'openai' || provider === 'opencode'
          ? await this.installFromNpmTarball(provider)
          : await this.installViaOfficialScript(provider as 'claude' | 'antigravity');

      const currentPaths = this.opts.store.getSettings().cliPaths ?? {};
      this.opts.store.updateSettings({
        cliPaths: { ...currentPaths, [provider]: cliPath },
      });
      invalidateModelCatalog(provider);
      if (provider === 'antigravity') {
        this.opts.authManager.invalidateAntigravityCache();
      }

      this.emit({
        provider,
        status: 'done',
        percent: 100,
        message: 'CLI installed and ready.',
        cliPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        provider,
        status: 'error',
        percent: null,
        message: `Failed to install ${provider} CLI`,
        error: msg,
      });
    }
  }
}
