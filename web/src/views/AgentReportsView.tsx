import type { Activity, Agent, Project, Task } from '@atelier/contracts';
import { ArrowUpRight, CheckCircle2, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProjectTile, TaskStatusIcon } from '../components/Atoms';
import { useT } from '../i18n';

interface AgentReportsViewProps {
  agent: Agent;
  projects: Project[];
  tasks: Task[];
  activities: Activity[];
  onOpenTask: (task: Task) => void;
  onOpenProject: (projectId: string) => void;
  onOpenAgentChat: () => void;
}

type ReportFilter = 'all' | 'active' | 'delivered';

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function AgentReportsView({
  agent,
  projects,
  tasks,
  activities,
  onOpenTask,
  onOpenProject,
  onOpenAgentChat,
}: AgentReportsViewProps) {
  const tr = useT();
  const [filter, setFilter] = useState<ReportFilter>('all');

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const assignedProjects = useMemo(
    () => projects.filter((p) => !p.archived && p.agentIds.includes(agent.id)),
    [projects, agent.id],
  );

  const agentTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.assigneeAgentId === agent.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks, agent.id],
  );

  const filteredTasks = useMemo(() => {
    if (filter === 'active') {
      return agentTasks.filter(
        (t) => t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress',
      );
    }
    if (filter === 'delivered') {
      return agentTasks.filter((t) => t.status === 'in_review' || t.status === 'done');
    }
    return agentTasks;
  }, [agentTasks, filter]);

  const projectActivities = useMemo(
    () =>
      activities
        .filter((a) => a.agentId === agent.id && a.projectId !== null)
        .slice(-15)
        .reverse(),
    [activities, agent.id],
  );

  const inReviewCount = agentTasks.filter((t) => t.status === 'in_review').length;
  const doneCount = agentTasks.filter((t) => t.status === 'done').length;
  const openCount = agentTasks.filter(
    (t) => t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress',
  ).length;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: 960,
        margin: '0 auto',
        overflowY: 'auto',
        padding: '4px 4px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Summary Strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 10,
        }}
      >
        {[
          { label: tr('Assigned projects'), value: assignedProjects.length, accent: 'var(--text-primary)' },
          { label: tr('Active tasks'), value: openCount, accent: 'var(--agent-blue)' },
          { label: tr('Awaiting review'), value: inReviewCount, accent: 'var(--agent-amber)' },
          { label: tr('Delivered / done'), value: doneCount, accent: 'var(--agent-green)' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{stat.label}</span>
            <span className="mono-num" style={{ fontSize: 20, fontWeight: 500, color: stat.accent }}>
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 3,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {(
            [
              { id: 'all', label: tr('All reports ({length})', { length: agentTasks.length }) },
              { id: 'delivered', label: tr('Delivered ({v0})', { v0: inReviewCount + doneCount }) },
              { id: 'active', label: tr('In queue ({openCount})', { openCount }) },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className="transition-atelier"
                style={{
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: active ? 'var(--surface-2)' : 'transparent',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onOpenAgentChat}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >{tr('Discuss directly with')} {agent.name}
        </button>
      </div>

      {/* Task & Deliverable Reports */}
      <section
        style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-secondary)',
          }}
        >
          <CheckCircle2 size={14} strokeWidth={1.5} />
          <span>{tr('Project Tasks & Deliverables')}</span>
        </div>

        {filteredTasks.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: 'var(--text-tertiary)' }}>{tr('No project tasks found in this filter yet.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {filteredTasks.map((task, idx) => {
              const proj = projectById.get(task.projectId);
              return (
                <div
                  key={task.id}
                  style={{
                    padding: '12px 14px',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenTask(task)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                        flex: 1,
                        textAlign: 'left',
                      }}
                    >
                      <TaskStatusIcon status={task.status} size={14} />
                      <span
                        className="mono-num"
                        style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}
                      >
                        {task.identifier}
                      </span>
                      <span
                        style={{
                          fontSize: 13.5,
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {task.title}
                      </span>
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {proj && (
                        <button
                          type="button"
                          onClick={() => onOpenProject(proj.id)}
                          title={tr('Open {name}', { name: proj.name })}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            fontSize: 11.5,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <ProjectTile name={proj.name} size={14} />
                          <span>{proj.name}</span>
                          <ArrowUpRight size={11} strokeWidth={1.5} />
                        </button>
                      )}
                      <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {formatShortDate(task.updatedAt)}
                      </span>
                    </div>
                  </div>

                  {task.deliverableSummary && (
                    <div
                      style={{
                        marginLeft: 22,
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 12.5,
                        lineHeight: '18px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {task.deliverableSummary}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Activity Feed across projects */}
      {projectActivities.length > 0 && (
        <section
          style={{
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-secondary)',
            }}
          >
            <FileText size={14} strokeWidth={1.5} />
            <span>{tr('Recent Project Activity')}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {projectActivities.map((act, idx) => {
              const proj = act.projectId ? projectById.get(act.projectId) : null;
              return (
                <div
                  key={act.id}
                  style={{
                    padding: '8px 14px',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                    {proj && (
                      <span
                        style={{
                          padding: '1px 7px',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--surface-2)',
                          color: 'var(--text-tertiary)',
                          fontSize: 11,
                          flexShrink: 0,
                        }}
                      >
                        {proj.name}
                      </span>
                    )}
                    <span className="mono-num" style={{ color: 'var(--text-primary)', flexShrink: 0 }}>
                      {act.label}
                    </span>
                    {act.detail && (
                      <span
                        style={{
                          color: 'var(--text-tertiary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {act.detail}
                      </span>
                    )}
                  </div>
                  <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {formatShortDate(act.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
