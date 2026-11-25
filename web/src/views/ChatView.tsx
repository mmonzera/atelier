import { useT } from '../i18n';
import {
  BUILT_IN_MODELS,
  parseMessageSegments,
  stripAtelierActions,
  type Activity,
  type Agent,
  type BrowserApprovalRequest,
  type BrowserScreenshotSummary,
  type BrowserSessionInfo,
  type BrowserTakeoverEvent,
  type Message,
  type ModelEntry,
  type ModelProvider,
  type Project,
  type Settings,
  type Task,
} from '@atelier/contracts';
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Hand,
  Minimize2,
  RefreshCw,
  Reply,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shownModels } from '../state/models';
import { api, browserApi } from '../api';
import {
  FormattedText,
  TaskStatusIcon,
  getColorVar,
} from '../components/Atoms';
import { MessageAttachments, isAttachmentOnlyText } from '../components/AttachmentViews';
import { ParallelAgentsStrip, WorkPointsChecklist } from '../components/ChatWorkPanel';
import { DesignOptionsCard, DesignPendingCard } from '../components/DesignOptionsCard';
import { ProviderIcon } from '../components/ProviderIcon';
import { BotMascot } from '../components/mascot/BotMascot';
import { QaReportCard } from '../components/QaReportCard';
import { Select } from '../components/Select';

function renderUserMessageText(text: string, agents: Agent[]): React.ReactNode {
  const named = agents
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  if (named.length === 0 || !text.includes('@')) return text;

  const escaped = named.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|\\s)(@(?:${escaped.join('|')}))(?=$|[\\s.,!?:;)])`, 'g');
  const byName = new Map(named.map((a) => [a.name, a]));
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = re.exec(text)) !== null) {
    const lead = match[1] ?? '';
    const mention = match[2] ?? '';
    const mentionStart = match.index + lead.length;
    if (mentionStart > lastIdx) {
      parts.push(text.slice(lastIdx, mentionStart));
    }
    const target = byName.get(mention.slice(1));
    if (target) {
      parts.push(
        <span
          key={`m-${keyIdx++}`}
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
              background: getColorVar(target.color),
              flexShrink: 0,
            }}
          />
          {mention}
        </span>,
      );
    } else {
      parts.push(mention);
    }
    lastIdx = mentionStart + mention.length;
  }

  if (lastIdx === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

interface ChatViewProps {
  project: Project | null;
  agent: Agent;
  agents: Agent[];
  projects?: Project[];
  messages: Message[];
  activities: Activity[];
  tasks: Task[];
  settings?: Settings;
  discoveredModels?: ModelEntry[];
  onSelectAgent: (agentId: string) => void;
  onReplyText: (text: string) => void;
  onQuickSend: (text: string) => Promise<void>;
  onForwardToProject?: (msg: Message, projectId: string) => Promise<void>;
  onRetryAgent: (opts?: {
    provider?: ModelProvider;
    model?: string;
    makeDefault?: boolean;
  }) => Promise<void>;
  onDismissFallback?: () => Promise<void>;
  onCreateTaskFromReply?: (description: string) => void;
  onOpenTask: (task: Task) => void;
  onOpenEditAgent: () => void;
  browserApprovals?: BrowserApprovalRequest[];
  browserTakeovers?: Record<string, BrowserTakeoverEvent>;
  browserSessions?: BrowserSessionInfo[];
  onOpenBrowserTab?: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ChatView({
  project,
  agent,
  agents,
  projects = [],
  messages,
  activities,
  tasks,
  settings,
  discoveredModels = [],
  onSelectAgent,
  onReplyText,
  onQuickSend,
  onForwardToProject,
  onRetryAgent,
  onDismissFallback,
  onCreateTaskFromReply,
  onOpenTask,
  onOpenEditAgent,
  browserApprovals = [],
  browserTakeovers = {},
  browserSessions = [],
  onOpenBrowserTab,
}: ChatViewProps) {
  const tr = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [expandedWorkIds, setExpandedWorkIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTickId, setActiveTickId] = useState<string | null>(null);
  const [pickedFallback, setPickedFallback] = useState('');
  const [makeDefaultOnRetry, setMakeDefaultOnRetry] = useState(false);
  const [enlargedShot, setEnlargedShot] = useState<BrowserScreenshotSummary | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);

  const allModels = useMemo(() => {
    const merged: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const m of [...BUILT_IN_MODELS, ...discoveredModels, ...(settings?.customModels ?? [])]) {
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(m);
      }
    }
    return merged;
  }, [discoveredModels, settings?.customModels]);

  const formatModelLabel = (provider: ModelProvider, modelId: string) => {
    const found = allModels.find((m) => m.provider === provider && m.id === modelId);
    return found ? `${found.label} (${provider})` : `${provider} · ${modelId}`;
  };

  const formatShortModelName = (provider: ModelProvider, modelId: string) => {
    const found = allModels.find((m) => m.provider === provider && m.id === modelId);
    return found ? found.label : modelId;
  };

  const threadMessages = useMemo(
    () =>
      messages.filter(
        (m) => (m.projectId ?? null) === (project?.id ?? null) && m.agentId === agent.id,
      ),
    [messages, project?.id, agent.id],
  );
  const savedDesignPicks = useMemo(() => {
    const picks = new Map<string, string>();
    for (const message of threadMessages) {
      const pick = message.metadata?.designPick;
      if (pick) picks.set(`${pick.messageId}:${pick.segmentIndex ?? -1}`, pick.optionId);
    }
    return picks;
  }, [threadMessages]);

  const enabledSkills = useMemo(() => agent.skills.filter((s) => s.enabled), [agent.skills]);
  const workingAgents = useMemo(() => agents.filter((a) => a.status === 'working'), [agents]);
  const showParallelStrip = useMemo(
    () => workingAgents.length >= 2 || workingAgents.some((a) => a.id !== agent.id),
    [workingAgents, agent.id],
  );
  const earliestActiveIso = useMemo(() => {
    let earliestMs = Infinity;
    let earliestIso = '';
    for (const a of workingAgents) {
      const ms = new Date(a.updatedAt).getTime();
      if (Number.isFinite(ms) && ms < earliestMs) {
        earliestMs = ms;
        earliestIso = a.updatedAt;
      }
    }
    return earliestIso || new Date().toISOString();
  }, [workingAgents]);
  const pendingAgentTasks = useMemo(
    () => tasks.filter((t) => t.assigneeAgentId === agent.id && t.status === 'todo'),
    [tasks, agent.id],
  );

  const lastMsg = threadMessages[threadMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (lastMsg) setActiveTickId(lastMsg.id);
  }, [threadMessages.length, lastMsg?.text, lastMsg?.streaming]);

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

  const scrollToMessage = (id: string) => {
    setActiveTickId(id);
    const node = messageRefs.current[id];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const suggestions = project
    ? [
        tr('Review open tasks in this project and propose an execution plan'),
        tr('Inspect the workspace repository and summarize what exists so far'),
        tr('Create a task breakdown for my next feature and start on the first item'),
      ]
    : [
        tr('Summarize all your open tasks and deliverables across projects'),
        tr('Help me with a quick ad-hoc task outside any project'),
        tr('Coordinate directly with another agent on the team to review something'),
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
      }}
    >
      {threadMessages.length > 0 && (
        <div
          aria-label={tr('Conversation scrubber')}
          style={{
            width: 24,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'flex-start',
            gap: 6,
            padding: '24px 0',
            userSelect: 'none',
          }}
        >
          {threadMessages.slice(-28).map((msg, idx, arr) => {
            const isActive = activeTickId ? activeTickId === msg.id : idx === arr.length - 1;
            return (
              <button
                key={msg.id}
                type="button"
                onClick={() => scrollToMessage(msg.id)}
                title={`${msg.author}: ${msg.text.slice(0, 40)}`}
                style={{ padding: '2px 4px', display: 'flex', alignItems: 'center' }}
              >
                <span
                  className="transition-atelier"
                  style={{
                    display: 'block',
                    width: isActive ? 10 : msg.author === 'user' ? 6 : 4,
                    height: isActive ? 2 : 1.5,
                    borderRadius: 2,
                    background: isActive ? 'var(--text-primary)' : 'rgba(148, 148, 163, 0.32)',
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: 650,
          margin: '0 auto',
          overflowY: 'auto',
          padding: '16px 6px 40px',
          // fade the text itself at both edges (no overlay, so no visible seam)
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 44px), transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 44px), transparent 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 26,
        }}
      >
        {threadMessages.length === 0 ? (
          <div
            style={{
              margin: 'auto 0',
              padding: '32px 16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <BotMascot
                size={56}
                color={agent.color}
                shape={agent.avatarShape}
                seed={agent.id}
                status={agent.status}
                clickable
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                {agent.name} · {agent.role}
              </span>
              <button
                type="button"
                onClick={onOpenEditAgent}
                title={tr('Edit instructions & skills')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                }}
              >
                <SlidersHorizontal size={11} strokeWidth={1.5} />
                {enabledSkills.length} {enabledSkills.length === 1 ? tr('skill') : tr('skills')}
              </button>
            </div>

            <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 500, lineHeight: '20px' }}>
              {agent.systemInstructions.trim() ? agent.systemInstructions.trim().slice(0, 220) +
                  (agent.systemInstructions.trim().length > 220 ? '…' : '') : project ? tr('Ready in {name}. Give instructions directly here or dispatch Linear-style tasks from the Tasks tab.', { name: project.name }) : tr('Direct 1-on-1 channel with {name}. Ask for quick help outside any project or discuss reports across all assigned projects.', { name: agent.name })}
            </div>

            {enabledSkills.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {enabledSkills.map((sk) => (
                  <span
                    key={sk.id}
                    style={{
                      padding: '3px 9px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      fontSize: 11.5,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {sk.name}
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void onQuickSend(prompt)}
                  className="transition-atelier"
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border-default)';
                    e.currentTarget.style.background = 'var(--surface-2)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border-subtle)';
                    e.currentTarget.style.background = 'var(--surface-1)';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          threadMessages.map((msg, idx) => {
            if (msg.author === 'user') {
              return (
                <div
                  key={msg.id}
                  ref={(el) => {
                    messageRefs.current[msg.id] = el;
                  }}
                  style={{ display: 'flex', justifyContent: 'flex-end' }}
                >
                  <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    {msg.metadata?.attachments && msg.metadata.attachments.length > 0 && (
                      <MessageAttachments attachments={msg.metadata.attachments} />
                    )}
                    {msg.metadata?.skills && msg.metadata.skills.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
                        {msg.metadata.skills.map((skill) => (
                          <span
                            key={skill.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                              padding: '2px 9px',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border-subtle)',
                              fontSize: 11.5,
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <Sparkles size={11} strokeWidth={1.5} style={{ color: 'var(--agent-purple)' }} />
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
                        {renderUserMessageText(msg.text, agents)}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            if (msg.author === 'system' && msg.metadata?.compacted) {
              const compactedCount = msg.metadata.compactedCount ?? 0;
              const summaryOpen = Boolean(expandedWorkIds[msg.id]);
              return (
                <div
                  key={msg.id}
                  ref={(el) => {
                    messageRefs.current[msg.id] = el;
                  }}
                  className="msg-enter"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                    margin: '4px 0',
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                    <button
                      type="button"
                      onClick={() => toggleWork(msg.id)}
                      className="transition-atelier"
                      title={tr('Toggle compacted context memory')}
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
                      <Minimize2 size={12} strokeWidth={1.5} style={{ color: 'var(--agent-amber)' }} />
                      <span>{tr('Context compacted')}</span>
                      {compactedCount > 0 && (
                        <span className="mono-num" style={{ color: 'var(--text-secondary)' }}>
                          · {compactedCount}{tr('msgs')}
                        </span>
                      )}
                      {summaryOpen ? (
                        <ChevronDown size={12} strokeWidth={1.5} />
                      ) : (
                        <ChevronRight size={12} strokeWidth={1.5} />
                      )}
                    </button>
                    <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                  </div>

                  {summaryOpen && (
                    <div
                      className="glass glass-agent glass-soft"
                      style={{
                        width: '100%',
                        borderRadius: 12,
                        padding: '10px 14px',
                        fontSize: 12,
                        lineHeight: '18px',
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

            if (msg.author === 'teammate' || msg.author === 'system') {
              const relatedTask = msg.metadata?.taskId
                ? tasks.find((t) => t.id === msg.metadata?.taskId)
                : undefined;
              const targetAgent = msg.metadata?.targetAgentId
                ? agents.find((a) => a.id === msg.metadata?.targetAgentId)
                : undefined;
              return (
                <div
                  key={msg.id}
                  ref={(el) => {
                    messageRefs.current[msg.id] = el;
                  }}
                  className="glass glass-agent glass-soft msg-enter"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '9px 14px',
                    borderRadius: 16,
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '9999px',
                      marginTop: 6,
                      background: targetAgent ? getColorVar(targetAgent.color) : 'var(--agent-blue)',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FormattedText text={msg.text} />
                    {msg.metadata?.qaRun && (
                      <div style={{ marginTop: 10 }}>
                        <QaReportCard
                          run={msg.metadata.qaRun}
                          compact
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
                    {relatedTask && (
                      <button
                        type="button"
                        onClick={() => onOpenTask(relatedTask)}
                        style={{
                          marginTop: 6,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          color: 'var(--text-primary)',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--border-default)',
                          textUnderlineOffset: 3,
                        }}
                      >
                        <TaskStatusIcon status={relatedTask.status} size={12} />
                        <span>
                          {relatedTask.identifier} · {relatedTask.title}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            const msgActivities =
              msg.metadata?.activities ?? activities.filter((a) => a.messageId === msg.id);
            const isExpanded = expandedWorkIds[msg.id] ?? msg.streaming;
            const linkedTask = msg.metadata?.taskId
              ? tasks.find((t) => t.id === msg.metadata?.taskId)
              : undefined;
            const targetAgent = msg.metadata?.targetAgentId
              ? agents.find((a) => a.id === msg.metadata?.targetAgentId)
              : undefined;

            let prevAssistant: Message | null = null;
            for (let j = idx - 1; j >= 0; j -= 1) {
              if (threadMessages[j]!.author === 'agent') {
                prevAssistant = threadMessages[j]!;
                break;
              }
            }
            const msgProvider = msg.metadata?.provider;
            const msgModel = msg.metadata?.model;
            const prevProvider = prevAssistant?.metadata?.provider;
            const prevModel = prevAssistant?.metadata?.model;
            const switchedModel = Boolean(
              msgProvider &&
                msgModel &&
                prevProvider &&
                prevModel &&
                (prevProvider !== msgProvider || prevModel !== msgModel),
            );

            return (
              <div
                key={msg.id}
                ref={(el) => {
                  messageRefs.current[msg.id] = el;
                }}
                className="message-group"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  paddingRight: 16,
                }}
              >
                {switchedModel && msgProvider && msgModel && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    <ProviderIcon provider={msgProvider} size={11} />
                    <span>
                      {tr('Switched to {model}', {
                        model: formatShortModelName(msgProvider, msgModel),
                      })}
                    </span>
                  </div>
                )}

                {(msg.streaming || msgActivities.length > 0 || (!msg.streaming && msg.durationMs)) && (
                  <WorkPointsChecklist
                    activities={msgActivities}
                    streaming={msg.streaming}
                    durationMs={msg.durationMs}
                    createdAt={msg.createdAt}
                    agents={agents}
                    pendingTasks={msg.streaming ? pendingAgentTasks : []}
                    expanded={isExpanded}
                    onToggle={() => toggleWork(msg.id, msg.streaming)}
                  />
                )}

                {msg.metadata?.fallbackTo && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      alignSelf: 'flex-start',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                      background: 'rgba(96, 165, 250, 0.1)',
                      border: '1px solid rgba(96, 165, 250, 0.25)',
                      fontSize: 11,
                      color: 'var(--agent-blue)',
                    }}
                  >
                    <RefreshCw size={10} strokeWidth={1.75} />
                    <span>{tr('Backup ·')} {msg.metadata.fallbackTo.provider} / {msg.metadata.fallbackTo.model}
                    </span>
                  </div>
                )}

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
                          maxWidth: '100%',
                          padding: '12px 16px',
                          borderRadius: 16,
                          fontSize: 13.5,
                          lineHeight: '21px',
                          color: 'var(--text-primary)',
                          wordBreak: 'break-word',
                        }}
                      >
                        <FormattedText text={seg.text} />
                      </div>
                    );
                  })}

                {msg.metadata?.browserScreenshots && msg.metadata.browserScreenshots.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {msg.metadata.browserScreenshots.map((shot) => (
                      <button
                        key={shot.artifactId}
                        type="button"
                        onClick={() => setEnlargedShot(shot)}
                        style={{
                          width: 210,
                          borderRadius: 12,
                          overflow: 'hidden',
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border-subtle)',
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                        }}
                      >
                        <img
                          src={shot.url}
                          alt={shot.label}
                          style={{
                            width: '100%',
                            height: 126,
                            objectFit: 'cover',
                            display: 'block',
                            background: '#0a0a0e',
                          }}
                        />
                        <div style={{ padding: '7px 10px' }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              color: 'var(--text-primary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {shot.label}
                          </div>
                          {shot.pageUrl && (
                            <div
                              className="mono-num"
                              style={{
                                fontSize: 10.5,
                                color: 'var(--text-muted)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {shot.pageUrl}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {msg.metadata?.cancelled && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tr('Stopped by user.')}
                  </div>
                )}

                {(targetAgent || linkedTask) && (
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
                    {targetAgent && (
                      <button
                        type="button"
                        onClick={() => onSelectAgent(targetAgent.id)}
                        className="transition-atelier"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12.5,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <span>{tr('Messaged')}</span>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '9999px',
                            background: getColorVar(targetAgent.color),
                          }}
                        />
                        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                          {targetAgent.name}
                        </span>
                      </button>
                    )}

                    {linkedTask && (
                      <button
                        type="button"
                        onClick={() => onOpenTask(linkedTask)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <TaskStatusIcon status={linkedTask.status} size={12} />
                        <span className="mono-num" style={{ color: 'var(--text-muted)' }}>
                          {linkedTask.identifier}
                        </span>
                        <span>{linkedTask.title}</span>
                      </button>
                    )}
                  </div>
                )}

                {!msg.streaming && (
                  <div
                    className="message-actions"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 12,
                      fontSize: 12,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    <span>{formatTime(msg.createdAt)}</span>
                    {msgProvider && msgModel && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 11.5,
                          color: 'var(--text-muted)',
                        }}
                      >
                        <ProviderIcon provider={msgProvider} size={11} active={false} />
                        <span>{formatShortModelName(msgProvider, msgModel)}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      title={tr('Copy reply')}
                      onClick={() => void handleCopy(msg.id, stripAtelierActions(msg.text))}
                      style={{ display: 'inline-flex', alignItems: 'center' }}
                    >
                      {copiedId === msg.id ? (
                        <Check size={14} strokeWidth={1.5} style={{ color: 'var(--agent-green)' }} />
                      ) : (
                        <Copy size={14} strokeWidth={1.5} />
                      )}
                    </button>
                    {project && onCreateTaskFromReply && (
                      <button
                        type="button"
                        title={tr('Create task from this reply')}
                        onClick={() => onCreateTaskFromReply(stripAtelierActions(msg.text).slice(0, 400))}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        <CheckSquare size={14} strokeWidth={1.5} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={tr('Follow up in composer')}
                      onClick={() => onReplyText(stripAtelierActions(msg.text))}
                      style={{ display: 'inline-flex', alignItems: 'center' }}
                    >
                      <Reply size={14} strokeWidth={1.5} />
                    </button>
                    {!project && onForwardToProject && projects.length > 0 && (
                      <button
                        type="button"
                        title={tr('Forward to project room')}
                        onClick={() => void onForwardToProject(msg, projects[0]!.id)}
                        style={{
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          padding: '1px 6px',
                          borderRadius: 'var(--radius-full)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {tr('Send to {name}', { name: projects[0]!.name })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {showParallelStrip && (
          <ParallelAgentsStrip
            agents={workingAgents}
            settings={settings}
            earliestActiveIso={earliestActiveIso}
            onSelectAgent={onSelectAgent}
            onStopAgents={async (ids) => {
              await Promise.allSettled(ids.map((id) => api.stopAgent(id)));
            }}
          />
        )}

        {browserApprovals
          .filter((req) => req.agentId === agent.id)
          .map((req) => (
            <div
              key={req.id}
              className="msg-enter"
              style={{
                padding: '13px 15px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(244, 188, 46, 0.08)',
                border: '1px solid rgba(244, 188, 46, 0.3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
                  <ShieldAlert size={16} style={{ color: 'var(--agent-amber)', flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {tr('Confirm browser action')}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{req.action}</div>
                    <div className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>
                      {req.url}
                    </div>
                  </div>
                </div>
                {req.screenshotUrl && (
                  <img
                    src={req.screenshotUrl}
                    alt={req.action}
                    style={{
                      width: 120,
                      height: 75,
                      objectFit: 'cover',
                      borderRadius: 6,
                      border: '1px solid var(--border-subtle)',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={resolvingApprovalId === req.id}
                  onClick={async () => {
                    setResolvingApprovalId(req.id);
                    try {
                      await browserApi.resolveApproval(req.id, true);
                    } finally {
                      setResolvingApprovalId(null);
                    }
                  }}
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--agent-green)',
                    color: '#0d0d11',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {tr('Allow')}
                </button>
                <button
                  type="button"
                  disabled={resolvingApprovalId === req.id}
                  onClick={async () => {
                    setResolvingApprovalId(req.id);
                    try {
                      await browserApi.resolveApproval(req.id, false);
                    } finally {
                      setResolvingApprovalId(null);
                    }
                  }}
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--agent-red)',
                    fontSize: 12,
                  }}
                >
                  {tr('Deny')}
                </button>
              </div>
            </div>
          ))}

        {browserSessions
          .filter((s) => s.agentId === agent.id && s.status === 'takeover')
          .map((s) => {
            const reason = browserTakeovers[s.id]?.reason || s.takeoverReason || tr('Manual verification requested');
            return (
              <div
                key={`takeover-${s.id}`}
                className="msg-enter"
                style={{
                  padding: '13px 15px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <Hand size={16} style={{ color: '#38bdf8', flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {tr('Browser needs your help')}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{reason}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => void browserApi.releaseSession(s.id)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--agent-green)',
                      color: '#0d0d11',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {tr('Done, resume agent')}
                  </button>
                  {onOpenBrowserTab && (
                    <button
                      type="button"
                      onClick={onOpenBrowserTab}
                      style={{
                        height: 28,
                        padding: '0 12px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-default)',
                        color: 'var(--text-primary)',
                        fontSize: 12,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <Globe size={12} /> {tr('Open Browser tab')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

        {agent.status === 'error' && agent.lastError && (
          agent.pendingFallback ? (
            <div
              className="msg-enter"
              style={{
                padding: '13px 15px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(244, 188, 46, 0.08)',
                border: '1px solid rgba(244, 188, 46, 0.28)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
                  <AlertTriangle
                    size={15}
                    strokeWidth={1.75}
                    style={{ color: 'var(--agent-amber)', flexShrink: 0, marginTop: 2 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {agent.pendingFallback.failedProvider} · {agent.pendingFallback.failedModel} {tr('stopped (')}
                      {agent.pendingFallback.errorKind.replace('_', ' ')})
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        marginTop: 2,
                        wordBreak: 'break-word',
                      }}
                    >
                      {agent.pendingFallback.errorMessage}
                    </div>
                  </div>
                </div>
              </div>

              {agent.pendingFallback.candidates.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {agent.pendingFallback.candidates.map((cand) => (
                    <button
                      key={`${cand.provider}:${cand.model}`}
                      type="button"
                      onClick={() =>
                        void onRetryAgent({
                          provider: cand.provider,
                          model: cand.model,
                          makeDefault: makeDefaultOnRetry,
                        })
                      }
                      className="transition-atelier"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--action-primary)',
                        color: 'var(--action-primary-fg)',
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                    >
                      <RefreshCw size={12} strokeWidth={1.75} />{tr('Continue with')} {formatModelLabel(cand.provider, cand.model)}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Select
                    ariaLabel={tr('Choose another backup model')}
                    value={pickedFallback}
                    placeholder={tr('Or choose another model…')}
                    onChange={setPickedFallback}
                    options={(settings ? shownModels(allModels, settings) : allModels)
                      .filter(
                        (m) =>
                          !(
                            m.provider === agent.pendingFallback?.failedProvider &&
                            m.id === agent.pendingFallback?.failedModel
                          ),
                      )
                      .map((m) => ({
                        value: `${m.provider}:${m.id}`,
                        label: m.label,
                        hint: m.provider,
                      }))}
                  />
                </div>
                {pickedFallback && (
                  <button
                    type="button"
                    onClick={() => {
                      const [prov, ...rest] = pickedFallback.split(':');
                      const modId = rest.join(':');
                      if (!prov || !modId) return;
                      void onRetryAgent({
                        provider: prov as ModelProvider,
                        model: modId,
                        makeDefault: makeDefaultOnRetry,
                      });
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--action-primary)',
                      color: 'var(--action-primary-fg)',
                      fontSize: 12,
                      fontWeight: 500,
                      flexShrink: 0,
                    }}
                  >{tr('Run on selected')}
                  </button>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                  paddingTop: 2,
                }}
              >
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={makeDefaultOnRetry}
                    onChange={(e) => setMakeDefaultOnRetry(e.target.checked)}
                  />{tr("Also set as this agent's default model")}
                </label>

                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void onRetryAgent()}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '5px 10px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                      fontSize: 11.5,
                      fontWeight: 500,
                    }}
                  >
                    <RotateCcw size={11} strokeWidth={1.5} />{tr('Retry primary')}
                  </button>
                  {onDismissFallback && (
                    <button
                      type="button"
                      onClick={() => void onDismissFallback()}
                      style={{
                        padding: '5px 8px',
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                      }}
                    >{tr('Dismiss')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div
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
              <span>{agent.lastError}</span>
              <button
                type="button"
                onClick={() => void onRetryAgent()}
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
                <RotateCcw size={12} strokeWidth={1.5} />{tr('Retry')}
              </button>
            </div>
          )
        )}
      </div>

      {enlargedShot && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setEnlargedShot(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            background: 'rgba(0,0,0,0.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '92vw',
              maxHeight: '90vh',
              background: 'var(--surface-1)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-default)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {enlargedShot.label}
                </div>
                {enlargedShot.pageUrl && (
                  <div className="mono-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {enlargedShot.pageUrl}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEnlargedShot(null)}
                style={{ color: 'var(--text-secondary)', padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>
            <img
              src={enlargedShot.url}
              alt={enlargedShot.label}
              style={{ maxWidth: '88vw', maxHeight: '80vh', objectFit: 'contain', display: 'block' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
