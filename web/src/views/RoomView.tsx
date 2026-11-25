import { useT } from '../i18n';
import {
  BUILT_IN_MODELS,
  parseMessageSegments,
  stripAtelierActions,
  type Activity,
  type Agent,
  type BrowserApprovalRequest,
  type BrowserSessionInfo,
  type BrowserTakeoverEvent,
  type Channel,
  type Message,
  type ModelEntry,
  type ModelProvider,
  type Project,
  type RoomQueueSnapshot,
  type RoomSession,
  type Settings,
  type Task,
} from '@atelier/contracts';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  Minimize2,
  RefreshCw,
  Reply,
  RotateCcw,
  SkipForward,
  Sparkles,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { MemoryChip } from '../components/MemoryChip';
import { FormattedText, getColorVar } from '../components/Atoms';
import { MessageAttachments, isAttachmentOnlyText } from '../components/AttachmentViews';
import { WorkPointsChecklist } from '../components/ChatWorkPanel';
import { DesignOptionsCard, DesignPendingCard } from '../components/DesignOptionsCard';
import { ProviderIcon } from '../components/ProviderIcon';
import { QaReportCard } from '../components/QaReportCard';
import { BotMascot } from '../components/mascot/BotMascot';

interface RoomViewProps {
  project: Project;
  channel: Channel;
  agents: Agent[];
  messages: Message[];
  sessions: RoomSession[];
  queue?: RoomQueueSnapshot | null;
  activities: Activity[];
  tasks: Task[];
  settings?: Settings;
  discoveredModels?: ModelEntry[];
  onReplyMessage: (msg: Message) => void;
  onQuickSend: (text: string) => Promise<void>;
  onSkipTurn: () => Promise<void>;
  onStopRoom: () => Promise<void>;
  onContinueChain: (rootMessageId: string) => Promise<void>;
  onApproveAction: (messageId: string) => Promise<void>;
  onReorderQueue: (order: string[]) => Promise<void>;
  onRetryAgent: (
    agentId: string,
    opts?: { provider?: ModelProvider; model?: string; makeDefault?: boolean },
  ) => Promise<void>;
  onCreateTaskFromReply?: (description: string) => void;
  onOpenTask: (task: Task) => void;
  browserApprovals?: BrowserApprovalRequest[];
  browserTakeovers?: Record<string, BrowserTakeoverEvent>;
  browserSessions?: BrowserSessionInfo[];
}

type FilterKey = 'all' | 'tasks' | string;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatShortModelName(provider: ModelProvider, modelId: string): string {
  const found = BUILT_IN_MODELS.find((m) => m.provider === provider && m.id === modelId);
  if (found) return found.label;
  return modelId.split('/').pop() ?? modelId;
}

function renderMentionText(text: string, agents: Agent[]): React.ReactNode {
  if (!text.includes('@')) return text;
  const named = [...agents]
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const escaped = named.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const tokenAlternation = [...escaped, 'all', 'semua'].join('|');
  const re = new RegExp(`(^|\\s)(@(?:${tokenAlternation}))(?=$|[\\s.,!?:;)])`, 'gi');
  const byLower = new Map(named.map((a) => [a.name.toLowerCase(), a]));
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = re.exec(text)) !== null) {
    const lead = match[1] ?? '';
    const mention = match[2] ?? '';
    const start = match.index + lead.length;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));
    const target = byLower.get(mention.slice(1).toLowerCase());
    parts.push(
      <span
        key={`rm-${keyIdx++}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 6px',
          borderRadius: 'var(--radius-full)',
          background: 'rgba(255, 255, 255, 0.08)',
          border: '1px solid var(--border-subtle)',
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '9999px',
            background: target ? getColorVar(target.color) : 'var(--action-primary)',
            flexShrink: 0,
          }}
        />
        {mention}
      </span>,
    );
    lastIdx = start + mention.length;
  }
  if (lastIdx === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

export function RoomView({
  project,
  channel,
  agents,
  messages,
  sessions,
  queue,
  activities,
  tasks,
  onReplyMessage,
  onQuickSend,
  onSkipTurn,
  onStopRoom,
  onContinueChain,
  onApproveAction,
  onReorderQueue,
  onRetryAgent,
  onCreateTaskFromReply,
  onOpenTask,
}: RoomViewProps) {
  const tr = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedWorkIds, setExpandedWorkIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [oldestRowid, setOldestRowid] = useState<number | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setOlderMessages([]);
    setOldestRowid(null);
    setHasMoreOlder(false);
    setFilter('all');
    let cancelled = false;
    api
      .listChannelMessages(channel.id, { limit: 100 })
      .then((res) => {
        if (cancelled) return;
        setOldestRowid(res.oldestRowid);
        setHasMoreOlder(res.hasMore);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  const loadOlder = async () => {
    if (!oldestRowid || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api.listChannelMessages(channel.id, {
        beforeRowid: oldestRowid,
        limit: 100,
      });
      setOlderMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...res.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      setOldestRowid(res.oldestRowid);
      setHasMoreOlder(res.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  };

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const roomMessages = useMemo(() => {
    const live = messages.filter(
      (m) => m.channelId === channel.id || (!m.channelId && m.projectId === project.id),
    );
    const seen = new Set(live.map((m) => m.id));
    const merged = [...olderMessages.filter((m) => !seen.has(m.id)), ...live];
    return merged;
  }, [messages, olderMessages, channel.id, project.id]);

  const filteredMessages = useMemo(() => {
    if (filter === 'all') return roomMessages;
    if (filter === 'tasks') {
      return roomMessages.filter(
        (m) =>
          m.metadata?.event?.kind === 'task_created' ||
          m.metadata?.event?.kind === 'task_status' ||
          Boolean(m.metadata?.taskId),
      );
    }
    return roomMessages.filter((m) => {
      if (m.agentId === filter) return true;
      if (m.metadata?.mentions?.includes(filter) || m.metadata?.toAgentIds?.includes(filter)) {
        return true;
      }
      if (m.metadata?.replyToMessageId) {
        const ref = roomMessages.find((x) => x.id === m.metadata?.replyToMessageId);
        if (ref?.agentId === filter) return true;
      }
      return false;
    });
  }, [roomMessages, filter]);

  const msgById = useMemo(() => new Map(roomMessages.map((m) => [m.id, m])), [roomMessages]);
  const savedDesignPicks = useMemo(() => {
    const picks = new Map<string, string>();
    for (const m of roomMessages) {
      const p = m.metadata?.designPick;
      if (!p) continue;
      picks.set(`${p.messageId}:${p.segmentIndex ?? -1}`, p.optionId);
    }
    return picks;
  }, [roomMessages]);

  const lastMsg = filteredMessages[filteredMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filteredMessages.length, lastMsg?.text, lastMsg?.streaming]);

  const activeTurnAgent = queue?.activeAgentId
    ? agentById.get(queue.activeAgentId) ?? agents.find((a) => a.status === 'working')
    : agents.find((a) => a.status === 'working');
  const nextQueuedAgent = queue?.queued[0] ? agentById.get(queue.queued[0].agentId) : undefined;
  const erroredAgents = agents.filter((a) => a.status === 'error' && a.lastError);

  const toggleWork = (id: string, defaultExpanded = false) => {
    setExpandedWorkIds((prev) => ({ ...prev, [id]: !(prev[id] ?? defaultExpanded) }));
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400);
    } catch {
      // ignore
    }
  };

  const suggestions = [
    tr('Review open tasks in this project and propose an execution plan'),
    tr('Inspect the workspace repository and summarize what exists so far'),
    tr('@all Introduce yourselves and list what each of you owns'),
  ];

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: 710,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Filter chips + serial queue bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '0 22px 8px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: tr('All') },
            ...agents.map((a) => ({ key: a.id, label: a.name, color: a.color })),
            { key: 'tasks', label: tr('Task events') },
          ].map((chip) => {
            const active = filter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilter(chip.key)}
                className="transition-atelier"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 11.5,
                  background: active ? 'var(--surface-2)' : 'transparent',
                  border: active ? '1px solid var(--border-default)' : '1px solid var(--border-subtle)',
                  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
              >
                {'color' in chip && chip.color && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '9999px',
                      background: getColorVar(chip.color),
                    }}
                  />
                )}
                {chip.label}
              </button>
            );
          })}
        </div>

        {(activeTurnAgent || (queue?.queued.length ?? 0) > 0) && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '3px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              fontSize: 11.5,
              color: 'var(--text-secondary)',
            }}
          >
            {activeTurnAgent && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '9999px',
                    background: getColorVar(activeTurnAgent.color),
                  }}
                />
                {activeTurnAgent.name} {tr('working')}
              </span>
            )}
            {nextQueuedAgent && (
              <span style={{ color: 'var(--text-tertiary)' }}>
                · {tr('next:')} {nextQueuedAgent.name}
                {(queue?.queued.length ?? 0) > 1 ? ` (+${queue!.queued.length - 1})` : ''}
              </span>
            )}
            {queue && queue.queued.length > 1 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {queue.queued.map((q, i) => {
                  const qa = agentById.get(q.agentId);
                  const move = (delta: number) => {
                    const order = queue.queued.map((x) => x.queueItemId);
                    const j = i + delta;
                    if (j < 0 || j >= order.length) return;
                    [order[i], order[j]] = [order[j]!, order[i]!];
                    void onReorderQueue(order);
                  };
                  return (
                    <span
                      key={q.queueItemId}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        padding: '0 5px',
                        borderRadius: 'var(--radius-full)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 11,
                      }}
                    >
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => move(-1)}
                        title={tr('Move earlier')}
                        style={{ opacity: i === 0 ? 0.3 : 1 }}
                      >
                        ‹
                      </button>
                      {qa?.name ?? tr('Agent')}
                      <button
                        type="button"
                        disabled={i === queue.queued.length - 1}
                        onClick={() => move(1)}
                        title={tr('Move later')}
                        style={{ opacity: i === queue.queued.length - 1 ? 0.3 : 1 }}
                      >
                        ›
                      </button>
                    </span>
                  );
                })}
              </span>
            )}
            {activeTurnAgent && (
              <button
                type="button"
                onClick={() => void onSkipTurn()}
                title={tr('Skip current turn')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                }}
              >
                <SkipForward size={11} /> {tr('Skip')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void onStopRoom()}
              title={tr('Stop room')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                color: 'var(--agent-red)',
                fontSize: 11,
              }}
            >
              <Square size={10} fill="var(--agent-red)" /> {tr('Stop')}
            </button>
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="chat-scroll-hide"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {hasMoreOlder && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
              style={{
                padding: '5px 12px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                fontSize: 11.5,
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <ArrowUp size={12} />
              {loadingOlder ? tr('Loading…') : tr('Load older messages')}
            </button>
          </div>
        )}

        {filteredMessages.length === 0 ? (
          <div
            style={{
              marginTop: 'auto',
              marginBottom: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 14,
              padding: '28px 0',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>
              {project.name} · {tr('Team room')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 460 }}>
              {tr('All agents in this project share this room. Mention @AgentName to address someone directly, or write normally for the default responder.')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void onQuickSend(s)}
                  className="glass glass-agent transition-atelier"
                  style={{
                    textAlign: 'left',
                    padding: '9px 13px',
                    borderRadius: 12,
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                    maxWidth: 300,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          filteredMessages.map((msg) => {
            if (msg.author === 'system') {
              const ev = msg.metadata?.event;
              if (ev?.kind === 'session_started') {
                const open = Boolean(expandedWorkIds[msg.id]);
                return (
                  <div
                    key={msg.id}
                    className="msg-enter"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, margin: '6px 0' }}
                  >
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                      <button
                        type="button"
                        onClick={() => toggleWork(msg.id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--surface-1)',
                          border: '1px solid var(--border-subtle)',
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        <RotateCcw size={11} style={{ color: 'var(--agent-blue)' }} />
                        <span>
                          {tr('Session')} {ev.seq} · {formatTime(msg.createdAt)}
                        </span>
                        {ev.carryoverSummary &&
                          (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
                      </button>
                      <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                    </div>
                    {open && ev.carryoverSummary && (
                      <div
                        className="glass glass-agent glass-soft"
                        style={{
                          width: '100%',
                          borderRadius: 12,
                          padding: '10px 14px',
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {ev.carryoverSummary}
                      </div>
                    )}
                  </div>
                );
              }

              if (msg.metadata?.compacted) {
                const open = Boolean(expandedWorkIds[msg.id]);
                return (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => toggleWork(msg.id)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      <Minimize2 size={11} style={{ color: 'var(--agent-amber)' }} />
                      <span>{tr('Context compacted')}</span>
                      {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                    {open && (
                      <div
                        className="glass glass-agent glass-soft"
                        style={{
                          width: '100%',
                          borderRadius: 12,
                          padding: '10px 14px',
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {msg.text}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={msg.id}
                  className="msg-enter"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '6px 12px',
                    borderRadius: 12,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>{msg.text}</span>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {msg.metadata?.approvalRequest && (
                      msg.metadata.approvalRequest.approved ? (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tr('Approved')}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onApproveAction(msg.id)}
                          style={{
                            padding: '3px 9px',
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--action-primary)',
                            color: 'var(--action-primary-fg)',
                            fontSize: 11.5,
                            fontWeight: 500,
                          }}
                        >
                          {tr('Allow once')}
                        </button>
                      )
                    )}
                    {ev?.kind === 'chain_budget' && !ev.warningOnly && (
                      <button
                        type="button"
                        onClick={() => void onContinueChain(ev.rootMessageId)}
                        style={{
                          padding: '3px 9px',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--action-primary)',
                          color: 'var(--action-primary-fg)',
                          fontSize: 11.5,
                          fontWeight: 500,
                        }}
                      >
                        {tr('Continue +6 turns')}
                      </button>
                    )}
                    {msg.metadata?.taskId && (
                      <button
                        type="button"
                        onClick={() => {
                          const t = tasks.find((x) => x.id === msg.metadata?.taskId);
                          if (t) onOpenTask(t);
                        }}
                        style={{ fontSize: 11, color: 'var(--agent-blue)' }}
                      >
                        {msg.metadata.taskIdentifier ?? tr('View task')}
                      </button>
                    )}
                    <span className="mono-num" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {formatTime(msg.createdAt)}
                    </span>
                  </div>
                </div>
              );
            }

            if (msg.author === 'user') {
              const quoted = msg.metadata?.replyToMessageId
                ? msgById.get(msg.metadata.replyToMessageId)
                : undefined;
              return (
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'flex-end' }}
                >
                  <button
                    type="button"
                    title={tr('Reply to this message')}
                    onClick={() => onReplyMessage(msg)}
                    style={{ color: 'var(--text-muted)', padding: 4 }}
                  >
                    <Reply size={13} />
                  </button>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 6,
                      maxWidth: '78%',
                    }}
                  >
                    {quoted && (
                      <div
                        style={{
                          padding: '5px 10px',
                          borderRadius: 10,
                          background: 'var(--surface-1)',
                          borderLeft: '2px solid var(--border-default)',
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {quoted.text.slice(0, 120)}
                      </div>
                    )}
                    {msg.metadata?.attachments && msg.metadata.attachments.length > 0 && (
                      <MessageAttachments attachments={msg.metadata.attachments} />
                    )}
                    {msg.metadata?.skills && msg.metadata.skills.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, justifyContent: 'flex-end' }}>
                        {msg.metadata.skills.map((skill) => (
                          <span
                            key={skill.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border-subtle)',
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <Sparkles size={11} style={{ color: 'var(--agent-purple)' }} />
                            {skill.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {!(msg.metadata?.attachments?.length && isAttachmentOnlyText(msg.text)) && (
                      <div
                        className="glass glass-user msg-enter"
                        style={{
                          maxWidth: '100%',
                          borderRadius: 16,
                          padding: '12px 16px',
                          fontSize: 13.5,
                          lineHeight: '21px',
                          color: 'var(--text-primary)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {renderMentionText(msg.text, agents)}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // Agent reply in room
            const sender = msg.agentId ? agentById.get(msg.agentId) : undefined;
            const msgActivities =
              msg.metadata?.activities ?? activities.filter((a) => a.messageId === msg.id);
            const isExpanded = expandedWorkIds[msg.id] ?? msg.streaming;
            const cleanCopyText = stripAtelierActions(msg.text);
            const msgProvider = msg.metadata?.provider ?? sender?.providerOverride;
            const msgModel = msg.metadata?.model ?? sender?.modelOverride;
            const quoted = msg.metadata?.replyToMessageId
              ? msgById.get(msg.metadata.replyToMessageId)
              : undefined;

            return (
              <div
                key={msg.id}
                style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 2 }}>
                  <BotMascot
                    size={20}
                    color={sender?.color ?? 'blue'}
                    shape={sender?.avatarShape}
                    seed={sender?.id ?? 'agent'}
                    status={msg.streaming ? 'working' : undefined}
                  />
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {sender?.name ?? tr('Removed agent')}
                  </span>
                  {sender?.role && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: 'var(--text-tertiary)',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {sender.role}
                    </span>
                  )}
                  {msg.streaming && (
                    <span style={{ fontSize: 11, color: 'var(--agent-blue)' }}>
                      {tr('typing…')}
                    </span>
                  )}
                </div>

                {quoted && (
                  <div
                    style={{
                      padding: '4px 10px',
                      borderRadius: 10,
                      background: 'var(--surface-1)',
                      borderLeft: '2px solid var(--border-default)',
                      fontSize: 11.5,
                      color: 'var(--text-tertiary)',
                      maxWidth: '86%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {quoted.text.slice(0, 120)}
                  </div>
                )}

                {(msg.streaming || msgActivities.length > 0 || (!msg.streaming && msg.durationMs)) && (
                  <WorkPointsChecklist
                    activities={msgActivities}
                    streaming={msg.streaming}
                    durationMs={msg.durationMs}
                    createdAt={msg.createdAt}
                    agents={agents}
                    pendingTasks={[]}
                    expanded={isExpanded}
                    onToggle={() => toggleWork(msg.id, msg.streaming)}
                  />
                )}

                {!msg.streaming && <MemoryChip used={msg.metadata?.memoryUsed} scope={msg.projectId ?? null} />}

                {msg.text &&
                  parseMessageSegments(msg.text).map((seg, i) => {
                    if (seg.type === 'design') {
                      return (
                        <DesignOptionsCard
                          key={`${msg.id}-d${i}`}
                          block={seg.block}
                          chosen={savedDesignPicks.get(`${msg.id}:${i}`) ?? savedDesignPicks.get(`${msg.id}:-1`)}
                          streaming={msg.streaming}
                          onChoose={(o) => api.pickDesign(msg.projectId, msg.id, o.id, i)}
                        />
                      );
                    }
                    if (seg.type === 'design-pending') {
                      return <DesignPendingCard key={`${msg.id}-p${i}`} title={seg.title} />;
                    }
                    if (!seg.text.trim()) return null;
                    return (
                      <div
                        key={`${msg.id}-t${i}`}
                        className="glass glass-agent msg-enter"
                        style={{
                          alignSelf: 'flex-start',
                          maxWidth: '88%',
                          borderRadius: 16,
                          padding: '13px 16px',
                          fontSize: 13.5,
                          lineHeight: '21px',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <FormattedText text={seg.text} />
                      </div>
                    );
                  })}

                {msg.metadata?.qaRun && (
                  <div style={{ width: '100%', maxWidth: '88%' }}>
                    <QaReportCard
                      run={msg.metadata.qaRun}
                      onSendFailuresToAgent={(run) =>
                        void onQuickSend(
                          [
                            `Fix the issues found in Browser QA on ${run.url}:`,
                            run.summary,
                            ...run.pageErrors.map((e) => `- PageError: ${e}`),
                            ...run.consoleErrors.map((e) => `- ConsoleError: ${e}`),
                            ...run.failedRequests.map((r) => `- HTTP ${r.status}: ${r.method} ${r.url}`),
                          ].join('\n'),
                        )
                      }
                    />
                  </div>
                )}

                {!msg.streaming && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '0 4px',
                      fontSize: 12,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    <span>{formatTime(msg.createdAt)}</span>
                    {msgProvider && msgModel && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}>
                        <ProviderIcon provider={msgProvider} size={11} active={false} />
                        <span>{formatShortModelName(msgProvider, msgModel)}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      title={tr('Copy reply')}
                      onClick={() => void handleCopy(msg.id, cleanCopyText)}
                      style={{ display: 'inline-flex', alignItems: 'center' }}
                    >
                      {copiedId === msg.id ? (
                        <Check size={14} style={{ color: 'var(--agent-green)' }} />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                    {onCreateTaskFromReply && (
                      <button
                        type="button"
                        title={tr('Create task from this reply')}
                        onClick={() => onCreateTaskFromReply(cleanCopyText.slice(0, 400))}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        <CheckSquare size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={tr('Reply to this message')}
                      onClick={() => onReplyMessage(msg)}
                      style={{ display: 'inline-flex', alignItems: 'center' }}
                    >
                      <Reply size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}

        {erroredAgents.map((errAgent) => (
          <div
            key={`err-${errAgent.id}`}
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(248, 113, 113, 0.08)',
              border: '1px solid rgba(248, 113, 113, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 12.5,
              color: 'var(--agent-red)',
            }}
          >
            <span>
              <strong>{errAgent.name}:</strong> {errAgent.lastError}
            </span>
            <button
              type="button"
              onClick={() => void onRetryAgent(errAgent.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 12,
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              <RotateCcw size={12} /> {tr('Retry')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
