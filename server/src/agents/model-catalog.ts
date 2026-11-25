import { BUILT_IN_MODELS, type ModelCatalog, type ModelEntry, type RealProvider, type Settings } from '@atelier/contracts';
import type { AppConfig } from '../config.js';
import { discoverLocalCodexModels } from './cli-runners.js';
import { execCliCapture, getOpenCodeCliCapabilities, resolveCliBinary } from './cli-spawn.js';

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

export interface OpenCodeCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

function readStringProp(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

function extractAuthKey(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return null;
  return (
    readStringProp(value, 'key') ??
    readStringProp(value, 'apiKey') ??
    readStringProp(value, 'token')
  );
}

/**
 * Extracts OpenCode custom providers (e.g. `vikey`) with a configured `baseURL` and matching
 * credential from `opencode debug config` and `opencode auth export`.
 */
export function extractOpenCodeCustomProviders(
  debugConfigStdout: string,
  authExportStdout: string,
): OpenCodeCustomProvider[] {
  let docs: unknown[] = [];
  try {
    const parsed = JSON.parse(debugConfigStdout.replace(/^\uFEFF/, '').trim());
    docs = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  } catch {
    return [];
  }

  const authByIntegration = new Map<string, string>();
  try {
    const parsedAuth = JSON.parse(authExportStdout.replace(/^\uFEFF/, '').trim());
    if (Array.isArray(parsedAuth)) {
      const inactiveFallback = new Map<string, string>();
      for (const item of parsedAuth) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const integrationId = readStringProp(rec, 'integrationID') ?? readStringProp(rec, 'provider');
        const key = extractAuthKey(rec.value) ?? extractAuthKey(rec);
        if (!integrationId || !key) continue;
        const normalized = integrationId.toLowerCase();
        if (rec.active !== false) {
          authByIntegration.set(normalized, key);
        } else if (!inactiveFallback.has(normalized)) {
          inactiveFallback.set(normalized, key);
        }
      }
      for (const [k, v] of inactiveFallback) {
        if (!authByIntegration.has(k)) authByIntegration.set(k, v);
      }
    } else if (parsedAuth && typeof parsedAuth === 'object') {
      for (const [k, v] of Object.entries(parsedAuth as Record<string, unknown>)) {
        const key = extractAuthKey(v);
        if (key) authByIntegration.set(k.toLowerCase(), key);
      }
    }
  } catch {
    // auth export is optional if inline apiKey is configured
  }

  const providers = new Map<string, OpenCodeCustomProvider>();
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const d = doc as Record<string, unknown>;
    const info = d.info && typeof d.info === 'object' ? (d.info as Record<string, unknown>) : d;
    for (const block of [info.providers, info.provider]) {
      if (!block || typeof block !== 'object') continue;
      for (const [rawId, rawCfg] of Object.entries(block as Record<string, unknown>)) {
        const id = rawId.trim();
        if (!id || !rawCfg || typeof rawCfg !== 'object') continue;
        const cfg = rawCfg as Record<string, unknown>;
        const baseUrl =
          readStringProp(cfg.settings, 'baseURL') ?? readStringProp(cfg.options, 'baseURL');
        if (!baseUrl) continue;
        const apiKey =
          authByIntegration.get(id.toLowerCase()) ??
          readStringProp(cfg.settings, 'apiKey') ??
          readStringProp(cfg.options, 'apiKey');
        if (!apiKey) continue;
        const name = readStringProp(cfg, 'name') ?? id;
        providers.set(id, { id, name, baseUrl, apiKey });
      }
    }
  }

  return [...providers.values()];
}

export function extractOpenCodeDisabledProviders(debugConfigStdout: string): string[] {
  let docs: unknown[] = [];
  try {
    const parsed = JSON.parse(debugConfigStdout.replace(/^\uFEFF/, '').trim());
    docs = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  } catch {
    return [];
  }

  const disabled = new Set<string>();
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const d = doc as Record<string, unknown>;
    const info = d.info && typeof d.info === 'object' ? (d.info as Record<string, unknown>) : d;
    if (!Array.isArray(info.policies)) continue;
    for (const policy of info.policies) {
      if (!policy || typeof policy !== 'object') continue;
      const p = policy as Record<string, unknown>;
      if (p.action === 'provider.use' && p.effect === 'deny') {
        const res = readStringProp(p, 'resource');
        if (res && res !== '*') disabled.add(res);
      }
    }
  }
  return [...disabled];
}

export function formatOpenCodeModelLabel(
  providerName: string,
  modelId: string,
  explicitName?: string,
): string {
  const cleanName = explicitName?.trim();
  return cleanName ? `${providerName} · ${cleanName}` : `${providerName} · ${modelId}`;
}

async function discoverOpenCodeCustomModels(
  binPath: string,
  standaloneArgs: string[],
): Promise<{ models: ModelEntry[]; customProviderNames: string[]; disabledProviders: string[] }> {
  const emptyRes = { exitCode: 1, stdout: '', stderr: '' };
  const [cfgRes, authRes] = await Promise.all([
    execCliCapture(binPath, [...standaloneArgs, 'debug', 'config'], 5000).catch(() => emptyRes),
    execCliCapture(binPath, [...standaloneArgs, 'auth', 'export'], 5000).catch(() => emptyRes),
  ]);
  const disabledProviders = extractOpenCodeDisabledProviders(cfgRes.stdout);
  const providers = extractOpenCodeCustomProviders(cfgRes.stdout, authRes.stdout);
  if (providers.length === 0) {
    return { models: [], customProviderNames: [], disabledProviders };
  }

  const models: ModelEntry[] = [];
  const customProviderNames: string[] = [];

  await Promise.allSettled(
    providers.map(async (prov) => {
      const endpoint = `${prov.baseUrl.replace(/\/+$/, '')}/models`;
      const res = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${prov.apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: Array<{ id?: unknown; name?: unknown }>;
      };
      if (!Array.isArray(body.data)) return;
      customProviderNames.push(prov.name);
      for (const item of body.data) {
        if (typeof item?.id !== 'string') continue;
        const itemId = item.id.trim();
        if (!itemId) continue;
        const fullId = `${prov.id}/${itemId}`;
        if (!MODEL_ID_RE.test(fullId)) continue;
        models.push({
          id: fullId,
          label: formatOpenCodeModelLabel(
            prov.name,
            itemId,
            typeof item.name === 'string' ? item.name : undefined,
          ),
          provider: 'opencode',
        });
      }
    }),
  );

  return { models, customProviderNames, disabledProviders };
}

async function fetchOpenCode(settings: Settings): Promise<{ models: ModelEntry[]; note?: string }> {
  const bin = await resolveCliBinary('opencode', settings.cliPaths?.opencode);
  if (!bin) throw new Error('OpenCode CLI not found. Install it or set its path in Accounts.');

  const { standaloneArgs } = await getOpenCodeCliCapabilities(bin);
  const [res, custom] = await Promise.all([
    execCliCapture(bin, [...standaloneArgs, 'models'], 20_000),
    discoverOpenCodeCustomModels(bin, standaloneArgs),
  ]);
  if (res.exitCode !== 0 && !res.stdout.trim() && custom.models.length === 0) {
    throw new Error(res.stderr.trim().split('\n').pop() || 'opencode models failed');
  }

  const byId = new Map<string, ModelEntry>();
  for (const raw of res.stdout.split(/\r?\n/)) {
    const id = raw.trim();
    if (id.includes('/') && MODEL_ID_RE.test(id)) {
      const label = id.startsWith('opencode-go/')
        ? `OpenCode Go · ${id.slice('opencode-go/'.length)}`
        : id;
      byId.set(id, { id, label, provider: 'opencode' });
    }
  }
  for (const m of custom.models) {
    byId.set(m.id, m);
  }

  const models = [...byId.values()];
  const disabledSet = new Set(custom.disabledProviders.map((d) => d.toLowerCase()));
  const activePrefixes = [
    ...new Set(
      models
        .map((m) => m.id.split('/')[0])
        .filter((p): p is string => Boolean(p) && !disabledSet.has(p.toLowerCase())),
    ),
  ];
  const noteParts: string[] = [];
  if (activePrefixes.length > 0) {
    noteParts.push(
      `Active in OpenCode: ${activePrefixes.join(', ')}. Use "+ Add provider" (or run opencode → /connect → OpenCode Go) to connect OpenCode Go, ChatGPT, Copilot, Gemini, and more.`,
    );
  }
  if (custom.disabledProviders.length > 0) {
    noteParts.push(
      `Disabled in OpenCode config: ${custom.disabledProviders.join(', ')} (re-enable in OpenCode to run these models).`,
    );
  }
  const note = noteParts.length > 0 ? noteParts.join(' ') : undefined;

  return { models, ...(note ? { note } : {}) };
}

async function fetchAntigravity(settings: Settings): Promise<ModelEntry[]> {
  const bin = await resolveCliBinary('antigravity', settings.cliPaths?.antigravity);
  if (!bin) return [];
  const res = await execCliCapture(bin, ['models'], 10_000);
  if (res.exitCode !== 0 && !res.stdout.trim()) {
    throw new Error(res.stderr.trim().split('\n').pop() || 'agy models failed');
  }
  const out: ModelEntry[] = [];
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(\S+)(?:\t+|\s{2,})(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (MODEL_ID_RE.test(id)) {
      out.push({ id, label: label || id, provider: 'antigravity' });
    }
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
      case 'opencode': {
        const { models, note } = await fetchOpenCode(settings);
        return {
          provider,
          models: mergeCatalog(provider, models),
          source: 'live',
          ...(note ? { note } : {}),
        };
      }
      case 'antigravity': {
        const detected = await fetchAntigravity(settings);
        return {
          provider,
          models: mergeCatalog(provider, detected),
          source: detected.length > 0 ? 'live' : 'builtin',
        };
      }
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
