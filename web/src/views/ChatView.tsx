import {
  BUILT_IN_MODELS,
  type Activity,
  type Agent,
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
  LayoutGrid,
  Minimize2,
  RefreshCw,
  Reply,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DotMatrixGrid,
  FormattedText,
  TaskStatusIcon,
  getColorVar,
} from '../components/Atoms';
import { BotMascot } from '../components/mascot/BotMascot';
import { QaReportCard } from '../components/QaReportCard';
import { Select } from '../components/Select';

interface ChatViewProps {
  project: Project | null;
  agent: Agent;
  agents: Agent[];
  messages: Message[];
  activities: Activity[];
  tasks: Task[];
  settings?: Settings;
  discoveredModels?: ModelEntry[];
  onSelectAgent: (agentId: string) => void;
  onReplyText: (text: string) => void;
  onQuickSend: (text: string) => Promise<void>;
  onRetryAgent: (opts?: {
    provider?: ModelProvider;
    model?: string;
    makeDefault?: boolean;
  }) => Promise<void>;
  onDismissFallback?: () => Promise<void>;
  onCreateTaskFromReply?: (description: string) => void;
  onOpenTask: (task: Task) => void;
  onOpenEditAgent: () => void;
}

function formatDuration(ms: number | null): string {
  if (!ms) return '1s';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function LiveTimer({ startIso }: { startIso: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startMs = new Date(startIso).getTime() || Date.now();
    const tick = () => setElapsed(Math.max(0, (Date.now() - startMs) / 1000));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [startIso]);

  return <span className="mono-num">{elapsed.toFixed(1)}s</span>;
}

export function ChatView({
  project,
  agent,
  agents,
  messages,
  activities,
  tasks,
  settings,
  discoveredModels = [],
  onSelectAgent,
  onReplyText,
  onQuickSend,
  onRetryAgent,
  onDismissFallback,
  onCreateTaskFromReply,
  onOpenTask,
  onOpenEditAgent,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [expandedWorkIds, setExpandedWorkIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTickId, setActiveTickId] = useState<string | null>(null);
  const [pickedFallback, setPickedFallback] = useState('');
  const [makeDefaultOnRetry, setMakeDefaultOnRetry] = useState(false);

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

  const threadMessages = useMemo(
    () =>
      messages.filter(
        (m) => (m.projectId ?? null) === (project?.id ?? null) && m.agentId === agent.id,
      ),
    [messages, project?.id, agent.id],
  );

  const enabledSkills = useMemo(() => agent.skills.filter((s) => s.enabled), [agent.skills]);

  const lastMsg = threadMessages[threadMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (lastMsg) setActiveTickId(lastMsg.id);
  }, [threadMessages.length, lastMsg?.text, lastMsg?.streaming]);

  const toggleWork = (id: string) => {
    setExpandedWorkIds((prev) => ({ ...prev, [id]: !prev[id] }));
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
        'Review open tasks in this project and propose an execution plan',
        'Inspect the workspace repository and summarize what exists so far',
        'Create a task breakdown for my next feature and start on the first item',
      ]
    : [
        'Summarize all your open tasks and deliverables across projects',
        'Help me with a quick ad-hoc task outside any project',
        'Coordinate directly with another agent on the team to review something',
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
          aria-label="Conversation scrubber"
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
                title="Edit instructions & skills"
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
                {enabledSkills.length} {enabledSkills.length === 1 ? 'skill' : 'skills'}
              </button>
            </div>

            <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', maxWidth: 500, lineHeight: '20px' }}>
              {agent.systemInstructions.trim()
                ? agent.systemInstructions.trim().slice(0, 220) +
                  (agent.systemInstructions.trim().length > 220 ? '…' : '')
                : project
                  ? `Ready in ${project.name}. Give instructions directly here or dispatch Linear-style tasks from the Tasks tab.`
                  : `Direct 1-on-1 channel with ${agent.name}. Ask for quick help outside any project or discuss reports across all assigned projects.`}
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
          threadMessages.map((msg) => {
            if (msg.author === 'user') {
              return (
                <div
                  key={msg.id}
                  ref={(el) => {
                    messageRefs.current[msg.id] = el;
                  }}
                  style={{ display: 'flex', justifyContent: 'flex-end' }}
                >
                  <div
                    className="glass glass-user msg-enter"
                    style={{
                      maxWidth: '75%',
                      borderRadius: 16,
                      padding: '12px 16px',
                      fontSize: 13.5,
                      lineHeight: '21px',
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {msg.text}
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
                      title="Toggle compacted context memory"
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
                      <span>Context compacted</span>
                      {compactedCount > 0 && (
                        <span className="mono-num" style={{ color: 'var(--text-secondary)' }}>
                          · {compactedCount} msgs
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
            const isExpanded = Boolean(expandedWorkIds[msg.id]);
            const latestTool = msgActivities[msgActivities.length - 1];
            const linkedTask = msg.metadata?.taskId
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
                className="message-group"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  paddingRight: 16,
                }}
              >
                {(msgActivities.length > 0 || (!msg.streaming && msg.durationMs)) && (
                  <div>
                    <button
                      type="button"
                      onClick={() => toggleWork(msg.id)}
                      className="transition-atelier"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        lineHeight: '16px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown size={14} strokeWidth={1.5} />
                      ) : (
                        <ChevronRight size={14} strokeWidth={1.5} />
                      )}
                      <LayoutGrid size={13} strokeWidth={1.5} />
                      <span>
                        {msg.streaming
                          ? `Working · ${msgActivities.length} step${msgActivities.length === 1 ? '' : 's'}`
                          : `Worked for ${formatDuration(msg.durationMs)}${
                              msgActivities.length > 0 ? ` · ${msgActivities.length} tools` : ''
                            }`}
                      </span>
                    </button>

                    {isExpanded && msgActivities.length > 0 && (
                      <div
                        className="transition-expand"
                        style={{
                          marginTop: 8,
                          marginLeft: 6,
                          paddingLeft: 12,
                          borderLeft: '1px solid var(--border-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        {msgActivities.map((act) => (
                          <div
                            key={act.id}
                            style={{
                              display: 'flex',
                              alignItems: 'baseline',
                              justifyContent: 'space-between',
                              gap: 12,
                              fontSize: 12,
                              color:
                                act.kind === 'error' ? 'var(--agent-red)' : 'var(--text-tertiary)',
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <span className="mono-num" style={{ color: 'var(--text-secondary)' }}>
                                {act.label}
                              </span>
                              {act.detail && (
                                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                                  {act.detail}
                                </span>
                              )}
                            </div>
                            <span
                              className="mono-num"
                              style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}
                            >
                              {formatTime(act.createdAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
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
                    <span>
                      Backup · {msg.metadata.fallbackTo.provider} / {msg.metadata.fallbackTo.model}
                    </span>
                  </div>
                )}

                {msg.text && (
                  <div
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
                    <FormattedText text={msg.text} />
                  </div>
                )}

                {msg.metadata?.cancelled && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Stopped by user.
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
                        <span>Messaged</span>
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

                {msg.streaming ? (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      marginTop: 2,
                    }}
                  >
                    <DotMatrixGrid pulsing color="var(--text-secondary)" />
                    <span>{latestTool ? `${latestTool.label}…` : 'Working…'}</span>
                    <LiveTimer startIso={msg.createdAt} />
                  </div>
                ) : (
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
                    <button
                      type="button"
                      title="Copy reply"
                      onClick={() => void handleCopy(msg.id, msg.text)}
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
                        title="Create task from this reply"
                        onClick={() => onCreateTaskFromReply(msg.text.slice(0, 400))}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        <CheckSquare size={14} strokeWidth={1.5} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Follow up in composer"
                      onClick={() => onReplyText(msg.text)}
                      style={{ display: 'inline-flex', alignItems: 'center' }}
                    >
                      <Reply size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}

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
                      {agent.pendingFallback.failedProvider} · {agent.pendingFallback.failedModel} stopped (
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
                      <RefreshCw size={12} strokeWidth={1.75} />
                      Continue with {formatModelLabel(cand.provider, cand.model)}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <Select
                    ariaLabel="Choose another backup model"
                    value={pickedFallback}
                    placeholder="Or choose another model…"
                    onChange={setPickedFallback}
                    options={allModels
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
                  >
                    Run on selected
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
                  />
                  Also set as this agent&apos;s default model
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
                    <RotateCcw size={11} strokeWidth={1.5} />
                    Retry primary
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
                    >
                      Dismiss
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
                <RotateCcw size={12} strokeWidth={1.5} />
                Retry
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
