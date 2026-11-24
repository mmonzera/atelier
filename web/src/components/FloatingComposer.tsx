import {
  ATTACHMENT_LIMITS,
  BUILT_IN_MODELS,
  type Agent,
  type AgentSkill,
  type McpServerConfig,
  type MessageAttachment,
  type ModelEntry,
  type Project,
  type ProviderUsageSummary,
  type ReasoningEffort,
  type Settings,
  type UsageDashboardResponse,
} from '@atelier/contracts';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  ListPlus,
  Mic,
  Minimize2,
  Paperclip,
  Plug,
  Plus,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shownModels } from '../state/models';
import { api } from '../api';
import { useMcpOAuth } from '../state/useMcpOAuth';
import { type PendingUpload, PendingAttachments } from './AttachmentViews';
import { toast } from './Toast';
import { TokenRing } from './Atoms';
import { McpIcon } from './modals/McpIcon';
import { PluginsPopover, needsAttention, setPluginAttached } from './PluginsPopover';
import { ProviderIcon } from './ProviderIcon';

interface FloatingComposerProps {
  project: Project | null;
  agent: Agent | null;
  settings: Settings;
  discoveredModels?: ModelEntry[];
  draftText: string;
  replyTo?: string | null;
  onClearReply?: () => void;
  onChangeDraft: (val: string) => void;
  onSend: (text: string, attachments?: MessageAttachment[], skillIds?: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  onUpdateReasoning: (effort: ReasoningEffort) => Promise<void>;
  onSelectModel: (entry: ModelEntry) => Promise<void>;
  onNewTask: () => void;
  onCompactContext?: () => void;
  onOpenLinkRepo: () => void;
  onOpenModels: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
}

const EFFORTS: ReasoningEffort[] = ['Low', 'Medium', 'High'];

const PROVIDER_GROUPS = [
  { key: 'claude', label: 'Claude' },
  { key: 'openai', label: 'ChatGPT' },
  { key: 'antigravity', label: 'Antigravity' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'openrouter', label: 'OpenRouter' },
  { key: 'opencode', label: 'OpenCode' },
] as const;

const PROVIDER_SHORT_LABELS: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
};

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatResetCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'resets soon';
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `resets ${days}d ${hours}h`;
  return `resets ${hours}h ${mins}m`;
}

function meterColor(pct: number | null): string {
  if (pct === null) return 'var(--agent-blue)';
  if (pct >= 90) return 'var(--agent-red)';
  if (pct >= 70) return 'var(--agent-amber)';
  return 'var(--agent-green)';
}

function MiniUsageBar({
  label,
  usedTokens,
  tokenLimit,
  percentUsed,
  resetsAt,
  isOfficial,
}: {
  label: string;
  usedTokens: number;
  tokenLimit: number | null;
  percentUsed: number | null;
  resetsAt: string | null;
  isOfficial?: boolean;
}) {
  const pct = percentUsed !== null ? Math.min(100, Math.max(0, percentUsed)) : 0;
  const resetText = formatResetCountdown(resetsAt);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div
        className="mono-num"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          fontSize: 10.5,
          color: 'var(--text-secondary)',
        }}
      >
        <span>
          {label}
          {resetText ? (
            <span style={{ color: 'var(--text-muted)', marginLeft: 5 }}>· {resetText}</span>
          ) : null}
        </span>
        <span>
          {percentUsed !== null ? `${percentUsed}%` : formatCompactTokens(usedTokens)}
          {!isOfficial && tokenLimit ? (
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}
              ({formatCompactTokens(usedTokens)}/{formatCompactTokens(tokenLimit)})
            </span>
          ) : isOfficial && usedTokens > 0 ? (
            <span style={{ color: 'var(--text-muted)' }}> · {formatCompactTokens(usedTokens)}</span>
          ) : null}
        </span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 'var(--radius-full)',
          background: 'rgba(255, 255, 255, 0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: 'var(--radius-full)',
            background: meterColor(percentUsed),
            transition: 'width 200ms var(--ease-atelier)',
          }}
        />
      </div>
    </div>
  );
}

function formatActiveModelLabel(
  settings: Settings,
  agent: Agent | null,
  allModels: ModelEntry[],
): string {
  const provider = agent?.providerOverride ?? settings.provider;
  const model = agent?.modelOverride ?? settings.model;
  const found = allModels.find((m) => m.provider === provider && m.id === model);
  if (found) return found.label;
  return model;
}

export function FloatingComposer({
  project,
  agent,
  settings,
  discoveredModels = [],
  draftText,
  replyTo = null,
  onClearReply,
  onChangeDraft,
  onSend,
  onStop,
  onUpdateReasoning,
  onSelectModel,
  onNewTask,
  onCompactContext,
  onOpenLinkRepo,
  onOpenModels,
  onOpenUsage,
  onOpenSettings,
  onOpenPlugins,
}: FloatingComposerProps) {
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [pluginsMenuOpen, setPluginsMenuOpen] = useState(false);
  const oauth = useMcpOAuth();
  const [pickedPlugins, setPickedPlugins] = useState<McpServerConfig[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [usageData, setUsageData] = useState<UsageDashboardResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [providerTab, setProviderTab] = useState<string>(agent?.providerOverride ?? settings.provider);
  const plusRef = useRef<HTMLDivElement | null>(null);
  const effortRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [pickedSkills, setPickedSkills] = useState<AgentSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  // Skills picked for one agent must not leak into a message to another.
  useEffect(() => setPickedSkills([]), [agent?.id]);

  // Typing "/" (alone, as the first word) opens the skill picker for this agent.
  const slashQuery = agent ? (/^\/(\S*)$/.exec(draftText)?.[1] ?? null) : null;
  const slashOptions =
    slashQuery === null || !agent
      ? []
      : agent.skills.filter((s) => {
          if (pickedSkills.some((p) => p.id === s.id)) return false;
          const needle = slashQuery.toLowerCase();
          return !needle || `${s.name} ${s.id} ${s.description}`.toLowerCase().includes(needle);
        });
  const slashOpen = slashQuery !== null;
  const activeSlashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));

  const pickSkill = (skill: AgentSkill) => {
    setPickedSkills((prev) => (prev.some((p) => p.id === skill.id) ? prev : [...prev, skill].slice(0, 5)));
    onChangeDraft('');
    setSlashIndex(0);
    inputRef.current?.focus();
  };

  // Plugins picked with "@" belong to one agent's message, like skills.
  useEffect(() => setPickedPlugins([]), [agent?.id]);

  // Typing "@" (at the start of a word, at the end of the draft) opens the plugin picker.
  const mentionQuery = agent ? (/(?:^|\s)@(\S*)$/.exec(draftText)?.[1] ?? null) : null;
  const mentionOptions =
    mentionQuery === null
      ? []
      : settings.mcpServers.filter((s) => {
          if (!s.enabled || needsAttention(s, oauth.status)) return false;
          if (pickedPlugins.some((p) => p.id === s.id)) return false;
          const needle = mentionQuery.toLowerCase();
          return !needle || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle);
        });
  const mentionOpen = mentionQuery !== null && !slashOpen;
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionOptions.length - 1));

  const pickPlugin = (server: McpServerConfig) => {
    setPickedPlugins((prev) => (prev.some((p) => p.id === server.id) ? prev : [...prev, server].slice(0, 5)));
    onChangeDraft(draftText.replace(/(^|\s)@\S*$/, '$1'));
    setMentionIndex(0);
    inputRef.current?.focus();
  };

  const addFiles = async (incoming: File[]) => {
    if (!agent || incoming.length === 0) return;
    const room = ATTACHMENT_LIMITS.maxFiles - pending.length;
    if (room <= 0) {
      toast.error(`Maksimal ${ATTACHMENT_LIMITS.maxFiles} lampiran per pesan.`);
      return;
    }
    const accepted: File[] = [];
    for (const f of incoming.slice(0, room)) {
      if (f.size > ATTACHMENT_LIMITS.maxFileBytes) {
        toast.error(`"${f.name}" lebih dari ${ATTACHMENT_LIMITS.maxFileBytes / 1048576} MB.`);
      } else if (f.size === 0) {
        toast.error(`"${f.name}" kosong.`);
      } else {
        accepted.push(f);
      }
    }
    if (incoming.length > room) toast.error(`Hanya ${room} file lagi yang muat; sisanya dilewati.`);
    if (accepted.length === 0) return;

    const entries: PendingUpload[] = accepted.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      name: f.name || 'pasted-image.png',
      size: f.size,
      isImage: f.type.startsWith('image/'),
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      status: 'uploading',
    }));
    setPending((prev) => [...prev, ...entries]);
    try {
      const { attachments } = await api.uploadAttachments(accepted);
      setPending((prev) =>
        prev.map((p) => {
          const idx = entries.findIndex((e) => e.key === p.key);
          return idx >= 0 ? { ...p, status: 'done', attachment: attachments[idx] } : p;
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload gagal';
      toast.error(message);
      setPending((prev) => prev.map((p) => (entries.some((e) => e.key === p.key) ? { ...p, status: 'error', error: message } : p)));
    }
  };

  const removePending = (key: string) => {
    setPending((prev) => {
      const item = prev.find((p) => p.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item?.attachment) void api.deleteAttachment(item.attachment.id).catch(() => undefined);
      return prev.filter((p) => p.key !== key);
    });
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  useEffect(() => {
    if (!effortMenuOpen) return;
    api
      .getUsage('7d')
      .then(setUsageData)
      .catch(() => null);
  }, [effortMenuOpen]);

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

  // What the picker lists: only the models chosen in Models & Providers (the active one stays).
  const pickerModels = useMemo(
    () =>
      shownModels(allModels, settings, {
        provider: agent?.providerOverride,
        model: agent?.modelOverride,
      }),
    [allModels, settings, agent?.providerOverride, agent?.modelOverride],
  );

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
        setPluginsMenuOpen(false);
      }
      if (effortRef.current && !effortRef.current.contains(e.target as Node)) {
        setEffortMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  const attentionCount = settings.mcpServers.filter((s) => needsAttention(s, oauth.status)).length;
  const hintParts = [
    agent && agent.skills.length > 0 ? '/ for skills' : null,
    settings.mcpServers.length > 0 ? '@ for plugins' : null,
  ].filter(Boolean);
  const placeholderHint = hintParts.length > 0 ? ` (type ${hintParts.join(', ')})` : '';
  const isWorking = agent?.status === 'working';
  const doneAttachments = pending.filter((p) => p.status === 'done' && p.attachment);
  const uploading = pending.some((p) => p.status === 'uploading');
  const canSubmit = Boolean(
    agent && (draftText.trim() || doneAttachments.length > 0 || pickedPlugins.length > 0) && !uploading && !sending,
  );

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!agent) return;
    const text = draftText.trim();
    if (!text && doneAttachments.length === 0 && pickedPlugins.length === 0) return;
    if (uploading) return;
    setSending(true);
    try {
      onChangeDraft('');
      const sent = doneAttachments.map((p) => p.attachment!);
      // composer is cleared; the sent files now belong to the message
      setPending((prev) => {
        for (const p of prev) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        return [];
      });
      const skillIds = pickedSkills.map((s) => s.id);
      setPickedSkills([]);
      // plugins called with "@": make sure the agent can use them, then name them in the message
      const plugins = pickedPlugins;
      setPickedPlugins([]);
      for (const plugin of plugins) {
        if (agent.mcpServerIds?.includes(plugin.id) && plugin.enabled) continue;
        try {
          await setPluginAttached(agent, plugin, true);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Could not attach ${plugin.name}`);
        }
      }
      const finalText = plugins.length
        ? `${plugins.map((p) => `@${p.name}`).join(' ')} ${text}`.trim()
        : text;
      await onSend(finalText, sent.length > 0 ? sent : undefined, skillIds.length > 0 ? skillIds : undefined);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const scopeKey = project?.id ?? 'direct';
  const autoCompact = settings.autoCompact ?? {
    enabled: true,
    maxMessages: 20,
    keepRecentMessages: 6,
    maxContextTokens: 40000,
  };
  const contextTokens = agent
    ? (agent.scopeTokens?.[scopeKey] ?? agent.tokenUsage.input)
    : 0;
  const contextPct = agent
    ? Math.min(
        100,
        Math.max(contextTokens > 0 ? 2 : 0, (contextTokens / autoCompact.maxContextTokens) * 100),
      )
    : 0;
  const outputPct = agent
    ? Math.min(100, Math.max(agent.tokenUsage.output > 0 ? 1 : 0, (agent.tokenUsage.output / 4000) * 100))
    : 0;

  const selectedProviderUsage: ProviderUsageSummary | null =
    usageData?.providers.find((p) => p.provider === providerTab) ?? null;

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 650,
        margin: '0 auto',
        paddingTop: 10,
        flexShrink: 0,
        zIndex: 15,
        position: 'relative',
      }}
      onDragOver={(e) => {
        if (!agent || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <PendingAttachments items={pending} onRemove={removePending} />
      {pickedSkills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 6px 6px' }}>
          {pickedSkills.map((skill) => (
            <span
              key={skill.id}
              title={skill.description || skill.name}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 6px 3px 9px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              <Sparkles size={12} strokeWidth={1.5} style={{ color: 'var(--agent-purple)' }} />
              {skill.name}
              <button
                type="button"
                aria-label={`Remove skill ${skill.name}`}
                onClick={() => setPickedSkills((prev) => prev.filter((p) => p.id !== skill.id))}
                style={{ display: 'inline-flex', color: 'var(--text-tertiary)' }}
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </span>
          ))}
        </div>
      )}
      {pickedPlugins.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 6px 6px' }}>
          {pickedPlugins.map((plugin) => (
            <span
              key={plugin.id}
              title={plugin.description || plugin.name}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 6px 3px 5px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              <McpIcon presetId={plugin.presetId} name={plugin.name} size={18} />
              {plugin.name}
              <button
                type="button"
                aria-label={`Remove plugin ${plugin.name}`}
                onClick={() => setPickedPlugins((prev) => prev.filter((p) => p.id !== plugin.id))}
                style={{ display: 'inline-flex', color: 'var(--text-tertiary)' }}
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {replyTo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '4px 14px 6px',
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Replying to: {replyTo}
          </span>
          {onClearReply && (
            <button type="button" onClick={onClearReply} style={{ color: 'var(--text-muted)' }}>
              Clear
            </button>
          )}
        </div>
      )}
      <form
        onSubmit={handleSubmit}
        style={{
          height: 52,
          borderRadius: 'var(--radius-full)',
          background: 'var(--surface-1)',
          border: dragging ? '1px dashed var(--text-secondary)' : '1px solid var(--border-subtle)',
          padding: '4px 4px 4px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          position: 'relative',
        }}
      >
        {slashOpen && (
          <div
            role="listbox"
            aria-label="Skills"
            className="popover-shadow"
            style={{
              position: 'absolute',
              bottom: 58,
              left: 0,
              right: 0,
              maxHeight: 260,
              overflowY: 'auto',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: 6,
              zIndex: 60,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {slashOptions.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                {agent && agent.skills.length === 0
                  ? 'No skills installed. Add some in Edit agent.'
                  : 'No matching skill.'}
              </div>
            ) : (
              slashOptions.map((skill, index) => (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSkill(skill)}
                  onMouseEnter={() => setSlashIndex(index)}
                  className="transition-atelier"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    textAlign: 'left',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: index === activeSlashIndex ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  <Sparkles size={15} strokeWidth={1.5} style={{ color: 'var(--agent-purple)', marginTop: 2, flexShrink: 0 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                      {skill.name}
                      {!skill.enabled && <span style={{ color: 'var(--text-muted)' }}> · off</span>}
                    </span>
                    {skill.description && (
                      <span
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {mentionOpen && (
          <div
            role="listbox"
            aria-label="Plugins"
            className="popover-shadow"
            style={{
              position: 'absolute',
              bottom: 58,
              left: 0,
              right: 0,
              maxHeight: 260,
              overflowY: 'auto',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: 6,
              zIndex: 60,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {mentionOptions.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                {settings.mcpServers.length === 0
                  ? 'No plugins yet. Add some from the + menu → Plugins.'
                  : 'No matching plugin ready to use.'}
              </div>
            ) : (
              mentionOptions.map((server, index) => (
                <button
                  key={server.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickPlugin(server)}
                  onMouseEnter={() => setMentionIndex(index)}
                  className="transition-atelier"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: index === activeMentionIndex ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  <McpIcon presetId={server.presetId} name={server.name} size={24} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{server.name}</span>
                    {server.description && (
                      <span
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {server.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        <div ref={plusRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            disabled={!agent && !project}
            onClick={() => {
              setPlusMenuOpen((v) => !v);
              setPluginsMenuOpen(false);
            }}
            title="Quick actions"
            className="transition-atelier"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-full)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: agent || project ? 'var(--text-secondary)' : 'var(--text-muted)',
            }}
            onMouseEnter={(e) => {
              if (agent || project) {
                e.currentTarget.style.background = 'var(--surface-3)';
                e.currentTarget.style.color = 'var(--text-primary)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = agent || project ? 'var(--text-secondary)' : 'var(--text-muted)';
            }}
          >
            <Plus size={18} strokeWidth={1.5} />
          </button>

          {plusMenuOpen && (agent || project) && (
            <div
              className="popover-shadow"
              style={{
                position: 'absolute',
                bottom: 44,
                left: 0,
                width: 250,
                background: 'var(--surface-1)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                padding: 6,
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {/* Chat-only actions; agent, MCP and repo settings live in the header menu. */}
              {[
                ...(agent
                  ? [{ label: 'Attach file or image', icon: Paperclip, action: () => fileInputRef.current?.click() }]
                  : []),
                ...(project ? [{ label: 'New task', icon: ListPlus, action: onNewTask }] : []),
                ...(agent && onCompactContext && !isWorking
                  ? [{ label: 'Compact context now', icon: Minimize2, action: onCompactContext }]
                  : []),
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    item.action();
                  }}
                  className="transition-atelier"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12.5,
                    color: 'var(--text-primary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--surface-3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <item.icon size={15} strokeWidth={1.5} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                  {item.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setPluginsMenuOpen((v) => !v)}
                className="transition-atelier"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12.5,
                  color: 'var(--text-primary)',
                  background: pluginsMenuOpen ? 'var(--surface-3)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface-3)';
                }}
                onMouseLeave={(e) => {
                  if (!pluginsMenuOpen) e.currentTarget.style.background = 'transparent';
                }}
              >
                <Plug size={15} strokeWidth={1.5} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>Plugins</span>
                {attentionCount > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {attentionCount} needs attention
                  </span>
                )}
                <ChevronRight size={14} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
              </button>

              {pluginsMenuOpen && (
                <div style={{ position: 'absolute', left: 'calc(100% + 6px)', bottom: 0 }}>
                  <PluginsPopover
                    agent={agent}
                    settings={settings}
                    oauth={oauth}
                    onManage={() => {
                      setPlusMenuOpen(false);
                      setPluginsMenuOpen(false);
                      onOpenPlugins();
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            width: 1,
            height: 18,
            background: 'var(--border-subtle)',
            flexShrink: 0,
          }}
        />

        <input
          ref={inputRef}
          type="text"
          value={draftText}
          disabled={!agent}
          onChange={(e) => {
            setSlashIndex(0);
            setMentionIndex(0);
            onChangeDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && mentionOptions.length > 0) {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setMentionIndex((activeMentionIndex + step + mentionOptions.length) % mentionOptions.length);
              } else if ((e.key === 'Enter' || e.key === 'Tab') && mentionOptions.length > 0) {
                e.preventDefault();
                pickPlugin(mentionOptions[activeMentionIndex]!);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onChangeDraft(draftText.replace(/(^|\s)@\S*$/, '$1'));
              }
              return;
            }
            if (!slashOpen) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (slashOptions.length === 0) return;
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setSlashIndex((activeSlashIndex + step + slashOptions.length) % slashOptions.length);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && slashOptions.length > 0) {
              e.preventDefault();
              pickSkill(slashOptions[activeSlashIndex]!);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onChangeDraft('');
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={
            agent
              ? project
                ? `Message ${agent.name}...${placeholderHint}`
                : `Message ${agent.name} directly...${placeholderHint}`
              : 'Create or select an agent to start...'
          }
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 13.5,
            lineHeight: '20px',
            color: 'var(--text-primary)',
          }}
        />

        {agent && agent.queueLength > 0 && (
          <span
            className="mono-num"
            style={{
              fontSize: 11,
              color: 'var(--agent-amber)',
              padding: '2px 7px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.queueLength} queued
          </span>
        )}

        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          title="Focus input"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-full)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          <Mic size={16} strokeWidth={1.5} />
        </button>

        {isWorking && !draftText.trim() ? (
          <button
            type="button"
            onClick={() => void onStop()}
            title="Stop active agent"
            className="transition-atelier"
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-full)',
              background: 'var(--action-primary)',
              color: 'var(--action-primary-fg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Square size={14} strokeWidth={1.5} fill="var(--action-primary-fg)" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSubmit}
            title={isWorking ? 'Queue message (FIFO)' : 'Send message'}
            className="transition-atelier"
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-full)',
              background: canSubmit ? 'var(--action-primary)' : 'var(--surface-3)',
              color: canSubmit ? 'var(--action-primary-fg)' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: canSubmit ? 'pointer' : 'default',
            }}
          >
            <ArrowUp size={17} strokeWidth={1.75} />
          </button>
        )}
      </form>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px 2px',
          fontSize: 12,
          lineHeight: '16px',
          color: 'var(--text-faint)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          {project ? (
            <>
              <button
                type="button"
                onClick={onOpenLinkRepo}
                className="transition-atelier"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                }}
              >
                <Folder size={13} strokeWidth={1.5} />
                <span>{project.repo?.fullName ?? 'No repo checkout'}</span>
              </button>

              <button
                type="button"
                onClick={onOpenLinkRepo}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                }}
              >
                <GitBranch size={13} strokeWidth={1.5} />
                <span>{project.repo?.defaultBranch ?? 'main'}</span>
                <ChevronDown size={12} strokeWidth={1.5} />
              </button>
            </>
          ) : (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
            >
              <Folder size={13} strokeWidth={1.5} />
              <span>Direct · Scratch workspace</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div ref={effortRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => {
                setProviderTab(agent?.providerOverride ?? settings.provider);
                setEffortMenuOpen((v) => !v);
              }}
              className="transition-atelier"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 'var(--radius-full)',
                color: 'var(--text-secondary)',
                background: effortMenuOpen ? 'var(--surface-2)' : 'transparent',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!effortMenuOpen) e.currentTarget.style.background = 'transparent';
              }}
            >
              <ProviderIcon provider={agent?.providerOverride ?? settings.provider} size={13} />
              <span>{formatActiveModelLabel(settings, agent, allModels)}</span>
              <span style={{ color: 'var(--text-faint)' }}>{settings.reasoningEffort}</span>
              <ChevronDown size={12} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
            </button>

            {effortMenuOpen && (
              <div
                className="glass glass-agent msg-enter popover-shadow"
                style={{
                  position: 'absolute',
                  bottom: 32,
                  right: 0,
                  width: 348,
                  borderRadius: 20,
                  padding: 10,
                  zIndex: 50,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  background: 'rgba(22, 22, 29, 0.96)',
                  transformOrigin: 'bottom right',
                }}
              >
                {/* Provider tabs: 3 top, 2 bottom with trailing empty slot */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                    gap: 3,
                    padding: 3,
                    borderRadius: 14,
                    background: 'rgba(0, 0, 0, 0.28)',
                  }}
                >
                  {PROVIDER_GROUPS.map((group) => {
                    const count = pickerModels.filter((m) => m.provider === group.key).length;
                    if (count === 0) return null;
                    const on = providerTab === group.key;
                    return (
                      <button
                        key={group.key}
                        type="button"
                        onClick={() => setProviderTab(group.key)}
                        className="transition-atelier"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 5,
                          height: 26,
                          padding: '0 8px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: 11.5,
                          fontWeight: on ? 500 : 400,
                          whiteSpace: 'nowrap',
                          color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                          background: on ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                          boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,0.14)' : 'none',
                        }}
                      >
                        <ProviderIcon provider={group.key} size={13} active={on} />
                        <span>{group.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Models of the selected provider */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    maxHeight: 196,
                    overflowY: 'auto',
                  }}
                >
                  {pickerModels
                    .filter((m) => m.provider === providerTab)
                    .map((m) => {
                      const active =
                        (agent?.providerOverride ?? settings.provider) === m.provider &&
                        (agent?.modelOverride ?? settings.model) === m.id;
                      return (
                        <button
                          key={`${m.provider}:${m.id}`}
                          type="button"
                          onClick={() => {
                            setEffortMenuOpen(false);
                            void onSelectModel(m);
                          }}
                          className="transition-atelier"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            textAlign: 'left',
                            padding: '8px 10px',
                            borderRadius: 12,
                            fontSize: 13,
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                            background: active ? 'rgba(255, 255, 255, 0.09)' : 'transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                          }}
                          onMouseLeave={(e) => {
                            if (!active) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <span style={{ flex: 1, minWidth: 0 }}>{m.label}</span>
                          {active && (
                            <Check size={15} strokeWidth={2} style={{ color: 'var(--agent-green)' }} />
                          )}
                        </button>
                      );
                    })}
                </div>

                {/* Rolling 5h & Weekly limit usage or provider balance */}
                {selectedProviderUsage && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 12,
                      background: 'rgba(0, 0, 0, 0.28)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 7,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {PROVIDER_SHORT_LABELS[providerTab] ?? providerTab} Usage
                        {selectedProviderUsage.sourceLabel ? (
                          <span
                            style={{
                              marginLeft: 5,
                              textTransform: 'none',
                              letterSpacing: 0,
                              fontWeight: 400,
                              color: 'var(--text-tertiary)',
                            }}
                          >
                            · {selectedProviderUsage.sourceLabel}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setEffortMenuOpen(false);
                          onOpenUsage();
                        }}
                        style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}
                      >
                        Full report ↗
                      </button>
                    </div>

                    {selectedProviderUsage.supportsRollingWindows ? (
                      <>
                        <MiniUsageBar
                          label={selectedProviderUsage.fiveHour.isOfficial ? '5h limit' : 'Est. 5h'}
                          usedTokens={selectedProviderUsage.fiveHour.usedTokens}
                          tokenLimit={selectedProviderUsage.fiveHour.tokenLimit}
                          percentUsed={selectedProviderUsage.fiveHour.percentUsed}
                          resetsAt={selectedProviderUsage.fiveHour.resetsAt}
                          isOfficial={selectedProviderUsage.fiveHour.isOfficial}
                        />
                        <MiniUsageBar
                          label={selectedProviderUsage.weekly.isOfficial ? 'Weekly limit' : 'Est. Weekly'}
                          usedTokens={selectedProviderUsage.weekly.usedTokens}
                          tokenLimit={selectedProviderUsage.weekly.tokenLimit}
                          percentUsed={selectedProviderUsage.weekly.percentUsed}
                          resetsAt={selectedProviderUsage.weekly.resetsAt}
                          isOfficial={selectedProviderUsage.weekly.isOfficial}
                        />
                      </>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <div
                          className="mono-num"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <span>
                            7d: {formatCompactTokens(selectedProviderUsage.totalTokens)} tokens ($
                            {selectedProviderUsage.estimatedCostUsd.toFixed(2)})
                          </span>
                          {selectedProviderUsage.liveBalance && (
                            <span
                              style={{
                                color: selectedProviderUsage.liveBalance.available
                                  ? 'var(--agent-green)'
                                  : 'var(--agent-red)',
                              }}
                            >
                              {selectedProviderUsage.liveBalance.label}
                            </span>
                          )}
                        </div>
                        {selectedProviderUsage.limit && (
                          <MiniUsageBar
                            label={`${selectedProviderUsage.limit.period} cap`}
                            usedTokens={selectedProviderUsage.limitWindowTokens}
                            tokenLimit={selectedProviderUsage.limit.tokenLimit}
                            percentUsed={selectedProviderUsage.percentUsed}
                            resetsAt={null}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Effort: segmented control with sliding thumb */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                    Effort
                  </span>
                  <div
                    style={{
                      position: 'relative',
                      flex: 1,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      padding: 3,
                      borderRadius: 'var(--radius-full)',
                      background: 'rgba(0, 0, 0, 0.28)',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        top: 3,
                        bottom: 3,
                        left: 3,
                        width: 'calc((100% - 6px) / 3)',
                        borderRadius: 'var(--radius-full)',
                        background: 'rgba(255, 255, 255, 0.14)',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16)',
                        transform: `translateX(${Math.max(0, EFFORTS.indexOf(settings.reasoningEffort)) * 100}%)`,
                        transition: 'transform 260ms cubic-bezier(0.34, 1.4, 0.64, 1)',
                      }}
                    />
                    {EFFORTS.map((eff) => (
                      <button
                        key={eff}
                        type="button"
                        onClick={() => {
                          void onUpdateReasoning(eff);
                        }}
                        style={{
                          position: 'relative',
                          height: 24,
                          fontSize: 11.5,
                          color:
                            settings.reasoningEffort === eff
                              ? 'var(--text-primary)'
                              : 'var(--text-tertiary)',
                        }}
                      >
                        {eff}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setEffortMenuOpen(false);
                      onOpenModels();
                    }}
                    style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}
                  >
                    Models & Providers
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEffortMenuOpen(false);
                      onOpenSettings();
                    }}
                    style={{ fontSize: 12, color: 'var(--text-tertiary)' }}
                  >
                    Harness Settings
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={!agent || isWorking || !onCompactContext}
            onClick={() => onCompactContext?.()}
            style={{ display: 'inline-flex', alignItems: 'center', cursor: agent && !isWorking ? 'pointer' : 'default' }}
          >
            <TokenRing
              percent={contextPct}
              label={`Context: ${contextTokens.toLocaleString()} / ${autoCompact.maxContextTokens.toLocaleString()} tokens · Auto-compact ${autoCompact.enabled ? 'ON' : 'OFF'}${agent && !isWorking ? ' (click to compact)' : ''}`}
            />
          </button>
          <TokenRing percent={outputPct} label={`Output tokens: ${agent?.tokenUsage.output ?? 0}`} />
        </div>
      </div>
    </div>
  );
}
