import {
  BUILT_IN_MODELS,
  type AudioDevicesInfo,
  type MeetingMeterEvent,
  type MeetingSettings,
  type ModelProvider,
  type Settings,
  type SttDownloadProgressEvent,
  type SttLocalStatus,
} from '@atelier/contracts';
import { AudioLines, Download, Mic, NotebookPen, Trash2, Users, Volume2 } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { meetingsApi } from '../api';
import { primaryBtnStyle, secondaryBtnStyle, inputStyle } from '../components/modals/ModalShell';
import { Select } from '../components/Select';
import { Switch } from '../components/Switch';
import { toast } from '../components/Toast';
import { useT } from '../i18n';
import { PROVIDER_DISPLAY_NAMES } from '../meetingNotice';
import { MEETING_METER_EVENT } from '../state/useWorkspace';

export const cardStyle: CSSProperties = {
  padding: 14,
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const hintStyle: CSSProperties = { fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 };

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// ------------------------------------------------------------------------------- devices

/** RMS 0..1 → bar width: speech is about 0.02–0.15, so a square root spreads it over the bar. */
function meterWidth(rms: number): number {
  return Math.min(100, Math.round(Math.sqrt(Math.max(0, rms)) * 260));
}

function MeterBar({ value, active }: { value: number; active: boolean }) {
  return (
    <div style={{ flex: 1, height: 6, borderRadius: 9999, background: 'var(--surface-3)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${active ? meterWidth(value) : 0}%`,
          height: '100%',
          borderRadius: 9999,
          background: 'linear-gradient(90deg, #8a6d3b, #d8be92 70%, #f4e2bd)',
          transition: 'width 90ms linear',
        }}
      />
    </div>
  );
}

/**
 * Which microphone and speaker to record, with a live level meter: the Windows default is
 * sometimes a device that never delivers sound (a camera's microphone), and that used to
 * look exactly like "recording works".
 */
export function MeetingDevicesCard({
  meeting,
  captureAvailable,
  recording,
  onChange,
}: {
  meeting: MeetingSettings;
  captureAvailable: boolean | null;
  recording: boolean;
  onChange: (patch: Partial<MeetingSettings>) => void;
}) {
  const t = useT();
  const [devices, setDevices] = useState<AudioDevicesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState({ mic: 0, speaker: 0 });
  const [openIssues, setOpenIssues] = useState<{ mic?: string | null; speaker?: string | null }>({});
  const [micSilentFor, setMicSilentFor] = useState(0);
  const lastMicSound = useRef(Date.now());

  useEffect(() => {
    if (!captureAvailable) return;
    meetingsApi
      .audioDevices()
      .then(setDevices)
      .catch((err) => setError(err instanceof Error ? err.message : t('Could not list the audio devices')));
  }, [captureAvailable, t]);

  // The meter runs while this card is on screen (the server stops it after 90 s without a refresh).
  const micDevice = meeting.micDevice;
  const speakerDevice = meeting.speakerDevice;
  useEffect(() => {
    if (!captureAvailable || recording) return;
    let stopped = false;
    const start = () => {
      if (!stopped) meetingsApi.audioMeter(true, { micDevice, speakerDevice }).catch(() => undefined);
    };
    start();
    lastMicSound.current = Date.now();
    setMicSilentFor(0);
    setOpenIssues({});
    const keepAlive = window.setInterval(start, 45_000);
    return () => {
      stopped = true;
      window.clearInterval(keepAlive);
      meetingsApi.audioMeter(false).catch(() => undefined);
    };
  }, [captureAvailable, recording, micDevice, speakerDevice]);

  useEffect(() => {
    const onMeter = (ev: Event) => {
      const r = (ev as CustomEvent<MeetingMeterEvent>).detail;
      if (!r) return;
      setLevels({ mic: r.mic, speaker: r.speaker });
      if (r.micError !== undefined || r.speakerError !== undefined) {
        setOpenIssues({ mic: r.micError, speaker: r.speakerError });
      }
      if (r.mic > 0.002) lastMicSound.current = Date.now();
      setMicSilentFor(Math.round((Date.now() - lastMicSound.current) / 1000));
    };
    window.addEventListener(MEETING_METER_EVENT, onMeter);
    return () => window.removeEventListener(MEETING_METER_EVENT, onMeter);
  }, []);

  const options = useCallback(
    (list: AudioDevicesInfo['inputs'], saved: string | null) => {
      const def = list.find((d) => d.isDefault);
      const items = [
        {
          value: '',
          label: def
            ? t('Follow Windows ({name})', { name: def.name })
            : t('Follow Windows default'),
        },
        ...list.map((d) => ({ value: d.name, label: d.name })),
      ];
      if (saved && !list.some((d) => d.name === saved)) {
        items.push({ value: saved, label: t('{name} (not connected)', { name: saved }) });
      }
      return items;
    },
    [t],
  );

  const micOptions = useMemo(() => options(devices?.inputs ?? [], micDevice), [devices, micDevice, options]);
  const speakerOptions = useMemo(
    () => options(devices?.outputs ?? [], speakerDevice),
    [devices, speakerDevice, options],
  );

  const micDead = micSilentFor >= 6 && !openIssues.mic;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AudioLines size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)' }} />
        <span style={eyebrowStyle}>{t('Audio devices')}</span>
      </div>

      {captureAvailable === false ? (
        <div style={hintStyle}>{t('Recording needs the Atelier desktop app; this window cannot reach the microphone.')}</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Mic size={13} strokeWidth={1.6} /> {t('Microphone (your voice)')}
            </span>
            <Select
              ariaLabel={t('Microphone')}
              value={micDevice ?? ''}
              onChange={(v) => onChange({ micDevice: v || null })}
              options={micOptions}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <MeterBar value={levels.mic} active={!recording} />
              <span style={{ ...hintStyle, minWidth: 112 }}>
                {recording ? t('Recording…') : micDead ? t('No sound') : t('Say something')}
              </span>
            </div>
            {openIssues.mic && <div style={{ ...hintStyle, color: 'var(--agent-red)' }}>{openIssues.mic}</div>}
            {micDead && (
              <div style={{ ...hintStyle, color: 'var(--agent-amber)' }}>
                {t('This microphone sends no sound. Pick another one above (the one you use in Zoom or Teams).')}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Volume2 size={13} strokeWidth={1.6} /> {t('Laptop sound (the other participants)')}
            </span>
            <Select
              ariaLabel={t('Speaker')}
              value={speakerDevice ?? ''}
              onChange={(v) => onChange({ speakerDevice: v || null })}
              options={speakerOptions}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <MeterBar value={levels.speaker} active={!recording} />
              <span style={{ ...hintStyle, minWidth: 112 }}>{t('Play some audio')}</span>
            </div>
            {openIssues.speaker && <div style={{ ...hintStyle, color: 'var(--agent-red)' }}>{openIssues.speaker}</div>}
            <div style={hintStyle}>
              {t('Choose the output your meeting plays on (headset or speakers), so the other participants are recorded.')}
            </div>
          </div>
          {error && <div style={{ ...hintStyle, color: 'var(--agent-red)' }}>{error}</div>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- notes writer

const NOTE_PROVIDERS: ModelProvider[] = ['claude', 'openai', 'deepseek', 'openrouter', 'opencode', 'antigravity'];

/** Who writes the notes, in which language, and in what layout. */
export function MeetingNotesWriterCard({
  meeting,
  settings,
  onChange,
}: {
  meeting: MeetingSettings;
  settings: Settings;
  onChange: (patch: Partial<MeetingSettings>) => void;
}) {
  const t = useT();
  const [template, setTemplate] = useState(meeting.notesTemplate);
  useEffect(() => setTemplate(meeting.notesTemplate), [meeting.notesTemplate]);

  const provider = meeting.notesProvider;
  const effectiveProvider = provider ?? settings.provider;
  const models = useMemo(() => {
    if (!provider) return [];
    const list = [...BUILT_IN_MODELS, ...(settings.customModels ?? [])]
      .filter((m) => m.provider === provider)
      .map((m) => ({ value: m.id, label: m.label }));
    const seen = new Set<string>();
    const unique = list.filter((m) => (seen.has(m.value) ? false : (seen.add(m.value), true)));
    if (meeting.notesModel && !seen.has(meeting.notesModel)) {
      unique.push({ value: meeting.notesModel, label: meeting.notesModel });
    }
    return unique;
  }, [provider, settings.customModels, meeting.notesModel]);

  const providerName = PROVIDER_DISPLAY_NAMES[effectiveProvider] ?? effectiveProvider;
  const local = effectiveProvider === 'opencode';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <NotebookPen size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)' }} />
        <span style={eyebrowStyle}>{t('Who writes the notes')}</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('Provider')}</span>
          <Select
            ariaLabel={t('Provider')}
            value={provider ?? ''}
            onChange={(v) => onChange({ notesProvider: (v || null) as ModelProvider | null, notesModel: null })}
            options={[
              { value: '', label: t('Follow the app default ({name})', { name: PROVIDER_DISPLAY_NAMES[settings.provider] ?? settings.provider }) },
              ...NOTE_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_DISPLAY_NAMES[p] ?? p })),
            ]}
          />
        </div>
        {provider && (
          <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('Model')}</span>
            <Select
              ariaLabel={t('Model')}
              value={meeting.notesModel ?? ''}
              onChange={(v) => onChange({ notesModel: v || null })}
              options={[{ value: '', label: t("The provider's light default") }, ...models]}
            />
          </div>
        )}
        <div style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('Language of the notes')}</span>
          <Select
            ariaLabel={t('Language of the notes')}
            value={meeting.notesLanguage}
            onChange={(v) => onChange({ notesLanguage: v as MeetingSettings['notesLanguage'] })}
            options={[
              { value: 'auto', label: t('Same as the meeting') },
              { value: 'id', label: t('Indonesian') },
              { value: 'en', label: t('English') },
            ]}
          />
        </div>
      </div>

      <div style={hintStyle}>
        {local
          ? t('Everything stays on this laptop: audio and notes.')
          : t('Audio never leaves this laptop. The transcript text is sent to {name} to write the notes.', { name: providerName })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('Layout of the notes (optional)')}</span>
        <textarea
          rows={4}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          onBlur={() => template !== meeting.notesTemplate && onChange({ notesTemplate: template })}
          placeholder={t('Empty = Summary, Decisions, Action items (who, what, when) and Open questions. Or describe your own layout.')}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.45, fontSize: 12 }}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- speaker engine

/** The optional engine that tells the other participants apart. */
export function SpeakerEngineCard({
  status,
  meeting,
  download,
  busy,
  onChange,
  onInstall,
  onRemove,
  onCancel,
}: {
  status: SttLocalStatus | null;
  meeting: MeetingSettings;
  download: SttDownloadProgressEvent | null;
  busy: boolean;
  onChange: (patch: Partial<MeetingSettings>) => void;
  onInstall: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const engine = status?.speakerEngine;
  const installing = download?.kind === 'diarization' ? download : null;
  const supported = (engine?.sizeBytes ?? 0) > 0;
  const step =
    installing?.id === 'engine'
      ? t('engine')
      : installing?.id === 'segmentation'
        ? t('who speaks when')
        : installing?.id === 'embedding'
          ? t('voice model')
          : '';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)' }} />
          <div>
            <div style={eyebrowStyle}>{t('Tell speakers apart')}</div>
            <div style={{ ...hintStyle, marginTop: 3 }}>
              {engine?.installed
                ? t('Installed. After a meeting, Atelier finds who said what and lets you name them.')
                : t('Without it, the transcript only separates "me" from "others". With it, each person gets their own name.')}
            </div>
          </div>
        </div>
        {engine?.installed ? (
          <button type="button" disabled={busy} onClick={onRemove} style={{ ...secondaryBtnStyle, padding: '5px 10px', fontSize: 11.5, gap: 5 }}>
            <Trash2 size={12} strokeWidth={1.6} />
            {t('Remove')}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !supported || Boolean(installing)}
            onClick={onInstall}
            style={{ ...primaryBtnStyle, padding: '6px 11px', fontSize: 12, gap: 6, opacity: supported ? 1 : 0.5 }}
          >
            <Download size={13} strokeWidth={1.6} />
            {t('Install (±{size} from {host})', { size: formatMb(engine?.sizeBytes ?? 0), host: engine?.host ?? 'github.com' })}
          </button>
        )}
      </div>

      {installing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ height: 6, borderRadius: 9999, background: 'var(--surface-3)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.min(100, Math.max(2, installing.percent))}%`,
                  height: '100%',
                  background: installing.status === 'error' ? 'var(--agent-red)' : 'var(--agent-blue)',
                  transition: 'width 150ms ease',
                }}
              />
            </div>
            <div style={{ ...hintStyle, marginTop: 3 }}>
              {installing.status === 'error'
                ? (installing.error ?? t('Download error'))
                : `${step} · ${installing.status === 'verifying' ? t('Verifying SHA-256…') : installing.status === 'extracting' ? t('Extracting…') : `${installing.percent}%`}`}
            </div>
          </div>
          {installing.status === 'downloading' && (
            <button type="button" onClick={onCancel} style={{ ...secondaryBtnStyle, padding: '4px 9px', fontSize: 11 }}>
              {t('Cancel')}
            </button>
          )}
        </div>
      )}

      {engine?.installed && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{t('Label who said what')}</div>
            <div style={hintStyle}>{t('Keeps the audio until you have named the speakers (24 hours at most).')}</div>
          </div>
          <Switch
            checked={meeting.speakerLabels}
            onChange={(speakerLabels) => {
              onChange({ speakerLabels });
              if (speakerLabels) toast.info(t('Applies to the next meeting'));
            }}
            label={t('Label who said what')}
          />
        </div>
      )}
    </div>
  );
}
