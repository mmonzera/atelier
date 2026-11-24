import {
  BUILT_IN_MODELS,
  DEFAULT_AUTO_COMPACT_SETTINGS,
  type FallbackMode,
  type ModelEntry,
  type ModelRef,
  type OnboardingStatus,
  type Project,
  type ReasoningEffort,
  type Settings,
} from '@atelier/contracts';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  Minimize2,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { shownModels } from '../state/models';
import { api } from '../api';
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
import { SecurityBackupPanel } from './SecurityBackupPanel';

export type SettingsTab = 'general' | 'providers' | 'security';

export function SettingsView({
  settings,
  activeProject,
  discoveredModels = [],
  initialTab = 'general',
  onOpenMcp,
  onClose,
}: {
  settings: Settings;
  activeProject: Project | null;
  discoveredModels?: ModelEntry[];
  initialTab?: SettingsTab;
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  const initialCompact = settings.autoCompact ?? DEFAULT_AUTO_COMPACT_SETTINGS;
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [model, setModel] = useState(settings.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(settings.reasoningEffort);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState(initialCompact.enabled);
  const [maxMessages, setMaxMessages] = useState(String(initialCompact.maxMessages));
  const [keepRecentMessages, setKeepRecentMessages] = useState(
    String(initialCompact.keepRecentMessages),
  );
  const [maxContextTokens, setMaxContextTokens] = useState(String(initialCompact.maxContextTokens));
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

      await api.updateSettings({
        model: model.trim(),
        reasoningEffort,
        autoCompact: {
          enabled: autoCompactEnabled,
          maxMessages: parsedMaxMsgs,
          keepRecentMessages: parsedKeep,
          maxContextTokens: parsedTokens,
          tailTokens: Math.min(6000, Math.max(1000, Math.round(Number(tailTokens) || 6000))),
          summarizerModel: summarizerModel.trim(),
        },
        fallbackMode,
        fallbackChain,
      });

      if (activeProject && allowFullPermissions !== activeProject.allowFullPermissions) {
        await api.updateProject(activeProject.id, { allowFullPermissions });
      }
      toast.success('Settings saved');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const checks = [
    {
      label: 'GitHub CLI (gh)',
      ok: Boolean(status?.github.authenticated),
      detail: status?.github.authenticated
        ? `Logged in as ${status.github.username || 'user'}`
        : status?.github.message || 'Optional · needed only for gh repo cloning',
    },
    {
      label: 'Active default AI provider',
      ok: true,
      detail: `${settings.provider} · ${settings.model}`,
    },
  ];

  return (
    <ModalShell
      title="Harness settings"
      subtitle="Configure AI providers, models, reasoning effort, context compaction, and permissions."
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
              { id: 'general' as SettingsTab, label: 'General' },
              { id: 'providers' as SettingsTab, label: 'Models & Providers' },
              { id: 'security' as SettingsTab, label: 'Security & Backup' },
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
        ) : activeTab === 'providers' ? (
          <ModelsProvidersPanel settings={settings} discoveredModels={discoveredModels} />
        ) : (
          <>
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
                >
                  Environment Readiness
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
                >
                  MCP connections ({settings.mcpServers.length})…
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
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>Default model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mono-num"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Effort</label>
              <Select
                ariaLabel="Effort"
                value={reasoningEffort}
                onChange={(v) => setReasoningEffort(v as ReasoningEffort)}
                options={[
                  { value: 'Low', label: 'Low' },
                  { value: 'Medium', label: 'Medium' },
                  { value: 'High', label: 'High' },
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
              <Minimize2 size={14} strokeWidth={1.5} style={{ color: 'var(--agent-amber)' }} />
              Auto-compact long conversations
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 22 }}>
              Summarizes older turns and keeps native sessions while they fit the context budget. The full conversation stays searchable.
            </div>

            {autoCompactEnabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, paddingLeft: 22 }}>
                <div>
                  <label style={labelStyle}>Trigger msgs</label>
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
                  <label style={labelStyle}>Keep recent</label>
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
                  <label style={labelStyle}>Context limit</label>
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
                </div>
                <div>
                  <label htmlFor="memory-tail-tokens" style={labelStyle}>History tail tokens</label>
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
                <div style={{ gridColumn: 'span 2' }}>
                  <label htmlFor="memory-model" style={labelStyle}>Summarizer model</label>
                  <input
                    id="memory-model"
                    value={summarizerModel}
                    placeholder="Automatic for provider"
                    maxLength={120}
                    onChange={(e) => setSummarizerModel(e.target.value)}
                    style={inputStyle}
                  />
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
                <RefreshCw size={14} strokeWidth={1.5} style={{ color: 'var(--agent-blue)' }} />
                Model fallback chain (when limit hits)
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
                    { id: 'ask' as FallbackMode, label: 'Ask me first' },
                    { id: 'auto' as FallbackMode, label: 'Auto-switch' },
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
              {fallbackMode === 'ask'
                ? 'When a provider hits rate limit or quota, pause and show a recovery card so you choose which backup model continues.'
                : 'Automatically hand off to the next healthy backup model below when rate limit, quota, or outage errors occur.'}
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
                          title="Move up"
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
                          title="Move down"
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
                          title="Remove backup"
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
                ariaLabel="Add backup model"
                value=""
                placeholder="Add backup model…"
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
                <ShieldAlert size={14} strokeWidth={1.5} style={{ color: 'var(--agent-red)' }} />
                Allow shell-enabled agents full permissions (`bypassPermissions`) in {activeProject.name}
              </label>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 22 }}>
                Per-project toggle: agents with shell execution enabled can run commands in the linked repo folder using your local user privileges.
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={primaryBtnStyle}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
          </>
        )}
      </div>
    </ModalShell>
  );
}
