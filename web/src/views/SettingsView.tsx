import { LANGUAGES, type Lang, setLang, useLang, useT } from '../i18n';
import {
  BUILT_IN_MODELS,
  DEFAULT_AUTO_COMPACT_SETTINGS,
  DEFAULT_MEMORY_SETTINGS,
  type AppUpdateStatus,
  type FallbackMode,
  type ModelEntry,
  type ModelRef,
  type OnboardingStatus,
  type Project,
  type ReasoningEffort,
  type Settings,
  type SttDownloadProgressEvent,
} from '@atelier/contracts';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Brain,
  CircleAlert,
  Minimize2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { shownModels } from '../state/models';
import { api, permissionsApi } from '../api';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from '../components/modals/ModalShell';
import { ModelsProvidersPanel } from '../components/modals/ModelsModal';
import { Select } from '../components/Select';
import { toast } from '../components/Toast';
import { BrowserSettingsPanel } from './BrowserSettingsPanel';
import { MeetingSettingsPanel } from './MeetingSettingsPanel';
import { SecurityBackupPanel } from './SecurityBackupPanel';

export type SettingsTab = 'general' | 'providers' | 'meeting' | 'browser' | 'security';

export function SettingsView({
  settings,
  activeProject,
  discoveredModels = [],
  onDiscoveredModelsChange,
  sttDownload = null,
  appUpdate = null,
  initialTab = 'general',
  onOpenMcp,
  onClose,
}: {
  settings: Settings;
  activeProject: Project | null;
  discoveredModels?: ModelEntry[];
  onDiscoveredModelsChange?: (models: ModelEntry[]) => void;
  sttDownload?: SttDownloadProgressEvent | null;
  appUpdate?: AppUpdateStatus | null;
  initialTab?: SettingsTab;
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const initialCompact = settings.autoCompact ?? DEFAULT_AUTO_COMPACT_SETTINGS;
  const initialMemory = { ...DEFAULT_MEMORY_SETTINGS, ...(settings.memory ?? {}) };
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [model, setModel] = useState(settings.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(settings.reasoningEffort);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState(initialCompact.enabled);
  const [selectiveMemory, setSelectiveMemory] = useState(initialMemory.mode === 'selective');
  const [memPush, setMemPush] = useState(String(initialMemory.pushBudgetTokens));
  const [memPinned, setMemPinned] = useState(String(initialMemory.pinnedBudgetTokens));
  const [memCatalog, setMemCatalog] = useState(String(initialMemory.catalogBudgetTokens));
  const [memTopK, setMemTopK] = useState(String(initialMemory.topK));
  const [rebuildingMemory, setRebuildingMemory] = useState(false);
  const [maxMessages, setMaxMessages] = useState(String(initialCompact.maxMessages));
  const [keepRecentMessages, setKeepRecentMessages] = useState(
    String(initialCompact.keepRecentMessages),
  );
  const [maxContextTokens, setMaxContextTokens] = useState(String(initialCompact.maxContextTokens));
  const [minCompactMessages, setMinCompactMessages] = useState(
    String(initialCompact.minCompactMessages ?? DEFAULT_AUTO_COMPACT_SETTINGS.minCompactMessages ?? 10),
  );
  const [providerContextLimit, setProviderContextLimit] = useState(
    String(initialCompact.providerContextLimit ?? DEFAULT_AUTO_COMPACT_SETTINGS.providerContextLimit ?? 100000),
  );
  const [tailTokens, setTailTokens] = useState(String(initialCompact.tailTokens ?? 6000));
  const [summarizerModel, setSummarizerModel] = useState(initialCompact.summarizerModel ?? '');
  const [fallbackMode, setFallbackMode] = useState<FallbackMode>(settings.fallbackMode ?? 'ask');
  const [fallbackChain, setFallbackChain] = useState<ModelRef[]>(settings.fallbackChain ?? []);
  const [allowFullPermissions, setAllowFullPermissions] = useState(
    activeProject?.allowFullPermissions ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allModels = useMemo(() => {
    const merged: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const m of [...BUILT_IN_MODELS, ...discoveredModels, ...(settings.customModels ?? [])]) {
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(m);
      }
    }
    return merged;
  }, [discoveredModels, settings.customModels]);

  useEffect(() => {
    setModel(settings.model);
    setReasoningEffort(settings.reasoningEffort);
    setFallbackMode(settings.fallbackMode ?? 'ask');
    setFallbackChain(settings.fallbackChain ?? []);
  }, [settings.model, settings.reasoningEffort, settings.fallbackMode, settings.fallbackChain]);

  useEffect(() => {
    api
      .getOnboardingStatus()
      .then(setStatus)
      .catch(() => null);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const parsedMaxMsgs = Math.min(
        200,
        Math.max(4, Math.round(Number(maxMessages) || DEFAULT_AUTO_COMPACT_SETTINGS.maxMessages)),
      );
      const parsedKeep = Math.min(
        parsedMaxMsgs - 1,
        Math.max(
          1,
          Math.round(Number(keepRecentMessages) || DEFAULT_AUTO_COMPACT_SETTINGS.keepRecentMessages),
        ),
      );
      const parsedTokens = Math.min(
        500_000,
        Math.max(
          4_000,
          Math.round(Number(maxContextTokens) || DEFAULT_AUTO_COMPACT_SETTINGS.maxContextTokens),
        ),
      );
      const maxBatchUpper = Math.max(2, Math.min(50, parsedMaxMsgs - parsedKeep));
      const parsedMinCompact = Math.min(
        maxBatchUpper,
        Math.max(
          2,
          Math.round(
            Number(minCompactMessages) ||
              DEFAULT_AUTO_COMPACT_SETTINGS.minCompactMessages ||
              10,
          ),
        ),
      );
      const parsedProviderLimit = Math.min(
        2_000_000,
        Math.max(
          8_000,
          Math.round(
            Number(providerContextLimit) ||
              DEFAULT_AUTO_COMPACT_SETTINGS.providerContextLimit ||
              100_000,
          ),
        ),
      );

      await api.updateSettings({
        model: model.trim(),
        reasoningEffort,
        autoCompact: {
          enabled: autoCompactEnabled,
          maxMessages: parsedMaxMsgs,
          keepRecentMessages: parsedKeep,
          maxContextTokens: parsedTokens,
          minCompactMessages: parsedMinCompact,
          providerContextLimit: parsedProviderLimit,
          tailTokens: Math.min(6000, Math.max(1000, Math.round(Number(tailTokens) || 6000))),
          summarizerModel: summarizerModel.trim(),
        },
        memory: {
          mode: selectiveMemory ? 'selective' : 'full',
          pushBudgetTokens: Math.min(8000, Math.max(200, Math.round(Number(memPush) || DEFAULT_MEMORY_SETTINGS.pushBudgetTokens))),
          pinnedBudgetTokens: Math.min(4000, Math.max(0, Math.round(Number(memPinned) || 0))),
          catalogBudgetTokens: Math.min(2000, Math.max(0, Math.round(Number(memCatalog) || 0))),
          topK: Math.min(30, Math.max(1, Math.round(Number(memTopK) || DEFAULT_MEMORY_SETTINGS.topK))),
        },
        fallbackMode,
        fallbackChain,
      });

      if (activeProject && allowFullPermissions !== activeProject.allowFullPermissions) {
        await api.updateProject(activeProject.id, { allowFullPermissions });
      }
      toast.success(t('Settings saved'));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to save settings'));
    } finally {
      setSaving(false);
    }
  };

  const checks = [
    {
      label: t('GitHub CLI (gh)'),
      ok: Boolean(status?.github.authenticated),
      detail: status?.github.authenticated
        ? t('Logged in as {name}', { name: status.github.username || 'user' })
        : status?.github.message || t('Optional · needed only for gh repo cloning'),
    },
    {
      label: t('Active default AI provider'),
      ok: true,
      detail: `${settings.provider} · ${settings.model}`,
    },
  ];

  return (
    <ModalShell
      title={t('Harness settings')}
      subtitle={t('Configure AI providers, models, reasoning effort, context compaction, and permissions.')}
      width={640}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Top segmented tabs inside Harness Settings */}
        <div
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            padding: 3,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            gap: 2,
          }}
        >
          {(
            [
              { id: 'general' as SettingsTab, label: t('General') },
              { id: 'providers' as SettingsTab, label: t('Models & Providers') },
              { id: 'meeting' as SettingsTab, label: t('Meeting') },
              { id: 'browser' as SettingsTab, label: t('Browser & Login') },
              { id: 'security' as SettingsTab, label: t('Security & Backup') },
            ]
          ).map((item) => {
            const on = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className="transition-atelier"
                style={{
                  height: 28,
                  padding: '0 12px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12.5,
                  fontWeight: on ? 500 : 400,
                  color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: on ? 'var(--surface-3)' : 'transparent',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'security' ? (
          <SecurityBackupPanel />
        ) : activeTab === 'browser' ? (
          <BrowserSettingsPanel settings={settings} />
        ) : activeTab === 'meeting' ? (
          <MeetingSettingsPanel settings={settings} sttDownload={sttDownload} />
        ) : activeTab === 'providers' ? (
          <ModelsProvidersPanel
            settings={settings}
            discoveredModels={discoveredModels}
            onDiscoveredModelsChange={onDiscoveredModelsChange}
          />
        ) : (
          <>
            {appUpdate && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)',
                  border:
                    appUpdate.state === 'available' || appUpdate.state === 'downloading'
                      ? '1px solid var(--agent-green)'
                      : '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                    Atelier Desktop <span className="mono-num">v{appUpdate.currentVersion}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {!appUpdate.supported
                      ? t('Desktop auto-updater is active in the installed Windows app.')
                      : appUpdate.state === 'available'
                        ? t('Update v{version} ready to install.', { version: appUpdate.availableVersion ?? '' })
                        : appUpdate.state === 'downloading'
                          ? t('Downloading update… {pct}%', { pct: appUpdate.progressPercent ?? 0 })
                          : appUpdate.state === 'checking'
                            ? t('Checking for updates…')
                            : appUpdate.state === 'up_to_date'
                              ? t('You are on the latest version.')
                              : appUpdate.state === 'error'
                                ? appUpdate.error || t('Update check failed.')
                                : t('Automatic updates via GitHub Releases.')}
                  </div>
                </div>
                {appUpdate.supported && (
                  <button
                    type="button"
                    disabled={appUpdate.state === 'checking' || appUpdate.state === 'downloading'}
                    onClick={() => {
                      if (appUpdate.state === 'available') {
                        void api.installAppUpdate();
                      } else {
                        void api.checkAppUpdate();
                      }
                    }}
                    style={{
                      ...(appUpdate.state === 'available' ? primaryBtnStyle : secondaryBtnStyle),
                      height: 30,
                      padding: '0 12px',
                      fontSize: 12,
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <RefreshCw size={13} strokeWidth={1.5} />
                    {appUpdate.state === 'available'
                      ? t('Update to v{version}', { version: appUpdate.availableVersion ?? '' })
                      : appUpdate.state === 'downloading'
                        ? `${appUpdate.progressPercent ?? 0}%`
                        : t('Check for updates')}
                  </button>
                )}
              </div>
            )}

            <div
              style={{
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                  }}
                >{t('Environment Readiness')}
                </div>
                <button
                  type="button"
                  onClick={onOpenMcp}
                  style={{
                    fontSize: 11.5,
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    padding: '3px 9px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--surface-3)',
                    border: '1px solid var(--border-default)',
                  }}
                >{t('MCP connections (')}{settings.mcpServers.length})…
                </button>
              </div>
          {checks.map((c) => (
            <div
              key={c.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--text-primary)' }}>
                {c.ok ? (
                  <CheckCircle2 size={14} strokeWidth={1.5} style={{ color: 'var(--agent-green)' }} />
                ) : (
                  <CircleAlert size={14} strokeWidth={1.5} style={{ color: 'var(--agent-amber)' }} />
                )}
                {c.label}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{c.detail}</span>
            </div>
          ))}
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>{t('Interface language')}</label>
            <Select
              ariaLabel={t('Interface language')}
              value={lang}
              onChange={(v) => {
                setLang(v as Lang);
                void api.updateSettings({ language: v as Lang }).catch(() => undefined);
              }}
              options={LANGUAGES}
            />
            <div style={{ fontSize: 11.5, lineHeight: '16px', color: 'var(--text-tertiary)', marginTop: 6 }}>
              {t('Choose the language used for menus, buttons and messages. Agent replies follow the language you write in.')}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>{t('Default model')}</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mono-num"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>{t('Effort')}</label>
              <Select
                ariaLabel={t('Effort')}
                value={reasoningEffort}
                onChange={(v) => setReasoningEffort(v as ReasoningEffort)}
                options={[
                  { value: 'Low', label: t('Low') },
                  { value: 'Medium', label: t('Medium') },
                  { value: 'High', label: t('High') },
                ]}
              />
            </div>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoCompactEnabled}
                onChange={(e) => setAutoCompactEnabled(e.target.checked)}
              />
              <Minimize2 size={14} strokeWidth={1.5} style={{ color: 'var(--agent-amber)' }} />{t('Auto-compact long conversations')}
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 22 }}>{t('Summarizes older turns and keeps native sessions while they fit the context budget. The full conversation stays searchable.')}
            </div>

            {autoCompactEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 22 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={labelStyle}>{t('Trigger msgs')}</label>
                    <input
                      type="number"
                      min={4}
                      max={200}
                      value={maxMessages}
                      onChange={(e) => setMaxMessages(e.target.value)}
                      className="mono-num"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>{t('Keep recent')}</label>
                    <input
                      type="number"
                      min={1}
                      max={199}
                      value={keepRecentMessages}
                      onChange={(e) => setKeepRecentMessages(e.target.value)}
                      className="mono-num"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor="min-compact-messages" style={labelStyle}>{t('Min. messages per compaction')}</label>
                    <input
                      id="min-compact-messages"
                      type="number"
                      min={2}
                      max={50}
                      value={minCompactMessages}
                      onChange={(e) => setMinCompactMessages(e.target.value)}
                      className="mono-num"
                      style={inputStyle}
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={labelStyle}>{t('Conversation limit')}</label>
                    <input
                      type="number"
                      min={4000}
                      max={500000}
                      step={1000}
                      value={maxContextTokens}
                      onChange={(e) => setMaxContextTokens(e.target.value)}
                      className="mono-num"
                      style={inputStyle}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                      {t('Estimated chat content tokens (excluding system prompt & tools)')}
                    </div>
                  </div>
                  <div>
                    <label htmlFor="provider-context-limit" style={labelStyle}>{t('Provider context limit')}</label>
                    <input
                      id="provider-context-limit"
                      type="number"
                      min={8000}
                      max={2000000}
                      step={5000}
                      value={providerContextLimit}
                      onChange={(e) => setProviderContextLimit(e.target.value)}
                      className="mono-num"
                      style={inputStyle}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                      {t('Safeguard. Compacts & resets session if provider prompt exceeds this')}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
                  <div>
                    <label htmlFor="memory-tail-tokens" style={labelStyle}>{t('History tail tokens')}</label>
                    <input
                      id="memory-tail-tokens"
                      type="number"
                      min={1000}
                      max={6000}
                      step={500}
                      value={tailTokens}
                      onChange={(e) => setTailTokens(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label htmlFor="memory-model" style={labelStyle}>{t('Summarizer model')}</label>
                    <input
                      id="memory-model"
                      value={summarizerModel}
                      placeholder={t('Automatic for provider')}
                      maxLength={120}
                      onChange={(e) => setSummarizerModel(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selectiveMemory}
                onChange={(e) => setSelectiveMemory(e.target.checked)}
              />
              <Brain size={14} strokeWidth={1.5} style={{ color: 'var(--agent-blue)' }} />{t('Selective memory (beta)')}
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 22 }}>
              {t('Send only the memory relevant to each request (pinned entries, matches and a title index) instead of all Canon and summaries. Agents fetch the rest with search_memory.')}
            </div>
            {selectiveMemory && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 22 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                  <div>
                    <label htmlFor="mem-push" style={labelStyle}>{t('Push budget')}</label>
                    <input id="mem-push" type="number" min={200} max={8000} step={100} value={memPush}
                      onChange={(e) => setMemPush(e.target.value)} className="mono-num" style={inputStyle} />
                  </div>
                  <div>
                    <label htmlFor="mem-pinned" style={labelStyle}>{t('Pinned budget')}</label>
                    <input id="mem-pinned" type="number" min={0} max={4000} step={50} value={memPinned}
                      onChange={(e) => setMemPinned(e.target.value)} className="mono-num" style={inputStyle} />
                  </div>
                  <div>
                    <label htmlFor="mem-catalog" style={labelStyle}>{t('Index budget')}</label>
                    <input id="mem-catalog" type="number" min={0} max={2000} step={50} value={memCatalog}
                      onChange={(e) => setMemCatalog(e.target.value)} className="mono-num" style={inputStyle} />
                  </div>
                  <div>
                    <label htmlFor="mem-topk" style={labelStyle}>{t('Top matches')}</label>
                    <input id="mem-topk" type="number" min={1} max={30} value={memTopK}
                      onChange={(e) => setMemTopK(e.target.value)} className="mono-num" style={inputStyle} />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    disabled={rebuildingMemory}
                    style={secondaryBtnStyle}
                    onClick={async () => {
                      setRebuildingMemory(true);
                      try {
                        await api.rebuildMemoryIndex();
                        toast.success(t('Memory index will be rebuilt on the next turn'));
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : t('Could not rebuild the memory index.'));
                      } finally {
                        setRebuildingMemory(false);
                      }
                    }}
                  >
                    {t('Rebuild memory index')}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {t('Tokens are estimated. Pin Canon entries in the Canon panel to always send them.')}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                <RefreshCw size={14} strokeWidth={1.5} style={{ color: 'var(--agent-blue)' }} />{t('Model fallback chain (when limit hits)')}
              </span>
              <div
                style={{
                  display: 'inline-flex',
                  padding: 2,
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  gap: 2,
                }}
              >
                {(
                  [
                    { id: 'ask' as FallbackMode, label: t('Ask me first') },
                    { id: 'auto' as FallbackMode, label: t('Auto-switch') },
                  ]
                ).map((m) => {
                  const active = fallbackMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setFallbackMode(m.id)}
                      className="transition-atelier"
                      style={{
                        padding: '3px 10px',
                        borderRadius: 'var(--radius-full)',
                        fontSize: 11.5,
                        fontWeight: active ? 500 : 400,
                        color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                        background: active ? 'var(--surface-3)' : 'transparent',
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {fallbackMode === 'ask' ? t('When a provider hits rate limit or quota, pause and show a recovery card so you choose which backup model continues.') : t('Automatically hand off to the next healthy backup model below when rate limit, quota, or outage errors occur.')}
            </div>

            {fallbackChain.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {fallbackChain.map((item, idx) => {
                  const label =
                    allModels.find((m) => m.provider === item.provider && m.id === item.model)
                      ?.label ?? item.model;
                  return (
                    <div
                      key={`${item.provider}:${item.model}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 12,
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          #{idx + 1}
                        </span>
                        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{label}</span>
                        <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {item.provider}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => {
                            if (idx === 0) return;
                            setFallbackChain((prev) => {
                              const next = [...prev];
                              [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                              return next;
                            });
                          }}
                          title={t('Move up')}
                          style={{ color: idx === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', padding: 3 }}
                        >
                          <ArrowUp size={12} strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={idx === fallbackChain.length - 1}
                          onClick={() => {
                            if (idx === fallbackChain.length - 1) return;
                            setFallbackChain((prev) => {
                              const next = [...prev];
                              [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                              return next;
                            });
                          }}
                          title={t('Move down')}
                          style={{
                            color:
                              idx === fallbackChain.length - 1
                                ? 'var(--text-muted)'
                                : 'var(--text-secondary)',
                            padding: 3,
                          }}
                        >
                          <ArrowDown size={12} strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setFallbackChain((prev) => prev.filter((_, i) => i !== idx))
                          }
                          title={t('Remove backup')}
                          style={{ color: 'var(--text-muted)', padding: 3 }}
                        >
                          <Trash2 size={12} strokeWidth={1.5} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {fallbackChain.length < 5 && (
              <Select
                ariaLabel={t('Add backup model')}
                value=""
                placeholder={t('Add backup model…')}
                onChange={(val) => {
                  const [prov, ...rest] = val.split(':');
                  const modId = rest.join(':');
                  if (!prov || !modId) return;
                  const key = `${prov}:${modId}`;
                  if (fallbackChain.some((c) => `${c.provider}:${c.model}` === key)) return;
                  setFallbackChain((prev) => [
                    ...prev,
                    { provider: prov as ModelRef['provider'], model: modId },
                  ]);
                }}
                options={shownModels(allModels, settings)
                  .filter(
                    (m) => !fallbackChain.some((c) => c.provider === m.provider && c.model === m.id),
                  )
                  .map((m) => ({
                    value: `${m.provider}:${m.id}`,
                    label: m.label,
                    hint: m.provider,
                  }))}
              />
            )}
          </div>

          {activeProject && (
            <div
              style={{
                padding: 10,
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(248, 113, 113, 0.06)',
                border: '1px solid rgba(248, 113, 113, 0.2)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={allowFullPermissions}
                  onChange={(e) => setAllowFullPermissions(e.target.checked)}
                />
                <ShieldAlert size={14} strokeWidth={1.5} style={{ color: 'var(--agent-red)' }} />{t('Allow shell-enabled agents full permissions (`bypassPermissions`) in')} {activeProject.name}
              </label>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 22 }}>{t('Per-project toggle: agents with shell execution enabled can run commands in the linked repo folder using your local user privileges.')}
              </div>
            </div>
          )}

          {(settings.approvedPermissions?.length ?? 0) > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                {t('Saved CLI & MCP permissions')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(settings.approvedPermissions ?? []).map((grant) => (
                  <span
                    key={grant.key}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 8px 3px 10px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border-default)',
                      fontSize: 11.5,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <span>{grant.label}</span>
                    <button
                      type="button"
                      title={t('Revoke permission')}
                      onClick={() => void permissionsApi.revokeGrant(grant.key)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>{t('Cancel')}
            </button>
            <button type="submit" disabled={saving} style={primaryBtnStyle}>
              {saving ? t('Saving…') : t('Save settings')}
            </button>
          </div>
        </form>
          </>
        )}
      </div>
    </ModalShell>
  );
}
