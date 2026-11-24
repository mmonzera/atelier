import type { MeetingAppEvent, Settings } from '@atelier/contracts';
import { Copy, Mic, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, meetingsApi } from '../api';
import { useLang, useT } from '../i18n';
import { buildMeetingNotice } from '../meetingNotice';
import { primaryBtnStyle, secondaryBtnStyle } from './modals/ModalShell';
import { toast } from './Toast';

/**
 * Bottom-right card shown when the desktop shell sees a meeting app take the microphone
 * (offer to take notes) or release it while Atelier is recording (offer to stop).
 * Nothing is ever recorded without the user's click.
 */
export function MeetingAppPrompt({
  event,
  settings,
  onDismiss,
  onOpenSettings,
}: {
  event: MeetingAppEvent;
  settings: Settings;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once notes started from this card: shows the "tell the participants" step. */
  const [started, setStarted] = useState(false);

  // A new event replaces the card's contents.
  useEffect(() => {
    setBusy(false);
    setError(null);
    setStarted(false);
  }, [event]);

  // The "started" confirmation goes away on its own.
  useEffect(() => {
    if (!started) return;
    const timer = window.setTimeout(onDismiss, 20_000);
    return () => window.clearTimeout(timer);
  }, [started, onDismiss]);

  const remind = settings.meeting?.remindParticipants ?? true;
  const isBrowser = event.appId === 'browser';
  const endedWhileRecording = event.state === 'ended' && Boolean(event.meetingId);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const date = new Date().toLocaleString(lang === 'id' ? 'id-ID' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      await meetingsApi.start({ title: `${isBrowser ? t('Browser meeting') : event.appName} · ${date}` });
      if (remind) setStarted(true);
      else {
        toast.success(t('Taking meeting notes'));
        onDismiss();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to start meeting notes'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!event.meetingId) return;
    setBusy(true);
    try {
      onDismiss();
      await meetingsApi.stop(event.meetingId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Meeting action failed'));
    } finally {
      setBusy(false);
    }
  };

  const neverAsk = async () => {
    const current = settings.meeting?.ignoredMeetingApps ?? [];
    onDismiss();
    try {
      await api.updateSettings({
        meeting: { ignoredMeetingApps: [...new Set([...current, event.appId])] },
      });
      toast.info(t('Atelier will not ask again for {app}. Change it in Settings → Meeting.', { app: event.appName }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save settings'));
    }
  };

  const copyNotice = async () => {
    try {
      await navigator.clipboard.writeText(buildMeetingNotice(settings, lang));
      toast.success(t('Notification message copied'));
      onDismiss();
    } catch {
      toast.error(t('Failed to copy message'));
    }
  };

  let title: string;
  let body: string;
  if (started) {
    title = t('Taking meeting notes');
    body = t('Let the participants know: paste the notice into the meeting chat.');
  } else if (endedWhileRecording) {
    title = t('{app} released the microphone', { app: event.appName });
    body = t('Has the meeting finished? Stop to get the transcript and notes.');
  } else {
    title = t('{app} is using the microphone', { app: event.appName });
    body = isBrowser
      ? t('In a browser meeting (e.g. Google Meet)? Atelier can take notes for it.')
      : t('Take notes for this meeting? Your mic and the laptop sound are transcribed on this laptop.');
  }

  // Portal to <body>: the main column is its own stacking context, so the right panel would
  // otherwise cover the card's lower half.
  return createPortal(
    <div
      role="dialog"
      aria-live="polite"
      aria-label={title}
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 60,
        width: 340,
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
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: '9999px',
            background: started ? 'rgba(239, 68, 68, 0.16)' : 'var(--surface-3)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Mic size={14} strokeWidth={1.7} style={{ color: started ? 'var(--agent-red)' : 'var(--text-secondary)' }} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.45 }}>{body}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('Close')}
          style={{ padding: 2, color: 'var(--text-tertiary)', background: 'transparent', flexShrink: 0 }}
        >
          <X size={14} strokeWidth={1.7} />
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--agent-red)', lineHeight: 1.45 }}>
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              onDismiss();
              onOpenSettings();
            }}
            style={{ color: 'var(--agent-blue)', background: 'transparent', padding: 0, fontSize: 11.5 }}
          >
            {t('Open Meeting settings')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {started ? (
          <button type="button" onClick={() => void copyNotice()} style={{ ...primaryBtnStyle, ...btn }}>
            <Copy size={12} strokeWidth={1.7} />
            {t('Copy notice message')}
          </button>
        ) : endedWhileRecording ? (
          <>
            <button type="button" disabled={busy} onClick={() => void stop()} style={{ ...primaryBtnStyle, ...btn }}>
              <Square size={10} fill="currentColor" strokeWidth={1.5} />
              {t('Stop taking notes')}
            </button>
            <button type="button" onClick={onDismiss} style={{ ...secondaryBtnStyle, ...btn }}>
              {t('Keep recording')}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void start()} style={{ ...primaryBtnStyle, ...btn }}>
              <Mic size={12} strokeWidth={1.7} />
              {busy ? t('Starting…') : t('Take notes')}
            </button>
            <button type="button" onClick={onDismiss} style={{ ...secondaryBtnStyle, ...btn }}>
              {t('Not now')}
            </button>
          </>
        )}
      </div>

      {!started && !endedWhileRecording && (
        <button
          type="button"
          onClick={() => void neverAsk()}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            padding: 0,
            fontSize: 11,
            color: 'var(--text-tertiary)',
            textDecoration: 'underline',
          }}
        >
          {t("Don't ask again for {app}", { app: isBrowser ? t('browsers') : event.appName })}
        </button>
      )}
    </div>,
    document.body,
  );
}

const btn: React.CSSProperties = {
  padding: '6px 11px',
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};
