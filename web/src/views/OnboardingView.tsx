import type { Agent, Project } from '@atelier/contracts';
import { ArrowRight, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { BotMascot } from '../components/mascot/BotMascot';

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
  const [busy, setBusy] = useState<'new' | 'existing' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleStartNew = async () => {
    setBusy('new');
    setError(null);
    try {
      const res = await api.startChiefOfStaff();
      onStarted(res.project, res.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memulai Chief of Staff');
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
      setError(err instanceof Error ? err.message : 'Gagal menambahkan Chief of Staff');
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
      setError(err instanceof Error ? err.message : 'Gagal melewati onboarding');
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
              <Sparkles size={11} strokeWidth={1.5} />
              Chief of Staff
            </span>
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                lineHeight: '24px',
                fontWeight: 500,
                color: 'var(--text-primary)',
              }}
            >
              Halo! Kenalan dulu dengan Chief of Staff
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
        >
          Chief of Staff bakal tanya singkat soal workflow yang mau kamu bangun—entah itu
          coding produk, riset, konten, atau operasional—lalu otomatis install tim bot beserta
          skills, task awal, dan rekomendasi koneksi MCP-nya.
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
          <div>• Jawab 4–5 pertanyaan singkat sesuai kebutuhanmu</div>
          <div>• Review usulan tim bot, model, MCP server, dan starter tasks</div>
          <div>• Konfirmasi sekali — semua bot & tasklist langsung terbuat otomatis</div>
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
            <span>{busy === 'new' ? 'Menyiapkan…' : 'Mulai dengan Chief of Staff'}</span>
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
                {busy === 'existing'
                  ? 'Menambahkan…'
                  : `Tambahkan ke project aktif`}
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
            {busy === 'dismiss' ? 'Menyimpan…' : 'Lewati, setup manual'}
          </button>
        </div>
      </div>
    </div>
  );
}
