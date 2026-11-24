import { BUILT_IN_MODELS, type ModelCatalog, type ModelEntry, type RealProvider, type Settings } from '@atelier/contracts';
import type { AppConfig } from '../config.js';
import { discoverLocalCodexModels } from './cli-runners.js';
import { execCliCapture, resolveCliBinary } from './cli-spawn.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: ModelCatalog }>();

/** The `claude` CLI has no command that lists models, so these are the ids it is known to accept. */
const CLAUDE_KNOWN: Array<[string, string]> = [
  ['claude-opus-4-5', 'Claude Opus 4.5'],
  ['claude-opus-4-1', 'Claude Opus 4.1'],
  ['claude-opus-4-0', 'Claude Opus 4'],
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['claude-sonnet-4-0', 'Claude Sonnet 4'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['claude-3-7-sonnet-latest', 'Claude Sonnet 3.7'],
  ['claude-3-5-haiku-latest', 'Claude Haiku 3.5'],
];

const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]+$/;

function builtIn(provider: RealProvider): ModelEntry[] {
  return BUILT_IN_MODELS.filter((m) => m.provider === provider);
}

/** Built-in entries win (they carry the nicer labels); the rest follow, sorted by label. */
function mergeCatalog(provider: RealProvider, extra: ModelEntry[]): ModelEntry[] {
  const byIdExtra = new Map(extra.map((m) => [m.id, m]));
  const base = builtIn(provider).map((m) => {
    const match = byIdExtra.get(m.id);
    return match && match.supportsTools !== undefined ? { ...m, supportsTools: match.supportsTools } : m;
  });
  const seen = new Set(base.map((m) => m.id));
  const rest = extra
    .filter((m) => MODEL_ID_RE.test(m.id) && !seen.has(m.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...base, ...rest];
}

async function fetchOpenRouter(config: AppConfig): Promise<ModelEntry[]> {
  const res = await fetch(`${config.openrouterBaseUrl}/models`, {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: unknown; name?: unknown; supported_parameters?: unknown }>;
  };
  const out: ModelEntry[] = [];
  for (const item of body.data ?? []) {
    if (typeof item.id !== 'string') continue;
    const params = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter((p): p is string => typeof p === 'string')
      : null;
    out.push({
      id: item.id,
      label: typeof item.name === 'string' && item.name ? item.name : item.id,
      provider: 'openrouter',
      ...(params ? { supportsTools: params.includes('tools') } : {}),
    });
  }
  return out;
}

async function fetchOpenCode(settings: Settings): Promise<ModelEntry[]> {
  const bin = await resolveCliBinary('opencode', settings.cliPaths?.opencode);
  if (!bin) throw new Error('OpenCode CLI not found. Install it or set its path in Accounts.');
  const res = await execCliCapture(bin, ['models'], 20_000);
  if (res.exitCode !== 0 && !res.stdout.trim()) {
    throw new Error(res.stderr.trim().split('\n').pop() || 'opencode models failed');
  }
  const out: ModelEntry[] = [];
  for (const raw of res.stdout.split(/\r?\n/)) {
    const id = raw.trim();
    if (id.includes('/') && MODEL_ID_RE.test(id)) out.push({ id, label: id, provider: 'opencode' });
  }
  return out;
}

async function load(
  provider: RealProvider,
  config: AppConfig,
  settings: Settings,
): Promise<ModelCatalog> {
  try {
    switch (provider) {
      case 'openrouter':
        return {
          provider,
          models: mergeCatalog(provider, await fetchOpenRouter(config)),
          source: 'live',
        };
      case 'opencode':
        return {
          provider,
          models: mergeCatalog(provider, await fetchOpenCode(settings)),
          source: 'live',
        };
      case 'openai': {
        const detected = discoverLocalCodexModels();
        return {
          provider,
          models: mergeCatalog(provider, detected),
          source: detected.length > 0 ? 'live' : 'builtin',
          note: detected.length > 0 ? 'Read from your Codex CLI.' : undefined,
        };
      }
      case 'claude':
        return {
          provider,
          models: mergeCatalog(
            provider,
            CLAUDE_KNOWN.map(([id, label]) => ({ id, label, provider })),
          ),
          source: 'builtin',
          note: 'The Claude CLI has no model list, so older versions are listed from known ids.',
        };
      default:
        return { provider, models: builtIn(provider), source: 'builtin' };
    }
  } catch (err) {
    return {
      provider,
      models: builtIn(provider),
      source: 'builtin',
      note: `Could not load the live list: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Full model list of one provider. Cached for ten minutes unless `refresh` is set. */
export async function getModelCatalog(
  provider: RealProvider,
  config: AppConfig,
  settings: Settings,
  refresh = false,
): Promise<ModelCatalog> {
  const hit = cache.get(provider);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load(provider, config, settings);
  // a failed live lookup is not worth remembering
  if (!value.note?.startsWith('Could not')) cache.set(provider, { at: Date.now(), value });
  return value;
}
