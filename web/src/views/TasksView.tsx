import type { Agent, Project, Task, TaskStatus } from '@atelier/contracts';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  Kanban,
  List,
  Play,
  Plus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { toast } from '../components/Toast';
import {
  PriorityBars,
  TASK_STATUS_META,
  TaskStatusIcon,
  getColorVar,
} from '../components/Atoms';

interface TasksViewProps {
  project: Project;
  agents: Agent[];
  tasks: Task[];
  onOpenNewTask: (defaults?: { status?: TaskStatus; assigneeAgentId?: string | null }) => void;
  onOpenTask: (task: Task) => void;
  onJumpToAgent: (agentId: string) => void;
}

const ORDERED_STATUSES: TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'cancelled',
];

const BOARD_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export function TasksView({
  project,
  agents,
  tasks,
  onOpenNewTask,
  onOpenTask,
  onJumpToAgent,
}: TasksViewProps) {
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'delivered'>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [qaRunningTaskId, setQaRunningTaskId] = useState<string | null>(null);

  const projectAgents = useMemo(
    () => agents.filter((a) => a.projectId === project.id),
    [agents, project.id],
  );

  const projectTasks = useMemo(() => {
    return tasks
      .filter((t) => t.projectId === project.id)
      .filter((t) => {
        if (agentFilter === 'unassigned') return !t.assigneeAgentId;
        if (agentFilter !== 'all') return t.assigneeAgentId === agentFilter;
        return true;
      })
      .filter((t) => {
        if (stateFilter === 'active') {
          return t.status === 'todo' || t.status === 'in_progress' || t.status === 'backlog';
        }
        if (stateFilter === 'delivered') {
          return t.status === 'in_review' || t.status === 'done';
        }
        return true;
      });
  }, [tasks, project.id, agentFilter, stateFilter]);

  const toggleGroup = (status: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const handleDispatch = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    if (!task.assigneeAgentId) {
      onOpenTask(task);
      return;
    }
    setDispatchingId(task.id);
    try {
      await api.dispatchTask(task.id);
    } finally {
      setDispatchingId(null);
    }
  };

  const handleRunTaskQa = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    if (!project.previewUrl) return;
    setQaRunningTaskId(task.id);
    try {
      const res = await api.runProjectQa(project.id, {
        taskId: task.id,
        agentId: task.assigneeAgentId,
        postToChat: true,
        watchLive: false,
      });
      if (res.run.passed) {
        toast.success(`Browser QA Passed for ${task.identifier}`);
      } else {
        toast.info(`Browser QA failed for ${task.identifier} · check agent chat`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Browser QA failed');
    } finally {
      setQaRunningTaskId(null);
    }
  };

  const handleQuickCycleStatus = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    const nextMap: Record<TaskStatus, TaskStatus> = {
      backlog: 'todo',
      todo: 'in_progress',
      in_progress: 'in_review',
      in_review: 'done',
      done: 'todo',
      cancelled: 'todo',
    };
    await api.updateTask(task.id, { status: nextMap[task.status] });
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: 1080,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Top Linear-style filter & action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
          padding: '8px 12px',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            onClick={() => setAgentFilter('all')}
            className="transition-atelier"
            style={{
              height: 26,
              padding: '0 10px',
              borderRadius: 'var(--radius-full)',
              fontSize: 12,
              background: agentFilter === 'all' ? 'var(--surface-3)' : 'transparent',
              color: agentFilter === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            All agents
          </button>

          {projectAgents.map((a) => {
            const active = agentFilter === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setAgentFilter(active ? 'all' : a.id)}
                className="transition-atelier"
                style={{
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: active ? 'var(--surface-3)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '9999px',
                    background: getColorVar(a.color),
                  }}
                />
                <span>{a.name}</span>
              </button>
            );
          })}

          <div style={{ width: 1, height: 16, background: 'var(--border-subtle)', margin: '0 2px' }} />

          {(
            [
              { id: 'all', label: 'All' },
              { id: 'active', label: 'Active' },
              { id: 'delivered', label: 'Delivered' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStateFilter(f.id)}
              style={{
                height: 26,
                padding: '0 8px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                color: stateFilter === f.id ? 'var(--text-primary)' : 'var(--text-tertiary)',
                background: stateFilter === f.id ? 'var(--surface-2)' : 'transparent',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'inline-flex',
              padding: 2,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <button
              type="button"
              onClick={() => setViewMode('list')}
              title="List view"
              style={{
                width: 26,
                height: 24,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: viewMode === 'list' ? 'var(--surface-3)' : 'transparent',
                color: viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              <List size={13} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('board')}
              title="Board view"
              style={{
                width: 26,
                height: 24,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: viewMode === 'board' ? 'var(--surface-3)' : 'transparent',
                color: viewMode === 'board' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              <Kanban size={13} strokeWidth={1.5} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => onOpenNewTask({})}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--action-primary)',
              color: 'var(--action-primary-fg)',
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Plus size={13} strokeWidth={1.75} />
            New task
          </button>
        </div>
      </div>

      {/* Main List or Board surface */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: viewMode === 'list' ? '8px 0' : 12,
        }}
      >
        {projectTasks.length === 0 && viewMode === 'list' ? (
          <div
            style={{
              height: '100%',
              minHeight: 240,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 24,
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
              No tasks in this view
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', maxWidth: 420 }}>
              Create tasks here, assign any custom agent (Designer, Builder, PM, QA), and click Run to dispatch work and track deliveries automatically.
            </div>
            <button
              type="button"
              onClick={() => onOpenNewTask({})}
              style={{
                marginTop: 4,
                height: 32,
                padding: '0 14px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 12.5,
                fontWeight: 500,
              }}
            >
              Create first task
            </button>
          </div>
        ) : viewMode === 'list' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ORDERED_STATUSES.map((status) => {
              const items = projectTasks.filter((t) => t.status === status);
              if (items.length === 0) return null;
              const meta = TASK_STATUS_META[status];
              const isCollapsed = Boolean(collapsedGroups[status]);

              return (
                <div key={status} style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* Linear-style group header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 16px',
                      background: 'rgba(255, 255, 255, 0.015)',
                      borderTop: '1px solid var(--border-subtle)',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(status)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {isCollapsed ? (
                        <ChevronRight size={13} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                      ) : (
                        <ChevronDown size={13} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                      )}
                      <TaskStatusIcon status={status} size={14} />
                      <span>{meta.label}</span>
                      <span className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {items.length}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenNewTask({ status })}
                      title={`Add task in ${meta.label}`}
                      style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                    >
                      <Plus size={14} strokeWidth={1.5} />
                    </button>
                  </div>

                  {/* Task rows */}
                  {!isCollapsed &&
                    items.map((task) => {
                      const assignee = projectAgents.find((a) => a.id === task.assigneeAgentId) ?? null;
                      const isDispatching = dispatchingId === task.id;
                      return (
                        <div
                          key={task.id}
                          onClick={() => onOpenTask(task)}
                          className="transition-atelier"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            padding: '9px 16px',
                            borderBottom: '1px solid rgba(38, 38, 48, 0.55)',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--surface-2)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                            <PriorityBars priority={task.priority} />

                            <span
                              className="mono-num"
                              style={{
                                fontSize: 11.5,
                                color: 'var(--text-muted)',
                                width: 46,
                                flexShrink: 0,
                              }}
                            >
                              {task.identifier}
                            </span>

                            <button
                              type="button"
                              onClick={(e) => void handleQuickCycleStatus(e, task)}
                              title="Cycle status"
                              style={{ display: 'inline-flex', alignItems: 'center' }}
                            >
                              <TaskStatusIcon status={task.status} size={14} />
                            </button>

                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {task.title}
                            </span>

                            {task.deliverableSummary && (
                              <span
                                style={{
                                  fontSize: 11.5,
                                  color: 'var(--text-tertiary)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: 260,
                                }}
                              >
                                · {task.deliverableSummary}
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                            {task.prUrl && (
                              <a
                                href={task.prUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  fontSize: 11.5,
                                  color: 'var(--agent-green)',
                                  padding: '2px 7px',
                                  borderRadius: 'var(--radius-full)',
                                  background: 'var(--surface-2)',
                                  border: '1px solid var(--border-subtle)',
                                }}
                              >
                                <ExternalLink size={11} strokeWidth={1.5} />
                                PR
                              </a>
                            )}

                            {assignee ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onJumpToAgent(assignee.id);
                                }}
                                title={`Open ${assignee.name} chat`}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: '2px 8px',
                                  borderRadius: 'var(--radius-full)',
                                  background: 'var(--surface-2)',
                                  border: '1px solid var(--border-subtle)',
                                  fontSize: 11.5,
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                <span
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '9999px',
                                    background: getColorVar(assignee.color),
                                  }}
                                />
                                {assignee.name}
                              </button>
                            ) : (
                              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                                Unassigned
                              </span>
                            )}

                            {project.previewUrl && task.status !== 'done' && task.status !== 'cancelled' && (
                              <button
                                type="button"
                                disabled={qaRunningTaskId === task.id}
                                onClick={(e) => void handleRunTaskQa(e, task)}
                                title={`Run headless Browser QA on ${project.previewUrl}`}
                                style={{
                                  height: 24,
                                  padding: '0 8px',
                                  borderRadius: 'var(--radius-full)',
                                  background: 'var(--surface-2)',
                                  border: '1px solid var(--border-subtle)',
                                  fontSize: 11.5,
                                  color: 'var(--text-secondary)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <FlaskConical size={10} strokeWidth={1.75} />
                                {qaRunningTaskId === task.id ? 'QA…' : 'QA'}
                              </button>
                            )}

                            {task.status !== 'done' && task.status !== 'cancelled' && (
                              <button
                                type="button"
                                disabled={isDispatching}
                                onClick={(e) => void handleDispatch(e, task)}
                                title={
                                  assignee
                                    ? `Run with ${assignee.name}`
                                    : 'Assign an agent to dispatch'
                                }
                                style={{
                                  height: 24,
                                  padding: '0 8px',
                                  borderRadius: 'var(--radius-full)',
                                  background: assignee ? 'var(--surface-3)' : 'transparent',
                                  border: '1px solid var(--border-subtle)',
                                  fontSize: 11.5,
                                  color: assignee ? 'var(--text-primary)' : 'var(--text-muted)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <Play size={10} strokeWidth={1.75} />
                                {isDispatching ? 'Queuing' : 'Run'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        ) : (
          /* Linear Board View */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(210px, 1fr))',
              gap: 10,
              height: '100%',
              minHeight: 0,
              overflowX: 'auto',
            }}
          >
            {BOARD_STATUSES.map((status) => {
              const items = projectTasks.filter((t) => t.status === status);
              const meta = TASK_STATUS_META[status];
              return (
                <div
                  key={status}
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    minHeight: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '2px 4px',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500 }}>
                      <TaskStatusIcon status={status} size={13} />
                      <span>{meta.label}</span>
                      <span className="mono-num" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        {items.length}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenNewTask({ status })}
                      style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                    >
                      <Plus size={13} strokeWidth={1.5} />
                    </button>
                  </div>

                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {items.map((task) => {
                      const assignee = projectAgents.find((a) => a.id === task.assigneeAgentId) ?? null;
                      return (
                        <div
                          key={task.id}
                          onClick={() => onOpenTask(task)}
                          style={{
                            padding: 10,
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--surface-1)',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {task.identifier}
                            </span>
                            <PriorityBars priority={task.priority} />
                          </div>
                          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', lineHeight: '17px' }}>
                            {task.title}
                          </div>
                          {task.deliverableSummary && (
                            <div
                              style={{
                                fontSize: 11.5,
                                color: 'var(--text-tertiary)',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}
                            >
                              {task.deliverableSummary}
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                            {assignee ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                <span
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '9999px',
                                    background: getColorVar(assignee.color),
                                  }}
                                />
                                {assignee.name}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Unassigned</span>
                            )}
                            {assignee && task.status !== 'done' && (
                              <button
                                type="button"
                                onClick={(e) => void handleDispatch(e, task)}
                                style={{
                                  fontSize: 11,
                                  color: 'var(--text-primary)',
                                  padding: '2px 7px',
                                  borderRadius: 'var(--radius-full)',
                                  background: 'var(--surface-3)',
                                }}
                              >
                                Run
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
