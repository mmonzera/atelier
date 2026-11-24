import type { QaRun } from '@atelier/contracts';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';

export function QaReportCard({
  run,
  compact = false,
  onSendFailuresToAgent,
}: {
  run: QaRun;
  compact?: boolean;
  onSendFailuresToAgent?: (run: QaRun) => void;
}) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(!run.passed);

  const errorCount =
    run.consoleErrors.length + run.pageErrors.length + run.failedRequests.length;
  const hasFailures = !run.passed || errorCount > 0;

  return (
    <>
      <div
        style={{
          padding: compact ? '10px 12px' : '12px 14px',
          borderRadius: 'var(--radius-md)',
          background: run.passed ? 'rgba(56, 201, 118, 0.06)' : 'rgba(239, 77, 66, 0.07)',
          border: `1px solid ${run.passed ? 'rgba(56, 201, 118, 0.25)' : 'rgba(239, 77, 66, 0.28)'}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {run.passed ? (
              <CheckCircle2 size={15} strokeWidth={1.75} style={{ color: 'var(--agent-green)', flexShrink: 0 }} />
            ) : (
              <XCircle size={15} strokeWidth={1.75} style={{ color: 'var(--agent-red)', flexShrink: 0 }} />
            )}
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              Browser QA {run.passed ? 'Passed' : 'Failed'}
            </span>
            <span
              className="mono-num"
              style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                padding: '1px 7px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {run.browserName} · {(run.durationMs / 1000).toFixed(1)}s
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: run.watchLive ? 'var(--agent-blue)' : 'var(--text-tertiary)',
              }}
            >
              {run.watchLive ? <Eye size={11} /> : <EyeOff size={11} />}
              {run.watchLive ? 'Watch live' : 'Headless'}
            </span>
          </div>

          {hasFailures && onSendFailuresToAgent && (
            <button
              type="button"
              onClick={() => onSendFailuresToAgent(run)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 11.5,
                fontWeight: 500,
              }}
            >
              <Send size={11} strokeWidth={1.75} />
              Fix in Chat
            </button>
          )}
        </div>

        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
          {run.summary}
        </div>

        {run.steps.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {run.steps.map((s) => (
              <div
                key={s.index}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(0, 0, 0, 0.2)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {s.ok ? (
                    <CheckCircle2 size={12} style={{ color: 'var(--agent-green)', flexShrink: 0 }} />
                  ) : (
                    <XCircle size={12} style={{ color: 'var(--agent-red)', flexShrink: 0 }} />
                  )}
                  <span
                    style={{
                      color: s.ok ? 'var(--text-primary)' : 'var(--agent-red)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.label}
                  </span>
                </span>
                <span className="mono-num" style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {s.durationMs}ms
                </span>
              </div>
            ))}
          </div>
        )}

        {errorCount > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowErrors((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--agent-red)',
                fontWeight: 500,
              }}
            >
              <AlertCircle size={12} />
              {showErrors ? 'Hide' : 'Show'} {errorCount} console / network issue
              {errorCount === 1 ? '' : 's'}
            </button>
            {showErrors && (
              <div
                className="mono-num"
                style={{
                  marginTop: 6,
                  padding: 8,
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(0, 0, 0, 0.35)',
                  border: '1px solid rgba(239, 77, 66, 0.25)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  maxHeight: 150,
                  overflowY: 'auto',
                }}
              >
                {run.pageErrors.map((err, i) => (
                  <div key={`pe-${i}`} style={{ color: 'var(--agent-red)' }}>
                    [PageError] {err}
                  </div>
                ))}
                {run.consoleErrors.map((err, i) => (
                  <div key={`ce-${i}`} style={{ color: 'var(--agent-red)' }}>
                    [Console] {err}
                  </div>
                ))}
                {run.failedRequests.map((req, i) => (
                  <div key={`req-${i}`} style={{ color: 'var(--agent-amber)' }}>
                    [{req.status}] {req.method} {req.url}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {run.screenshots.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.screenshots.map((shot) => (
              <button
                key={shot.url}
                type="button"
                onClick={() => setLightboxUrl(shot.url)}
                title={`View ${shot.label}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  padding: 4,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  textAlign: 'left',
                }}
              >
                <img
                  src={shot.url}
                  alt={shot.label}
                  style={{
                    width: compact ? 112 : 140,
                    height: compact ? 70 : 86,
                    objectFit: 'cover',
                    borderRadius: 5,
                    display: 'block',
                  }}
                />
                <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{shot.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.78)',
            zIndex: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '90vw',
              maxHeight: '90vh',
              background: 'var(--surface-1)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-default)',
              padding: 10,
            }}
          >
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              aria-label="Close screenshot"
              style={{
                position: 'absolute',
                top: 14,
                right: 14,
                width: 28,
                height: 28,
                borderRadius: '9999px',
                background: 'rgba(0, 0, 0, 0.7)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={14} />
            </button>
            <img
              src={lightboxUrl}
              alt="QA Screenshot"
              style={{
                maxWidth: '85vw',
                maxHeight: '82vh',
                display: 'block',
                borderRadius: 'var(--radius-sm)',
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
