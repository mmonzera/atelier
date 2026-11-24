import type {
  AgentUsageSummary,
  ModelProvider,
  ProviderLiveBalance,
  ProviderUsageSummary,
  RollingWindowUsage,
  UsageDashboardResponse,
  UsageLogEntry,
  UsagePeriod,
  UsageRange,
} from '@atelier/contracts';
import type { AppConfig } from '../config.js';
import type { AtelierStore } from '../store.js';
import { readLocalCliUsage } from './local-usage.js';

const ALL_PROVIDERS: ModelProvider[] = [
  'claude',
  'openai',
  'antigravity',
  'deepseek',
  'opencode',
];

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_ROLLING_LIMITS: Partial<
  Record<ModelProvider, { fiveHour: number; weekly: number }>
> = {
  claude: { fiveHour: 10_000_000, weekly: 100_000_000 },
  openai: { fiveHour: 600_000, weekly: 6_000_000 },
  antigravity: { fiveHour: 600_000, weekly: 6_000_000 },
};

function computeRollingWindow(
  logs: UsageLogEntry[],
  provider: ModelProvider,
  windowMs: number,
  tokenLimit: number | null,
  nowMs: number,
): RollingWindowUsage {
  const cutoffMs = nowMs - windowMs;
  let usedTokens = 0;
  let oldestMs: number | null = null;

  for (const log of logs) {
    if (log.provider !== provider) continue;
    const t = new Date(log.createdAt).getTime();
    if (!Number.isFinite(t) || t < cutoffMs) continue;
    usedTokens += log.inputTokens + log.outputTokens;
    if (oldestMs === null || t < oldestMs) {
      oldestMs = t;
    }
  }

  const remainingTokens =
    tokenLimit !== null && tokenLimit > 0 ? Math.max(0, tokenLimit - usedTokens) : null;
  const percentUsed =
    tokenLimit !== null && tokenLimit > 0
      ? Math.round((usedTokens / tokenLimit) * 1000) / 10
      : null;
  const resetsAt = oldestMs !== null ? new Date(oldestMs + windowMs).toISOString() : null;

  return {
    usedTokens,
    tokenLimit,
    remainingTokens,
    percentUsed,
    resetsAt,
    isOfficial: false,
  };
}

function computeFixedWeeklyWindow(
  logs: UsageLogEntry[],
  provider: ModelProvider,
  resetDay: number,
  tokenLimit: number | null,
  now: Date,
): RollingWindowUsage {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const diffDays = (startOfToday.getDay() - resetDay + 7) % 7;
  const cycleStartMs = startOfToday.getTime() - diffDays * 86_400_000;
  const cycleEndMs = cycleStartMs + 7 * 86_400_000;

  let usedTokens = 0;
  for (const log of logs) {
    if (log.provider !== provider) continue;
    const t = new Date(log.createdAt).getTime();
    if (!Number.isFinite(t) || t < cycleStartMs) continue;
    usedTokens += log.inputTokens + log.outputTokens;
  }

  const remainingTokens =
    tokenLimit !== null && tokenLimit > 0 ? Math.max(0, tokenLimit - usedTokens) : null;
  const percentUsed =
    tokenLimit !== null && tokenLimit > 0
      ? Math.round((usedTokens / tokenLimit) * 1000) / 10
      : null;

  return {
    usedTokens,
    tokenLimit,
    remainingTokens,
    percentUsed,
    resetsAt: new Date(cycleEndMs).toISOString(),
    isOfficial: false,
  };
}

interface PricingRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

function getPricingRate(provider: ModelProvider, model: string): PricingRate {
  const m = model.toLowerCase();
  switch (provider) {
    case 'claude':
      if (m.includes('opus') || m.includes('fable')) {
        return { inputPerMillion: 15, outputPerMillion: 75 };
      }
      if (m.includes('haiku')) {
        return { inputPerMillion: 0.8, outputPerMillion: 4 };
      }
      return { inputPerMillion: 3, outputPerMillion: 15 };
    case 'openai':
      if (m.includes('luna') || m.includes('mini')) {
        return { inputPerMillion: 0.4, outputPerMillion: 1.6 };
      }
      return { inputPerMillion: 2.5, outputPerMillion: 10 };
    case 'antigravity':
      if (m.includes('hydrogen') || m.includes('flash')) {
        return { inputPerMillion: 0.15, outputPerMillion: 0.6 };
      }
      return { inputPerMillion: 1.25, outputPerMillion: 5 };
    case 'deepseek':
      if (m.includes('reasoner') || m.includes('r1')) {
        return { inputPerMillion: 0.55, outputPerMillion: 2.19 };
      }
      return { inputPerMillion: 0.27, outputPerMillion: 1.1 };
    case 'opencode':
      if (m.includes('claude')) return { inputPerMillion: 3, outputPerMillion: 15 };
      if (m.includes('gpt')) return { inputPerMillion: 2.5, outputPerMillion: 10 };
      if (m.includes('deepseek')) return { inputPerMillion: 0.27, outputPerMillion: 1.1 };
      return { inputPerMillion: 0.5, outputPerMillion: 1.5 };
  }
}

export function estimateTurnCostUsd(
  provider: ModelProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = getPricingRate(provider, model);
  const cost =
    (Math.max(0, inputTokens) / 1_000_000) * rate.inputPerMillion +
    (Math.max(0, outputTokens) / 1_000_000) * rate.outputPerMillion;
  return Number(cost.toFixed(6));
}

function getPeriodStartIso(period: UsagePeriod, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'daily') {
    return new Date(Date.UTC(y, m, d, 0, 0, 0, 0)).toISOString();
  }
  if (period === 'weekly') {
    const start = new Date(Date.UTC(y, m, d - 6, 0, 0, 0, 0));
    return start.toISOString();
  }
  return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
}

export function getRangeStartIso(range: UsageRange, now = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (range === 'today') {
    return new Date(Date.UTC(y, m, d, 0, 0, 0, 0)).toISOString();
  }
  if (range === '7d') {
    return new Date(Date.UTC(y, m, d - 6, 0, 0, 0, 0)).toISOString();
  }
  return new Date(Date.UTC(y, m, d - 29, 0, 0, 0, 0)).toISOString();
}

export async function fetchDeepSeekLiveBalance(
  store: AtelierStore,
  config: AppConfig,
): Promise<ProviderLiveBalance | null> {
  const apiKey = store.getProviderSecret('deepseek') || config.deepseekApiKey;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${config.deepseekBaseUrl}/user/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
      }>;
    };
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const preferred = infos.find((b) => b.currency === 'USD') ?? infos[0];
    if (!preferred) return null;

    const currency = String(preferred.currency || 'USD').toUpperCase();
    const remaining = Number(preferred.total_balance ?? 0);
    if (!Number.isFinite(remaining)) return null;

    const formatted =
      currency === 'USD'
        ? `$${remaining.toFixed(2)} left`
        : `${currency} ${remaining.toFixed(2)} left`;

    return {
      available: Boolean(data.is_available),
      currency,
      remaining,
      label: formatted,
    };
  } catch {
    return null;
  }
}

export async function buildUsageDashboard(
  store: AtelierStore,
  config: AppConfig,
  range: UsageRange = '30d',
  opts?: { forceRefresh?: boolean },
): Promise<UsageDashboardResponse> {
  const now = new Date();
  const rangeStart = getRangeStartIso(range, now);
  const dbLogs = store.listUsageLogs();
  const localScanSinceMs = now.getTime() - 30 * 86_400_000;
  const localSnapshot = readLocalCliUsage(
    config,
    localScanSinceMs,
    Boolean(opts?.forceRefresh),
  );

  // Deduplicate: skip SQLite logs for claude/openai that fall within ±15s of a local CLI log for the same provider
  const localTsByProvider = new Map<ModelProvider, number[]>();
  for (const entry of localSnapshot.entries) {
    const t = Date.parse(entry.createdAt);
    if (!Number.isFinite(t)) continue;
    const list = localTsByProvider.get(entry.provider) ?? [];
    list.push(t);
    localTsByProvider.set(entry.provider, list);
  }

  const dedupedDbLogs = dbLogs.filter((dbLog) => {
    if (dbLog.provider !== 'claude' && dbLog.provider !== 'openai') return true;
    const candidates = localTsByProvider.get(dbLog.provider);
    if (!candidates || candidates.length === 0) return true;
    const t = Date.parse(dbLog.createdAt);
    return !candidates.some((ct) => Math.abs(ct - t) <= 15_000);
  });

  const allLogs = [...dedupedDbLogs, ...localSnapshot.entries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const rangeLogs = rangeStart ? allLogs.filter((l) => l.createdAt >= rangeStart) : allLogs;

  const hasLocalClaude = localSnapshot.entries.some((e) => e.provider === 'claude');
  const hasLocalOpenAi = localSnapshot.entries.some((e) => e.provider === 'openai');

  const settings = store.getSettings();
  const limits = settings.usageLimits ?? {};
  const deepseekBalance = await fetchDeepSeekLiveBalance(store, config);

  let totalTurns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  const byProvider = new Map<
    ModelProvider,
    { turns: number; input: number; output: number; cost: number }
  >();
  for (const p of ALL_PROVIDERS) {
    byProvider.set(p, { turns: 0, input: 0, output: 0, cost: 0 });
  }

  const agentsList = store.listAgents();
  const agentNameById = new Map<string, string>(agentsList.map((a) => [a.id, a.name]));
  agentNameById.set('local_cli_claude', 'Claude Code (Local CLI)');
  agentNameById.set('local_cli_openai', 'Codex (Local CLI)');
  const byAgent = new Map<
    string,
    { turns: number; input: number; output: number; cost: number }
  >();

  for (const log of rangeLogs) {
    totalTurns += 1;
    totalInput += log.inputTokens;
    totalOutput += log.outputTokens;
    totalCost += log.estimatedCostUsd;

    const pStat = byProvider.get(log.provider) ?? { turns: 0, input: 0, output: 0, cost: 0 };
    pStat.turns += 1;
    pStat.input += log.inputTokens;
    pStat.output += log.outputTokens;
    pStat.cost += log.estimatedCostUsd;
    byProvider.set(log.provider, pStat);

    const aStat = byAgent.get(log.agentId) ?? { turns: 0, input: 0, output: 0, cost: 0 };
    aStat.turns += 1;
    aStat.input += log.inputTokens;
    aStat.output += log.outputTokens;
    aStat.cost += log.estimatedCostUsd;
    byAgent.set(log.agentId, aStat);
  }

  const providers: ProviderUsageSummary[] = ALL_PROVIDERS.map((provider) => {
    const stat = byProvider.get(provider)!;
    const limit = limits[provider] ?? null;
    const rollingDefaults = DEFAULT_ROLLING_LIMITS[provider];
    const supportsRollingWindows = Boolean(rollingDefaults);
    const fiveHourLimit =
      limit?.fiveHourTokenLimit !== undefined
        ? limit.fiveHourTokenLimit
        : (rollingDefaults?.fiveHour ?? null);
    const weeklyLimit =
      limit?.weeklyTokenLimit !== undefined
        ? limit.weeklyTokenLimit
        : (rollingDefaults?.weekly ?? null);

    const nowMs = now.getTime();
    const weeklyResetDay =
      typeof limit?.weeklyResetDay === 'number' &&
      limit.weeklyResetDay >= 0 &&
      limit.weeklyResetDay <= 6
        ? limit.weeklyResetDay
        : null;

    let fiveHour = computeRollingWindow(allLogs, provider, FIVE_HOURS_MS, fiveHourLimit, nowMs);
    let weekly =
      weeklyResetDay !== null
        ? computeFixedWeeklyWindow(allLogs, provider, weeklyResetDay, weeklyLimit, now)
        : computeRollingWindow(allLogs, provider, SEVEN_DAYS_MS, weeklyLimit, nowMs);

    const hasCustomFiveHour =
      limit?.fiveHourTokenLimit !== undefined && limit.fiveHourTokenLimit !== null;
    const hasCustomWeekly =
      (limit?.weeklyTokenLimit !== undefined && limit.weeklyTokenLimit !== null) ||
      weeklyResetDay !== null;

    if (provider === 'openai' && localSnapshot.codexOfficialLimits) {
      const off5 = localSnapshot.codexOfficialLimits.fiveHour;
      const offW = localSnapshot.codexOfficialLimits.weekly;
      if (off5 && !hasCustomFiveHour) {
        fiveHour = {
          ...fiveHour,
          percentUsed: off5.percentUsed,
          resetsAt: off5.resetsAt ?? fiveHour.resetsAt,
          isOfficial: true,
        };
      }
      if (offW && !hasCustomWeekly) {
        weekly = {
          ...weekly,
          percentUsed: offW.percentUsed,
          resetsAt: offW.resetsAt ?? weekly.resetsAt,
          isOfficial: true,
        };
      }
    }

    const sourceLabel =
      provider === 'claude'
        ? hasLocalClaude
          ? 'Local Claude Code logs'
          : 'Atelier tracked'
        : provider === 'openai'
          ? localSnapshot.codexOfficialLimits
            ? 'Official Codex limits'
            : hasLocalOpenAi
              ? 'Local Codex logs'
              : 'Atelier tracked'
          : provider === 'deepseek'
            ? deepseekBalance
              ? 'Live DeepSeek balance'
              : 'Atelier tracked'
            : 'Atelier tracked';

    let limitWindowTokens = 0;
    let limitWindowCostUsd = 0;
    let remainingTokens: number | null = null;
    let remainingBudgetUsd: number | null = null;
    let percentUsed: number | null = null;

    if (limit) {
      const winStart = getPeriodStartIso(limit.period, now);
      for (const log of allLogs) {
        if (log.provider === provider && log.createdAt >= winStart) {
          limitWindowTokens += log.inputTokens + log.outputTokens;
          limitWindowCostUsd += log.estimatedCostUsd;
        }
      }

      const ratios: number[] = [];
      if (limit.tokenLimit !== null && limit.tokenLimit > 0) {
        remainingTokens = Math.max(0, limit.tokenLimit - limitWindowTokens);
        ratios.push((limitWindowTokens / limit.tokenLimit) * 100);
      }
      if (limit.budgetUsd !== null && limit.budgetUsd > 0) {
        remainingBudgetUsd = Math.max(
          0,
          Number((limit.budgetUsd - limitWindowCostUsd).toFixed(4)),
        );
        ratios.push((limitWindowCostUsd / limit.budgetUsd) * 100);
      }
      if (ratios.length > 0) {
        percentUsed = Math.round(Math.max(...ratios) * 10) / 10;
      }
    }

    return {
      provider,
      turns: stat.turns,
      inputTokens: stat.input,
      outputTokens: stat.output,
      totalTokens: stat.input + stat.output,
      estimatedCostUsd: Number(stat.cost.toFixed(6)),
      supportsRollingWindows,
      fiveHour,
      weekly,
      limit,
      limitWindowTokens,
      limitWindowCostUsd: Number(limitWindowCostUsd.toFixed(6)),
      remainingTokens,
      remainingBudgetUsd,
      percentUsed,
      liveBalance: provider === 'deepseek' ? deepseekBalance : null,
      sourceLabel,
    };
  });

  const agents: AgentUsageSummary[] = [...byAgent.entries()]
    .map(([agentId, stat]) => ({
      agentId,
      agentName: agentNameById.get(agentId) ?? 'Deleted agent',
      turns: stat.turns,
      inputTokens: stat.input,
      outputTokens: stat.output,
      totalTokens: stat.input + stat.output,
      estimatedCostUsd: Number(stat.cost.toFixed(6)),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    range,
    totals: {
      turns: totalTurns,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      estimatedCostUsd: Number(totalCost.toFixed(6)),
    },
    providers,
    agents,
    recentLogs: rangeLogs.slice(0, 20),
  };
}
