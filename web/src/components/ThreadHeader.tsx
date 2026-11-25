import { useT } from '../i18n';
import type {
  Agent,
  AgentViewTab,
  Channel,
  Project,
  RoomQueueSnapshot,
  WorkspaceTab,
} from '@atelier/contracts';
import { MoreHorizontal, RotateCcw, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getColorVar } from './Atoms';
import { BotMascot } from './mascot/BotMascot';

interface ThreadHeaderProps {
  mode: 'project' | 'agent';
  project: Project | null;
  activeAgent: Agent | null;
  roomChannel?: Channel | null;
  roomAgents?: Agent[];
  roomQueue?: RoomQueueSnapshot | null;
  activeTab: WorkspaceTab;
  agentTab: AgentViewTab;
  hasActiveBrowserSession?: boolean;
  onChangeTab: (tab: WorkspaceTab) => void;
  onChangeAgentTab: (tab: AgentViewTab) => void;
  onSelectRoomAgent?: (agentId: string) => void;
  onNewRoomSession?: (carryover: 'summary' | 'clean') => void;
  onStopRoom?: () => void;
  onEditAgent: () => void;
  onNewTask: () => void;
  onCompactContext?: () => void;
  onOpenChiefOfStaff: () => void;
  onOpenMcp: () => void;
  onOpenLinkRepo: () => void;
  onOpenProjectManage: () => void;
}

const PROJECT_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'preview', label: 'Preview' },
  { id: 'browser', label: 'Browser' },
  { id: 'library', label: 'Library' },
];

const AGENT_TABS: Array<{ id: AgentViewTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'reports', label: 'Reports' },
  { id: 'browser', label: 'Browser' },
  { id: 'library', label: 'Library' },
];

export function ThreadHeader({
  mode,
  project,
  activeAgent,
  roomChannel,
  roomAgents = [],
  roomQueue,
  activeTab,
  agentTab,
  hasActiveBrowserSession = false,
  onChangeTab,
  onChangeAgentTab,
  onSelectRoomAgent,
  onNewRoomSession,
  onStopRoom,
  onEditAgent,
  onNewTask,
  onCompactContext,
  onOpenChiefOfStaff,
  onOpenMcp,
  onOpenLinkRepo,
  onOpenProjectManage,
}: ThreadHeaderProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen && !membersOpen && !sessionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setSessionOpen(false);
      }
      if (leftRef.current && !leftRef.current.contains(e.target as Node)) {
        setMembersOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen, membersOpen, sessionOpen]);

  const isWide =
    (mode === 'project' && activeTab !== 'chat') ||
    (mode === 'agent' && agentTab !== 'chat');

  const isRoomHeader = mode === 'project' && Boolean(project) && Boolean(roomChannel);
  const hasContext = mode === 'project' ? Boolean(project) : Boolean(activeAgent);
  const workingRoomAgents = roomAgents.filter((a) => a.status === 'working');
  const isRoomBusy =
    workingRoomAgents.length > 0 ||
    Boolean(roomQueue?.activeAgentId) ||
    (roomQueue?.queued.length ?? 0) > 0;

  return (
    <header
      style={{
        width: '100%',
        maxWidth: isWide ? 1080 : 666,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '4px 0 12px',
        flexShrink: 0,
        transition: 'max-width 200ms var(--ease-atelier)',
      }}
    >
      <div
        ref={leftRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          minWidth: 0,
          position: 'relative',
        }}
      >
        {isRoomHeader && roomAgents.length > 0 ? (
          <button
            type="button"
            onClick={() => setMembersOpen((v) => !v)}
            title={t('Room members & models')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              maxWidth: '100%',
              minWidth: 0,
              padding: '2px 6px 2px 2px',
              borderRadius: 'var(--radius-full)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
              {roomAgents.slice(0, 3).map((m, idx) => (
                <span
                  key={m.id}
                  style={{
                    marginLeft: idx === 0 ? 0 : -6,
                    position: 'relative',
                    display: 'inline-flex',
                    borderRadius: '9999px',
                    border: '1.5px solid var(--bg-canvas, #0d0d11)',
                  }}
                >
                  <BotMascot
                    size={22}
                    color={m.color}
                    shape={m.avatarShape}
                    seed={m.id}
                    status={m.status}
                  />
                </span>
              ))}
            </span>
            <span
              style={{
                fontSize: 13.5,
                lineHeight: '20px',
                fontWeight: 500,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {project?.name}
            </span>
            <span
              className="mono-num"
              style={{
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                padding: '1px 6px',
                borderRadius: '9999px',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                flexShrink: 0,
              }}
            >
              {roomAgents.length}
            </span>
          </button>
        ) : (
          <>
            <BotMascot
              size={32}
              color={activeAgent?.color ?? 'blue'}
              shape={activeAgent?.avatarShape}
              seed={activeAgent?.id ?? 'atelier'}
              status={activeAgent?.status}
            />
            <div
              style={{
                fontSize: 14,
                lineHeight: '20px',
                fontWeight: 500,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {mode === 'agent' && activeAgent
                ? t('{name} · Direct', { name: activeAgent.name })
                : project
                  ? `${activeAgent?.name ?? 'Agent'} · ${project.name}`
                  : t('Atelier · Agent Harness & Task Studio')}
            </div>

            {hasContext && activeAgent?.role && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: '9999px',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {activeAgent.role}
              </span>
            )}
          </>
        )}

        {isRoomHeader && membersOpen && (
          <div
            className="popover-shadow"
            style={{
              position: 'absolute',
              top: 38,
              left: 0,
              width: 260,
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              padding: 6,
              zIndex: 45,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div
              style={{
                padding: '4px 8px 6px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {t('Room members')}
            </div>
            {roomAgents.map((m) => {
              const isResponder = roomChannel?.defaultResponderAgentId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setMembersOpen(false);
                    onSelectRoomAgent?.(m.id);
                    onEditAgent();
                  }}
                  className="transition-atelier"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--surface-3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '9999px',
                        background: getColorVar(m.color),
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 500 }}>
                        {m.name}
                        {isResponder ? (
                          <span style={{ marginLeft: 5, fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                            · {t('default')}
                          </span>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {m.role}
                      </div>
                    </span>
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color:
                        m.status === 'working'
                          ? 'var(--agent-blue)'
                          : m.status === 'error'
                            ? 'var(--agent-red)'
                            : 'var(--text-muted)',
                    }}
                  >
                    {m.status}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {hasContext && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, position: 'relative' }}
          ref={menuRef}
        >
          <nav
            aria-label={t('Workspace views')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              padding: 3,
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-full)',
            }}
          >
            {mode === 'project'
              ? PROJECT_TABS.map((tab) => {
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => onChangeTab(tab.id)}
                      className="transition-atelier"
                      style={{
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-full)',
                        fontSize: 12,
                        fontWeight: active ? 500 : 400,
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        background: active ? 'var(--surface-2)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(tab.label)}
                      {tab.id === 'browser' && hasActiveBrowserSession && (
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '9999px',
                            background: 'var(--agent-green)',
                          }}
                        />
                      )}
                    </button>
                  );
                })
              : AGENT_TABS.map((tab) => {
                  const active = agentTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => onChangeAgentTab(tab.id)}
                      className="transition-atelier"
                      style={{
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-full)',
                        fontSize: 12,
                        fontWeight: active ? 500 : 400,
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        background: active ? 'var(--surface-2)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(tab.label)}
                      {tab.id === 'browser' && hasActiveBrowserSession && (
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '9999px',
                            background: 'var(--agent-green)',
                          }}
                        />
                      )}
                    </button>
                  );
                })}
          </nav>

          {isRoomHeader && activeTab === 'chat' && isRoomBusy && onStopRoom && (
            <button
              type="button"
              onClick={onStopRoom}
              title={t('Stop room')}
              style={{
                height: 28,
                padding: '0 9px',
                borderRadius: 'var(--radius-full)',
                background: 'rgba(248, 113, 113, 0.12)',
                border: '1px solid rgba(248, 113, 113, 0.3)',
                color: 'var(--agent-red)',
                fontSize: 11.5,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <Square size={10} fill="var(--agent-red)" />
              {t('Stop')}
            </button>
          )}

          {isRoomHeader && activeTab === 'chat' && onNewRoomSession && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => {
                  setSessionOpen((v) => !v);
                  setMenuOpen(false);
                }}
                aria-label={t('New session')}
                title={t('New session')}
                className="transition-atelier"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: sessionOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: sessionOpen ? 'var(--surface-2)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface-2)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = sessionOpen ? 'var(--surface-2)' : 'transparent';
                  e.currentTarget.style.color = sessionOpen ? 'var(--text-primary)' : 'var(--text-secondary)';
                }}
              >
                <RotateCcw size={14} strokeWidth={1.6} />
              </button>
              {sessionOpen && (
                <div
                  className="popover-shadow"
                  style={{
                    position: 'absolute',
                    top: 34,
                    right: 0,
                    width: 224,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-md)',
                    padding: 6,
                    zIndex: 45,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <div
                    style={{
                      padding: '4px 10px 5px',
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {t('Start new session')}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionOpen(false);
                      onNewRoomSession('summary');
                    }}
                    className="transition-atelier"
                    style={{
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
                    {t('New session + summary')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionOpen(false);
                      onNewRoomSession('clean');
                    }}
                    className="transition-atelier"
                    style={{
                      textAlign: 'left',
                      padding: '7px 10px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12.5,
                      color: 'var(--text-secondary)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--surface-3)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {t('New session (clean)')}
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setMenuOpen((v) => !v);
              setSessionOpen(false);
            }}
            aria-label={t('Options')}
            className="transition-atelier"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface-2)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </button>

          {menuOpen && (
            <div
              className="popover-shadow"
              style={{
                position: 'absolute',
                top: 34,
                right: 0,
                width: 205,
                background: 'var(--surface-1)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                padding: 6,
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {[
                ...(activeAgent ? [{ label: t('Edit agent & skills'), action: onEditAgent }] : []),
                ...(activeAgent && onCompactContext && activeAgent.status !== 'working'
                  ? [{ label: t('Compact context now'), action: onCompactContext }]
                  : []),
                ...(mode === 'project' ? [{ label: t('New task'), action: onNewTask }] : []),
                { label: t('MCP connections'), action: onOpenMcp },
                { label: t('Ask Chief of Staff'), action: onOpenChiefOfStaff },
                ...(mode === 'project'
                  ? [
                      { label: t('Link repository'), action: onOpenLinkRepo },
                      { label: t('Archive / delete project'), action: onOpenProjectManage, danger: true },
                    ]
                  : []),
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    item.action();
                  }}
                  className="transition-atelier"
                  style={{
                    textAlign: 'left',
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12.5,
                    color: item.danger ? 'var(--agent-red)' : 'var(--text-primary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--surface-3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
