import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RealProvider } from '@atelier/contracts';

const execFileAsync = promisify(execFile);

function getCandidatePaths(provider: RealProvider): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  if (process.platform === 'win32') {
    switch (provider) {
      case 'claude':
        return [
          path.join(home, '.local', 'bin', 'claude.exe'),
          path.join(appData, 'npm', 'claude.cmd'),
          path.join(appData, 'npm', 'claude.exe'),
        ];
      case 'openai':
        return [
          path.join(appData, 'npm', 'codex.exe'),
          path.join(home, '.local', 'bin', 'codex.exe'),
          path.join(appData, 'npm', 'codex.cmd'),
        ];
      case 'antigravity':
        return [
          path.join(localAppData, 'agy', 'bin', 'agy.exe'),
          path.join(localAppData, 'Programs', 'antigravity', 'bin', 'agy.exe'),
          path.join(home, '.local', 'bin', 'agy.exe'),
          path.join(localAppData, 'agy', 'bin', 'agy.cmd'),
          path.join(appData, 'npm', 'agy.cmd'),
          path.join(localAppData, 'Programs', 'antigravity', 'bin', 'agy.cmd'),
        ];
      case 'opencode':
        return [
          path.join(home, '.opencode', 'bin', 'opencode.exe'),
          path.join(localAppData, 'opencode', 'opencode.exe'),
          path.join(appData, 'npm', 'opencode.cmd'),
          path.join(appData, 'npm', 'opencode.exe'),
          path.join(home, '.local', 'bin', 'opencode.exe'),
          path.join(home, 'scoop', 'shims', 'opencode.exe'),
        ];
      case 'deepseek':
      case 'openrouter':
        return [];
    }
  }

  const binNames: Record<RealProvider, string[]> = {
    claude: ['claude'],
    openai: ['codex'],
    antigravity: ['agy'],
    opencode: ['opencode'],
    deepseek: [],
    openrouter: [],
  };
  return binNames[provider].flatMap((name) => [
    path.join(home, '.local', 'bin', name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ]);
}

async function findOnPath(names: string[]): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(finder, [name], { timeout: 2500 });
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        // Prefer .exe over .cmd over extensionless/ps1 shims on Windows
        const preferred =
          lines.find((l) => /\.exe$/i.test(l)) ??
          lines.find((l) => /\.cmd$/i.test(l)) ??
          lines[0];
        if (fs.existsSync(preferred)) {
          return preferred;
        }
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function resolveCliBinary(
  provider: RealProvider,
  customPath?: string,
): Promise<string | null> {
  if (provider === 'deepseek' || provider === 'openrouter') {
    return null;
  }
  if (customPath && customPath.trim()) {
    const resolved = path.resolve(customPath.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }

  const candidates = getCandidatePaths(provider);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  const pathNames: Record<RealProvider, string[]> = {
    claude: process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'],
    openai: process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'],
    antigravity: process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'],
    opencode:
      process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'],
    deepseek: [],
    openrouter: [],
  };

  return findOnPath(pathNames[provider]);
}

/**
 * Unwraps npm-style `.cmd`/`.bat` shims directly to the underlying `.exe` or Node script
 * so Windows spawns avoid `cmd.exe` quoting and `%*` expansion pitfalls.
 */
export function unwrapWindowsCmdShim(
  binPath: string,
): { command: string; prefixArgs: string[] } | null {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binPath) || !fs.existsSync(binPath)) {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(binPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = path.dirname(binPath);

  const exeMatch = /["']?%~?dp0%?[\\/]([^"'%\r\n]+?\.exe)["']?\s+%\*/i.exec(content);
  if (exeMatch?.[1]) {
    const targetExe = path.resolve(shimDir, exeMatch[1]);
    if (fs.existsSync(targetExe) && fs.statSync(targetExe).isFile()) {
      return { command: targetExe, prefixArgs: [] };
    }
  }

  const jsMatch = /["']?%~?dp0%?[\\/]([^"'%\r\n]+?\.(?:c|m)?js)["']?\s+%\*/i.exec(content);
  if (jsMatch?.[1]) {
    const targetScript = path.resolve(shimDir, jsMatch[1]);
    if (fs.existsSync(targetScript) && fs.statSync(targetScript).isFile()) {
      const localNode = path.join(shimDir, 'node.exe');
      const command =
        fs.existsSync(localNode) && fs.statSync(localNode).isFile()
          ? localNode
          : process.execPath;
      return { command, prefixArgs: [targetScript] };
    }
  }

  return null;
}

export function quoteCmdArg(arg: string): string {
  if (arg === '') {
    return '""';
  }
  if (/^[a-zA-Z0-9._:/\\=-]+$/.test(arg)) {
    return arg;
  }
  const escaped = arg
    .replace(/%/g, '%%')
    .replace(/(\\*)"/g, (_, bs: string) => `${'\\'.repeat(bs.length * 2 + 1)}"`)
    .replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Wraps the full command line in outer quotes for `cmd.exe /d /s /c`, which strips only
 * the outermost quote pair when `windowsVerbatimArguments` is set.
 */
export function buildWindowsCmdCommand(binPath: string, args: string[]): string {
  const inner = [quoteCmdArg(binPath), ...args.map(quoteCmdArg)].join(' ');
  return `"${inner}"`;
}

export function spawnCli(
  binPath: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: 'pipe' | 'ignore';
    signal?: AbortSignal;
  } = {},
): ChildProcess {
  const isWindowsBatch =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath);
  const unwrapped = isWindowsBatch ? unwrapWindowsCmdShim(binPath) : null;

  const child = unwrapped
    ? spawn(unwrapped.command, [...unwrapped.prefixArgs, ...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : isWindowsBatch
      ? spawn('cmd.exe', ['/d', '/s', '/c', buildWindowsCmdCommand(binPath, args)], {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(binPath, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

  if (opts.signal) {
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    };
    if (opts.signal.aborted) {
      killTree();
    } else {
      opts.signal.addEventListener('abort', killTree, { once: true });
      child.once('exit', () => opts.signal?.removeEventListener('abort', killTree));
    }
  }

  return child;
}

export async function execCliCapture(
  binPath: string,
  args: string[],
  timeoutMs = 4000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const child = spawnCli(binPath, args, {
      stdin: 'ignore',
      signal: controller.signal,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

const openCodeMajorCache = new Map<string, number>();

/**
 * Returns the major version of an OpenCode binary (defaulting to 2) and whether `--standalone`
 * should be passed so OpenCode v2 CLI calls do not hang waiting on a background/desktop server.
 */
export async function getOpenCodeCliCapabilities(
  binPath: string,
): Promise<{ major: number; standaloneArgs: string[] }> {
  let cacheKey = binPath;
  try {
    cacheKey = `${binPath}:${fs.statSync(binPath).mtimeMs}`;
  } catch {
    // use raw path
  }
  const cached = openCodeMajorCache.get(cacheKey);
  if (cached !== undefined) {
    return { major: cached, standaloneArgs: cached >= 2 ? ['--standalone'] : [] };
  }
  const verRes = await execCliCapture(binPath, ['--version'], 4000).catch(() => ({
    exitCode: 1,
    stdout: '',
    stderr: '',
  }));
  const parsedMajor = Number(/\b(\d+)\.\d+\.\d+/.exec(verRes.stdout)?.[1]);
  const major = parsedMajor || 2;
  openCodeMajorCache.set(cacheKey, major);
  return { major, standaloneArgs: major >= 2 ? ['--standalone'] : [] };
}
