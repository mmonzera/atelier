import { ATTACHMENT_ONLY_TEXT, type MessageAttachment, type PreviewFileKind } from '@atelier/contracts';
import { Download, Eye, FolderOpen, Paperclip, X } from 'lucide-react';
import { attachmentUrl } from '../api';
import { useT } from '../i18n';
import { FileKindIcon, useFilePreview } from './FilePreviewModal';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** True when the visible text is only the neutral default for attachment-only messages. */
export function isAttachmentOnlyText(text: string): boolean {
  return text.trim() === ATTACHMENT_ONLY_TEXT;
}

function guessAttachmentPreviewKind(a: MessageAttachment): PreviewFileKind {
  if (a.kind === 'image') return 'image';
  const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf' || a.mime === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'word';
  if (ext === 'xlsx' || ext === 'csv' || ext === 'tsv') return 'excel';
  if (a.kind === 'text') return 'text';
  return 'file';
}

/**
 * Attachments inside a sent message: image thumbnails and document chips (.md, .pdf, .docx, .xlsx, .csv, .txt).
 * Clicking any attachment opens the universal FilePreviewModal with full preview and "Show file path" action.
 */
export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const t = useT();
  const { openFilePreview } = useFilePreview();
  const images = attachments.filter((a) => a.kind === 'image');
  const others = attachments.filter((a) => a.kind !== 'image');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      {images.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {images.map((a) => (
            <div
              key={a.id}
              style={{
                position: 'relative',
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-2)',
              }}
            >
              <button
                type="button"
                onClick={() => openFilePreview({ attachmentId: a.id, name: a.name })}
                title={`${a.name} · ${formatBytes(a.size)}`}
                style={{
                  padding: 0,
                  border: 0,
                  background: 'transparent',
                  lineHeight: 0,
                  cursor: 'zoom-in',
                  display: 'block',
                }}
              >
                <img
                  src={attachmentUrl(a)}
                  alt={a.name}
                  loading="lazy"
                  style={{
                    maxWidth: images.length === 1 ? 260 : 130,
                    maxHeight: images.length === 1 ? 200 : 100,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openFilePreview({ attachmentId: a.id, name: a.name, initialShowPath: true });
                }}
                title={t('Show file path')}
                aria-label={t('Show file path')}
                style={{
                  position: 'absolute',
                  bottom: 6,
                  right: 6,
                  height: 22,
                  padding: '0 7px',
                  borderRadius: 'var(--radius-full)',
                  background: 'rgba(13, 13, 17, 0.82)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontSize: 10.5,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  backdropFilter: 'blur(4px)',
                }}
              >
                <FolderOpen size={11} strokeWidth={1.75} />
                <span>{t('Path')}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {others.map((a) => {
            const pKind = guessAttachmentPreviewKind(a);
            return (
              <div
                key={a.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: 320,
                  padding: '5px 8px 5px 10px',
                  borderRadius: 10,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                }}
              >
                <button
                  type="button"
                  onClick={() => openFilePreview({ attachmentId: a.id, name: a.name })}
                  title={t('Preview {name}', { name: a.name })}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    minWidth: 0,
                    flex: 1,
                    color: 'var(--text-primary)',
                    textAlign: 'left',
                  }}
                >
                  <FileKindIcon kind={pKind} size={14} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(a.size)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openFilePreview({ attachmentId: a.id, name: a.name })}
                  title={t('Preview')}
                  aria-label={t('Preview')}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary)',
                    background: 'var(--surface-3)',
                    flexShrink: 0,
                  }}
                >
                  <Eye size={12} strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  onClick={() => openFilePreview({ attachmentId: a.id, name: a.name, initialShowPath: true })}
                  title={t('Show file path')}
                  aria-label={t('Show file path')}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary)',
                    background: 'var(--surface-3)',
                    flexShrink: 0,
                  }}
                >
                  <FolderOpen size={12} strokeWidth={1.7} />
                </button>
                <a
                  href={attachmentUrl(a)}
                  download={a.name}
                  title={t('Download')}
                  aria-label={t('Download')}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary)',
                    background: 'var(--surface-3)',
                    flexShrink: 0,
                    textDecoration: 'none',
                  }}
                >
                  <Download size={12} strokeWidth={1.7} />
                </a>
              </div>
            );
          })}
        </div>
      )}
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

/** Chips shown above (or inside) the composer while files are being attached. */
export function PendingAttachments({
  items,
  onRemove,
  inline = false,
}: {
  items: PendingUpload[];
  onRemove: (key: string) => void;
  inline?: boolean;
}) {
  const t = useT();
  if (items.length === 0) return null;
  const thumbSize = inline ? 48 : 44;
  return (
    <div
      style={
        inline
          ? {
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              padding: '4px 2px 10px',
              borderBottom: '1px solid var(--border-subtle)',
              marginBottom: 4,
            }
          : { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 6px 8px' }
      }
    >
      {items.map((it) => (
        <div key={it.key} style={{ position: 'relative' }}>
        <div
          title={it.error ?? `${it.name} · ${formatBytes(it.size)}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: thumbSize,
            maxWidth: 220,
            padding: it.previewUrl ? 0 : '0 12px 0 10px',
            borderRadius: inline ? 10 : 12,
            overflow: 'hidden',
            background: inline ? 'var(--surface-2)' : 'var(--surface-1)',
            border: `1px solid ${it.status === 'error' ? 'var(--agent-red)' : 'var(--border-default)'}`,
            opacity: it.status === 'uploading' ? 0.6 : 1,
          }}
        >
          {it.previewUrl ? (
            <img src={it.previewUrl} alt={it.name} style={{ height: thumbSize, width: thumbSize, objectFit: 'cover', display: 'block' }} />
          ) : (
            <>
              <Paperclip size={14} strokeWidth={1.5} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.name}
                </div>
                <div style={{ fontSize: 10.5, color: it.status === 'error' ? 'var(--agent-red)' : 'var(--text-muted)' }}>
                  {it.status === 'error' ? (it.error ?? t('Failed')) : it.status === 'uploading' ? t('Uploading…') : formatBytes(it.size)}
                </div>
              </div>
            </>
          )}
        </div>
          <button
            type="button"
            onClick={() => onRemove(it.key)}
            aria-label={t('Remove {name}', { name: it.name })}
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
