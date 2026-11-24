import { useT } from '../i18n';
import type { Agent, AgentViewTab, Project, WorkspaceTab } from '@atelier/contracts';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BotMascot } from './mascot/BotMascot';

interface ThreadHeaderProps {
  mode: 'project' | 'agent';
  project: Project | null;
  activeAgent: Agent | null;
  activeTab: WorkspaceTab;
  agentTab: AgentViewTab;
  hasActiveBrowserSession?: boolean;
  onChangeTab: (tab: WorkspaceTab) => void;
  onChangeAgentTab: (tab: AgentViewTab) => void;
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
  activeTab,
  agentTab,
  hasActiveBrowserSession = false,
  onChangeTab,
  onChangeAgentTab,
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
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const isWide =
    (mode === 'project' && activeTab !== 'chat') ||
    (mode === 'agent' && agentTab !== 'chat');

  const hasContext = mode === 'project' ? Boolean(project) : Boolean(activeAgent);

  return (
    <header
      style={{
        width: '100%',
        maxWidth: isWide ? 1080 : 650,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '4px 0 12px',
        flexShrink: 0,
        transition: 'max-width 200ms var(--ease-atelier)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
          {mode === 'agent' && activeAgent ? t('{name} · Direct', { name: activeAgent.name }) : project ? `${activeAgent?.name ?? 'Agent'} · ${project.name}` : t('Atelier · Agent Harness & Task Studio')}
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
      </div>

      {hasContext && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }} ref={menuRef}>
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

          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
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
