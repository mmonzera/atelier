import { AlertCircle, Check, Info, Trash2 } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Toasts: centered at the bottom, rising in from below.
 * Call from anywhere (no provider needed):  toast.success('Saved')  toast.deleted('Task deleted')
 * Mount <Toaster /> once at the app root.
 */

export type ToastKind = 'success' | 'deleted' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  leaving: boolean;
}

const MAX_VISIBLE = 3;
const EXIT_MS = 220;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot() {
  return items;
}

function push(kind: ToastKind, message: string) {
  // identical toast already on screen: don't stack duplicates
  if (items.some((t) => !t.leaving && t.kind === kind && t.message === message)) return;
  items = [...items, { id: nextId++, kind, message, leaving: false }];
  const live = items.filter((t) => !t.leaving);
  if (live.length > MAX_VISIBLE) dismiss(live[0].id);
  emit();
}

function dismiss(id: number) {
  const target = items.find((t) => t.id === id);
  if (!target || target.leaving) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, EXIT_MS);
}

export const toast = {
  success: (message: string) => push('success', message),
  deleted: (message: string) => push('deleted', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
};

const LOOK: Record<ToastKind, { icon: typeof Check; color: string }> = {
  success: { icon: Check, color: 'var(--agent-green)' },
  deleted: { icon: Trash2, color: 'var(--text-secondary)' },
  error: { icon: AlertCircle, color: 'var(--agent-red)' },
  info: { icon: Info, color: 'var(--agent-blue)' },
};

function ToastView({ item }: { item: ToastItem }) {
  const { icon: Icon, color } = LOOK[item.kind];
  const duration = item.kind === 'error' ? 5500 : 3200;
  const [hover, setHover] = useState(false);

  // auto-dismiss; hovering pauses it (the timer restarts on mouse leave)
  useEffect(() => {
    if (item.leaving || hover) return;
    const t = window.setTimeout(() => dismiss(item.id), duration);
    return () => window.clearTimeout(t);
  }, [item.id, item.leaving, duration, hover]);

  return (
    <div
      role={item.kind === 'error' ? 'alert' : 'status'}
      className={`toast ${item.leaving ? 'toast-out' : 'toast-in'}`}
      onClick={() => dismiss(item.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '9999px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color,
          background: 'rgba(255, 255, 255, 0.07)',
        }}
      >
        <Icon size={13} strokeWidth={2.25} />
      </span>
      <span style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-primary)' }}>
        {item.message}
      </span>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="toast-region" aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
