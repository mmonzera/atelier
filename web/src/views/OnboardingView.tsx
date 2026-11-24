import type { Agent, Project } from '@atelier/contracts';
import { ArrowRight, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { BotMascot } from '../components/mascot/BotMascot';
import { useT } from '../i18n';

interface OnboardingViewProps {
  activeProject: Project | null;
  onStarted: (project: Project, agent: Agent) => void;
  onDismissed: () => void;
}

export function OnboardingView({
  activeProject,
  onStarted,
  onDismissed,
}: OnboardingViewProps) {
  const t = useT();
  const [busy, setBusy] = useState<'new' | 'existing' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleStartNew = async () => {
    setBusy('new');
    setError(null);
    try {
      const res = await api.startChiefOfStaff();
      onStarted(res.project, res.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not start Chief of Staff'));
    } finally {
      setBusy(null);
    }
  };

  const handleAddToActive = async () => {
    if (!activeProject) return;
    setBusy('existing');
    setError(null);
    try {
      const res = await api.startChiefOfStaff(activeProject.id);
      onStarted(res.project, res.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not add Chief of Staff'));
    } finally {
      setBusy(null);
    }
  };

  const handleDismiss = async () => {
    setBusy('dismiss');
    setError(null);
    try {
      await api.dismissOnboarding();
      onDismissed();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not skip onboarding'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 10,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <BotMascot
            size={64}
            color="amber"
            shape="triangle"
            seed="chief-of-staff"
            clickable
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                alignSelf: 'flex-start',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--agent-amber)',
              }}
            >
              <Sparkles size={11} strokeWidth={1.5} />{t('Chief of Staff')}
            </span>
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                lineHeight: '24px',
                fontWeight: 500,
                color: 'var(--text-primary)',
              }}
            >{t('Hi! Meet your Chief of Staff')}
            </h1>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: '21px',
            color: 'var(--text-secondary)',
          }}
        >{t('Chief of Staff will ask a few quick questions about the workflow you want to build — product coding, research, content or operations — then automatically installs a team of bots with skills, starter tasks and MCP connection suggestions.')}
        </p>

        <div
          style={{
            padding: 12,
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 12.5,
            lineHeight: '19px',
            color: 'var(--text-secondary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div>{t('• Answer 4–5 short questions about your needs')}</div>
          <div>{t('• Review the suggested bot team, models, MCP servers and starter tasks')}</div>
          <div>{t('• Confirm once — all bots & the tasklist are created automatically')}</div>
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: 'var(--agent-red)' }}>{error}</div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handleStartNew()}
            className="transition-atelier"
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--action-primary)',
              color: 'var(--action-primary-fg)',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <span>{busy === 'new' ? t('Preparing…') : t('Start with Chief of Staff')}</span>
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>

          {activeProject && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void handleAddToActive()}
              className="transition-atelier"
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                fontSize: 12.5,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Plus size={13} strokeWidth={1.5} />
              <span>
                {busy === 'existing' ? t('Adding…') : t('Add to the active project')}
              </span>
            </button>
          )}

          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handleDismiss()}
            style={{
              marginLeft: 'auto',
              padding: '6px 8px',
              fontSize: 12.5,
              color: 'var(--text-tertiary)',
            }}
          >
            {busy === 'dismiss' ? t('Saving…') : t('Skip, set up manually')}
          </button>
        </div>
      </div>
    </div>
  );
}
