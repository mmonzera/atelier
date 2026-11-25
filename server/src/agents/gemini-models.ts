import type { ModelEntry } from '@atelier/contracts';

const LIST_CACHE_MS = 10 * 60 * 1000;
const listCache = new Map<string, { at: number; models: ModelEntry[] }>();

/** Models that failed for this key: id -> time until we stop skipping them. */
const blocked = new Map<string, { until: number; reason: string }>();

/** Used when no key list is available. Verified to work on the free tier. */
export const GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';

/** Suffixes earlier UIs appended to the id for reasoning effort (e.g. "gemini-3.8-flash-high"). */
const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i;

const NON_CHAT_RE = /embedding|imagen|tts|image|live|audio|robotics|computer-use|native-dialog|transcribe|nano-banana/i;

function cacheKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl}|${apiKey.slice(-6)}`;
}

export function normalizeGeminiId(id: string): string {
  return id.trim().replace(/^models\//, '').replace(EFFORT_SUFFIX_RE, '');
}

function isBlocked(id: string): boolean {
  const hit = blocked.get(id);
  if (!hit) return false;
  if (Date.now() > hit.until) {
    blocked.delete(id);
    return false;
  }
  return true;
}

/**
 * Remembers that a model failed for this key so it is skipped (and hidden in the picker) for a while.
 * Quota 0 / "no longer available" are long-lived; "high demand" (503) is short.
 */
export function markGeminiModelFailed(id: string, status: number): void {
  const ms = status === 503 || status === 500 ? 2 * 60 * 1000 : 60 * 60 * 1000;
  blocked.set(id, { until: Date.now() + ms, reason: String(status) });
}

/** Lists the chat models this Gemini API key can call via generateContent. */
export async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const key = cacheKey(baseUrl, apiKey);
  const hit = listCache.get(key);
  let models: ModelEntry[];
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) {
    models = hit.models;
  } else {
    // Native endpoint: it reports supportedGenerationMethods (the OpenAI-compat one doesn't).
    const nativeBase = baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '');
    const res = await fetch(`${nativeBase}/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error('Google rejected the Gemini API key. Check it in Google AI Studio.');
    }
    if (!res.ok) throw new Error(`Gemini API answered ${res.status}`);
    const body = (await res.json()) as {
      models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>;
    };
    models = [];
    for (const item of body.models ?? []) {
      if (typeof item.name !== 'string') continue;
      const id = item.name.replace(/^models\//, '');
      if (!id.startsWith('gemini-') || NON_CHAT_RE.test(id)) continue;
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) continue;
      const label = typeof item.displayName === 'string' && item.displayName ? item.displayName : id;
      models.push({ id, label, provider: 'antigravity' });
    }
    models = sortGemini(models);
    listCache.set(key, { at: Date.now(), models });
  }
  return models.filter((m) => !isBlocked(m.id));
}

function version(id: string): number {
  const m = /^gemini-(\d+(?:\.\d+)?)-/.exec(id);
  return m ? Number(m[1]) : -1;
}

function isUnstable(id: string): boolean {
  return /preview|exp|latest|customtools/.test(id);
}

/** Newest numbered stable models first, then the rest. */
function sortGemini<T extends { id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ua = isUnstable(a.id) ? 1 : 0;
    const ub = isUnstable(b.id) ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const va = version(a.id);
    const vb = version(b.id);
    if (va !== vb) return vb - va;
    return a.id.localeCompare(b.id);
  });
}

function family(id: string): 'pro' | 'lite' | 'flash' | null {
  if (/flash-lite/.test(id)) return 'lite';
  if (/flash/.test(id)) return 'flash';
  if (/pro/.test(id)) return 'pro';
  return null;
}

/**
 * Ordered list of models to try for a request: the requested model (without any effort suffix)
 * first when the key serves it, then same-family models, then the newest stable flash models.
 */
export async function geminiCandidates(baseUrl: string, apiKey: string, requested: string, max = 5): Promise<string[]> {
  const wanted = normalizeGeminiId(requested);
  let available: string[];
  try {
    available = (await fetchGeminiModels(baseUrl, apiKey)).map((m) => m.id);
  } catch {
    return [wanted];
  }
  if (available.length === 0) return [wanted];

  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && out.length < max) out.push(id);
  };
  if (available.includes(wanted)) add(wanted);

  const stable = available.filter((id) => !isUnstable(id) && version(id) > 0);
  const fam = family(wanted);
  if (fam) for (const id of stable.filter((id) => family(id) === fam)) add(id);
  for (const id of stable.filter((id) => family(id) === 'flash')) add(id);
  for (const id of stable.filter((id) => family(id) === 'lite')) add(id);
  for (const id of available) add(id);
  return out;
}

/** Status code of a "<label> API error (NNN): ..." error, if it is one. */
export function geminiErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /API error \((\d{3})\)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Errors that mean "this model can't serve this key right now", so another model is worth trying. */
export function isGeminiModelError(status: number | null): boolean {
  return status === 404 || status === 429 || status === 503 || status === 500;
}
