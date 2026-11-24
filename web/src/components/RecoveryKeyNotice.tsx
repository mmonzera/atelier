import { Copy, Download, ShieldCheck } from 'lucide-react';
import { secondaryBtnStyle } from './modals/ModalShell';
import { toast } from './Toast';
import { useT } from '../i18n';

/** Shows a one-time recovery key with copy/save actions. The server only keeps its hash. */
export function RecoveryKeyNotice({ recoveryKey, title }: { recoveryKey: string; title?: string }) {
  const t = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast.success(t('Recovery key copied'));
    } catch {
      toast.error(t('Copy failed — copy it manually from the box above.'));
    }
  };

  const save = () => {
    const text = `Atelier recovery key\n\n${recoveryKey}\n\nDibuat: ${new Date().toLocaleString()}\nPakai di layar kunci > "Lupa password?". Key ini hanya bisa dipakai sekali.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atelier-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 'var(--radius-md)',
        background: 'rgba(56, 201, 118, 0.06)',
        border: '1px solid rgba(56, 201, 118, 0.25)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-primary)' }}>
        <ShieldCheck size={15} strokeWidth={1.6} style={{ color: 'var(--agent-green)' }} />
        {title ?? t('Save this recovery key now')}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          letterSpacing: '0.06em',
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          userSelect: 'all',
          textAlign: 'center',
        }}
      >
        {recoveryKey}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('This is the only way into Atelier if you forget your password. Atelier only stores its hash, so this key will not be shown again.')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={copy} style={secondaryBtnStyle}>
          <Copy size={13} strokeWidth={1.6} />{t('Copy')}
        </button>
        <button type="button" onClick={save} style={secondaryBtnStyle}>
          <Download size={13} strokeWidth={1.6} />{t('Save .txt')}
        </button>
      </div>
    </div>
  );
}
