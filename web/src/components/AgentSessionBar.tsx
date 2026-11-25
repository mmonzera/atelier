import type { Channel, RoomSession } from '@atelier/contracts';
import { Check, ChevronDown, MessagesSquare, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useT, type TFn } from '../i18n';
import { toast } from './Toast';

export function sessionLabel(s: Pick<RoomSession, 'name' | 'seq'>, tr: TFn): string {
  return s.name?.trim() || tr('Session {v0}', { v0: s.seq });
}

const fieldStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  padding: '0 10px',
  fontSize: 12.5,
  color: 'var(--text-primary)',
  background: 'var(--surface-1)',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  outline: 'none',
  boxShadow: 'none',
};

const iconBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-tertiary)',
  flexShrink: 0,
};

function InlineNameForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  submitTitle,
  pending,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder: string;
  submitTitle: string;
  pending: boolean;
}) {
  const tr = useT();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 4 }}
    >
      <input
        autoFocus
        type="text"
        value={value}
        maxLength={80}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        placeholder={placeholder}
        style={fieldStyle}
      />
      <button type="submit" disabled={pending} title={submitTitle} style={{ ...iconBtn, color: 'var(--text-primary)' }}>
        <Check size={14} />
      </button>
      <button type="button" onClick={onCancel} title={tr('Cancel')} style={iconBtn}>
        <X size={14} />
      </button>
    </form>
  );
}

/**
 * Session switcher for an agent's personal chat: start a named session, reopen an earlier one,
 * rename any of them. Picking a session also scrolls the chat to where it starts.
 */
export function AgentSessionBar({
  channel,
  sessions,
  busy,
  onNavigate,
}: {
  channel: Channel;
  sessions: RoomSession[];
  /** True while the agent is working: the server refuses to switch sessions mid-turn. */
  busy: boolean;
  /** Scrolls the chat to the start of a session. */
  onNavigate?: (sessionId: string) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const ordered = useMemo(() => [...sessions].sort((a, b) => b.seq - a.seq), [sessions]);
  const current = sessions.find((s) => s.id === channel.currentSessionId) ?? null;
  const currentLabel = current ? sessionLabel(current, tr) : tr('Session {v0}', { v0: 1 });

  const close = () => {
    setOpen(false);
    setCreating(false);
    setRenamingId(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setPending(true);
    try {
      await fn();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : fallback);
      return false;
    } finally {
      setPending(false);
    }
  };

  const createSession = async () => {
    const ok = await run(() => api.startAgentSession(channel.id, newName.trim() || undefined), tr('Could not start a new session'));
    if (ok) {
      toast.info(tr('Started new session'));
      setNewName('');
      close();
      // the new session's divider appears at the bottom
      window.setTimeout(() => onNavigate?.(''), 0);
    }
  };

  const switchTo = async (s: RoomSession) => {
    if (s.id !== channel.currentSessionId) {
      const ok = await run(() => api.activateAgentSession(channel.id, s.id), tr('Could not switch session'));
      if (!ok) return;
    }
    close();
    onNavigate?.(s.id);
  };

  const saveRename = async (s: RoomSession) => {
    const ok = await run(() => api.renameSession(channel.id, s.id, renameValue.trim()), tr('Could not rename session'));
    if (ok) setRenamingId(null);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={tr('Chat sessions')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="transition-atelier"
        style={{
          maxWidth: 240,
          height: 28,
          padding: '0 10px',
          borderRadius: 'var(--radius-full)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: 'var(--text-primary)',
          background: open ? 'var(--surface-2)' : 'var(--surface-1)',
          border: `1px solid ${open ? 'var(--border-default)' : 'var(--border-subtle)'}`,
        }}
      >
        <MessagesSquare size={13} strokeWidth={1.6} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentLabel}</span>
        <ChevronDown
          size={12}
          style={{ flexShrink: 0, color: 'var(--text-tertiary)', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            zIndex: 30,
            width: 300,
            maxHeight: 380,
            overflowY: 'auto',
            padding: 6,
            borderRadius: 12,
            border: '1px solid var(--border-default)',
            background: 'var(--surface-2)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 4px 4px 8px',
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
              }}
            >
              {tr('Sessions')}
            </span>
            {!creating && (
              <button
                type="button"
                disabled={pending || busy}
                onClick={() => setCreating(true)}
                title={busy ? tr('Wait for the agent to finish first') : tr('New session')}
                className="transition-atelier"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 24,
                  padding: '0 8px',
                  borderRadius: 7,
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Plus size={12} /> {tr('New session')}
              </button>
            )}
          </div>

          {creating && (
            <InlineNameForm
              value={newName}
              onChange={setNewName}
              onSubmit={() => void createSession()}
              onCancel={() => setCreating(false)}
              placeholder={tr('Session name (optional)')}
              submitTitle={tr('Start session')}
              pending={pending}
            />
          )}

          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '2px 4px 4px' }} />

          {ordered.map((s) => {
            const isCurrent = s.id === channel.currentSessionId;
            if (renamingId === s.id) {
              return (
                <InlineNameForm
                  key={s.id}
                  value={renameValue}
                  onChange={setRenameValue}
                  onSubmit={() => void saveRename(s)}
                  onCancel={() => setRenamingId(null)}
                  placeholder={tr('Session {v0}', { v0: s.seq })}
                  submitTitle={tr('Save')}
                  pending={pending}
                />
              );
            }
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={isCurrent}
                className="session-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  paddingRight: 4,
                  borderRadius: 8,
                  background: isCurrent ? 'var(--surface-3)' : 'transparent',
                }}
              >
                <button
                  type="button"
                  disabled={pending || (busy && !isCurrent)}
                  onClick={() => void switchTo(s)}
                  title={busy && !isCurrent ? tr('Wait for the agent to finish first') : undefined}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '7px 8px',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    opacity: busy && !isCurrent ? 0.5 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: isCurrent ? 'var(--agent-green)' : 'var(--border-default)',
                    }}
                  />
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-primary)',
                        fontWeight: isCurrent ? 500 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sessionLabel(s, tr)}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {new Date(s.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
                      {isCurrent ? ` · ${tr('Active')}` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(s.id);
                    setRenameValue(s.name ?? '');
                  }}
                  title={tr('Rename session')}
                  aria-label={tr('Rename session')}
                  className="session-row-action"
                  style={iconBtn}
                >
                  <Pencil size={12} />
                </button>
              </div>
            );
          })}

          {ordered.length === 0 && (
            <div style={{ padding: '6px 8px', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: '17px' }}>
              {tr('This chat has one session so far. Start a new one to keep topics separate.')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
