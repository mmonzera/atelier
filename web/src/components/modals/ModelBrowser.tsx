import {
  BUILT_IN_MODELS,
  type ModelCatalog,
  type ModelEntry,
  type RealProvider,
  type Settings,
} from '@atelier/contracts';
import { RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { ProviderIcon } from '../ProviderIcon';
import { Switch } from '../Switch';
import { toast } from '../Toast';
import { inputStyle, secondaryBtnStyle } from './ModalShell';
import { useT } from '../../i18n';

const chip = (active: boolean) =>
  ({
    height: 26,
    padding: '0 10px',
    borderRadius: 'var(--radius-full)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11.5,
    fontWeight: active ? 500 : 400,
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    background: active ? 'var(--surface-3)' : 'var(--surface-2)',
    border: `1px solid ${active ? 'var(--border-default)' : 'var(--border-subtle)'}`,
  }) as const;

/**
 * "Browse all": every model a provider offers (OpenRouter and OpenCode are asked live), each with
 * a toggle. The toggled-on ones are what the chat pickers show.
 */
export function ModelBrowser({
  settings,
  detected,
  providers,
  initialProvider,
}: {
  settings: Settings;
  /** models found on this machine (e.g. from the Codex CLI) */
  detected: ModelEntry[];
  providers: Array<{ id: RealProvider; label: string }>;
  initialProvider: RealProvider;
}) {
  const t = useT();
  const [provider, setProvider] = useState<RealProvider>(initialProvider);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        setCatalog(await api.getModelCatalog(provider, refresh));
      } catch (err) {
        setCatalog(null);
        setError(err instanceof Error ? err.message : t('Could not load models'));
      } finally {
        setLoading(false);
      }
    },
    [provider],
  );

  useEffect(() => {
    setQuery('');
    void load();
  }, [load]);

  const custom = useMemo(
    () => (settings.customModels ?? []).filter((m) => m.provider === provider),
    [settings.customModels, provider],
  );

  // what the chat shows today for this provider (also the starting point of the first toggle)
  const shownIds = useMemo(() => {
    const saved = settings.visibleModels?.[provider];
    if (saved) return new Set(saved);
    return new Set(
      [
        ...BUILT_IN_MODELS.filter((m) => m.provider === provider),
        ...detected.filter((m) => m.provider === provider),
        ...custom,
      ].map((m) => m.id),
    );
  }, [settings.visibleModels, provider, detected, custom]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const merged: ModelEntry[] = [];
    for (const m of [...(catalog?.models ?? []), ...detected.filter((d) => d.provider === provider), ...custom]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    const needle = query.trim().toLowerCase();
    return needle
      ? merged.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(needle))
      : merged;
  }, [catalog, detected, custom, provider, query]);

  const isActive = (m: ModelEntry) => settings.provider === m.provider && settings.model === m.id;

  /** Save the new shown set; models that only exist in the live list are remembered as custom entries. */
  const save = async (next: Set<string>, add: ModelEntry[] = []) => {
    setBusy(true);
    try {
      const known = new Set([
        ...BUILT_IN_MODELS.filter((m) => m.provider === provider).map((m) => m.id),
        ...detected.filter((m) => m.provider === provider).map((m) => m.id),
        ...custom.map((m) => m.id),
      ]);
      const extra = add
        .filter((m) => !known.has(m.id))
        .map((m) => ({ id: m.id, label: m.label, provider, builtIn: false }));
      await api.updateSettings({
        visibleModels: { ...(settings.visibleModels ?? {}), [provider]: [...next] },
        ...(extra.length > 0 ? { customModels: [...(settings.customModels ?? []), ...extra] } : {}),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not save your choice'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (m: ModelEntry, on: boolean) => {
    const next = new Set(shownIds);
    if (on) next.add(m.id);
    else next.delete(m.id);
    void save(next, on ? [m] : []);
  };

  const bulk = (on: boolean) => {
    const next = new Set(shownIds);
    for (const m of rows) {
      if (on) next.add(m.id);
      else if (!isActive(m)) next.delete(m.id);
    }
    void save(next, on ? rows : []);
  };

  const reset = async () => {
    const rest = { ...(settings.visibleModels ?? {}) };
    delete rest[provider];
    setBusy(true);
    try {
      await api.updateSettings({ visibleModels: rest });
      toast.info(t('Back to the default list'));
    } finally {
      setBusy(false);
    }
  };

  const shownCount = rows.filter((m) => shownIds.has(m.id) || isActive(m)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProvider(p.id)}
            className="transition-atelier"
            style={chip(provider === p.id)}
          >
            <ProviderIcon provider={p.id} size={12} active={provider === p.id} />
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            ...inputStyle,
            padding: '0 11px',
            height: 34,
            width: 'auto',
          }}
        >
          <Search size={14} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search {v0} models', { v0: providers.find((p) => p.id === provider)?.label ?? '' })}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 13,
              color: 'var(--text-primary)',
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          title={t('Fetch the list again')}
          style={{ ...secondaryBtnStyle, height: 34, padding: '0 12px', fontSize: 12 }}
        >
          <RefreshCw size={13} strokeWidth={1.5} />{t('Refresh')}
        </button>
        {provider === 'opencode' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void api
                .loginProvider('opencode')
                .then(() => {
                  toast.info(
                    t('Complete provider login in the opened OpenCode window, then click Refresh.'),
                  );
                })
                .catch((err) => {
                  toast.error(err instanceof Error ? err.message : t('Failed to start login'));
                });
            }}
            style={{ ...secondaryBtnStyle, height: 34, padding: '0 12px', fontSize: 12 }}
          >
            {t('+ Add provider')}
          </button>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          fontSize: 11.5,
          color: 'var(--text-tertiary)',
        }}
      >
        <span>
          {loading ? t('Loading models…') : t('{shownCount} of {length} shown in chat{v2}', { shownCount, length: rows.length, v2: catalog?.source === 'live' ? t(' · live list') : '' })}
        </span>
        <span style={{ display: 'inline-flex', gap: 12 }}>
          <button type="button" disabled={busy || loading} onClick={() => bulk(true)} style={{ color: 'var(--text-secondary)' }}>{t('Show all')}{query ? t(' results') : ''}
          </button>
          <button type="button" disabled={busy || loading} onClick={() => bulk(false)} style={{ color: 'var(--text-secondary)' }}>{t('Hide all')}{query ? t(' results') : ''}
          </button>
          {settings.visibleModels?.[provider] && (
            <button type="button" disabled={busy} onClick={() => void reset()} style={{ color: 'var(--text-secondary)' }}>{t('Reset')}
            </button>
          )}
        </span>
      </div>

      {(error || catalog?.note) && (
        <div
          style={{
            fontSize: 11.5,
            lineHeight: '16px',
            color: error || catalog?.note?.startsWith('Could not') ? 'var(--agent-amber)' : 'var(--text-tertiary)',
          }}
        >
          {error ?? catalog?.note}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}>
        {!loading && rows.length === 0 && (
          <div style={{ padding: '16px 4px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('No model matches.')}
          </div>
        )}
        {rows.map((m) => {
          const active = isActive(m);
          const on = shownIds.has(m.id) || active;
          return (
            <div
              key={m.id}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.label}
                  {m.supportsTools === false && (
                    <span style={{ marginLeft: 8, fontSize: 10.5, color: 'var(--agent-amber)', fontWeight: 400 }}>
                      {t('no tool calling')}
                    </span>
                  )}
                  {active && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--agent-green)', fontWeight: 400 }}>{t('in use')}
                    </span>
                  )}
                </div>
                <div
                  className="mono-num"
                  style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.id}
                </div>
              </div>
              <Switch
                checked={on}
                disabled={busy || active}
                label={t('{v0} {label} in chat', { v0: on ? 'Hide' : 'Show', label: m.label })}
                onChange={(next) => toggle(m, next)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
