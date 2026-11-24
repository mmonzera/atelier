import type { MeetingLevelEvent, MeetingStatusEvent } from '@atelier/contracts';
import { AlertTriangle, Check, Mic, Minimize2, Pause, X, Zap } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { meetingsApi } from '../api';
import { useT } from '../i18n';
import { MEETING_LEVEL_EVENT } from '../state/useWorkspace';
import { toast } from './Toast';

const BAR_COUNT = 38;

/** Recorded time in ms: wall time minus pauses. */
function recordedMs(m: MeetingStatusEvent['meeting'], now: number): number {
  const pausedNow = m.pausedSince ? Math.max(0, now - Date.parse(m.pausedSince)) : 0;
  return Math.max(0, now - Date.parse(m.createdAt) - (m.pausedMs ?? 0) - pausedNow);
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/** RMS (speech is ~0.02–0.2) → bar height 0..1, with a floor so silence still shows a line. */
function levelToHeight(rms: number): number {
  return Math.min(1, Math.max(0.08, Math.sqrt(rms) * 2.1));
}

/**
 * The recorder shown while a meeting is being recorded: a timer, the live waveform of what is
 * being captured, and three round buttons (discard · pause/resume · finish). Collapses to a
 * small pill so it never hides the chat.
 */
export function MeetingRecorder({ event, bottomOffset = 24 }: { event: MeetingStatusEvent; bottomOffset?: number }) {
  // Bottom centre of the main column (lined up with the composer). Its z-index is above full
  // pages (Meeting notes, Plugins, z-index 30), which used to cover it.
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: bottomOffset,
        transform: 'translateX(-50%)',
        zIndex: 40,
        transition: 'bottom 200ms ease',
      }}
    >
      <RecorderPanel event={event} />
    </div>
  );
}

function RecorderPanel({ event }: { event: MeetingStatusEvent }) {
  const t = useT();
  const { meeting, canSwitchSmallerModel, smallerModelId, warning } = event;
  const [now, setNow] = useState(() => Date.now());
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState<null | 'pause' | 'finish' | 'discard' | 'action'>(null);
  const [collapsed, setCollapsed] = useState(false);
  const lastLevelAt = useRef(0);
  const paused = meeting.paused;

  // Timer tick.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Live loudness from the desktop shell (a few times a second).
  useEffect(() => {
    const onLevel = (ev: Event) => {
      const detail = (ev as CustomEvent<MeetingLevelEvent>).detail;
      if (!detail || detail.meetingId !== meeting.id) return;
      lastLevelAt.current = Date.now();
      setLevels((prev) => [...prev, ...detail.levels].slice(-BAR_COUNT));
    };
    window.addEventListener(MEETING_LEVEL_EVENT, onLevel);
    return () => window.removeEventListener(MEETING_LEVEL_EVENT, onLevel);
  }, [meeting.id]);

  // Paused, or no audio arriving (e.g. a browser tab without the desktop app): let the wave settle.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (paused || Date.now() - lastLevelAt.current > 1500) {
        setLevels((prev) => (prev.some((v) => v > 0) ? [...prev.slice(1), 0] : prev));
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [paused]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Meeting action failed'));
      setBusy(null);
      return;
    }
    // finish/discard: the recorder goes away when the server's status arrives.
    if (kind === 'pause' || kind === 'action') setBusy(null);
  };

  const clock = formatClock(recordedMs(meeting, now));
  const isLagging = meeting.mode === 'live' && meeting.pendingChunks > 3;
  const statusLine =
    meeting.mode === 'economy'
      ? t('Economy mode · transcribed after the meeting')
      : meeting.lagSeconds > 0
        ? t('Local transcript · {sec}s behind', { sec: meeting.lagSeconds })
        : t('Local transcript · live');

  if (collapsed) {
    return (
      <div style={{ ...shellStyle, padding: '5px 6px 5px 12px', flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 'var(--radius-full)' }}>
        <RecDot paused={paused} />
        <span className="mono-num" style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{clock}</span>
        <MiniWave levels={levels.slice(-12)} paused={paused} />
        <button type="button" onClick={() => setCollapsed(false)} style={pillBtn} title={t('Expand recorder')}>
          {t('Open')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('finish', () => meetingsApi.stop(meeting.id))}
          style={{ ...pillBtn, background: 'var(--action-primary)', color: 'var(--action-primary-fg)' }}
        >
          {busy === 'finish' ? t('Finishing…') : t('Finish')}
        </button>
      </div>
    );
  }

  return (
    <div style={shellStyle} role="region" aria-label={t('Meeting recorder')}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {paused ? t('Paused') : t('Recording')}
        </span>
        <span
          className="mono-num"
          aria-live="off"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '4px 11px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-3)',
            border: '1px solid var(--border-default)',
            fontSize: 13,
            color: 'var(--text-primary)',
          }}
        >
          <RecDot paused={paused} />
          {clock}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title={t('Minimise')}
          aria-label={t('Minimise')}
          style={{ padding: 4, background: 'transparent', color: 'var(--text-tertiary)' }}
        >
          <Minimize2 size={13} strokeWidth={1.7} />
        </button>
      </div>

      <Wave levels={levels} paused={paused} />

      {confirmDiscard ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('Throw this recording away?')}</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('discard', () => meetingsApi.discard(meeting.id))}
            style={{ ...pillBtn, color: 'var(--agent-red)', borderColor: 'rgba(239,77,66,0.4)' }}
          >
            {busy === 'discard' ? t('Discarding…') : t('Discard')}
          </button>
          <button type="button" onClick={() => setConfirmDiscard(false)} style={pillBtn}>
            {t('Cancel')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
          <RoundButton
            label={t('Discard recording')}
            disabled={busy !== null}
            onClick={() => setConfirmDiscard(true)}
          >
            <X size={18} strokeWidth={1.8} />
          </RoundButton>
          <RoundButton
            big
            label={paused ? t('Resume recording') : t('Pause recording')}
            disabled={busy !== null}
            active={!paused}
            onClick={() => void run('pause', () => meetingsApi.pause(meeting.id, !paused))}
          >
            {paused ? <Mic size={22} strokeWidth={1.8} /> : <Pause size={22} strokeWidth={1.8} />}
          </RoundButton>
          <RoundButton
            label={t('Finish and write notes')}
            disabled={busy !== null}
            onClick={() => void run('finish', () => meetingsApi.stop(meeting.id))}
          >
            {busy === 'finish' ? <Spinner /> : <Check size={18} strokeWidth={2} />}
          </RoundButton>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11.5, color: isLagging ? 'var(--agent-amber)' : 'var(--text-tertiary)' }}>
          {busy === 'finish' ? t('Finishing: saving the last audio…') : statusLine}
        </span>
        {warning && (
          <span
            title={warning}
            style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, fontSize: 11.5, color: 'var(--agent-amber)', textAlign: 'center', lineHeight: 1.4 }}
          >
            <AlertTriangle size={12} strokeWidth={1.7} style={{ flexShrink: 0, marginTop: 2 }} />
            {warning}
          </span>
        )}
        {isLagging && (
          <div style={{ display: 'flex', gap: 6 }}>
            {canSwitchSmallerModel && smallerModelId && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run('action', () => meetingsApi.switchModel(meeting.id, smallerModelId))}
                style={pillBtn}
              >
                <Zap size={11} strokeWidth={1.7} />
                {t('Switch to smaller model')}
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('action', () => meetingsApi.defer(meeting.id))}
              style={pillBtn}
            >
              <Pause size={11} strokeWidth={1.7} />
              {t('Continue later')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Wave({ levels, paused }: { levels: number[]; paused: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        height: 64,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        // Fade the oldest and newest bars so the wave seems to flow through the card.
        maskImage: 'linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)',
      }}
    >
      {levels.map((v, i) => {
        const h = levelToHeight(v);
        return (
          <span
            key={i}
            style={{
              width: 4,
              height: `${Math.round(h * 100)}%`,
              borderRadius: 2,
              background: paused
                ? 'var(--surface-3)'
                : // Atelier's gold (the background cables), brighter on louder bars.
                  `color-mix(in srgb, var(--agent-amber) ${Math.round(35 + h * 65)}%, var(--agent-sand))`,
              opacity: paused ? 1 : 0.55 + h * 0.45,
              transition: 'height 160ms ease-out, background 200ms',
            }}
          />
        );
      })}
    </div>
  );
}

function MiniWave({ levels, paused }: { levels: number[]; paused: boolean }) {
  return (
    <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 16 }}>
      {levels.map((v, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: `${Math.round(levelToHeight(v) * 100)}%`,
            borderRadius: 1,
            background: paused ? 'var(--surface-3)' : 'var(--agent-amber)',
            transition: 'height 160ms ease-out',
          }}
        />
      ))}
    </span>
  );
}

function RecDot({ paused }: { paused: boolean }) {
  return (
    <span
      aria-hidden
      className={paused ? undefined : 'atelier-rec-pulse'}
      style={{
        width: 8,
        height: 8,
        borderRadius: '9999px',
        background: paused ? 'var(--agent-amber)' : 'var(--agent-red)',
        flexShrink: 0,
      }}
    />
  );
}

function RoundButton({
  children,
  label,
  onClick,
  disabled,
  big,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  big?: boolean;
  active?: boolean;
}) {
  const size = big ? 58 : 44;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="transition-atelier"
      style={{
        width: size,
        height: size,
        borderRadius: '9999px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        // White on red; dark on the amber "paused" button, where white would be hard to see.
        color: big ? (active ? '#fff' : 'var(--action-primary-fg)') : 'var(--text-primary)',
        background: big
          ? active
            ? 'var(--agent-red)'
            : 'var(--agent-amber)'
          : 'var(--surface-3)',
        border: big ? 'none' : '1px solid var(--border-default)',
        boxShadow: big
          ? `0 0 0 6px ${active ? 'rgba(239,77,66,0.16)' : 'rgba(244,188,46,0.16)'}, 0 8px 22px rgba(0,0,0,0.35)`
          : 'none',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="atelier-spin"
      style={{
        width: 16,
        height: 16,
        borderRadius: '9999px',
        border: '2px solid var(--border-default)',
        borderTopColor: 'var(--text-primary)',
      }}
    />
  );
}

const shellStyle: CSSProperties = {
  width: 340,
  padding: '12px 16px 14px',
  borderRadius: 'var(--radius-lg, 16px)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-default)',
  boxShadow: '0 14px 40px rgba(0,0,0,0.5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const pillBtn: CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--surface-3)',
  border: '1px solid var(--border-default)',
  fontSize: 11.5,
  color: 'var(--text-primary)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
};
