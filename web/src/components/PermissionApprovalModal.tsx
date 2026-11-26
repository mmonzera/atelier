import type { CliPermissionDecision, CliPermissionRequest } from '@atelier/contracts';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { permissionsApi } from '../api';
import { useT } from '../i18n';
import { ProviderIcon } from './ProviderIcon';
import { ModalShell, secondaryBtnStyle } from './modals/ModalShell';
import { toast } from './Toast';

const PROVIDER_DISPLAY: Record<CliPermissionRequest['provider'], string> = {
  antigravity: 'Antigravity',
  openai: 'ChatGPT / Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
};

export function PermissionApprovalModal({
  approvals,
}: {
  approvals: CliPermissionRequest[];
}) {
  const t = useT();
  const [busyDecision, setBusyDecision] = useState<CliPermissionDecision | null>(null);
  const req = approvals[0];
  if (!req) return null;

  const resolve = async (decision: CliPermissionDecision) => {
    setBusyDecision(decision);
    try {
      await permissionsApi.resolveApproval(req.id, decision);
      if (decision === 'allow_always') {
        toast.success(t('Saved permission for {target}', { target: req.target }));
      } else if (decision === 'allow_all_mcp') {
        toast.success(t('Saved permission for all MCP servers'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Something went wrong.'));
    } finally {
      setBusyDecision(null);
    }
  };

  const subtitle =
    approvals.length > 1
      ? `${req.agentName} · ${PROVIDER_DISPLAY[req.provider]} (${1}/${approvals.length})`
      : `${req.agentName} · ${PROVIDER_DISPLAY[req.provider]}`;

  return createPortal(
    <ModalShell
      title={t('Permission Required')}
      subtitle={subtitle}
      width={500}
      onClose={() => {
        if (!busyDecision) void resolve('deny');
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(244, 188, 46, 0.08)',
            border: '1px solid rgba(244, 188, 46, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <ShieldAlert size={16} style={{ color: 'var(--agent-amber)', flexShrink: 0 }} />
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                background: 'rgba(244, 188, 46, 0.16)',
                color: 'var(--agent-amber)',
              }}
            >
              {req.kind}
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
              {req.target}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--text-secondary)',
              }}
            >
              <ProviderIcon provider={req.provider} size={12} />
              {PROVIDER_DISPLAY[req.provider]}
            </span>
          </div>

          <div
            className="mono-num"
            style={{
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '7px 9px',
              wordBreak: 'break-word',
            }}
          >
            {req.rawTool}
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>
            {req.reason}
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '18px' }}>
          {t(
            'Choosing Always Allow saves this permission permanently across all agents and CLI models (Antigravity, ChatGPT, Claude, OpenCode) so it will never ask again.',
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            autoFocus
            disabled={busyDecision !== null}
            onClick={() => void resolve('allow_always')}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--agent-green)',
              color: '#0d0d11',
              fontSize: 12.5,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
            }}
          >
            <ShieldCheck size={15} />
            {busyDecision === 'allow_always'
              ? t('Saving…')
              : t('Always allow {target}', { target: req.target })}
          </button>

          {req.kind === 'mcp' && (
            <button
              type="button"
              disabled={busyDecision !== null}
              onClick={() => void resolve('allow_all_mcp')}
              style={{
                height: 33,
                padding: '0 14px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(96, 165, 250, 0.14)',
                border: '1px solid rgba(96, 165, 250, 0.35)',
                color: 'var(--text-primary)',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {busyDecision === 'allow_all_mcp' ? t('Saving…') : t('Allow all MCP servers')}
            </button>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={busyDecision !== null}
              onClick={() => void resolve('allow_once')}
              style={{ ...secondaryBtnStyle, flex: 1, height: 32 }}
            >
              {t('Allow once')}
            </button>
            <button
              type="button"
              disabled={busyDecision !== null}
              onClick={() => void resolve('deny')}
              style={{
                ...secondaryBtnStyle,
                flex: 1,
                height: 32,
                color: 'var(--agent-red)',
              }}
            >
              {t('Deny')}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}
