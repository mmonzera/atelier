import { ATTACHMENT_ONLY_TEXT, type MessageAttachment } from '@atelier/contracts';
import { FileText, Paperclip, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { attachmentUrl } from '../api';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** True when the visible text is only the neutral default for attachment-only messages. */
export function isAttachmentOnlyText(text: string): boolean {
  return text.trim() === ATTACHMENT_ONLY_TEXT;
}

function Lightbox({ attachment, onClose }: { attachment: MessageAttachment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label={attachment.name}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(6, 6, 9, 0.86)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        style={{ position: 'absolute', top: 16, right: 16, color: 'var(--text-secondary)' }}
      >
        <X size={20} />
      </button>
      <img
        src={attachmentUrl(attachment)}
        alt={attachment.name}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 8 }}
      />
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {attachment.name} · {formatBytes(attachment.size)}
      </div>
    </div>
  );
}

/** Attachments inside a sent message: image thumbnails (click to enlarge) and file chips (download). */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const [open, setOpen] = useState<MessageAttachment | null>(null);
  const images = attachments.filter((a) => a.kind === 'image');
  const others = attachments.filter((a) => a.kind !== 'image');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      {images.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(a)}
              title={`${a.name} · ${formatBytes(a.size)}`}
              style={{
                padding: 0,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-2)',
                lineHeight: 0,
                cursor: 'zoom-in',
              }}
            >
              <img
                src={attachmentUrl(a)}
                alt={a.name}
                loading="lazy"
                style={{ maxWidth: images.length === 1 ? 260 : 130, maxHeight: images.length === 1 ? 200 : 100, objectFit: 'cover', display: 'block' }}
              />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {others.map((a) => (
            <a
              key={a.id}
              href={attachmentUrl(a)}
              download={a.name}
              title="Download"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                maxWidth: 240,
                padding: '6px 10px',
                borderRadius: 10,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                fontSize: 12,
                textDecoration: 'none',
              }}
            >
              <FileText size={14} strokeWidth={1.5} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(a.size)}</span>
            </a>
          ))}
        </div>
      )}
      {open && createPortal(<Lightbox attachment={open} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}

export interface PendingUpload {
  key: string;
  name: string;
  size: number;
  isImage: boolean;
  previewUrl: string | null;
  status: 'uploading' | 'done' | 'error';
  attachment?: MessageAttachment;
  error?: string;
}

/** Chips shown above the composer while files are being attached. */
export function PendingAttachments({
  items,
  onRemove,
}: {
  items: PendingUpload[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 6px 8px' }}>
      {items.map((it) => (
        <div key={it.key} style={{ position: 'relative' }}>
        <div
          title={it.error ?? `${it.name} · ${formatBytes(it.size)}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 44,
            maxWidth: 220,
            padding: it.previewUrl ? 0 : '0 12px 0 10px',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--surface-1)',
            border: `1px solid ${it.status === 'error' ? 'var(--agent-red)' : 'var(--border-default)'}`,
            opacity: it.status === 'uploading' ? 0.6 : 1,
          }}
        >
          {it.previewUrl ? (
            <img src={it.previewUrl} alt={it.name} style={{ height: 44, width: 44, objectFit: 'cover', display: 'block' }} />
          ) : (
            <>
              <Paperclip size={14} strokeWidth={1.5} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.name}
                </div>
                <div style={{ fontSize: 10.5, color: it.status === 'error' ? 'var(--agent-red)' : 'var(--text-muted)' }}>
                  {it.status === 'error' ? (it.error ?? 'Gagal') : it.status === 'uploading' ? 'Mengunggah…' : formatBytes(it.size)}
                </div>
              </div>
            </>
          )}
        </div>
          <button
            type="button"
            onClick={() => onRemove(it.key)}
            aria-label={`Remove ${it.name}`}
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              borderRadius: 9999,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--surface-3)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
            }}
          >
            <X size={10} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
