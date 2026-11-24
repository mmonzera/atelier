import type {
  Agent,
  FallbackErrorKind,
  ModelProvider,
  ModelRef,
  Settings,
} from '@atelier/contracts';

export interface ClassifiedTurnError {
  kind: FallbackErrorKind;
  recoverable: boolean;
  cooldownMs: number;
  label: string;
}

export interface CooldownEntry {
  provider: ModelProvider;
  model: string;
  reason: FallbackErrorKind;
  untilMs: number;
}

export function classifyTurnError(message: string): ClassifiedTurnError {
  const text = message || '';

  if (/\b429\b|rate[_ ]?limit|too many requests|requests per minute|tokens per minute/i.test(text)) {
    return {
      kind: 'rate_limit',
      recoverable: true,
      cooldownMs: 5 * 60_000,
      label: 'Rate limit hit (429)',
    };
  }

  if (
    /insufficient_quota|\bquota\b|usage limit|credit balance|out of credits|billing|5-hour|weekly limit/i.test(
      text,
    )
  ) {
    return {
      kind: 'quota',
      recoverable: true,
      cooldownMs: 15 * 60_000,
      label: 'Quota / usage limit reached',
    };
  }

  if (/\b529\b|\b503\b|\b502\b|\b504\b|overloaded|service unavailable|at capacity/i.test(text)) {
    return {
      kind: 'overloaded',
      recoverable: true,
      cooldownMs: 2 * 60_000,
      label: 'Provider overloaded',
    };
  }

  if (
    /\b401\b|\b403\b|unauthorized|not authenticated|login required|invalid api key|token expired/i.test(
      text,
    )
  ) {
    return {
      kind: 'auth',
      recoverable: true,
      cooldownMs: 10 * 60_000,
      label: 'Authentication required',
    };
  }

  if (/timed out|timeout|ETIMEDOUT/i.test(text)) {
    return {
      kind: 'timeout',
      recoverable: true,
      cooldownMs: 60_000,
      label: 'Request timed out',
    };
  }

  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|network error/i.test(text)) {
    return {
      kind: 'network',
      recoverable: true,
      cooldownMs: 60_000,
      label: 'Network connection error',
    };
  }

  return {
    kind: 'unknown',
    recoverable: false,
    cooldownMs: 0,
    label: 'Turn error',
  };
}

export class ProviderCooldownTracker {
  private readonly entries = new Map<string, CooldownEntry>();

  private key(provider: ModelProvider, model: string): string {
    return `${provider}:${model}`;
  }

  public mark(
    provider: ModelProvider,
    model: string,
    cooldownMs: number,
    reason: FallbackErrorKind,
  ): void {
    if (cooldownMs <= 0) return;
    this.entries.set(this.key(provider, model), {
      provider,
      model,
      reason,
      untilMs: Date.now() + cooldownMs,
    });
  }

  public isCoolingDown(provider: ModelProvider, model: string, nowMs = Date.now()): boolean {
    const k = this.key(provider, model);
    const entry = this.entries.get(k);
    if (!entry) return false;
    if (entry.untilMs <= nowMs) {
      this.entries.delete(k);
      return false;
    }
    return true;
  }

  public listActive(nowMs = Date.now()): CooldownEntry[] {
    const active: CooldownEntry[] = [];
    for (const [k, entry] of this.entries.entries()) {
      if (entry.untilMs <= nowMs) {
        this.entries.delete(k);
      } else {
        active.push(entry);
      }
    }
    return active;
  }

  public clear(provider?: ModelProvider, model?: string): void {
    if (!provider) {
      this.entries.clear();
      return;
    }
    for (const [k, entry] of this.entries.entries()) {
      if (entry.provider === provider && (!model || entry.model === model)) {
        this.entries.delete(k);
      }
    }
  }
}

export function resolveFallbackCandidates(
  agent: Agent,
  settings: Settings,
  failedProvider: ModelProvider,
  failedModel: string,
): ModelRef[] {
  const raw =
    agent.fallbackChain && agent.fallbackChain.length > 0
      ? agent.fallbackChain
      : (settings.fallbackChain ?? []);

  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const item of raw) {
    if (!item?.provider || !item?.model?.trim()) continue;
    const model = item.model.trim();
    if (item.provider === failedProvider && model === failedModel) continue;
    const key = `${item.provider}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: item.provider, model });
  }
  return out;
}
