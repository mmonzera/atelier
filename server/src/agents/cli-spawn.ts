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
          path.join(appData, 'npm', 'codex.cmd'),
          path.join(home, '.local', 'bin', 'codex.exe'),
        ];
      case 'antigravity':
        return [
          path.join(localAppData, 'agy', 'bin', 'agy.exe'),
          path.join(localAppData, 'agy', 'bin', 'agy.cmd'),
          path.join(appData, 'npm', 'agy.cmd'),
          path.join(localAppData, 'Programs', 'antigravity', 'bin', 'agy.cmd'),
          path.join(localAppData, 'Programs', 'antigravity', 'bin', 'agy.exe'),
          path.join(home, '.local', 'bin', 'agy.exe'),
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
        // Prefer .exe or .cmd over extensionless/ps1 shims on Windows
        const preferred =
          lines.find((l) => /\.(exe|cmd)$/i.test(l)) ?? lines[0];
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
    openai: process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'],
    antigravity: process.platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy'] : ['agy'],
    opencode:
      process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'],
    deepseek: [],
    openrouter: [],
  };

  return findOnPath(pathNames[provider]);
}

function quoteCmdArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
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

  const child = isWindowsBatch
    ? spawn(
        'cmd.exe',
        ['/d', '/s', '/c', [quoteCmdArg(binPath), ...args.map(quoteCmdArg)].join(' ')],
        {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      )
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
