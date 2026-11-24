import type { Agent, Project } from '@atelier/contracts';
import { BarChart3, PanelRight, Plus, Settings as SettingsIcon } from 'lucide-react';
import { ProjectTile, getColorVar } from './Atoms';
import { BotMascot } from './mascot/BotMascot';
import { resolveMascotColor } from './mascot/mascotConfig';

interface LeftRailProps {
  projects: Project[];
  agents: Agent[];
  activeMode: 'project' | 'agent';
  activeProjectId: string | null;
  activeDirectAgentId: string | null;
  rightPanelOpen: boolean;
  onSelectProject: (projectId: string) => void;
  onSelectDirectAgent: (agentId: string) => void;
  onToggleRightPanel: () => void;
  onOpenNewProject: () => void;
  onOpenNewGlobalAgent: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
}

export function LeftRail({
  projects,
  agents,
  activeMode,
  activeProjectId,
  activeDirectAgentId,
  rightPanelOpen,
  onSelectProject,
  onSelectDirectAgent,
  onToggleRightPanel,
  onOpenNewProject,
  onOpenNewGlobalAgent,
  onOpenUsage,
  onOpenSettings,
}: LeftRailProps) {
  const visibleProjects = projects.filter((p) => !p.archived);

  return (
    <aside
      style={{
        width: 56,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          width: 56,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          padding: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 7,
          maxHeight: 'calc(100vh - 70px)',
        }}
      >
        <button
          type="button"
          onClick={onToggleRightPanel}
          title={rightPanelOpen ? 'Hide context panel' : 'Show context panel'}
          className="transition-atelier"
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: rightPanelOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: rightPanelOpen ? 'var(--surface-2)' : 'transparent',
            flexShrink: 0,
          }}
        >
          <PanelRight size={18} strokeWidth={1.5} />
        </button>

        <div style={{ width: 24, height: 1, background: 'var(--border-subtle)', flexShrink: 0 }} />

        {/* Projects */}
        {visibleProjects.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              maxHeight: '28vh',
              overflowY: 'auto',
              padding: '2px 0',
            }}
          >
            {visibleProjects.map((project) => {
              const isActive = activeMode === 'project' && project.id === activeProjectId;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  title={`Project · ${project.name}`}
                  className="transition-atelier"
                  style={{
                    borderRadius: 'var(--radius-sm)',
                    padding: 2,
                    background: isActive ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  <ProjectTile name={project.name} size={28} active={isActive} />
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={onOpenNewProject}
          title="New project"
          className="transition-atelier"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-3)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <Plus size={16} strokeWidth={1.5} />
        </button>

        <div style={{ width: 24, height: 1, background: 'var(--border-subtle)', flexShrink: 0 }} />

        {/* Global Agents (Direct 1-on-1 DM & Reports) */}
        {agents.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              maxHeight: '28vh',
              overflowY: 'auto',
              padding: '2px 0',
            }}
          >
            {agents.map((agent) => {
              const isActive = activeMode === 'agent' && agent.id === activeDirectAgentId;
              const isWorking = agent.status === 'working';
              const accentHex = resolveMascotColor(agent.color).hex;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onSelectDirectAgent(agent.id)}
                  title={`${agent.name} · ${agent.role} (Direct DM & Reports)`}
                  className="mascot-rail-btn transition-atelier"
                  style={{
                    position: 'relative',
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: isActive ? 'var(--surface-3)' : 'transparent',
                    border: isActive
                      ? `1.5px solid ${getColorVar(agent.color)}`
                      : '1px solid transparent',
                    boxShadow: isActive ? `0 0 14px -2px ${accentHex}44` : 'none',
                  }}
                >
                  <BotMascot
                    size={32}
                    color={agent.color}
                    shape={agent.avatarShape}
                    seed={agent.id}
                    status={agent.status}
                    active={isActive}
                  />
                  {isWorking && (
                    <span
                      style={{
                        position: 'absolute',
                        right: 2,
                        bottom: 2,
                        width: 6,
                        height: 6,
                        borderRadius: '9999px',
                        background: 'var(--agent-green)',
                        boxShadow: '0 0 0 1.5px var(--surface-1)',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={onOpenNewGlobalAgent}
          title="Add global agent"
          className="transition-atelier"
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-3)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <Plus size={15} strokeWidth={1.5} />
        </button>

        <div style={{ width: 24, height: 1, background: 'var(--border-subtle)', flexShrink: 0 }} />

        <button
          type="button"
          onClick={onOpenUsage}
          title="AI Usage & Limits"
          className="transition-atelier"
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-3)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <BarChart3 size={18} strokeWidth={1.5} />
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings & Integrations"
          className="transition-atelier"
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-3)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <SettingsIcon size={18} strokeWidth={1.5} />
        </button>
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        title="Local Studio Workspace"
        style={{
          width: 32,
          height: 32,
          borderRadius: '9999px',
          background: 'radial-gradient(circle at 30% 30%, #3b4252, #18181f)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}
      >
        AT
      </button>
    </aside>
  );
}
