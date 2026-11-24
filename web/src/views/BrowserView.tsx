import type { Agent, BrowserFrameEvent, BrowserSessionInfo } from '@atelier/contracts';
import {
  Globe,
  Hand,
  Lock,
  Pause,
  Play,
  Settings,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { browserApi } from '../api';
import { Select } from '../components/Select';
import { toast } from '../components/Toast';
import { useT } from '../i18n';

interface BrowserViewProps {
  agent: Agent | null;
  sessions: BrowserSessionInfo[];
  frames: Record<string, BrowserFrameEvent>;
  onOpenBrowserSettings: () => void;
}

function sessionStatusBadge(t: (k: string) => string, status: BrowserSessionInfo['status']) {
  switch (status) {
    case 'working':
      return { label: t('Working'), color: 'var(--agent-blue)' };
    case 'waiting_user':
      return { label: t('Waiting approval'), color: 'var(--agent-amber)' };
    case 'takeover':
      return { label: t('Takeover active'), color: 'var(--agent-amber)' };
    case 'paused':
      return { label: t('Paused'), color: 'var(--text-tertiary)' };
    default:
      return { label: t('Idle'), color: 'var(--agent-green)' };
  }
}

export function BrowserView({
  agent,
  sessions,
  frames,
  onOpenBrowserSettings,
}: BrowserViewProps) {
  const t = useT();
  const agentSessions = useMemo(
    () =>
      sessions.filter(
        (s) => s.status !== 'closed' && (!agent || s.agentId === agent.id),
      ),
    [sessions, agent],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const activeSession =
    agentSessions.find((s) => s.id === selectedId) ?? agentSessions[0] ?? null;

  useEffect(() => {
    if (!activeSession) return;
    const sid = activeSession.id;
    void browserApi.watchSession(sid).catch(() => undefined);
    return () => {
      void browserApi.unwatchSession(sid).catch(() => undefined);
    };
  }, [activeSession?.id]);

  if (!activeSession) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          maxWidth: 1080,
          width: '100%',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          <Globe size={22} strokeWidth={1.5} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          {t("Agent hasn't opened a browser yet.")}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', maxWidth: 420, textAlign: 'center' }}>
          {t('Enable Browser on this agent and configure saved site logins in Settings → Browser & Login.')}
        </div>
        <button
          type="button"
          onClick={onOpenBrowserSettings}
          style={{
            height: 32,
            padding: '0 14px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
            fontSize: 12.5,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Settings size={13} /> {t('Browser & Login settings')}
        </button>
      </div>
    );
  }

  const frame = frames[activeSession.id];
  const badge = sessionStatusBadge(t, activeSession.status);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusyAction(label);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Browser action failed'));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: 1080,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingBottom: 80,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
        }}
      >
        {agentSessions.length > 1 && (
          <div style={{ width: 150 }}>
            <Select
              ariaLabel={t('Select browser session')}
              value={activeSession.id}
              onChange={setSelectedId}
              options={agentSessions.map((s) => ({
                value: s.id,
                label: s.profileName || s.id,
              }))}
            />
          </div>
        )}

        <div
          style={{
            flex: 1,
            minWidth: 200,
            height: 30,
            padding: '0 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          <Lock size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span
            className="mono-num"
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={activeSession.url}
          >
            {activeSession.url || 'about:blank'}
          </span>
        </div>

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 11.5,
            color: badge.color,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '9999px',
              background: badge.color,
            }}
          />
          {badge.label}
        </span>

        {activeSession.status === 'takeover' ? (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              void runAction('release', () => browserApi.releaseSession(activeSession.id))
            }
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--agent-green)',
              color: '#0d0d11',
              fontSize: 12,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {t('Done, resume agent')}
          </button>
        ) : (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              void runAction('takeover', () => browserApi.takeoverSession(activeSession.id))
            }
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--action-primary)',
              color: 'var(--action-primary-fg)',
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Hand size={13} /> {t('Take over')}
          </button>
        )}

        {activeSession.status === 'paused' ? (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              void runAction('resume', () => browserApi.resumeSession(activeSession.id))
            }
            style={{
              height: 30,
              padding: '0 10px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Play size={12} /> {t('Resume agent')}
          </button>
        ) : (
          activeSession.status !== 'takeover' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('pause', () => browserApi.pauseSession(activeSession.id))
              }
              style={{
                height: 30,
                padding: '0 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-secondary)',
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Pause size={12} /> {t('Pause agent')}
            </button>
          )
        )}

        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() =>
            void runAction('close', () => browserApi.closeSession(activeSession.id))
          }
          style={{
            height: 30,
            padding: '0 10px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--agent-red)',
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <X size={13} /> {t('Close session')}
        </button>
      </div>

      {/* Live Viewport */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: 'var(--radius-lg)',
          background: '#0a0a0e',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {activeSession.status === 'takeover' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              padding: 24,
              textAlign: 'center',
            }}
          >
            <Hand size={28} style={{ color: 'var(--agent-amber)' }} />
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('Manual takeover window is open')}
            </div>
            {activeSession.takeoverReason && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 420 }}>
                {activeSession.takeoverReason}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {t('Finish your steps in the opened browser window, then click “Done, resume agent”.')}
            </div>
          </div>
        ) : frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.jpegBase64}`}
            alt={activeSession.title || activeSession.url}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {t('Waiting for live browser frame…')}
          </div>
        )}
      </div>
    </div>
  );
}
