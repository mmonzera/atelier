import type { AgentAvatarShape, AgentColor, AgentStatus, TaskPriority, TaskStatus } from '@atelier/contracts';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Clock,
  XCircle,
} from 'lucide-react';
import { BotMascot } from './mascot/BotMascot';
import { MASCOT_COLORS } from './mascot/mascotConfig';

export function getColorVar(color: AgentColor): string {
  if (color in MASCOT_COLORS) {
    return `var(--agent-${color})`;
  }
  return 'var(--agent-green)';
}

export function getAgentColor(color: AgentColor, status?: AgentStatus): string {
  if (status === 'error') return 'var(--agent-red)';
  return getColorVar(color);
}

export function BotTwoDotAvatar({
  size = 28,
  color = 'green',
  shape,
  seed,
  status,
  interactive = true,
  active = false,
}: {
  size?: number;
  color?: AgentColor;
  shape?: AgentAvatarShape;
  seed?: string;
  status?: AgentStatus;
  interactive?: boolean;
  active?: boolean;
}) {
  return (
    <BotMascot
      size={size}
      color={color}
      shape={shape}
      seed={seed}
      status={status}
      interactive={interactive}
      active={active}
    />
  );
}

const TILE_ACCENTS = [
  { bg: '#23202a', fg: '#e4e4ea' },
  { bg: '#1e242b', fg: '#94a3b8' },
  { bg: '#25221e', fg: '#d4c3a3' },
  { bg: '#1f2623', fg: '#a7cbb9' },
];

export function ProjectTile({
  name,
  size = 28,
  active = false,
}: {
  name: string;
  size?: number;
  active?: boolean;
}) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const palette = TILE_ACCENTS[Math.abs(hash) % TILE_ACCENTS.length];
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'AT';

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-sm)',
        background: palette.bg,
        color: palette.fg,
        border: active ? '1px solid rgba(228, 228, 234, 0.45)' : '1px solid var(--border-subtle)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size <= 24 ? 10 : 11,
        fontWeight: 500,
        letterSpacing: '0.02em',
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

export function DotMatrixGrid({
  color = 'var(--text-secondary)',
  pulsing = false,
}: {
  color?: string;
  pulsing?: boolean;
}) {
  return (
    <span
      className={pulsing ? 'dot-matrix-pulse' : undefined}
      style={{
        display: 'inline-grid',
        gridTemplateColumns: 'repeat(3, 3px)',
        gridTemplateRows: 'repeat(2, 3px)',
        gap: '2px',
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {Array.from({ length: 6 }).map((_, idx) => (
        <span
          key={idx}
          style={{
            width: 3,
            height: 3,
            borderRadius: 1,
            background: color,
            opacity: pulsing ? 0.9 : 0.65,
          }}
        />
      ))}
    </span>
  );
}

export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; color: string; short: string }
> = {
  in_progress: { label: 'In Progress', color: 'var(--agent-amber)', short: 'In progress' },
  in_review: { label: 'In Review', color: 'var(--agent-blue)', short: 'In review' },
  todo: { label: 'Todo', color: 'var(--text-secondary)', short: 'Todo' },
  backlog: { label: 'Backlog', color: 'var(--text-muted)', short: 'Backlog' },
  done: { label: 'Done', color: 'var(--agent-green)', short: 'Done' },
  cancelled: { label: 'Cancelled', color: 'var(--text-muted)', short: 'Cancelled' },
};

export function TaskStatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const color = TASK_STATUS_META[status].color;
  switch (status) {
    case 'backlog':
      return <CircleDashed size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
    case 'todo':
      return <Circle size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
    case 'in_progress':
      return <CircleDot size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
    case 'in_review':
      return <Clock size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
    case 'done':
      return <CheckCircle2 size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
    case 'cancelled':
      return <XCircle size={size} strokeWidth={1.5} style={{ color, flexShrink: 0 }} />;
  }
}

export function PriorityBars({ priority }: { priority: TaskPriority }) {
  if (priority === 'urgent') {
    return (
      <span title="Urgent" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <AlertCircle size={13} strokeWidth={1.5} style={{ color: 'var(--agent-red)' }} />
      </span>
    );
  }
  const activeBars =
    priority === 'high' ? 3 : priority === 'medium' ? 2 : priority === 'low' ? 1 : 0;

  return (
    <span
      title={`Priority: ${priority}`}
      style={{
        display: 'inline-flex',
        alignItems: 'flex-end',
        gap: 1.5,
        height: 11,
        width: 13,
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {[5, 8, 11].map((h, idx) => (
        <span
          key={h}
          style={{
            width: 2.5,
            height: h,
            borderRadius: 1,
            background: idx < activeBars ? 'var(--text-secondary)' : 'rgba(148, 148, 163, 0.22)',
          }}
        />
      ))}
    </span>
  );
}

export function TokenRing({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const r = 5;
  const c = 2 * Math.PI * r;
  const offset = c - (clamped / 100) * c;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--text-tertiary)',
        fontSize: 12,
      }}
      title={label}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="rgba(148,148,163,0.25)"
          strokeWidth="1.5"
        />
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="var(--text-secondary)"
          strokeWidth="1.5"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="mono-num">{clamped}%</span>
    </span>
  );
}

export function FormattedText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((line, i) => {
        if (!line.trim()) {
          return <div key={i} style={{ height: 4 }} />;
        }
        const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
          <div key={i} style={{ wordBreak: 'break-word' }}>
            {parts.map((part, j) => {
              if (part.startsWith('**') && part.endsWith('**')) {
                return (
                  <span key={j} style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                    {part.slice(2, -2)}
                  </span>
                );
              }
              if (part.startsWith('`') && part.endsWith('`')) {
                return (
                  <code
                    key={j}
                    className="mono-num"
                    style={{
                      fontSize: 12,
                      padding: '1px 5px',
                      borderRadius: 5,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {part.slice(1, -1)}
                  </code>
                );
              }
              return <span key={j}>{part}</span>;
            })}
          </div>
        );
      })}
    </div>
  );
}
