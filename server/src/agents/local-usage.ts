import fs from 'node:fs';
import path from 'node:path';
import type { UsageLogEntry } from '@atelier/contracts';
import type { AppConfig } from '../config.js';

export interface OfficialRateWindow {
  percentUsed: number;
  resetsAt: string | null;
}

export interface LocalCliUsageSnapshot {
  entries: UsageLogEntry[];
  codexOfficialLimits: {
    fiveHour: OfficialRateWindow | null;
    weekly: OfficialRateWindow | null;
  } | null;
}

interface CacheBucket {
  key: string;
  fetchedAt: number;
  snapshot: LocalCliUsageSnapshot;
}

const CACHE_TTL_MS = 15_000;
let cachedBucket: CacheBucket | null = null;

function collectRecentJsonlFiles(rootDir: string | null, sinceMs: number, maxDepth: number): string[] {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of items) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs) {
            results.push(full);
          }
        } catch {
          // ignore unreadable stat
        }
      }
    }
  };

  walk(rootDir, 0);
  return results;
}

function estimateClaudeCost(
  model: string,
  uncachedInput: number,
  cacheCreate: number,
  cacheRead: number,
  output: number,
): number {
  const m = model.toLowerCase();
  const baseIn = m.includes('opus') || m.includes('fable') ? 15 : m.includes('haiku') ? 0.8 : 3;
  const baseOut = m.includes('opus') || m.includes('fable') ? 75 : m.includes('haiku') ? 4 : 15;
  const cost =
    (uncachedInput / 1_000_000) * baseIn +
    (cacheCreate / 1_000_000) * (baseIn * 1.25) +
    (cacheRead / 1_000_000) * (baseIn * 0.1) +
    (output / 1_000_000) * baseOut;
  return Number(cost.toFixed(6));
}

function estimateCodexCost(
  uncachedInput: number,
  cachedInput: number,
  output: number,
): number {
  const cost =
    (uncachedInput / 1_000_000) * 2.5 +
    (cachedInput / 1_000_000) * 0.25 +
    (output / 1_000_000) * 10;
  return Number(cost.toFixed(6));
}

export function scanClaudeLocalUsage(projectsDir: string | null, sinceMs: number): UsageLogEntry[] {
  const files = collectRecentJsonlFiles(projectsDir, sinceMs, 4);
  if (files.length === 0) return [];

  // Deduplicate streaming chunks belonging to the same Anthropic message.id
  const byMessageId = new Map<
    string,
    {
      model: string;
      createdAt: string;
      tsMs: number;
      effectiveInput: number;
      outputTokens: number;
      estimatedCostUsd: number;
    }
  >();

  let syntheticIdx = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.includes('"assistant"')) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type !== 'assistant') continue;
      const msg = obj.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (!msg || !usage) continue;

      const tsStr = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      const tsMs = Date.parse(tsStr);
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;

      const uncachedIn = Math.max(0, Number(usage.input_tokens ?? 0));
      const cacheCreate = Math.max(0, Number(usage.cache_creation_input_tokens ?? 0));
      const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens ?? 0));
      const output = Math.max(0, Number(usage.output_tokens ?? 0));
      // Weight prompt-cache reads at 10% so repeated tool context doesn't saturate quota bars prematurely
      const effectiveInput = uncachedIn + cacheCreate + Math.round(cacheRead * 0.1);
      if (effectiveInput + output <= 0) continue;

      const model = typeof msg.model === 'string' && msg.model ? msg.model : 'sonnet';
      const msgKey =
        typeof msg.id === 'string' && msg.id
          ? msg.id
          : typeof obj.uuid === 'string'
            ? obj.uuid
            : `${path.basename(file)}_${++syntheticIdx}`;

      const prev = byMessageId.get(msgKey);
      if (!prev || effectiveInput + output > prev.effectiveInput + prev.outputTokens) {
        byMessageId.set(msgKey, {
          model,
          createdAt: new Date(tsMs).toISOString(),
          tsMs,
          effectiveInput,
          outputTokens: output,
          estimatedCostUsd: estimateClaudeCost(model, uncachedIn, cacheCreate, cacheRead, output),
        });
      }
    }
  }

  return [...byMessageId.entries()].map(([msgId, item]) => ({
    id: `local_cl_${msgId}`,
    provider: 'claude',
    model: item.model,
    agentId: 'local_cli_claude',
    projectId: null,
    inputTokens: item.effectiveInput,
    outputTokens: item.outputTokens,
    estimatedCostUsd: item.estimatedCostUsd,
    createdAt: item.createdAt,
  }));
}

export function scanCodexLocalUsage(
  sessionsDir: string | null,
  sinceMs: number,
  nowMs = Date.now(),
): {
  entries: UsageLogEntry[];
  officialLimits: { fiveHour: OfficialRateWindow | null; weekly: OfficialRateWindow | null } | null;
} {
  const files = collectRecentJsonlFiles(sessionsDir, sinceMs, 5);
  if (files.length === 0) return { entries: [], officialLimits: null };

  const entries: UsageLogEntry[] = [];
  let latestRateTs = -1;
  let officialLimits: {
    fiveHour: OfficialRateWindow | null;
    weekly: OfficialRateWindow | null;
  } | null = null;

  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const baseName = path.basename(file, '.jsonl');
    let lastCumulativeTotal = -1;
    let turnIdx = 0;

    for (const line of raw.split(/\r?\n/)) {
      if (!line || !line.includes('"token_count"')) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type !== 'event_msg') continue;
      const payload = obj.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== 'token_count') continue;

      const tsStr = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      const tsMs = Date.parse(tsStr);
      if (!Number.isFinite(tsMs)) continue;

      const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
      if (rateLimits && tsMs >= latestRateTs) {
        const parseWindow = (win: unknown): OfficialRateWindow | null => {
          if (!win || typeof win !== 'object') return null;
          const w = win as Record<string, unknown>;
          const rawPct = Number(w.used_percent);
          const resetsSec = Number(w.resets_at);
          if (!Number.isFinite(rawPct)) return null;
          const resetMs = Number.isFinite(resetsSec) ? resetsSec * 1000 : null;
          const expired = resetMs !== null && resetMs <= nowMs;
          return {
            percentUsed: expired ? 0 : Math.min(100, Math.max(0, rawPct)),
            resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
          };
        };

        const primary = parseWindow(rateLimits.primary);
        const secondary = parseWindow(rateLimits.secondary);
        if (primary || secondary) {
          latestRateTs = tsMs;
          officialLimits = {
            fiveHour: primary,
            weekly: secondary,
          };
        }
      }

      if (tsMs < sinceMs) continue;

      const info = payload.info as Record<string, unknown> | undefined;
      const totalUsage = info?.total_token_usage as Record<string, unknown> | undefined;
      const lastUsage = info?.last_token_usage as Record<string, unknown> | undefined;
      if (!lastUsage) continue;

      const cumTotal = Number(totalUsage?.total_tokens ?? -1);
      if (cumTotal >= 0 && cumTotal === lastCumulativeTotal) {
        continue;
      }
      if (cumTotal >= 0) lastCumulativeTotal = cumTotal;

      const rawIn = Math.max(0, Number(lastUsage.input_tokens ?? 0));
      const cachedIn = Math.max(0, Number(lastUsage.cached_input_tokens ?? 0));
      const uncachedIn = Math.max(0, rawIn - cachedIn);
      const output = Math.max(0, Number(lastUsage.output_tokens ?? 0));
      const effectiveInput = uncachedIn + Math.round(cachedIn * 0.1);
      if (effectiveInput + output <= 0) continue;

      entries.push({
        id: `local_cx_${baseName}_${++turnIdx}`,
        provider: 'openai',
        model: 'codex-cli',
        agentId: 'local_cli_openai',
        projectId: null,
        inputTokens: effectiveInput,
        outputTokens: output,
        estimatedCostUsd: estimateCodexCost(uncachedIn, cachedIn, output),
        createdAt: new Date(tsMs).toISOString(),
      });
    }
  }

  return { entries, officialLimits };
}

export function readLocalCliUsage(
  config: AppConfig,
  sinceMs: number,
  forceRefresh = false,
): LocalCliUsageSnapshot {
  const bucketKey = `${config.claudeProjectsDir ?? ''}|${config.codexSessionsDir ?? ''}|${Math.floor(sinceMs / 60_000)}`;
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedBucket &&
    cachedBucket.key === bucketKey &&
    now - cachedBucket.fetchedAt < CACHE_TTL_MS
  ) {
    return cachedBucket.snapshot;
  }

  const claudeEntries = scanClaudeLocalUsage(config.claudeProjectsDir, sinceMs);
  const codexRes = scanCodexLocalUsage(config.codexSessionsDir, sinceMs, now);
  const snapshot: LocalCliUsageSnapshot = {
    entries: [...claudeEntries, ...codexRes.entries],
    codexOfficialLimits: codexRes.officialLimits,
  };

  cachedBucket = {
    key: bucketKey,
    fetchedAt: now,
    snapshot,
  };
  return snapshot;
}
