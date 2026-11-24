import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  workspacesDir: string;
  dbPath: string;
  anthropicApiKey: string | null;
  deepseekApiKey: string | null;
  deepseekBaseUrl: string;
  claudeProjectsDir: string | null;
  codexSessionsDir: string | null;
}

function loadDotEnvIfPresent(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(envPath);
      } catch {
        // ignore malformed optional .env
      }
      break;
    }
  }
}

export function loadConfig(
  overrides?: Partial<{
    dataDir: string;
    workspacesDir: string;
    port: number;
    dbPath: string;
    deepseekBaseUrl: string;
    claudeProjectsDir: string | null;
    codexSessionsDir: string | null;
  }>,
): AppConfig {
  loadDotEnvIfPresent();

  const dataDir = path.resolve(overrides?.dataDir ?? process.env.ATELIER_DATA_DIR ?? './data');
  const workspacesDir = path.resolve(
    overrides?.workspacesDir ?? process.env.ATELIER_WORKSPACES_DIR ?? './workspaces',
  );
  const port = overrides?.port ?? Number(process.env.ATELIER_PORT || process.env.PORT || 8787);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim() || null;
  const deepseekBaseUrl = (
    overrides?.deepseekBaseUrl ??
    process.env.DEEPSEEK_BASE_URL?.trim() ??
    'https://api.deepseek.com'
  ).replace(/\/+$/, '');
  const isVitest = Boolean(process.env.VITEST);
  const claudeProjectsDir =
    overrides?.claudeProjectsDir !== undefined
      ? overrides.claudeProjectsDir
      : isVitest
        ? null
        : path.join(os.homedir(), '.claude', 'projects');
  const codexSessionsDir =
    overrides?.codexSessionsDir !== undefined
      ? overrides.codexSessionsDir
      : isVitest
        ? null
        : path.join(os.homedir(), '.codex', 'sessions');

  return {
    port,
    host: '127.0.0.1',
    dataDir,
    workspacesDir,
    dbPath: overrides?.dbPath ?? path.join(dataDir, 'atelier.db'),
    anthropicApiKey,
    deepseekApiKey,
    deepseekBaseUrl,
    claudeProjectsDir,
    codexSessionsDir,
  };
}

export function isAllowedHost(hostHeader: string | undefined, serverPort: number): boolean {
  if (!hostHeader) return false;
  const allowedHosts = new Set([
    'localhost:8080',
    '127.0.0.1:8080',
    'localhost:5173',
    '127.0.0.1:5173',
    `localhost:${serverPort}`,
    `127.0.0.1:${serverPort}`,
  ]);
  return allowedHosts.has(hostHeader.toLowerCase());
}

export function isAllowedOrigin(originHeader: string | undefined, serverPort: number): boolean {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isAllowedHost(parsed.host, serverPort);
  } catch {
    return false;
  }
}

export function redactHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' || k.toLowerCase().includes('token')) {
      out[k] = v ? '[REDACTED]' : undefined;
    } else {
      out[k] = v;
    }
  }
  return out;
}
