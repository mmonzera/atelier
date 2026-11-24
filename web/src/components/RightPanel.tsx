import type { Agent, CanonEntry, PortEntry, Project, Settings, Task } from '@atelier/contracts';
import {
  ArrowLeftRight,
  Check,
  FolderGit2,
  GitBranch,
  Globe,
  Laptop,
  MessageSquare,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  DotMatrixGrid,
  ProjectTile,
  TaskStatusIcon,
  getAgentColor,
  getColorVar,
} from './Atoms';
import { BotMascot } from './mascot/BotMascot';
import { CanonPanel } from './CanonPanel';
import { useT } from '../i18n';

interface RightPanelProps {
  mode: 'project' | 'agent';
  project: Project | null;
  allProjects: Project[];
  agents: Agent[];
  allAgents: Agent[];
  activeAgent: Agent | null;
  tasks: Task[];
  ports: PortEntry[];
  settings: Settings;
  hostname: string;
  canon: CanonEntry[];
  onSelectProject: (projectId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectDirectAgent: (agentId: string) => void;
  onAddAgent: () => void;
  onAddGlobalAgent: () => void;
  onEditAgent: (agent: Agent) => void;
  onAssignAgent: (projectId: string, agentId: string) => Promise<void>;
  onUnassignAgent: (projectId: string, agentId: string) => Promise<void>;
  onNewTask: () => void;
  onSelectTask: (task: Task) => void;
  onOpenReports: () => void;
  onOpenPortPreview: (port: PortEntry) => void;
  onOpenLinkRepo: () => void;
  onOpenModels: () => void;
  onOpenMcp: () => void;
  onOpenSettings: () => void;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
};

function formatShortModel(settings: Settings, agent: Agent | null): string {
  const provider = agent?.providerOverride ?? settings.provider;
  const model = agent?.modelOverride ?? settings.model;
  const prefix = PROVIDER_LABEL[provider] ?? provider;
  return `${prefix} · ${model}`;
}

export function RightPanel({
  mode,
  project,
  allProjects,
  agents,
  allAgents,
  activeAgent,
  tasks,
  ports,
  settings,
  hostname,
  canon,
  onSelectProject,
  onSelectAgent,
  onSelectDirectAgent,
  onAddAgent,
  onAddGlobalAgent,
  onEditAgent,
  onAssignAgent,
  onUnassignAgent,
  onNewTask,
  onSelectTask,
  onOpenReports,
  onOpenPortPreview,
  onOpenLinkRepo,
  onOpenModels,
  onOpenMcp,
  onOpenSettings,
}: RightPanelProps) {
  const tr = useT();
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [showAllPorts, setShowAllPorts] = useState(false);
  const [assignPickerOpen, setAssignPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visibleProjects = useMemo(
    () => allProjects.filter((p) => !p.archived),
    [allProjects],
  );
  const projectById = useMemo(
    () => new Map(visibleProjects.map((p) => [p.id, p])),
    [visibleProjects],
  );

  const projectTasks = useMemo(
    () => (project ? tasks.filter((t) => t.projectId === project.id) : []),
    [project, tasks],
  );
  const projectPorts = useMemo(
    () => (project ? ports.filter((p) => p.projectId === project.id) : []),
    [project, ports],
  );

  const sortedProjectTasks = useMemo(() => {
    const rank = (s: Task['status']) =>
      s === 'in_progress' ? 0 : s === 'in_review' ? 1 : s === 'todo' ? 2 : s === 'backlog' ? 3 : 4;
    return [...projectTasks].sort((a, b) => {
      const diff = rank(a.status) - rank(b.status);
      return diff !== 0 ? diff : b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [projectTasks]);

  const agentReports = useMemo(() => {
    if (!activeAgent) return [];
    const rank = (s: Task['status']) =>
      s === 'in_review' ? 0 : s === 'in_progress' ? 1 : s === 'done' ? 2 : s === 'todo' ? 3 : 4;
    return tasks
      .filter((t) => t.assigneeAgentId === activeAgent.id)
      .sort((a, b) => {
        const diff = rank(a.status) - rank(b.status);
        return diff !== 0 ? diff : b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [tasks, activeAgent]);

  const assignedProjects = useMemo(
    () =>
      activeAgent
        ? visibleProjects.filter((p) => p.agentIds.includes(activeAgent.id))
        : [],
    [visibleProjects, activeAgent],
  );

  const visibleTasks = showAllTasks ? sortedProjectTasks : sortedProjectTasks.slice(0, 4);
  const hiddenTaskCount = Math.max(0, sortedProjectTasks.length - 4);
  const visiblePorts = showAllPorts ? projectPorts : projectPorts.slice(0, 3);
  const hiddenPortCount = Math.max(0, projectPorts.length - 3);
  const otherProjectAgent = agents.find((a) => a.id !== activeAgent?.id) ?? null;

  const handleToggleAssign = async (projId: string, agtId: string, isAssigned: boolean) => {
    setBusyId(`${projId}:${agtId}`);
    try {
      if (isAssigned) await onUnassignAgent(projId, agtId);
      else await onAssignAgent(projId, agtId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside
      style={{
        width: 270,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
        paddingRight: 2,
        zIndex: 10,
      }}
    >
      {(project || activeAgent) && <CanonPanel key={project?.id ?? 'direct'} entries={canon} />}
      {mode === 'agent' && activeAgent ? (
        <>
          {/* Direct Agent Profile */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              <Laptop size={13} strokeWidth={1.5} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {hostname || tr('Local Workstation')}{tr('· Direct')}
              </span>
            </div>

            <div
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                padding: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                <BotMascot
                  size={38}
                  color={activeAgent.color}
                  shape={activeAgent.avatarShape}
                  seed={activeAgent.id}
                  status={activeAgent.status}
                  clickable
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: '18px',
                      fontWeight: 500,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {activeAgent.name}
                  </div>
                  <button
                    type="button"
                    onClick={onOpenModels}
                    title={tr('Switch model or sign in')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11.5,
                      color: 'var(--text-tertiary)',
                      maxWidth: '100%',
                    }}
                  >
                    <DotMatrixGrid color="var(--text-tertiary)" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatShortModel(settings, activeAgent)}
                    </span>
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onEditAgent(activeAgent)}
                title={tr('Configure agent, skills & MCP')}
                className="transition-atelier"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-3)',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                <SlidersHorizontal size={13} strokeWidth={1.5} />
              </button>
            </div>
          </section>

          {/* Assigned Projects */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: '14px',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >{tr('ASSIGNED PROJECTS (')}{assignedProjects.length})
              </span>
              {visibleProjects.length > 0 && (
                <button
                  type="button"
                  onClick={() => setProjectPickerOpen((v) => !v)}
                  title={tr('Assign to projects')}
                  style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                >
                  <Plus size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>

            {projectPickerOpen && visibleProjects.length > 0 && (
              <div
                style={{
                  padding: 8,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {visibleProjects.map((p) => {
                  const assigned = p.agentIds.includes(activeAgent.id);
                  const pending = busyId === `${p.id}:${activeAgent.id}`;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={pending}
                      onClick={() => void handleToggleAssign(p.id, activeAgent.id, assigned)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        padding: '3px 4px',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <ProjectTile name={p.name} size={16} />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {p.name}
                        </span>
                      </span>
                      {assigned && <Check size={13} strokeWidth={1.75} style={{ color: 'var(--agent-green)' }} />}
                    </button>
                  );
                })}
              </div>
            )}

            {assignedProjects.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{tr('Not assigned to any project yet.')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {assignedProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectProject(p.id)}
                    className="transition-atelier"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      textAlign: 'left',
                      fontSize: 12.5,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <ProjectTile name={p.name} size={18} />
                      <span
                        style={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.name}
                      </span>
                    </span>
                    <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tr('Open')}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Project Reports */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: '14px',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >{tr('PROJECT REPORTS')}
              </span>
              {agentReports.length > 0 && (
                <button
                  type="button"
                  onClick={onOpenReports}
                  style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}
                >{tr('All →')}
                </button>
              )}
            </div>

            {agentReports.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{tr('No project tasks or reports yet.')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {agentReports.slice(0, 5).map((t) => {
                  const proj = projectById.get(t.projectId);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onSelectTask(t)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        textAlign: 'left',
                        padding: '2px 0',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <TaskStatusIcon status={t.status} size={13} />
                        <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {t.identifier}
                        </span>
                        <span
                          style={{
                            fontSize: 12.5,
                            color: 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                          }}
                        >
                          {t.title}
                        </span>
                      </div>
                      {(proj || t.deliverableSummary) && (
                        <div
                          style={{
                            marginLeft: 20,
                            fontSize: 11,
                            color: 'var(--text-tertiary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {proj ? `${proj.name}` : ''}
                          {proj && t.deliverableSummary ? ' · ' : ''}
                          {t.deliverableSummary ?? ''}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Other Global Agents (Direct DM) */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: '14px',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >{tr('ALL AGENTS (')}{allAgents.length})
              </span>
              <button
                type="button"
                onClick={onAddGlobalAgent}
                title={tr('Add global agent')}
                style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
              >
                <Plus size={13} strokeWidth={1.5} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {allAgents.map((a) => {
                const isSelf = a.id === activeAgent.id;
                const color = getAgentColor(a.color, a.status);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onSelectDirectAgent(a.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '3px 4px',
                      borderRadius: 'var(--radius-sm)',
                      background: isSelf ? 'rgba(255,255,255,0.04)' : 'transparent',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <BotMascot
                        size={22}
                        color={a.color}
                        shape={a.avatarShape}
                        seed={a.id}
                        status={a.status}
                        active={isSelf}
                      />
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.name}
                      </span>
                    </span>
                    <DotMatrixGrid color={color} pulsing={a.status === 'working'} />
                  </button>
                );
              })}
            </div>
          </section>
        </>
      ) : (
        <>
          {/* Project Header Card */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              <Laptop size={13} strokeWidth={1.5} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {hostname || tr('Local Workstation')}
              </span>
            </div>

            {project ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <ProjectTile name={project.name} size={24} active />
                    <span
                      style={{
                        fontSize: 13,
                        lineHeight: '18px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {project.name}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={onOpenLinkRepo}
                    title={project.repo ? project.repo.fullName : tr('Link repository')}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: project.repo ? 'var(--agent-green)' : 'var(--text-tertiary)',
                      flexShrink: 0,
                    }}
                  >
                    <FolderGit2 size={14} strokeWidth={1.5} />
                  </button>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <GitBranch size={13} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {project.repo ? `${project.repo.defaultBranch} · ${project.repo.fullName}` : tr('No repo linked')}
                  </span>
                </div>

                <div style={{ height: 1, background: 'var(--border-subtle)', margin: '2px 0' }} />

                <div
                  style={{
                    fontSize: 11,
                    lineHeight: '14px',
                    fontWeight: 500,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                  }}
                >{tr('ACTIONS')}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    { label: tr('New task'), onClick: onNewTask },
                    { label: tr('Add custom agent'), onClick: onAddAgent },
                    { label: project.repo ? tr('Switch / link repo') : tr('Link repository'), onClick: onOpenLinkRepo },
                  ].map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      className="transition-atelier"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '2px 0',
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--text-primary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--text-secondary)';
                      }}
                    >
                      <Plus size={14} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
                      <span>{action.label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{tr('Select a project or click an agent on the left rail for a Direct 1-on-1 chat.')}
              </div>
            )}
          </section>

          {/* Project Agent Team */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {activeAgent && project && (
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  <BotMascot
                    size={38}
                    color={activeAgent.color}
                    shape={activeAgent.avatarShape}
                    seed={activeAgent.id}
                    status={activeAgent.status}
                    clickable
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: '18px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {activeAgent.name}
                    </div>
                    <button
                      type="button"
                      onClick={onOpenModels}
                      title={tr('Switch model or sign in')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                        maxWidth: '100%',
                      }}
                    >
                      <DotMatrixGrid color="var(--text-tertiary)" />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {formatShortModel(settings, activeAgent)}
                      </span>
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => onEditAgent(activeAgent)}
                    title={tr('Configure agent, skills & instructions')}
                    className="transition-atelier"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-3)',
                      border: '1px solid var(--border-default)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <SlidersHorizontal size={13} strokeWidth={1.5} />
                  </button>
                  {otherProjectAgent && (
                    <button
                      type="button"
                      onClick={() => onSelectAgent(otherProjectAgent.id)}
                      title={tr('Switch to {name}', { name: otherProjectAgent.name })}
                      className="transition-atelier"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-3)',
                        border: '1px solid var(--border-default)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <ArrowLeftRight size={13} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <span style={{ color: 'var(--text-secondary)' }}>{tr('Agent team')}</span>
                <span className="mono-num" style={{ color: 'var(--text-muted)' }}>
                  {agents.length}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                {project && (
                  <button
                    type="button"
                    onClick={() => setAssignPickerOpen((v) => !v)}
                    title={tr('Assign existing agents or add new')}
                    style={{ display: 'flex', alignItems: 'center', color: 'inherit' }}
                  >
                    <Plus size={14} strokeWidth={1.5} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  title={tr('Agent runtime settings')}
                  style={{ display: 'flex', alignItems: 'center', color: 'inherit' }}
                >
                  <MoreHorizontal size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {assignPickerOpen && project && (
              <div
                style={{
                  padding: 8,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{tr('Assign agents to')} {project.name}
                </div>
                {allAgents.map((a) => {
                  const assigned = project.agentIds.includes(a.id);
                  const pending = busyId === `${project.id}:${a.id}`;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      disabled={pending}
                      onClick={() => void handleToggleAssign(project.id, a.id, assigned)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        padding: '3px 4px',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '9999px',
                            background: getColorVar(a.color),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {a.name}
                        </span>
                      </span>
                      {assigned && <Check size={13} strokeWidth={1.75} style={{ color: 'var(--agent-green)' }} />}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setAssignPickerOpen(false);
                    onAddAgent();
                  }}
                  style={{
                    marginTop: 2,
                    paddingTop: 6,
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <Plus size={12} strokeWidth={1.5} />
                  <span>{tr('Create new agent…')}</span>
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {agents.length === 0 && project ? (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('No agents assigned yet. Click + to assign or create one.')}
                </div>
              ) : (
                agents.map((agent) => {
                  const isSelected = activeAgent?.id === agent.id;
                  const color = getAgentColor(agent.color, agent.status);
                  const enabledSkills = agent.skills.filter((s) => s.enabled).length;
                  const subtitle =
                    agent.status === 'working'
                      ? agent.currentTask || 'Working…'
                      : agent.status === 'error'
                        ? agent.lastError || tr('Turn error')
                        : agent.queueLength > 0
                          ? `${agent.queueLength} ${tr('queued')}`
                          : enabledSkills > 0
                            ? `${agent.role} · ${enabledSkills}s`
                            : agent.role;

                  return (
                    <div
                      key={agent.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                        padding: '4px 4px',
                        borderRadius: 'var(--radius-sm)',
                        background: isSelected ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                        minWidth: 0,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => onSelectAgent(agent.id)}
                        onDoubleClick={() => onEditAgent(agent)}
                        title={tr('{name} ({role}) — double-click to edit', { name: agent.name, role: agent.role })}
                        className="transition-atelier"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          minWidth: 0,
                          flex: 1,
                          textAlign: 'left',
                        }}
                      >
                        <span
                          style={{
                            width: 11,
                            height: 11,
                            borderRadius: '9999px',
                            border: `1.5px solid ${isSelected ? 'var(--text-primary)' : 'var(--text-muted)'}`,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {isSelected && (
                            <span
                              style={{
                                width: 4,
                                height: 4,
                                borderRadius: '9999px',
                                background: 'var(--text-primary)',
                              }}
                            />
                          )}
                        </span>

                        <BotMascot
                          size={22}
                          color={agent.color}
                          shape={agent.avatarShape}
                          seed={agent.id}
                          status={agent.status}
                          active={isSelected}
                        />

                        <span
                          style={{
                            fontSize: 13,
                            lineHeight: '18px',
                            fontWeight: 500,
                            color: 'var(--text-primary)',
                            maxWidth: 92,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            flexShrink: 0,
                          }}
                        >
                          {agent.name}
                        </span>

                        <span
                          style={{
                            fontSize: 12,
                            lineHeight: '18px',
                            color: agent.status === 'error' ? 'var(--agent-red)' : 'var(--text-tertiary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            minWidth: 0,
                          }}
                        >
                          {subtitle}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onSelectDirectAgent(agent.id)}
                        title={tr('Direct 1-on-1 DM with {name}', { name: agent.name })}
                        style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                      >
                        <MessageSquare size={12} strokeWidth={1.5} />
                      </button>
                      <DotMatrixGrid color={color} pulsing={agent.status === 'working'} />
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Project Tasks */}
          <section
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: '14px',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >{tr('TASKS')}
              </span>
              {project && (
                <button
                  type="button"
                  onClick={onNewTask}
                  title={tr('New task')}
                  style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                >
                  <Plus size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>

            {visibleTasks.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{tr('No tasks yet.')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visibleTasks.map((t) => {
                  const assignee = allAgents.find((a) => a.id === t.assigneeAgentId) ?? null;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onSelectTask(t)}
                      className="transition-atelier"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '2px 0',
                        textAlign: 'left',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
                        <TaskStatusIcon status={t.status} size={13} />
                        <span
                          className="mono-num"
                          style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}
                        >
                          {t.identifier}
                        </span>
                        <span
                          style={{
                            fontSize: 12.5,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {t.title}
                        </span>
                      </div>
                      {assignee && (
                        <span
                          title={`${assignee.name} (${assignee.role})`}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '9999px',
                            background: getColorVar(assignee.color),
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </button>
                  );
                })}

                {hiddenTaskCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllTasks((v) => !v)}
                    style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}
                  >
                    {showAllTasks ? tr('Show less') : tr('Show {hiddenTaskCount} more', { hiddenTaskCount })}
                  </button>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {/* MCP Card (shown in both modes) */}
      <section
        style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span
            style={{
              fontSize: 11,
              lineHeight: '14px',
              fontWeight: 500,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >{tr('MCP')}
          </span>
          <button
            type="button"
            onClick={onOpenMcp}
            title={tr('Manage MCP connections')}
            style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>

        {settings.mcpServers.length === 0 ? (
          <button
            type="button"
            onClick={onOpenMcp}
            style={{
              textAlign: 'left',
              fontSize: 12.5,
              color: 'var(--text-tertiary)',
            }}
          >{tr('Connect tools via MCP…')}
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {settings.mcpServers.slice(0, 5).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={onOpenMcp}
                className="transition-atelier"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  textAlign: 'left',
                  fontSize: 12.5,
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    color: m.enabled ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '9999px',
                      background: m.enabled ? 'var(--agent-green)' : 'var(--text-muted)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {m.name}
                  </span>
                </span>
                <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {m.transport}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {mode === 'project' && (
        <section
          style={{
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-xl)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 11,
              lineHeight: '14px',
              fontWeight: 500,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >{tr('PORTS')}
          </div>

          {visiblePorts.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{tr('No dev servers active')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visiblePorts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenPortPreview(p)}
                  className="transition-atelier"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
                    <Globe size={13} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
                    <span>{p.name}</span>
                  </span>
                  <span className="mono-num" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    :{p.port}
                  </span>
                </button>
              ))}

              {hiddenPortCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllPorts((v) => !v)}
                  style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}
                >
                  {showAllPorts ? tr('Show less') : tr('Show {hiddenPortCount} more', { hiddenPortCount })}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
