import type { MeetingSession } from '@atelier/contracts';
import { Check, Minus, Play, Plus, Square, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { meetingsApi } from '../api';
import { useT } from '../i18n';
import { automaticSpeakerName, speakerColor, speakerName } from '../speakerLabels';
import { ModalShell, inputStyle, primaryBtnStyle, secondaryBtnStyle } from './modals/ModalShell';
import { Select } from './Select';
import { toast } from './Toast';

/**
 * "Name your speakers": play a sample of each voice, give it a name, merge voices that are the
 * same person, or run the speaker engine again with the number of people that were in the meeting.
 * Finishing writes the notes again with the names and deletes the audio kept for this.
 */
export function SpeakerNamingDialog({
  meeting,
  onClose,
  onChanged,
}: {
  meeting: MeetingSession;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useT();
  const speakers = meeting.speakers;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [participants, setParticipants] = useState(Math.max(2, speakers.length));
  const [busy, setBusy] = useState<null | 'rerun' | 'done' | 'merge'>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // New list after a repeat run or a merge: drop drafts of speakers that no longer exist.
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => speakers.some((s) => s.id === id))));
  }, [speakers]);

  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  const play = (id: string) => {
    audio.current?.pause();
    if (playing === id) {
      setPlaying(null);
      return;
    }
    const el = new Audio(meetingsApi.speakerSampleUrl(meeting.id, id));
    el.onended = () => setPlaying((p) => (p === id ? null : p));
    el.onerror = () => {
      setPlaying(null);
      toast.error(t('No audio sample for this speaker'));
    };
    audio.current = el;
    setPlaying(id);
    void el.play().catch(() => setPlaying(null));
  };

  const rerun = async () => {
    setBusy('rerun');
    try {
      await meetingsApi.diarize(meeting.id, participants);
      setDrafts({});
      await onChanged();
      toast.success(t('Speakers found again'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not find the speakers again'));
    } finally {
      setBusy(null);
    }
  };

  const merge = async (id: string, into: string) => {
    if (!into) return;
    setBusy('merge');
    try {
      await meetingsApi.mergeSpeaker(meeting.id, id, into);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not merge the speakers'));
    } finally {
      setBusy(null);
    }
  };

  const done = async () => {
    setBusy('done');
    try {
      let named = false;
      for (const sp of speakers) {
        const draft = drafts[sp.id];
        if (draft === undefined) continue;
        const clean = draft.trim() || null;
        if (clean !== (sp.name ?? null)) {
          await meetingsApi.renameSpeaker(meeting.id, sp.id, clean);
        }
        if (clean) named = true;
      }
      named = named || speakers.some((s) => s.name?.trim());
      // Notes are written again only when there is a real name to put in them.
      await meetingsApi.speakersDone(meeting.id, named);
      await onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not save the names'));
      setBusy(null);
    }
  };

  const others = (id: string) => speakers.filter((s) => s.id !== id);

  // Portal to <body>: inside the page overlay the dialog sat under the right-hand panel.
  return createPortal(
    <ModalShell
      title={t('Name your speakers')}
      subtitle={t('Play the sample, then type a name for each voice.')}
      width={600}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <Users size={14} strokeWidth={1.6} />
            {t('Participants')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-2)',
              }}
            >
              <button
                type="button"
                aria-label={t('Fewer participants')}
                disabled={participants <= 1 || busy !== null}
                onClick={() => setParticipants((n) => Math.max(1, n - 1))}
                style={stepBtn}
              >
                <Minus size={13} strokeWidth={1.8} />
              </button>
              <span className="mono-num" style={{ minWidth: 28, textAlign: 'center', fontSize: 13, color: 'var(--text-primary)' }}>
                {participants}
              </span>
              <button
                type="button"
                aria-label={t('More participants')}
                disabled={participants >= 20 || busy !== null}
                onClick={() => setParticipants((n) => Math.min(20, n + 1))}
                style={stepBtn}
              >
                <Plus size={13} strokeWidth={1.8} />
              </button>
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void rerun()}
              style={{ ...primaryBtnStyle, height: 30, padding: '0 12px', fontSize: 12 }}
            >
              {busy === 'rerun' ? t('Finding…') : t('Re-run')}
            </button>
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-subtle)' }}>
          {speakers.map((sp) => (
            <div
              key={sp.id}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}
            >
              <span aria-hidden style={{ width: 9, height: 9, borderRadius: 9999, background: speakerColor(sp.color), flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <input
                  type="text"
                  value={drafts[sp.id] ?? sp.name ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [sp.id]: e.target.value }))}
                  placeholder={automaticSpeakerName(t, sp.id)}
                  aria-label={t('Name of {name}', { name: speakerName(t, sp) })}
                  maxLength={60}
                  style={{ ...inputStyle, minWidth: 0 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('{count} sentences', { count: sp.segmentCount })}
                </span>
              </div>
              {sp.id !== 'me' && others(sp.id).length > 0 && (
                <div style={{ width: 150, flexShrink: 0 }}>
                  <Select
                    ariaLabel={t('Same person as…')}
                    value=""
                    onChange={(into) => void merge(sp.id, into)}
                    options={[
                      { value: '', label: t('Same as…') },
                      ...others(sp.id).map((o) => ({ value: o.id, label: speakerName(t, o) })),
                    ]}
                  />
                </div>
              )}
              <button
                type="button"
                disabled={!sp.hasSample}
                onClick={() => play(sp.id)}
                style={{ ...secondaryBtnStyle, height: 30, padding: '0 10px', fontSize: 12, gap: 5, opacity: sp.hasSample ? 1 : 0.4, flexShrink: 0 }}
              >
                {playing === sp.id ? <Square size={10} fill="currentColor" strokeWidth={1.5} /> : <Play size={11} strokeWidth={1.7} />}
                {playing === sp.id ? t('Stop') : t('Listen')}
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45, maxWidth: 300 }}>
            {t('Saving writes the notes again with these names and deletes the audio kept for this step.')}
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void done()}
            style={{ ...primaryBtnStyle, gap: 6 }}
          >
            <Check size={13} strokeWidth={1.8} />
            {busy === 'done' ? t('Saving…') : t('Done')}
          </button>
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}

const stepBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-secondary)',
  background: 'transparent',
};
