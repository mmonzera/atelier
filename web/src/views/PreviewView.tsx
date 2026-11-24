import type { Project, QaRun } from '@atelier/contracts';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  FlaskConical,
  Globe,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { QaReportCard } from '../components/QaReportCard';
import { toast } from '../components/Toast';

interface PreviewViewProps {
  project: Project;
  onSavePreviewUrl: (url: string | null) => Promise<void>;
  onOpenTasks: () => void;
  onSendQaToAgent?: (run: QaRun) => void;
}

export function PreviewView({
  project,
  onSavePreviewUrl,
  onOpenTasks,
  onSendQaToAgent,
}: PreviewViewProps) {
  const [urlInput, setUrlInput] = useState(project.previewUrl ?? '');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [watchLive, setWatchLive] = useState(false);
  const [runningQa, setRunningQa] = useState(false);
  const [qaRuns, setQaRuns] = useState<QaRun[]>([]);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    setUrlInput(project.previewUrl ?? '');
    setIframeLoaded(false);
    api
      .listProjectQaRuns(project.id)
      .then((res) => setQaRuns(res.runs))
      .catch(() => setQaRuns([]));
  }, [project.id, project.previewUrl]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = urlInput.trim();
    await onSavePreviewUrl(cleaned || null);
    setReloadNonce((n) => n + 1);
  };

  const handleRunQa = async () => {
    const targetUrl = (urlInput.trim() || project.previewUrl || '').trim();
    if (!targetUrl) {
      toast.info('Enter a local preview URL first.');
      return;
    }
    setRunningQa(true);
    try {
      const res = await api.runProjectQa(project.id, {
        url: targetUrl,
        watchLive,
        postToChat: true,
      });
      setQaRuns((prev) => [res.run, ...prev.filter((r) => r.id !== res.run.id)].slice(0, 15));
      setReportOpen(true);
      if (res.run.passed) {
        toast.success(`Browser QA Passed (${res.run.browserName})`);
      } else {
        toast.info(`Browser QA found issues · see report below`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Browser QA failed');
    } finally {
      setRunningQa(false);
    }
  };

  const latestRun = qaRuns[0] ?? null;

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
      }}
    >
      <form
        onSubmit={handleSave}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          flexWrap: 'wrap',
        }}
      >
        <Globe size={15} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="http://localhost:3000 or local dev server URL"
          className="mono-num"
          style={{
            flex: 1,
            minWidth: 180,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        />
        <button
          type="submit"
          style={{
            height: 28,
            padding: '0 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          Apply
        </button>

        {(project.previewUrl || urlInput.trim()) && (
          <>
            <button
              type="button"
              onClick={() => setWatchLive((v) => !v)}
              title={
                watchLive
                  ? 'Watch live: opens visible browser window during QA'
                  : 'Headless: runs silently in background'
              }
              className="transition-atelier"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 'var(--radius-sm)',
                background: watchLive ? 'rgba(59, 141, 247, 0.16)' : 'var(--surface-2)',
                border: `1px solid ${watchLive ? 'rgba(59, 141, 247, 0.45)' : 'var(--border-subtle)'}`,
                fontSize: 11.5,
                color: watchLive ? 'var(--agent-blue)' : 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {watchLive ? <Eye size={12} /> : <EyeOff size={12} />}
              {watchLive ? 'Watch live' : 'Headless'}
            </button>

            <button
              type="button"
              disabled={runningQa}
              onClick={() => void handleRunQa()}
              title="Run automated Browser E2E QA & screenshot check"
              style={{
                height: 28,
                padding: '0 11px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 11.5,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                opacity: runningQa ? 0.6 : 1,
              }}
            >
              <FlaskConical size={12} strokeWidth={1.75} />
              {runningQa ? 'Testing…' : 'Run Browser QA'}
            </button>
          </>
        )}

        {project.previewUrl && (
          <>
            <button
              type="button"
              onClick={() => {
                setIframeLoaded(false);
                setReloadNonce((n) => n + 1);
              }}
              title="Reload preview"
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <RefreshCw size={13} strokeWidth={1.5} />
            </button>
            <a
              href={project.previewUrl}
              target="_blank"
              rel="noreferrer"
              title="Open preview in new tab"
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <ExternalLink size={13} strokeWidth={1.5} />
            </a>
          </>
        )}
      </form>

      {latestRun && (
        <div
          style={{
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={() => setReportOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            <span>
              Latest Browser QA:{' '}
              <strong style={{ color: latestRun.passed ? 'var(--agent-green)' : 'var(--agent-red)' }}>
                {latestRun.passed ? 'Passed' : 'Failed'}
              </strong>{' '}
              <span style={{ color: 'var(--text-tertiary)' }}>· {latestRun.summary}</span>
            </span>
            {reportOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {reportOpen && (
            <QaReportCard
              run={latestRun}
              compact
              onSendFailuresToAgent={onSendQaToAgent}
            />
          )}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {project.previewUrl ? (
          <>
            {!iframeLoaded && (
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 12,
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  zIndex: 2,
                }}
              >
                Loading preview…
              </div>
            )}
            <iframe
              key={`${project.previewUrl}-${reloadNonce}`}
              src={project.previewUrl}
              onLoad={() => setIframeLoaded(true)}
              title={`Build Preview — ${project.name}`}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: '#0d0d11',
              }}
            />
          </>
        ) : (
          <div
            style={{
              margin: 'auto',
              padding: 32,
              maxWidth: 420,
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <AlertTriangle size={18} strokeWidth={1.5} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
              No preview URL yet
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Dispatch a task to an agent with shell permissions to spin up a local dev server, or enter a local preview URL above.
            </div>
            <button
              type="button"
              onClick={onOpenTasks}
              style={{
                marginTop: 4,
                padding: '8px 14px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 12.5,
                fontWeight: 500,
              }}
            >
              Open Tasks
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
