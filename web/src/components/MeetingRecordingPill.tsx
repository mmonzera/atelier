import type { MeetingStatusEvent } from '@atelier/contracts';
import { AlertTriangle, Mic, Pause, Play, Square, Zap } from 'lucide-react';
import { useState } from 'react';
import { meetingsApi } from '../api';
import { toast } from '../components/Toast';
import { useT } from '../i18n';

export function MeetingRecordingPill({ event }: { event: MeetingStatusEvent }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const { meeting, canSwitchSmallerModel, smallerModelId } = event;
  const isLagging = meeting.status === 'recording' && meeting.mode === 'live' && meeting.pendingChunks > 3;

  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Meeting action failed'));
    } finally {
      setBusy(false);
    }
  };

  let dotColor = 'var(--agent-red)';
  let label = t('Local transcript · lagging {sec}s', { sec: meeting.lagSeconds });
  if (meeting.status === 'recording' && meeting.mode === 'economy') {
    dotColor = 'var(--agent-amber)';
    label = t('Economy mode · {count} queued', { count: meeting.pendingChunks });
  } else if (meeting.status === 'transcribing') {
    dotColor = 'var(--agent-blue)';
    label = t('Transcribing {pct}%', { pct: meeting.transcribeProgress });
  } else if (meeting.status === 'identifying') {
    dotColor = 'var(--agent-blue)';
    label = t('Finding the speakers…');
  } else if (meeting.status === 'summarizing') {
    dotColor = 'var(--agent-blue)';
    label = t('Writing meeting notes…');
  } else if (meeting.status === 'pending') {
    dotColor = 'var(--agent-amber)';
    label = t('Transcription paused · {count} pending', { count: meeting.pendingChunks });
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        fontSize: 12,
        color: 'var(--text-primary)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '9999px',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <Mic size={13} strokeWidth={1.7} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
      <span>{label}</span>

      {event.warning && (
        <span
          title={event.warning}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: 280,
            color: 'var(--agent-amber)',
            fontSize: 11.5,
          }}
        >
          <AlertTriangle size={12} strokeWidth={1.7} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.warning}
          </span>
        </span>
      )}

      {isLagging && canSwitchSmallerModel && smallerModelId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(() => meetingsApi.switchModel(meeting.id, smallerModelId))}
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-3)',
            border: '1px solid var(--border-default)',
            fontSize: 11,
            color: 'var(--text-primary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Zap size={11} strokeWidth={1.7} />
          {t('Switch to smaller model')}
        </button>
      )}

      {isLagging && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(() => meetingsApi.defer(meeting.id))}
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-3)',
            border: '1px solid var(--border-default)',
            fontSize: 11,
            color: 'var(--text-primary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Pause size={11} strokeWidth={1.7} />
          {t('Continue later')}
        </button>
      )}

      {meeting.status === 'pending' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(() => meetingsApi.resume(meeting.id))}
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--agent-blue)',
            fontSize: 11,
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Play size={11} strokeWidth={1.7} />
          {t('Resume')}
        </button>
      )}

      {meeting.status === 'recording' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(() => meetingsApi.stop(meeting.id))}
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'rgba(239, 68, 68, 0.16)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            fontSize: 11,
            color: 'var(--agent-red)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Square size={10} fill="currentColor" strokeWidth={1.5} />
          {t('Stop')}
        </button>
      )}
    </div>
  );
}
