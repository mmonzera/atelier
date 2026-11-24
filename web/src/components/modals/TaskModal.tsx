import type { Agent, Project, Task, TaskPriority, TaskStatus } from '@atelier/contracts';
import { ExternalLink, MessageSquare, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { TASK_STATUS_META } from '../Atoms';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';
import { Select } from '../Select';
import { toast } from '../Toast';

export function TaskModal({
  project,
  agents,
  existingTask,
  defaultStatus = 'todo',
  defaultAssigneeId = null,
  defaultDescription = '',
  onClose,
  onJumpToAgent,
}: {
  project: Project;
  agents: Agent[];
  existingTask?: Task | null;
  defaultStatus?: TaskStatus;
  defaultAssigneeId?: string | null;
  defaultDescription?: string;
  onClose: () => void;
  onJumpToAgent: (agentId: string) => void;
}) {
  const isEdit = Boolean(existingTask);
  const projectAgents = agents.filter((a) => a.projectId === project.id);

  const [title, setTitle] = useState(existingTask?.title ?? '');
  const [description, setDescription] = useState(
    existingTask?.description ?? defaultDescription,
  );
  const [status, setStatus] = useState<TaskStatus>(existingTask?.status ?? defaultStatus);
  const [priority, setPriority] = useState<TaskPriority>(existingTask?.priority ?? 'medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>(
    existingTask?.assigneeAgentId ?? defaultAssigneeId ?? projectAgents[0]?.id ?? '',
  );
  const [branch, setBranch] = useState(existingTask?.branch ?? '');
  const [prUrl, setPrUrl] = useState(existingTask?.prUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveTask = async (): Promise<Task> => {
    const payload = {
      title: title.trim(),
      description,
      status,
      priority,
      assigneeAgentId: assigneeAgentId || null,
      branch: branch.trim() || null,
      prUrl: prUrl.trim() || null,
    };
    const res = isEdit && existingTask
      ? await api.updateTask(existingTask.id, payload)
      : await api.createTask(project.id, payload);
    return res.task;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Task title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTask();
      toast.success(isEdit ? `Task ${saved.identifier} updated` : `Task ${saved.identifier} created`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setBusy(false);
    }
  };

  const handleDispatch = async () => {
    if (!title.trim()) {
      setError('Task title is required.');
      return;
    }
    if (!assigneeAgentId) {
      setError('Select an agent assignee before dispatching.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTask();
      await api.dispatchTask(saved.id);
      toast.success(`Task ${saved.identifier} dispatched`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch task');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!existingTask) return;
    setBusy(true);
    try {
      await api.deleteTask(existingTask.id);
      toast.deleted(`Task ${existingTask.identifier} deleted`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={isEdit && existingTask ? `${existingTask.identifier} · ${existingTask.title}` : 'New task'}
      subtitle={
        isEdit
          ? `Status: ${TASK_STATUS_META[existingTask!.status].label}`
          : 'Add a task to track agent progress and deliverables.'
      }
      width={560}
      onClose={onClose}
    >
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Title</label>
          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Build Stripe webhook handler + tests"
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Description / Acceptance criteria</label>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Context, files, acceptance criteria..."
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Status</label>
            <Select
              ariaLabel="Status"
              value={status}
              onChange={(v) => setStatus(v as TaskStatus)}
              options={Object.entries(TASK_STATUS_META).map(([key, meta]) => ({
                value: key,
                label: meta.label,
              }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Priority</label>
            <Select
              ariaLabel="Priority"
              value={priority}
              onChange={(v) => setPriority(v as TaskPriority)}
              options={[
                { value: 'urgent', label: 'Urgent' },
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' },
                { value: 'none', label: 'None' },
              ]}
            />
          </div>
          <div>
            <label style={labelStyle}>Assignee agent</label>
            <Select
              ariaLabel="Assignee agent"
              value={assigneeAgentId}
              onChange={setAssigneeAgentId}
              options={[
                { value: '', label: 'Unassigned' },
                ...projectAgents.map((a) => ({ value: a.id, label: a.name, hint: a.role })),
              ]}
            />
          </div>
        </div>

        {existingTask?.deliverableSummary && (
          <div
            style={{
              padding: 10,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 4 }}>
              Latest Deliverable Summary
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)', lineHeight: '19px', whiteSpace: 'pre-wrap' }}>
              {existingTask.deliverableSummary}
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Branch (optional)</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feat/my-task"
              className="mono-num"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>PR URL (optional)</label>
            <input
              type="url"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/..."
              className="mono-num"
              style={inputStyle}
            />
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            paddingTop: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            {isEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDelete()}
                title="Delete task"
                style={{ ...secondaryBtnStyle, color: 'var(--agent-red)', padding: '0 10px' }}
              >
                <Trash2 size={13} strokeWidth={1.5} />
              </button>
            )}
            {assigneeAgentId && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onJumpToAgent(assigneeAgentId);
                }}
                style={secondaryBtnStyle}
              >
                <MessageSquare size={13} strokeWidth={1.5} />
                Agent Chat
              </button>
            )}
            {existingTask?.prUrl && (
              <a href={existingTask.prUrl} target="_blank" rel="noreferrer" style={secondaryBtnStyle}>
                <ExternalLink size={13} strokeWidth={1.5} />
                PR
              </a>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy} style={secondaryBtnStyle}>
              Save
            </button>
            <button
              type="button"
              disabled={busy || !assigneeAgentId}
              onClick={() => void handleDispatch()}
              style={primaryBtnStyle}
            >
              <Play size={12} strokeWidth={1.75} />
              {busy ? 'Working…' : 'Dispatch to Agent'}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}
