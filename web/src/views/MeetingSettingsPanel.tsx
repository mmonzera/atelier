import {
  DEFAULT_MEETING_SETTINGS,
  type MeetingMode,
  type MeetingSettings,
  type Settings,
  type SttBenchmarkRecommendation,
  type SttDownloadProgressEvent,
  type SttLanguage,
  type SttLocalStatus,
} from '@atelier/contracts';
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  Gauge,
  HardDrive,
  Mic,
  Radar,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, meetingsApi, sttApi } from '../api';
import {
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from '../components/modals/ModalShell';
import { Select } from '../components/Select';
import { Switch } from '../components/Switch';
import { toast } from '../components/Toast';
import { useLang, useT } from '../i18n';
import {
  DEFAULT_NOTICE_EN,
  DEFAULT_NOTICE_ID,
  PROVIDER_DISPLAY_NAMES,
  buildMeetingNotice,
} from '../meetingNotice';


const cardStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function formatMb(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function recommendationMeta(
  t: (k: string) => string,
  rec: SttBenchmarkRecommendation,
): { label: string; detail: string; color: string } {
  switch (rec) {
    case 'live_safe':
      return {
        label: t('Live safe'),
        detail: t('Fast enough for real-time meeting notes.'),
        color: 'var(--agent-green)',
      };
    case 'live_tight':
      return {
        label: t('Live tight'),
        detail: t('Consider a smaller model or more threads to avoid lag.'),
        color: 'var(--agent-amber)',
      };
    case 'economy':
      return {
        label: t('Use economy mode'),
        detail: t('Slower than real-time on this configuration; transcribe after the meeting.'),
        color: 'var(--agent-red)',
      };
  }
}

export function MeetingSettingsPanel({
  settings,
  sttDownload,
}: {
  settings: Settings;
  sttDownload?: SttDownloadProgressEvent | null;
}) {
  const t = useT();
  const lang = useLang();
  const meeting: MeetingSettings = settings.meeting ?? DEFAULT_MEETING_SETTINGS;

  const [status, setStatus] = useState<SttLocalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEngineId, setSelectedEngineId] = useState('cpu-x64');
  const [benchmarking, setBenchmarking] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /** Audio is recorded by the desktop app; a browser tab on the dev server cannot record. */
  const [captureAvailable, setCaptureAvailable] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    meetingsApi
      .list()
      .then((res) => {
        setCaptureAvailable(res.captureAvailable);
        setRecording(res.active?.meeting.status === 'recording');
      })
      .catch(() => setCaptureAvailable(false));
  }, []);
  const [noticeDraft, setNoticeDraft] = useState(
    lang === 'id'
      ? (meeting.noticeTextId ?? DEFAULT_NOTICE_ID)
      : (meeting.noticeTextEn ?? DEFAULT_NOTICE_EN),
  );

  useEffect(() => {
    setNoticeDraft(
      lang === 'id'
        ? (meeting.noticeTextId ?? DEFAULT_NOTICE_ID)
        : (meeting.noticeTextEn ?? DEFAULT_NOTICE_EN),
    );
  }, [lang, meeting.noticeTextId, meeting.noticeTextEn]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await sttApi.status();
      setStatus(res.status);
      if (res.status.installedEngine?.id) {
        setSelectedEngineId(res.status.installedEngine.id);
      } else if (res.status.engines.length > 0 && !res.status.engines.some((e) => e.id === selectedEngineId)) {
        setSelectedEngineId(res.status.engines[0]!.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load speech-to-text status'));
    } finally {
      setLoading(false);
    }
  }, [selectedEngineId, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const onProgress = (ev: Event) => {
      const detail = (ev as CustomEvent<SttDownloadProgressEvent>).detail;
      if (detail && (detail.status === 'done' || detail.status === 'error' || detail.status === 'cancelled')) {
        void loadStatus();
      }
    };
    window.addEventListener('atelier:stt-progress', onProgress);
    return () => window.removeEventListener('atelier:stt-progress', onProgress);
  }, [loadStatus]);

  const updateMeeting = async (patch: Partial<MeetingSettings>) => {
    try {
      await api.updateSettings({ meeting: patch });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save settings'));
    }
  };

  const activeDownload = sttDownload ?? status?.activeDownload ?? null;
  const activeEngine = status?.engines.find((e) => e.id === selectedEngineId) ?? status?.engines[0] ?? null;
  const activeModel = status?.models.find((m) => m.id === meeting.activeModelId);
  const engineInstalled = Boolean(status?.installedEngine);
  const modelInstalled = Boolean(activeModel?.installed);

  const matchingBenchmark = useMemo(() => {
    if (!status?.installedEngine) return null;
    return (
      status.benchmarks.find(
        (b) =>
          b.engineVersion === status.installedEngine!.version &&
          b.modelId === meeting.activeModelId &&
          b.threads === meeting.threads &&
          b.useGpu === meeting.useGpu,
      ) ?? null
    );
  }, [status, meeting.activeModelId, meeting.threads, meeting.useGpu]);

  const handleInstallEngine = async () => {
    if (!activeEngine) return;
    setBusyAction(`engine:${activeEngine.id}`);
    try {
      const res = await sttApi.installEngine(activeEngine.id);
      setStatus(res.status);
      toast.success(t('Whisper engine installed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to install Whisper engine'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadModel = async (id: string) => {
    setBusyAction(`model:${id}`);
    try {
      const res = await sttApi.downloadModel(id);
      setStatus(res.status);
      toast.success(t('Whisper model downloaded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to download Whisper model'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteModel = async (id: string) => {
    setBusyAction(`delete-model:${id}`);
    try {
      const res = await sttApi.deleteModel(id);
      setStatus(res.status);
      toast.info(t('Model removed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to remove model'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteEngine = async () => {
    setBusyAction('delete-engine');
    try {
      const res = await sttApi.deleteEngine();
      setStatus(res.status);
      toast.info(t('Whisper engine removed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to remove engine'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleClearAll = async () => {
    setBusyAction('clear-all');
    try {
      const res = await sttApi.clearAll();
      setStatus(res.status);
      toast.info(t('All Whisper engine and model files cleared'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to clear storage'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelDownload = async () => {
    try {
      const res = await sttApi.cancel();
      setStatus(res.status);
      toast.info(t('Download cancelled'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to cancel download'));
    }
  };

  const handleBenchmark = async () => {
    setBenchmarking(true);
    try {
      const res = await sttApi.benchmark(meeting.activeModelId);
      setStatus(res.status);
      toast.success(t('Speed test completed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Speed test failed'));
    } finally {
      setBenchmarking(false);
    }
  };

  const handleStartMeeting = async () => {
    setBusyAction('start-meeting');
    try {
      await meetingsApi.start();
      setRecording(true);
      toast.success(t('Taking meeting notes'));
      if (meeting.remindParticipants) {
        await navigator.clipboard.writeText(buildMeetingNotice(settings, lang)).catch(() => undefined);
        toast.info(t('Notice message copied: paste it into the meeting chat'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to start meeting notes'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnignoreApp = (appId: string) =>
    void updateMeeting({ ignoredMeetingApps: meeting.ignoredMeetingApps.filter((id) => id !== appId) });

  const installedEngineHasGpu = Boolean(
    status?.installedEngine && status.engines.find((e) => e.id === status.installedEngine!.id)?.gpu,
  );

  const handleCopyNotice = async () => {
    try {
      await navigator.clipboard.writeText(buildMeetingNotice(settings, lang, noticeDraft));
      toast.success(t('Notification message copied'));
    } catch {
      toast.error(t('Failed to copy message'));
    }
  };

  if (loading && !status) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: 12 }}>
        {t('Loading speech-to-text settings…')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* §6.1 Transcription Readiness Status */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Mic size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)' }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('Local Whisper')}
            </span>
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 500,
              color: status?.ready ? 'var(--agent-green)' : 'var(--agent-amber)',
            }}
          >
            {status?.ready ? (
              <CheckCircle2 size={14} strokeWidth={1.6} />
            ) : (
              <CircleAlert size={14} strokeWidth={1.6} />
            )}
            {status?.ready
              ? t('Ready ({model})', { model: activeModel?.label ?? meeting.activeModelId })
              : !engineInstalled
                ? t('Engine not installed')
                : t('Active model not downloaded')}
          </span>
        </div>
        {!status?.ready && (
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
            {!engineInstalled
              ? t('Install the whisper.cpp engine below before starting meeting transcription.')
              : t('Download the selected Whisper model below (or switch to an installed model) to enable local transcription.')}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
            {captureAvailable === false
              ? t('Recording needs the Atelier desktop app; this window cannot reach the microphone.')
              : recording
                ? t('A meeting is being recorded. Stop it from the pill at the top of the window.')
                : t('Records your microphone and the laptop sound (the other participants). Also from the tray icon.')}
          </div>
          <button
            type="button"
            disabled={
              !captureAvailable ||
              recording ||
              busyAction !== null ||
              (!status?.ready && meeting.mode === 'live')
            }
            onClick={() => void handleStartMeeting()}
            style={{
              ...primaryBtnStyle,
              padding: '6px 11px',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              opacity: !captureAvailable || recording || (!status?.ready && meeting.mode === 'live') ? 0.5 : 1,
            }}
          >
            <Mic size={13} strokeWidth={1.6} />
            {busyAction === 'start-meeting' ? t('Starting…') : t('Start taking notes')}
          </button>
        </div>
      </div>

      {/* Automatic meeting detection */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <Radar size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)', marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                {t('Offer to take notes when a meeting starts')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.45 }}>
                {t('When Zoom, Teams, Webex, Slack or a browser (Google Meet) starts using the microphone, Atelier asks whether to take notes. It never records without your click.')}
              </div>
            </div>
          </div>
          <Switch
            checked={meeting.detectMeetingApps}
            onChange={(detectMeetingApps) => void updateMeeting({ detectMeetingApps })}
            label={t('Offer to take notes when a meeting starts')}
          />
        </div>
        {meeting.ignoredMeetingApps.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t('Not asked for:')}</span>
            {meeting.ignoredMeetingApps.map((appId) => (
              <button
                key={appId}
                type="button"
                onClick={() => handleUnignoreApp(appId)}
                title={t('Ask again for this app')}
                style={{
                  ...secondaryBtnStyle,
                  padding: '2px 8px',
                  fontSize: 11,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {meetingAppLabel(t, appId)}
                <X size={11} strokeWidth={1.7} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* §6.2 Whisper Engine */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={eyebrowStyle}>{t('Whisper Engine')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {status?.installedEngine
                ? t('Installed v{version} ({id})', {
                    version: status.installedEngine.version,
                    id: status.installedEngine.id,
                  })
                : t('Not installed')}
              {status?.engines.some((e) => e.updateAvailable) && (
                <span style={{ marginLeft: 8, color: 'var(--agent-amber)' }}>
                  · {t('Update available')}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {activeEngine && !status?.installedEngine && (
              <button
                type="button"
                disabled={Boolean(activeDownload) || busyAction !== null}
                onClick={() => void handleInstallEngine()}
                style={{
                  ...primaryBtnStyle,
                  padding: '6px 11px',
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Download size={13} strokeWidth={1.6} />
                {t('Install (±{size} from {host})', {
                  size: formatMb(activeEngine.sizeBytes),
                  host: activeEngine.host,
                })}
              </button>
            )}
            {status?.installedEngine && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleDeleteEngine()}
                style={{
                  ...secondaryBtnStyle,
                  padding: '5px 10px',
                  fontSize: 11.5,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Trash2 size={12} strokeWidth={1.6} />
                {t('Remove engine')}
              </button>
            )}
          </div>
        </div>

        {status && status.engines.length > 1 && !status.installedEngine && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 96 }}>
              {t('Variant')}
            </span>
            <div style={{ flex: 1 }}>
              <Select
                value={selectedEngineId}
                onChange={setSelectedEngineId}
                options={status.engines.map((e) => ({
                  value: e.id,
                  label: `${e.id} · v${e.version}`,
                  hint: formatMb(e.sizeBytes),
                }))}
              />
            </div>
          </div>
        )}

        {activeDownload?.kind === 'engine' && (
          <DownloadProgressRow progress={activeDownload} onCancel={handleCancelDownload} />
        )}

        {/* Only GPU builds of the engine can use it; the CPU and BLAS builds ignore the flag. */}
        {installedEngineHasGpu && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 4,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-primary)' }}>
              <span>{t('Use GPU (Vulkan)')}</span>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-3)',
                  color: 'var(--agent-amber)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {t('experimental')}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {t('Offloads compute to supported iGPU/GPU when available; turn off if unstable.')}
            </div>
          </div>
          <Switch
            checked={meeting.useGpu}
            onChange={(useGpu) => void updateMeeting({ useGpu })}
            label={t('Use GPU (Vulkan)')}
          />
        </div>
        )}
      </div>

      {/* §6.2 Whisper Models */}
      <div style={cardStyle}>
        <div style={eyebrowStyle}>{t('Whisper Models')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(status?.models ?? []).map((m) => {
            const isDownloading = activeDownload?.kind === 'model' && activeDownload.id === m.id;
            return (
              <div
                key={m.id}
                style={{
                  padding: '9px 11px',
                  borderRadius: 'var(--radius-sm)',
                  background: m.active ? 'var(--surface-3)' : 'var(--surface-1)',
                  border: m.active
                    ? '1px solid var(--border-strong, var(--border-default))'
                    : '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                        {m.label}
                      </span>
                      {m.recommended && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 'var(--radius-full)',
                            background: 'rgba(59, 130, 246, 0.15)',
                            color: 'var(--agent-blue)',
                          }}
                        >
                          {t('Recommended')}
                        </span>
                      )}
                      {m.active && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 'var(--radius-full)',
                            background: 'rgba(34, 197, 94, 0.15)',
                            color: 'var(--agent-green)',
                          }}
                        >
                          {t('Active')}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        marginTop: 2,
                      }}
                    >
                      <span className="mono-num">{formatMb(m.sizeBytes)}</span>
                      <span>·</span>
                      <span>{t('RAM ~{ram} MB', { ram: m.ramMb })}</span>
                      <span>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                        {Array.from({ length: 4 }).map((_, i) => (
                          <Star
                            key={i}
                            size={10}
                            fill={i < m.quality ? 'var(--agent-amber)' : 'none'}
                            stroke={i < m.quality ? 'var(--agent-amber)' : 'var(--text-muted)'}
                          />
                        ))}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {!m.installed ? (
                      <button
                        type="button"
                        disabled={Boolean(activeDownload) || busyAction !== null}
                        onClick={() => void handleDownloadModel(m.id)}
                        style={{
                          ...secondaryBtnStyle,
                          padding: '5px 9px',
                          fontSize: 11.5,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <Download size={12} strokeWidth={1.6} />
                        {t('Download ({size} · {host})', {
                          size: formatMb(m.sizeBytes),
                          host: m.host,
                        })}
                      </button>
                    ) : (
                      <>
                        {!m.active && (
                          <button
                            type="button"
                            onClick={() => void updateMeeting({ activeModelId: m.id })}
                            style={{
                              ...primaryBtnStyle,
                              padding: '5px 10px',
                              fontSize: 11.5,
                            }}
                          >
                            {t('Use')}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void handleDeleteModel(m.id)}
                          aria-label={t('Delete model')}
                          style={{
                            ...secondaryBtnStyle,
                            padding: '5px 8px',
                            fontSize: 11.5,
                          }}
                        >
                          <Trash2 size={12} strokeWidth={1.6} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isDownloading && activeDownload && (
                  <DownloadProgressRow progress={activeDownload} onCancel={handleCancelDownload} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* §6.2 Threads, Mode & Language */}
      <div style={cardStyle}>
        <div style={eyebrowStyle}>{t('Performance & Transcription Mode')}</div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{t('CPU threads')}</span>
            <span className="mono-num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {meeting.threads} / {status?.cpuCores ?? 16}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={status?.cpuCores ?? 16}
            value={meeting.threads}
            onChange={(e) => void updateMeeting({ threads: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {t('More = faster, but heavier during meetings')}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('Transcription mode')}
            </div>
            <Select
              value={meeting.mode}
              onChange={(val) => void updateMeeting({ mode: val as MeetingMode })}
              options={[
                { value: 'live', label: t('Live (notes during meeting)') },
                { value: 'economy', label: t('Economy (transcribe after meeting)') },
              ]}
            />
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('Spoken language')}
            </div>
            <Select
              value={meeting.language}
              onChange={(val) => void updateMeeting({ language: val as SttLanguage })}
              options={[
                { value: 'auto', label: t('Auto-detect') },
                { value: 'id', label: t('Indonesian') },
                { value: 'en', label: t('English') },
              ]}
            />
          </div>
        </div>
      </div>

      {/* §6.3 Speed Test */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={eyebrowStyle}>{t('Speed Test')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {t('Transcribes a short spoken sample with the active model and thread count.')}
            </div>
          </div>
          <button
            type="button"
            disabled={!status?.ready || benchmarking}
            onClick={() => void handleBenchmark()}
            style={{
              ...secondaryBtnStyle,
              padding: '6px 11px',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              opacity: !status?.ready || benchmarking ? 0.5 : 1,
            }}
          >
            <Gauge size={13} strokeWidth={1.6} />
            {benchmarking ? t('Testing…') : t('Test speed')}
          </button>
        </div>

        {matchingBenchmark && (() => {
          const meta = recommendationMeta(t, matchingBenchmark.recommendation);
          return (
            <div
              style={{
                padding: '9px 11px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                {t('{duration}s audio finished in {elapsed}s ({ratio}× faster than real-time)', {
                  duration: matchingBenchmark.audioDurationSec,
                  elapsed: matchingBenchmark.elapsedSec,
                  ratio: matchingBenchmark.realtimeRatio,
                })}
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {meta.detail}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: meta.color,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {meta.label}
              </span>
            </div>
          );
        })()}
      </div>

      {/* §6.2 Disk Usage */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HardDrive size={14} strokeWidth={1.6} style={{ color: 'var(--text-secondary)' }} />
            <div>
              <div style={eyebrowStyle}>{t('Storage Used')}</div>
              <div className="mono-num" style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 3 }}>
                {t('Engine {engine} · Models {models} · Total {total}', {
                  engine: formatMb(status?.diskUsage.engineBytes ?? 0),
                  models: formatMb(status?.diskUsage.modelsBytes ?? 0),
                  total: formatMb(status?.diskUsage.totalBytes ?? 0),
                })}
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={(status?.diskUsage.totalBytes ?? 0) === 0 || busyAction !== null}
            onClick={() => void handleClearAll()}
            style={{
              ...secondaryBtnStyle,
              padding: '5px 10px',
              fontSize: 11.5,
              opacity: (status?.diskUsage.totalBytes ?? 0) === 0 ? 0.5 : 1,
            }}
          >
            {t('Clear all')}
          </button>
        </div>
      </div>

      {/* §8 Participant Notice */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={eyebrowStyle}>{t('Participant Notice')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('Remind to notify participants when recording starts')}
            </div>
          </div>
          <Switch
            checked={meeting.remindParticipants}
            onChange={(remindParticipants) => void updateMeeting({ remindParticipants })}
            label={t('Remind to notify participants when recording starts')}
          />
        </div>

        <textarea
          rows={3}
          value={noticeDraft}
          onChange={(e) => setNoticeDraft(e.target.value)}
          onBlur={() => {
            const trimmed = noticeDraft.trim();
            if (!trimmed) return;
            if (lang === 'id') void updateMeeting({ noticeTextId: trimmed });
            else void updateMeeting({ noticeTextEn: trimmed });
          }}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.45, fontSize: 12 }}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {settings.provider !== 'opencode'
              ? t('Includes note that transcript text is sent to {provider} for summary.', {
                  provider: PROVIDER_DISPLAY_NAMES[settings.provider] ?? settings.provider,
                })
              : t('Audio and notes stay local.')}
          </div>
          <button
            type="button"
            onClick={() => void handleCopyNotice()}
            style={{
              ...secondaryBtnStyle,
              padding: '5px 10px',
              fontSize: 11.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
            }}
          >
            <Copy size={12} strokeWidth={1.6} />
            {t('Copy notice message')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function meetingAppLabel(t: (k: string) => string, appId: string): string {
  switch (appId) {
    case 'zoom':
      return 'Zoom';
    case 'teams':
      return 'Microsoft Teams';
    case 'browser':
      return t('Browser (Google Meet)');
    case 'webex':
      return 'Webex';
    case 'slack':
      return 'Slack';
    case 'skype':
      return 'Skype';
    default:
      return appId;
  }
}

function DownloadProgressRow({
  progress,
  onCancel,
}: {
  progress: SttDownloadProgressEvent;
  onCancel: () => Promise<void>;
}) {
  const t = useT();
  const statusText =
    progress.status === 'verifying'
      ? t('Verifying SHA-256…')
      : progress.status === 'extracting'
        ? t('Extracting…')
        : progress.status === 'error'
          ? progress.error || t('Download error')
          : `${progress.percent}% (${formatMb(progress.downloadedBytes)} / ${formatMb(progress.totalBytes)})`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1 }}>
        <div
          style={{
            height: 6,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-3)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.max(2, progress.percent))}%`,
              height: '100%',
              background: progress.status === 'error' ? 'var(--agent-red)' : 'var(--agent-blue)',
              transition: 'width 150ms ease',
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{statusText}</div>
      </div>
      {progress.status === 'downloading' && (
        <button
          type="button"
          onClick={() => void onCancel()}
          aria-label={t('Cancel download')}
          style={{
            ...secondaryBtnStyle,
            padding: '4px 7px',
            fontSize: 11,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <X size={12} strokeWidth={1.6} />
          {t('Cancel')}
        </button>
      )}
    </div>
  );
}
