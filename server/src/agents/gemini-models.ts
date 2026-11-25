import type { ModelEntry } from '@atelier/contracts';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; ids: ModelEntry[] }>();

/** Last-resort model when nothing the user picked exists on the Gemini API. */
export const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';

/** Lists the models the Gemini API key can really call via generateContent (OpenAI-compatible endpoint). */
export async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const key = `${baseUrl}|${apiKey.slice(-6)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;

  // Native Gemini endpoint: it reports which models support generateContent (the OpenAI-compat one doesn't).
  const nativeBase = baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '');
  const res = await fetch(`${nativeBase}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error('Google rejected the API key. Check it in Google AI Studio.');
  }
  if (!res.ok) throw new Error(`Gemini API answered ${res.status}`);
  const body = (await res.json()) as {
    models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>;
  };
  const out: ModelEntry[] = [];
  for (const item of body.models ?? []) {
    if (typeof item.name !== 'string') continue;
    const id = item.name.replace(/^models\//, '');
    if (!id.startsWith('gemini-')) continue;
    const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
    if (!methods.includes('generateContent')) continue;
    // text chat only: skip image/audio/TTS/live/agentic-computer variants
    if (/embedding|imagen|tts|image|live|audio|robotics|computer-use|native-dialog/i.test(id)) continue;
    const label = typeof item.displayName === 'string' && item.displayName ? item.displayName : id;
    out.push({ id, label, provider: 'antigravity' });
  }
  out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  cache.set(key, { at: Date.now(), ids: out });
  return out;
}

/**
 * Maps whatever model id is stored (including UI-only ones like "gemini-3.8-flash-high" or the
 * built-in placeholder names) to an id the Gemini API actually serves. Falls back by family
 * (pro / flash-lite / flash), then to the newest available model.
 */
export async function resolveGeminiModel(baseUrl: string, apiKey: string, requested: string): Promise<string> {
  const wanted = requested.replace(/^models\//, '');
  let available: string[];
  try {
    available = (await fetchGeminiModels(baseUrl, apiKey)).map((m) => m.id);
  } catch {
    return wanted;
  }
  if (available.length === 0 || available.includes(wanted)) return wanted;

  const stable = (ids: string[]) => ids.filter((id) => !/preview|exp|latest/.test(id));
  const newest = (ids: string[]) =>
    [...ids].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const pick = (re: RegExp, exclude?: RegExp) => {
    const ids = available.filter((id) => re.test(id) && !(exclude && exclude.test(id)));
    return newest(stable(ids)) ?? newest(ids);
  };

  const lower = wanted.toLowerCase();
  const family = lower.includes('pro')
    ? pick(/pro/)
    : lower.includes('lite')
      ? pick(/flash-lite/)
      : lower.includes('flash')
        ? pick(/flash/, /lite/)
        : undefined;
  return (
    family ??
    (available.includes(GEMINI_FALLBACK_MODEL) ? GEMINI_FALLBACK_MODEL : (pick(/flash/, /lite/) ?? available[0]!))
  );
}
