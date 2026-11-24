import type { MeetingSession, MeetingStatusEvent, Settings } from '@atelier/contracts';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileText,
  Mic,
  NotebookPen,
  Pencil,
  Play,
  Search,
  Settings as SettingsIcon,
  Trash2,
  X,
} from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { meetingsApi } from '../api';
import { Markdown } from '../components/Markdown';
import { inputStyle, primaryBtnStyle, secondaryBtnStyle } from '../components/modals/ModalShell';
import { toast } from '../components/Toast';
import { useLang, useT } from '../i18n';
import { buildMeetingNotice } from '../meetingNotice';

type TFn = ReturnType<typeof useT>;

const pageTitleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 500,
  lineHeight: '28px',
  color: 'var(--text-primary)',
  margin: 0,
};

const backBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  color: 'var(--text-secondary)',
  marginBottom: 18,
};

const cardStyle: CSSProperties = {
  padding: '16px 18px',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-1)',
  border: '1px solid var(--border-subtle)',
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 10,
};

const smallBtn: CSSProperties = {
  padding: '0 11px',
  height: 30,
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

function formatDate(iso: string, lang: 'en' | 'id'): string {
  return new Date(iso).toLocaleString(lang === 'id' ? 'id-ID' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function statusMeta(t: TFn, m: MeetingSession): { label: string; color: string } {
  switch (m.status) {
    case 'recording':
      return { label: t('Recording'), color: 'var(--agent-red)' };
    case 'transcribing':
      return { label: t('Transcribing {pct}%', { pct: m.transcribeProgress }), color: 'var(--agent-blue)' };
    case 'summarizing':
      return { label: t('Writing notes…'), color: 'var(--agent-blue)' };
    case 'pending':
      return { label: t('Waiting to transcribe'), color: 'var(--agent-amber)' };
    case 'error':
      return { label: t('Failed'), color: 'var(--agent-red)' };
    default:
      return { label: t('Ready'), color: 'var(--agent-green)' };
  }
}

/** Plain-text first line of the summary, for the list. */
function summaryPreview(m: MeetingSession): string {
  const source = m.summary ?? m.transcript.map((s) => s.text).join(' ');
  // Skip headings ("## Decisions"): the first real sentence says more.
  const lines = source
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^[>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
    .filter((l) => l.length > 0);
  return lines.slice(0, 2).join(' · ');
}

export function meetingToMarkdown(m: MeetingSession, t: TFn, lang: 'en' | 'id'): string {
  const parts = [`# ${m.title}`, '', `${formatDate(m.createdAt, lang)} · ${m.modelId}`, ''];
  parts.push(`## ${t('Notes')}`, '', m.summary?.trim() || t('No notes yet.'), '');
  parts.push(`## ${t('Transcript')}`, '');
  const text = m.transcript.map((s) => s.text.trim()).filter(Boolean);
  parts.push(text.length ? text.join('\n\n') : t('No transcript yet.'), '');
  return parts.join('\n');
}

function safeFileName(title: string): string {
  return (title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'meeting').slice(0, 80);
}

export function MeetingsView({
  settings,
  activeMeeting,
  selectedId,
  onSelect,
  onBack,
  onOpenSettings,
}: {
  settings: Settings;
  activeMeeting: MeetingStatusEvent | null;
  selectedId: string | null;
  onSelect: (meetingId: string | null) => void;
  onBack: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [meetings, setMeetings] = useState<MeetingSession[] | null>(null);
  const [captureAvailable, setCaptureAvailable] = useState(false);
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await meetingsApi.list();
      setMeetings(res.meetings);
      setCaptureAvailable(res.captureAvailable);
    } catch (err) {
      setMeetings((prev) => prev ?? []);
      toast.error(err instanceof Error ? err.message : t('Failed to load meetings'));
    }
  }, [t]);

  // Reload whenever the running meeting changes state (new chunk, notes ready, …).
  const activeKey = activeMeeting
    ? `${activeMeeting.meeting.id}:${activeMeeting.meeting.status}:${activeMeeting.meeting.completedChunks}`
    : 'none';
  useEffect(() => {
    void load();
  }, [load, activeKey]);

  const recording = activeMeeting?.meeting.status === 'recording';
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (meetings ?? []).filter(
        (m) =>
          !needle ||
          m.title.toLowerCase().includes(needle) ||
          (m.summary ?? '').toLowerCase().includes(needle) ||
          m.transcript.some((s) => s.text.toLowerCase().includes(needle)),
      ),
    [meetings, needle],
  );

  const start = async () => {
    setStarting(true);
    try {
      const ev = await meetingsApi.start();
      toast.success(t('Taking meeting notes'));
      if (settings.meeting?.remindParticipants ?? true) {
        await navigator.clipboard.writeText(buildMeetingNotice(settings, lang)).catch(() => undefined);
        toast.info(t('Notice message copied: paste it into the meeting chat'));
      }
      onSelect(ev.meeting.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to start meeting notes'));
    } finally {
      setStarting(false);
    }
  };

  const selected = selectedId ? (meetings ?? []).find((m) => m.id === selectedId) ?? null : null;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 4px 40px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '8px 12px 0' }}>
        {selectedId ? (
          <>
            <button type="button" onClick={() => onSelect(null)} className="transition-atelier" style={backBtnStyle}>
              <ArrowLeft size={14} strokeWidth={1.5} />
              {t('All meeting notes')}
            </button>
            {selected ? (
              <MeetingDetail
                meeting={selected}
                onChanged={load}
                onDeleted={() => {
                  onSelect(null);
                  void load();
                }}
              />
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                {meetings === null ? t('Loading…') : t('This meeting no longer exists.')}
              </div>
            )}
          </>
        ) : (
          <>
            <button type="button" onClick={onBack} className="transition-atelier" style={backBtnStyle}>
              <ArrowLeft size={14} strokeWidth={1.5} />
              {t('Back to chat')}
            </button>

            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 6 }}>
              <h1 style={pageTitleStyle}>{t('Meeting notes')}</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  title={t('Meeting settings')}
                  aria-label={t('Meeting settings')}
                  style={{ ...secondaryBtnStyle, width: 34, padding: 0 }}
                >
                  <SettingsIcon size={14} strokeWidth={1.6} />
                </button>
                {captureAvailable && (
                  <button
                    type="button"
                    disabled={recording || starting}
                    onClick={() => void start()}
                    style={{ ...primaryBtnStyle, gap: 6, opacity: recording || starting ? 0.5 : 1 }}
                  >
                    <Mic size={13} strokeWidth={1.7} />
                    {recording ? t('Recording…') : starting ? t('Starting…') : t('Start taking notes')}
                  </button>
                )}
              </div>
            </div>
            <p style={{ margin: '0 0 22px', fontSize: 13, lineHeight: '19px', color: 'var(--text-tertiary)' }}>
              {t('Transcripts and notes from meetings Atelier recorded. Audio is transcribed on this laptop.')}
            </p>

            {(meetings?.length ?? 0) > 0 && (
              <label
                style={{
                  height: 38,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '0 12px',
                  marginBottom: 16,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-tertiary)',
                }}
              >
                <Search size={15} strokeWidth={1.5} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Search titles, notes and transcripts')}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13.5, color: 'var(--text-primary)' }}
                />
              </label>
            )}

            {meetings === null ? (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('Loading…')}</div>
            ) : meetings.length === 0 ? (
              <EmptyState captureAvailable={captureAvailable} onOpenSettings={onOpenSettings} />
            ) : filtered.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 2px' }}>
                {t('No meeting matches your search.')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filtered.map((m) => (
                  <MeetingRow key={m.id} meeting={m} onOpen={() => onSelect(m.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MeetingRow({ meeting, onOpen }: { meeting: MeetingSession; onOpen: () => void }) {
  const t = useT();
  const lang = useLang();
  const status = statusMeta(t, meeting);
  const preview = summaryPreview(meeting);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="transition-atelier"
      style={{
        ...cardStyle,
        padding: '13px 16px',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.background = 'var(--surface-2)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
        e.currentTarget.style.background = 'var(--surface-1)';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-3)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'var(--text-secondary)',
        }}
      >
        <FileText size={15} strokeWidth={1.6} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
            {meeting.title}
          </span>
          <StatusBadge label={status.label} color={status.color} />
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{formatDate(meeting.createdAt, lang)}</span>
        {preview && (
          <span
            style={{
              fontSize: 12.5,
              lineHeight: '18px',
              color: 'var(--text-secondary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              marginTop: 2,
            }}
          >
            {preview}
          </span>
        )}
      </span>
    </button>
  );
}

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        color: 'var(--text-secondary)',
        padding: '1px 8px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-subtle)',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '9999px', background: color }} />
      {label}
    </span>
  );
}

function EmptyState({ captureAvailable, onOpenSettings }: { captureAvailable: boolean; onOpenSettings: () => void }) {
  const t = useT();
  const steps = [
    t('Set up local Whisper once in Meeting settings (engine + model).'),
    captureAvailable
      ? t('Join a Zoom, Teams or Google Meet call: Atelier offers to take notes. Or press Start taking notes.')
      : t('Open the Atelier desktop app: recording needs it.'),
    t('Press Stop when the meeting ends. The transcript and notes appear here.'),
  ];
  return (
    <div style={{ ...cardStyle, padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <NotebookPen size={18} strokeWidth={1.5} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{t('No meeting notes yet')}</span>
      </div>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {steps.map((s) => (
          <li key={s} style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--text-secondary)' }}>
            {s}
          </li>
        ))}
      </ol>
      <div>
        <button type="button" onClick={onOpenSettings} style={{ ...secondaryBtnStyle, ...smallBtn }}>
          <SettingsIcon size={13} strokeWidth={1.6} />
          {t('Open Meeting settings')}
        </button>
      </div>
    </div>
  );
}

function MeetingDetail({
  meeting,
  onChanged,
  onDeleted,
}: {
  meeting: MeetingSession;
  onChanged: () => Promise<void> | void;
  onDeleted: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = statusMeta(t, meeting);
  const finished = meeting.status === 'completed' || meeting.status === 'pending' || meeting.status === 'error';

  useEffect(() => {
    setTitle(meeting.title);
    setConfirmDelete(false);
  }, [meeting.id, meeting.title]);

  const saveTitle = async () => {
    setEditing(false);
    const next = title.trim();
    if (!next || next === meeting.title) {
      setTitle(meeting.title);
      return;
    }
    try {
      await meetingsApi.rename(meeting.id, next);
      await onChanged();
    } catch (err) {
      setTitle(meeting.title);
      toast.error(err instanceof Error ? err.message : t('Failed to rename meeting'));
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(meetingToMarkdown(meeting, t, lang));
      toast.success(t('Meeting notes copied'));
    } catch {
      toast.error(t('Failed to copy message'));
    }
  };

  const saveMd = () => {
    const url = URL.createObjectURL(
      new Blob([meetingToMarkdown(meeting, t, lang)], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName(meeting.title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await meetingsApi.remove(meeting.id);
      toast.deleted(t('Meeting deleted'));
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to delete meeting'));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await meetingsApi.resume(meeting.id);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Meeting action failed'));
    } finally {
      setBusy(false);
    }
  };

  const transcript = meeting.transcript.filter((s) => s.text.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Title + meta */}
      <div>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTitle();
              if (e.key === 'Escape') {
                setTitle(meeting.title);
                setEditing(false);
              }
            }}
            aria-label={t('Meeting title')}
            style={{ ...inputStyle, fontSize: 20, fontWeight: 500, padding: '4px 10px' }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={t('Rename')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'transparent', padding: 0, textAlign: 'left' }}
          >
            <h1 style={pageTitleStyle}>{meeting.title}</h1>
            <Pencil size={13} strokeWidth={1.6} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <StatusBadge label={status.label} color={status.color} />
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {formatDate(meeting.createdAt, lang)} · {meeting.modelId}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void copyAll()} style={{ ...secondaryBtnStyle, ...smallBtn }}>
          <Copy size={13} strokeWidth={1.6} />
          {t('Copy')}
        </button>
        <button type="button" onClick={saveMd} style={{ ...secondaryBtnStyle, ...smallBtn }}>
          <Download size={13} strokeWidth={1.6} />
          {t('Save as .md')}
        </button>
        <span style={{ flex: 1 }} />
        {finished &&
          (confirmDelete ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('Delete the notes and transcript for good?')}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                style={{
                  ...secondaryBtnStyle,
                  ...smallBtn,
                  color: 'var(--agent-red)',
                  borderColor: 'rgba(239, 68, 68, 0.4)',
                }}
              >
                <Check size={13} strokeWidth={1.8} />
                {t('Delete')}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} style={{ ...secondaryBtnStyle, ...smallBtn }}>
                <X size={13} strokeWidth={1.8} />
                {t('Cancel')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{ ...secondaryBtnStyle, ...smallBtn, color: 'var(--text-secondary)' }}
            >
              <Trash2 size={13} strokeWidth={1.6} />
              {t('Delete')}
            </button>
          ))}
      </div>

      {meeting.status === 'pending' && (
        <div
          style={{
            ...cardStyle,
            borderColor: 'rgba(245, 158, 11, 0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--text-secondary)' }}>
            {t('{count} pieces of audio are still waiting to be transcribed.', { count: meeting.pendingChunks })}
            {meeting.error && (
              <div style={{ fontSize: 11.5, color: 'var(--agent-red)', marginTop: 3 }}>{meeting.error}</div>
            )}
          </div>
          <button type="button" disabled={busy} onClick={() => void resume()} style={{ ...primaryBtnStyle, ...smallBtn }}>
            <Play size={12} strokeWidth={1.7} />
            {t('Transcribe now')}
          </button>
        </div>
      )}

      {/* Notes */}
      <section style={cardStyle}>
        <div style={eyebrowStyle}>{t('Notes')}</div>
        {meeting.summary ? (
          <div className="markdown-body" style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-primary)' }}>
            <Markdown text={meeting.summary} />
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {meeting.status === 'completed'
              ? t('No notes were written (the transcript was empty or no agent provider is set up).')
              : t('Notes are written by your agent model once the meeting is stopped and transcribed.')}
          </div>
        )}
      </section>

      {/* Transcript */}
      <section style={cardStyle}>
        <div style={{ ...eyebrowStyle, display: 'flex', justifyContent: 'space-between' }}>
          <span>{t('Transcript')}</span>
          {transcript.length > 0 && (
            <span style={{ textTransform: 'none', letterSpacing: 0 }}>
              {t('{count} parts', { count: transcript.length })}
            </span>
          )}
        </div>
        {transcript.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {meeting.status === 'recording'
              ? t('The transcript appears here as the meeting goes on.')
              : t('No speech was transcribed.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {transcript.map((s) => (
              <p
                key={s.seq}
                style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
              >
                {s.text.trim()}
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Bottom-right card when a meeting's notes have just been written. */
export function MeetingReadyCard({
  meeting,
  onOpen,
  onDismiss,
}: {
  meeting: MeetingSession;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 30_000);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  return createPortal(
    <div
      role="status"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 60,
        width: 320,
        padding: 14,
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <NotebookPen size={16} strokeWidth={1.6} style={{ color: 'var(--agent-green)', marginTop: 1, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t('Meeting notes are ready')}</div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meeting.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('Close')}
          style={{ padding: 2, color: 'var(--text-tertiary)', background: 'transparent' }}
        >
          <X size={14} strokeWidth={1.7} />
        </button>
      </div>
      <div>
        <button
          type="button"
          onClick={() => {
            onDismiss();
            onOpen();
          }}
          style={{ ...primaryBtnStyle, ...smallBtn }}
        >
          <FileText size={13} strokeWidth={1.6} />
          {t('Open notes')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
