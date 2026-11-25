import type { Channel, RoomSession } from '@atelier/contracts';
import { Check, ChevronDown, MessageSquarePlus, Pencil, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useT, type TFn } from '../i18n';
import { toast } from './Toast';

export function sessionLabel(s: Pick<RoomSession, 'name' | 'seq'>, tr: TFn): string {
  return s.name?.trim() || tr('Session {v0}', { v0: s.seq });
}

/**
 * Session switcher for an agent's personal chat: start a named session, reopen an earlier one,
 * rename any of them. A chat that predates sessions shows a single implicit "Session 1".
 */
export function AgentSessionBar({
  channel,
  sessions,
  busy,
}: {
  channel: Channel;
  sessions: RoomSession[];
  /** True while the agent is working: the server refuses to switch sessions mid-turn. */
  busy: boolean;
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
      setCreating(false);
      setOpen(false);
    }
  };

  const switchTo = async (s: RoomSession) => {
    if (s.id === channel.currentSessionId) {
      setOpen(false);
      return;
    }
    const ok = await run(() => api.activateAgentSession(channel.id, s.id), tr('Could not switch session'));
    if (ok) setOpen(false);
  };

  const saveRename = async (s: RoomSession) => {
    const ok = await run(() => api.renameSession(channel.id, s.id, renameValue.trim()), tr('Could not rename session'));
    if (ok) setRenamingId(null);
  };

  const rowBtn = {
    width: 24,
    height: 24,
    borderRadius: 6,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-tertiary)',
    flexShrink: 0,
  } as const;

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
          color: 'var(--text-secondary)',
          background: open ? 'var(--surface-2)' : 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentLabel}</span>
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="listbox"
          className="glass"
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            zIndex: 30,
            width: 280,
            maxHeight: 360,
            overflowY: 'auto',
            padding: 6,
            borderRadius: 12,
            border: '1px solid var(--border-default)',
            background: 'var(--surface-2)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createSession();
              }}
              style={{ display: 'flex', gap: 6, padding: 4 }}
            >
              <input
                autoFocus
                type="text"
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
                placeholder={tr('Session name (optional)')}
                style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12.5 }}
              />
              <button type="submit" disabled={pending} title={tr('Start session')} style={{ ...rowBtn, color: 'var(--text-primary)' }}>
                <Check size={14} />
              </button>
              <button type="button" onClick={() => setCreating(false)} title={tr('Cancel')} style={rowBtn}>
                <X size={14} />
              </button>
            </form>
          ) : (
            <button
              type="button"
              disabled={pending || busy}
              onClick={() => setCreating(true)}
              title={busy ? tr('Wait for the agent to finish first') : undefined}
              className="transition-atelier"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 8px',
                borderRadius: 8,
                fontSize: 12.5,
                color: 'var(--text-primary)',
                opacity: busy ? 0.5 : 1,
                textAlign: 'left',
              }}
            >
              <MessageSquarePlus size={14} /> {tr('New session')}
            </button>
          )}

          {ordered.length > 0 && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 2px' }} />}

          {ordered.map((s) => {
            const isCurrent = s.id === channel.currentSessionId;
            if (renamingId === s.id) {
              return (
                <form
                  key={s.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveRename(s);
                  }}
                  style={{ display: 'flex', gap: 6, padding: 4 }}
                >
                  <input
                    autoFocus
                    type="text"
                    value={renameValue}
                    maxLength={80}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setRenamingId(null)}
                    placeholder={tr('Session {v0}', { v0: s.seq })}
                    style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12.5 }}
                  />
                  <button type="submit" disabled={pending} title={tr('Save')} style={{ ...rowBtn, color: 'var(--text-primary)' }}>
                    <Check size={14} />
                  </button>
                  <button type="button" onClick={() => setRenamingId(null)} title={tr('Cancel')} style={rowBtn}>
                    <X size={14} />
                  </button>
                </form>
              );
            }
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={isCurrent}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 8,
                  background: isCurrent ? 'var(--surface-3)' : 'transparent',
                }}
              >
                <button
                  type="button"
                  disabled={pending || (busy && !isCurrent)}
                  onClick={() => void switchTo(s)}
                  className="transition-atelier"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '7px 8px',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    opacity: busy && !isCurrent ? 0.5 : 1,
                  }}
                >
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
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                    {new Date(s.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
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
                  style={rowBtn}
                >
                  <Pencil size={12} />
                </button>
              </div>
            );
          })}

          {ordered.length === 0 && (
            <div style={{ padding: '6px 8px', fontSize: 11.5, color: 'var(--text-muted)' }}>
              {tr('This chat has one session so far. Start a new one to keep topics separate.')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
