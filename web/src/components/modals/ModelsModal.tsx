import { useT } from '../../i18n';
import {
  BUILT_IN_MODELS,
  type ModelEntry,
  type ProviderAuthStatus,
  type RealProvider,
  type Settings,
} from '@atelier/contracts';
import {
  Check,
  ExternalLink,
  Key,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { isModelShown } from '../../state/models';
import { ProviderIcon, ProviderTile } from '../ProviderIcon';
import { Select } from '../Select';
import { toast } from '../Toast';
import { ModelBrowser } from './ModelBrowser';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';

type ModalTab = 'accounts' | 'models';

const PROVIDER_SHORT: Record<RealProvider, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
};

const MODEL_PLACEHOLDER: Record<RealProvider, { id: string; label: string }> = {
  claude: { id: 'e.g. sonnet', label: 'e.g. Claude Sonnet 5.5' },
  openai: { id: 'e.g. gpt-6.2-astra', label: 'e.g. GPT-6.2 Astra' },
  antigravity: { id: 'e.g. gemini-3.5-flash', label: 'e.g. Gemini 3.5 Flash' },
  deepseek: { id: 'e.g. deepseek-reasoner', label: 'e.g. DeepSeek R1' },
  opencode: { id: 'e.g. opencode/big-pickle', label: 'e.g. OpenCode Big Pickle' },
  openrouter: { id: 'e.g. anthropic/claude-sonnet-4.5', label: 'e.g. OpenRouter · Claude Sonnet' },
};

const PROVIDER_ORDER: RealProvider[] = [
  'claude',
  'openai',
  'antigravity',
  'deepseek',
  'openrouter',
  'opencode',
];

export function ModelsProvidersPanel({
  settings,
  discoveredModels = [],
}: {
  settings: Settings;
  discoveredModels?: ModelEntry[];
}) {
  const t = useT();
  const [tab, setTab] = useState<ModalTab>('accounts');
  const [providerFilter, setProviderFilter] = useState<RealProvider | 'all'>('all');
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [modelsView, setModelsView] = useState<'chat' | 'browse'>('chat');

  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [localDiscovered, setLocalDiscovered] = useState<ModelEntry[]>(discoveredModels);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [busyProvider, setBusyProvider] = useState<RealProvider | null>(null);
  const [expandedCliPath, setExpandedCliPath] = useState<Partial<Record<RealProvider, boolean>>>({});
  const [cliPathDrafts, setCliPathDrafts] = useState<Partial<Record<RealProvider, string>>>(
    settings.cliPaths ?? {},
  );
  const [expandedApiKey, setExpandedApiKey] = useState<Partial<Record<RealProvider, boolean>>>({});
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Partial<Record<RealProvider, string>>>({});

  const [newProvider, setNewProvider] = useState<RealProvider>(settings.provider);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatuses = useCallback(async () => {
    try {
      const res = await api.getProvidersStatus();
      setProviders(res.providers);
      if (res.discoveredModels) {
        setLocalDiscovered(res.discoveredModels);
      }
    } catch {
      // ignore transient errors
    } finally {
      setLoadingAuth(false);
    }
  }, []);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses, settings.cliPaths]);

  useEffect(() => {
    const anyInProgress = providers.some((p) => p.loginInProgress);
    if (!anyInProgress) return;
    const id = window.setInterval(() => {
      void loadStatuses();
    }, 2000);
    return () => window.clearInterval(id);
  }, [providers, loadStatuses]);

  const allModels = useMemo(() => {
    const merged: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const m of [...BUILT_IN_MODELS, ...localDiscovered, ...(settings.customModels ?? [])]) {
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(m);
      }
    }
    return merged;
  }, [localDiscovered, settings.customModels]);

  // the models the chat pickers show (chosen under "Browse all")
  const shownList = useMemo(
    () => allModels.filter((m) => isModelShown(settings, m)),
    [allModels, settings],
  );

  const filteredModels = useMemo(
    () =>
      providerFilter === 'all'
        ? shownList
        : shownList.filter((m) => m.provider === providerFilter),
    [shownList, providerFilter],
  );

  const connectedCount = providers.filter((p) => p.authenticated).length;

  const handleLogin = async (provider: RealProvider) => {
    setBusyProvider(provider);
    setError(null);
    try {
      const res = await api.loginProvider(provider);
      setProviders((prev) => prev.map((p) => (p.provider === provider ? res.status : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to start login'));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleLogout = async (provider: RealProvider) => {
    setBusyProvider(provider);
    setError(null);
    try {
      const res = await api.logoutProvider(provider);
      setProviders((prev) => prev.map((p) => (p.provider === provider ? res.status : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to sign out'));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleSaveCliPath = async (provider: RealProvider) => {
    const pathVal = cliPathDrafts[provider]?.trim() || '';
    await api.updateSettings({
      cliPaths: { ...settings.cliPaths, [provider]: pathVal || undefined },
    });
    setExpandedCliPath((prev) => ({ ...prev, [provider]: false }));
    toast.success(t('{v0} CLI path saved', { v0: PROVIDER_SHORT[provider] }));
    await loadStatuses();
  };

  const handleSaveApiKey = async (provider: RealProvider) => {
    const rawKey = apiKeyDrafts[provider]?.trim() || '';
    if (!rawKey) return;
    setBusyProvider(provider);
    setError(null);
    try {
      const res = await api.saveProviderApiKey(provider, rawKey);
      setProviders((prev) => prev.map((p) => (p.provider === provider ? res.status : p)));
      setApiKeyDrafts((prev) => ({ ...prev, [provider]: '' }));
      setExpandedApiKey((prev) => ({ ...prev, [provider]: false }));
      toast.success(t('{v0} API key saved', { v0: PROVIDER_SHORT[provider] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to save API key'));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleClearApiKey = async (provider: RealProvider) => {
    setBusyProvider(provider);
    setError(null);
    try {
      const res = await api.clearProviderApiKey(provider);
      setProviders((prev) => prev.map((p) => (p.provider === provider ? res.status : p)));
      toast.info(t('{v0} API key cleared', { v0: PROVIDER_SHORT[provider] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to clear API key'));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleAddModel = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = newModelId.trim();
    if (!id) return;
    if (!/^[a-zA-Z0-9._:/-]+$/.test(id)) {
      setError(t('Model ID may only contain letters, numbers, ".", "_", "-", ":", or "/".'));
      return;
    }
    const label = newModelLabel.trim() || id;
    setSavingModel(true);
    setError(null);
    try {
      const existingCustom = settings.customModels ?? [];
      const nextCustom: ModelEntry[] = [
        ...existingCustom.filter((m) => !(m.provider === newProvider && m.id === id)),
        { id, label, provider: newProvider, builtIn: false },
      ];
      await api.updateSettings({
        customModels: nextCustom,
        provider: newProvider,
        model: id,
      });
      setNewModelId('');
      setNewModelLabel('');
      setAddFormOpen(false);
      toast.success(t('Model “{label}” added', { label }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to add model'));
    } finally {
      setSavingModel(false);
    }
  };

  const handleDeleteCustomModel = async (entry: ModelEntry) => {
    const nextCustom = (settings.customModels ?? []).filter(
      (m) => !(m.provider === entry.provider && m.id === entry.id),
    );
    await api.updateSettings({ customModels: nextCustom });
    toast.deleted(t('Model “{label}” removed', { label: entry.label }));
  };

  const handleUseModel = async (entry: ModelEntry) => {
    await api.updateSettings({
      provider: entry.provider,
      model: entry.id,
    });
    toast.success(t('Now using {label}', { label: entry.label }));
  };

  const placeholder = MODEL_PLACEHOLDER[newProvider];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Top segmented tab bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              padding: 3,
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              gap: 2,
            }}
          >
            {(
              [
                {
                  id: 'accounts' as ModalTab,
                  label: t('Accounts'),
                  badge: providers.length > 0 ? `${connectedCount}/${providers.length}` : undefined,
                },
                {
                  id: 'models' as ModalTab,
                  label: t('Models'),
                  badge: String(shownList.length),
                },
              ]
            ).map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className="transition-atelier"
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 'var(--radius-full)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12.5,
                    fontWeight: active ? 500 : 400,
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    background: active ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  <span>{item.label}</span>
                  {item.badge && (
                    <span
                      className="mono-num"
                      style={{
                        fontSize: 10.5,
                        color: active ? 'var(--text-secondary)' : 'var(--text-muted)',
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {tab === 'accounts' ? (
            <button
              type="button"
              onClick={() => void loadStatuses()}
              className="transition-atelier"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 'var(--radius-full)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--text-secondary)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <RefreshCw size={12} strokeWidth={1.5} />{t('Refresh')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAddFormOpen((v) => !v)}
              className="transition-atelier"
              style={{
                height: 28,
                padding: '0 12px',
                borderRadius: 'var(--radius-full)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 500,
                color: addFormOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: addFormOpen ? 'var(--surface-3)' : 'var(--surface-2)',
                border: `1px solid ${addFormOpen ? 'var(--border-default)' : 'var(--border-subtle)'}`,
              }}
            >
              <Plus size={13} strokeWidth={1.6} />{t('Custom model')}
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(248, 113, 113, 0.08)',
              border: '1px solid rgba(248, 113, 113, 0.24)',
              fontSize: 12,
              color: 'var(--agent-red)',
            }}
          >
            {error}
          </div>
        )}

        {tab === 'accounts' ? (
          loadingAuth && providers.length === 0 ? (
            <div style={{ padding: '24px 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('Checking installed CLIs & credentials…')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {providers.map((p) => {
                const tileStatus = p.authenticated
                  ? 'connected'
                  : p.cliInstalled
                    ? 'ready'
                    : 'missing';
                const isBusy = busyProvider === p.provider;
                const cliOpen = Boolean(expandedCliPath[p.provider]);
                const keyOpen = Boolean(expandedApiKey[p.provider]);

                return (
                  <div
                    key={p.provider}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 12,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <ProviderTile provider={p.provider} size={36} status={tileStatus} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                              }}
                            >
                              {p.label}
                            </span>
                            {p.accountLabel && (
                              <span
                                className="mono-num"
                                style={{
                                  fontSize: 11,
                                  color: 'var(--text-secondary)',
                                  padding: '1px 7px',
                                  borderRadius: 6,
                                  background: 'var(--surface-3)',
                                  border: '1px solid var(--border-subtle)',
                                  maxWidth: 200,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {p.accountLabel}
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--text-tertiary)',
                              marginTop: 2,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={p.message}
                          >
                            {p.message}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        {p.authMode === 'api_key' ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedApiKey((prev) => ({
                                  ...prev,
                                  [p.provider]: !prev[p.provider],
                                }))
                              }
                              className="transition-atelier"
                              style={{
                                height: 30,
                                padding: '0 12px',
                                borderRadius: 'var(--radius-full)',
                                background: keyOpen
                                  ? 'var(--surface-3)'
                                  : p.authenticated
                                    ? 'var(--surface-1)'
                                    : 'rgba(255, 255, 255, 0.11)',
                                border: '1px solid var(--border-default)',
                                fontSize: 12,
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                              }}
                            >
                              <Key size={12} strokeWidth={1.5} />
                              {p.authenticated ? t('Update key') : t('Set API key')}
                            </button>
                            {p.authenticated && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleClearApiKey(p.provider)}
                                title={t('Clear saved API key')}
                                className="transition-atelier"
                                style={{
                                  width: 30,
                                  height: 30,
                                  borderRadius: 'var(--radius-full)',
                                  background: 'var(--surface-1)',
                                  border: '1px solid var(--border-subtle)',
                                  color: 'var(--text-secondary)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <Trash2 size={13} strokeWidth={1.5} />
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedCliPath((prev) => ({
                                  ...prev,
                                  [p.provider]: !prev[p.provider],
                                }))
                              }
                              title={t('Set custom CLI path')}
                              className="transition-atelier"
                              style={{
                                width: 30,
                                height: 30,
                                borderRadius: 'var(--radius-full)',
                                background: cliOpen ? 'var(--surface-3)' : 'transparent',
                                border: `1px solid ${cliOpen ? 'var(--border-default)' : 'transparent'}`,
                                color: cliOpen ? 'var(--text-primary)' : 'var(--text-tertiary)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <Terminal size={13} strokeWidth={1.5} />
                            </button>

                            {p.authenticated ? (
                              <>
                                {p.provider === 'opencode' && (
                                  <button
                                    type="button"
                                    disabled={isBusy || !p.cliInstalled}
                                    onClick={() => void handleLogin('opencode')}
                                    className="transition-atelier"
                                    style={{
                                      height: 30,
                                      padding: '0 12px',
                                      borderRadius: 'var(--radius-full)',
                                      background: 'rgba(255, 255, 255, 0.11)',
                                      border: '1px solid var(--border-default)',
                                      fontSize: 12,
                                      fontWeight: 500,
                                      color: 'var(--text-primary)',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 5,
                                    }}
                                  >
                                    <LogIn size={12} strokeWidth={1.5} />{t('+ Add provider')}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleLogout(p.provider)}
                                  className="transition-atelier"
                                  style={{
                                    height: 30,
                                    padding: '0 12px',
                                    borderRadius: 'var(--radius-full)',
                                    background: 'var(--surface-1)',
                                    border: '1px solid var(--border-subtle)',
                                    fontSize: 12,
                                    color: 'var(--text-secondary)',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 5,
                                  }}
                                >
                                  <LogOut size={12} strokeWidth={1.5} />{t('Sign out')}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy || !p.cliInstalled}
                                onClick={() => void handleLogin(p.provider)}
                                className="transition-atelier"
                                style={{
                                  height: 30,
                                  padding: '0 12px',
                                  borderRadius: 'var(--radius-full)',
                                  background: p.cliInstalled
                                    ? 'rgba(255, 255, 255, 0.11)'
                                    : 'var(--surface-3)',
                                  border: `1px solid ${p.cliInstalled ? 'var(--border-default)' : 'transparent'}`,
                                  color: p.cliInstalled ? 'var(--text-primary)' : 'var(--text-muted)',
                                  fontSize: 12,
                                  fontWeight: 500,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 5,
                                  cursor: p.cliInstalled ? 'pointer' : 'not-allowed',
                                }}
                              >
                                <LogIn size={12} strokeWidth={1.5} />
                                {p.loginInProgress ? t('Waiting…') : t('Sign in')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {p.authUrl && (
                      <a
                        href={p.authUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          paddingLeft: 48,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 12,
                          color: 'var(--agent-blue)',
                        }}
                      >
                        <ExternalLink size={12} strokeWidth={1.5} />{t('Open browser login link')}
                      </a>
                    )}

                    {p.authMode === 'api_key' && keyOpen && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          paddingTop: 10,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <input
                          type="password"
                          value={apiKeyDrafts[p.provider] ?? ''}
                          onChange={(e) =>
                            setApiKeyDrafts((prev) => ({
                              ...prev,
                              [p.provider]: e.target.value,
                            }))
                          }
                          placeholder={t('Paste sk-… API key (stored server-side)')}
                          className="mono-num"
                          style={{ ...inputStyle, padding: '6px 10px', fontSize: 12 }}
                        />
                        <button
                          type="button"
                          disabled={isBusy || !(apiKeyDrafts[p.provider]?.trim())}
                          onClick={() => void handleSaveApiKey(p.provider)}
                          style={{ ...primaryBtnStyle, height: 32, padding: '0 14px', fontSize: 12 }}
                        >{t('Save key')}
                        </button>
                      </div>
                    )}

                    {p.authMode !== 'api_key' && cliOpen && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          paddingTop: 10,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <input
                          type="text"
                          value={cliPathDrafts[p.provider] ?? p.cliPath ?? ''}
                          onChange={(e) =>
                            setCliPathDrafts((prev) => ({
                              ...prev,
                              [p.provider]: e.target.value,
                            }))
                          }
                          placeholder={t('Full path to CLI executable or .cmd')}
                          className="mono-num"
                          style={{ ...inputStyle, padding: '6px 10px', fontSize: 12 }}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveCliPath(p.provider)}
                          style={{ ...secondaryBtnStyle, height: 32, padding: '0 12px', fontSize: 12 }}
                        >{t('Save path')}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              role="tablist"
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                padding: 3,
                gap: 2,
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {(
                [
                  { id: 'chat', label: t('In chat ({length})', { length: shownList.length }) },
                  { id: 'browse', label: t('Browse all models') },
                ] as const
              ).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={modelsView === v.id}
                  onClick={() => setModelsView(v.id)}
                  className="transition-atelier"
                  style={{
                    height: 26,
                    padding: '0 12px',
                    borderRadius: 'var(--radius-full)',
                    fontSize: 12,
                    fontWeight: modelsView === v.id ? 500 : 400,
                    color: modelsView === v.id ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    background: modelsView === v.id ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {modelsView === 'browse' ? (
              <ModelBrowser
                settings={settings}
                detected={localDiscovered}
                initialProvider={providerFilter === 'all' ? settings.provider : providerFilter}
                providers={PROVIDER_ORDER.map((id) => ({ id, label: PROVIDER_SHORT[id] }))}
              />
            ) : (
              <>
            {addFormOpen && (
              <form
                onSubmit={handleAddModel}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1.3fr 1.3fr',
                    gap: 8,
                  }}
                >
                  <div>
                    <label style={labelStyle}>{t('Provider')}</label>
                    <Select
                      ariaLabel={t('Provider')}
                      value={newProvider}
                      onChange={(v) => setNewProvider(v as RealProvider)}
                      options={PROVIDER_ORDER.map((id) => ({
                        value: id,
                        label: PROVIDER_SHORT[id],
                      }))}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>{t('Model ID')}</label>
                    <input
                      type="text"
                      value={newModelId}
                      onChange={(e) => setNewModelId(e.target.value)}
                      placeholder={placeholder.id}
                      className="mono-num"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>{t('Display Name')}</label>
                    <input
                      type="text"
                      value={newModelLabel}
                      onChange={(e) => setNewModelLabel(e.target.value)}
                      placeholder={placeholder.label}
                      style={inputStyle}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setAddFormOpen(false)}
                    style={{ ...secondaryBtnStyle, height: 30, fontSize: 12 }}
                  >{t('Cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={!newModelId.trim() || savingModel}
                    style={{ ...primaryBtnStyle, height: 30, fontSize: 12 }}
                  >{t('Add & activate')}
                  </button>
                </div>
              </form>
            )}

            {/* Provider filter strip */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setProviderFilter('all')}
                className="transition-atelier"
                style={{
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 11.5,
                  fontWeight: providerFilter === 'all' ? 500 : 400,
                  color: providerFilter === 'all' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: providerFilter === 'all' ? 'var(--surface-3)' : 'var(--surface-2)',
                  border: `1px solid ${providerFilter === 'all' ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                }}
              >{t('All (')}{shownList.length})
              </button>
              {PROVIDER_ORDER.map((id) => {
                const count = shownList.filter((m) => m.provider === id).length;
                if (count === 0) return null;
                const active = providerFilter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProviderFilter(id)}
                    className="transition-atelier"
                    style={{
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
                    }}
                  >
                    <ProviderIcon provider={id} size={12} active={active} />
                    <span>{PROVIDER_SHORT[id]}</span>
                    <span className="mono-num" style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Clean model list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filteredModels.map((m) => {
                const isActive = settings.provider === m.provider && settings.model === m.id;
                return (
                  <div
                    key={`${m.provider}:${m.id}`}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 10,
                      background: isActive ? 'rgba(52, 211, 153, 0.06)' : 'var(--surface-2)',
                      border: `1px solid ${isActive ? 'rgba(52, 211, 153, 0.28)' : 'var(--border-subtle)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <ProviderIcon provider={m.provider} size={14} active={isActive} />
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
                          {PROVIDER_SHORT[m.provider]} · {m.id}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {!m.builtIn && (
                        <button
                          type="button"
                          onClick={() => void handleDeleteCustomModel(m)}
                          title={t('Remove custom model')}
                          style={{ color: 'var(--text-muted)', padding: 4 }}
                        >
                          <Trash2 size={13} strokeWidth={1.5} />
                        </button>
                      )}
                      {isActive ? (
                        <span
                          style={{
                            height: 26,
                            padding: '0 10px',
                            borderRadius: 'var(--radius-full)',
                            background: 'rgba(52, 211, 153, 0.14)',
                            border: '1px solid rgba(52, 211, 153, 0.3)',
                            color: 'var(--agent-green)',
                            fontSize: 11.5,
                            fontWeight: 500,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <Check size={12} strokeWidth={1.75} />{t('Active')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleUseModel(m)}
                          className="transition-atelier"
                          style={{
                            height: 26,
                            padding: '0 12px',
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-subtle)',
                            fontSize: 11.5,
                          }}
                        >{t('Use')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {filteredModels.length === 0 && (
              <div style={{ padding: '14px 4px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('No model is shown here. Use “Browse all models” to pick some.')}
              </div>
            )}
              </>
            )}
          </div>
        )}
    </div>
  );
}

export function ModelsModal({
  settings,
  discoveredModels = [],
  onClose,
}: {
  settings: Settings;
  discoveredModels?: ModelEntry[];
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ModalShell
      title={t('Models & Provider Login')}
      subtitle={t('Connect providers via OAuth, CLI, or API key, and choose default workspace models.')}
      width={620}
      onClose={onClose}
    >
      <ModelsProvidersPanel settings={settings} discoveredModels={discoveredModels} />
    </ModalShell>
  );
}
