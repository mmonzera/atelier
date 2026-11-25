import type { Channel, RoomSession } from '@atelier/contracts';
import { Check, ChevronDown, MessagesSquare, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useT, type TFn } from '../i18n';
import { toast } from './Toast';

export function sessionLabel(s: Pick<RoomSession, 'name' | 'seq'>, tr: TFn): string {
  return s.name?.trim() || tr('Session {v0}', { v0: s.seq });
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const NEW_SESSION_KEY = IS_MAC ? '⌘T' : 'Ctrl T';

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

  // Cmd/Ctrl+T starts a new session (when the agent is idle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
        if (busy || pending) return;
        e.preventDefault();
        setOpen(true);
        setCreating(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, pending]);

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
    <div ref={rootRef} style={{ position: 'relative', minWidth: 0, flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={tr('Chat sessions')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="transition-atelier"
        style={{
          maxWidth: 240,
          height: 36,
          padding: '0 12px 0 6px',
          borderRadius: 'var(--radius-md)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--text-primary)',
          background: open ? 'var(--surface-2)' : 'var(--surface-1)',
          border: `1px solid ${open ? 'var(--border-default)' : 'var(--border-subtle)'}`,
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            background: 'linear-gradient(135deg, var(--agent-cobalt), var(--agent-purple))',
          }}
        >
          <MessagesSquare size={13} strokeWidth={1.8} />
        </span>
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
            top: 44,
            left: 0,
            zIndex: 30,
            width: 300,
            maxHeight: 400,
            overflowY: 'auto',
            padding: 6,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-2)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
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
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >
            <span>{tr('Sessions')}</span>
            <span className="mono-num">{ordered.length}</span>
          </div>

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
                  paddingRight: 6,
                  borderRadius: 10,
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
                    padding: '9px 10px',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    opacity: busy && !isCurrent ? 0.5 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flexShrink: 0,
                      boxSizing: 'border-box',
                      background: isCurrent ? 'var(--agent-green)' : 'transparent',
                      border: isCurrent ? 'none' : '1.5px solid var(--text-muted)',
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 14,
                      color: 'var(--text-primary)',
                      fontWeight: isCurrent ? 600 : 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sessionLabel(s, tr)}
                  </span>
                  {isCurrent ? (
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--agent-green)', whiteSpace: 'nowrap' }}>
                      ✓ {tr('Active')}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(s.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                    </span>
                  )}
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
            <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: '17px' }}>
              {tr('This chat has one session so far. Start a new one to keep topics separate.')}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 6px' }} />

          {creating ? (
            <InlineNameForm
              value={newName}
              onChange={setNewName}
              onSubmit={() => void createSession()}
              onCancel={() => setCreating(false)}
              placeholder={tr('Session name (optional)')}
              submitTitle={tr('Start session')}
              pending={pending}
            />
          ) : (
            <button
              type="button"
              disabled={pending || busy}
              onClick={() => setCreating(true)}
              title={busy ? tr('Wait for the agent to finish first') : undefined}
              className="session-row transition-atelier"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 10,
                textAlign: 'left',
                opacity: busy ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                  border: '1px dashed var(--text-muted)',
                }}
              >
                <Plus size={13} />
              </span>
              <span style={{ flex: 1, fontSize: 14, color: 'var(--text-primary)' }}>{tr('New session')}</span>
              <kbd
                style={{
                  padding: '2px 7px',
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontFamily: 'inherit',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border-default)',
                  background: 'var(--surface-1)',
                }}
              >
                {NEW_SESSION_KEY}
              </kbd>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
