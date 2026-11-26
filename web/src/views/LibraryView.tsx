import { useT } from '../i18n';
import type { LibraryImage, PreviewFileKind } from '@atelier/contracts';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FolderOpen,
  ImageIcon,
  Maximize2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '../api';
import {
  FileKindIcon,
  kindBadgeMeta,
  useFilePreview,
} from '../components/FilePreviewModal';
import { toast } from '../components/Toast';

interface LibraryViewProps {
  /** Project id, or null for a direct chat. */
  projectId: string | null;
  /** Limit to one agent's images (direct chats). */
  agentId?: string;
  /** Changes when chat activity may have added images (e.g. the message count). */
  refreshKey: number;
}

type SourceFilter = 'all' | 'attachment' | 'artifact' | 'documents';

const FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attachment', label: 'Uploads' },
  { id: 'artifact', label: 'Designs' },
  { id: 'documents', label: 'Documents' },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function downloadName(image: LibraryImage): string {
  if (image.name.includes('.')) return image.name;
  return `${image.name}${image.mime === 'image/svg+xml' ? '.svg' : image.mime === 'image/jpeg' ? '.jpg' : '.png'}`;
}

function itemPreviewKind(item: LibraryImage): PreviewFileKind {
  if (item.previewKind) return item.previewKind;
  if (item.mime === 'image/svg+xml') return 'svg';
  if (item.mime.startsWith('image/')) return 'image';
  return 'file';
}

function isImageOrSvg(item: LibraryImage): boolean {
  const k = itemPreviewKind(item);
  return k === 'image' || k === 'svg';
}

const iconButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 'var(--radius-full)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};

export function LibraryView({ projectId, agentId, refreshKey }: LibraryViewProps) {
  const t = useT();
  const { openFilePreview } = useFilePreview();
  const [items, setItems] = useState<LibraryImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [showPathInLightbox, setShowPathInLightbox] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .libraryImages(projectId, agentId)
      .then((res) => {
        const merged = [...res.images, ...(res.documents ?? [])];
        setItems(merged);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('Could not load the library.')));
  }, [projectId, agentId, t]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  // Quietly pick up new uploads / designs while the tab is open.
  useEffect(() => {
    load();
  }, [refreshKey, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((item) => {
      if (needle && !item.name.toLowerCase().includes(needle)) return false;
      if (filter === 'all') return true;
      if (filter === 'documents') return !isImageOrSvg(item);
      if (filter === 'attachment') return item.source === 'attachment';
      if (filter === 'artifact') return item.source === 'artifact' && isImageOrSvg(item);
      return true;
    });
  }, [items, query, filter]);

  const current = openIndex === null ? null : (visible[openIndex] ?? null);

  useEffect(() => {
    setShowPathInLightbox(false);
    setPathCopied(false);
  }, [openIndex]);

  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenIndex(null);
      else if (event.key === 'ArrowRight') setOpenIndex((i) => (i === null ? i : Math.min(visible.length - 1, i + 1)));
      else if (event.key === 'ArrowLeft') setOpenIndex((i) => (i === null ? i : Math.max(0, i - 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIndex, visible.length]);

  const openItemPreview = (item: LibraryImage, index: number, initialShowPath = false) => {
    if (!isImageOrSvg(item) || initialShowPath) {
      if (item.id.startsWith('att_')) {
        openFilePreview({ attachmentId: item.id, name: item.name, filePath: item.filePath, initialShowPath });
      } else if (item.id.startsWith('art_')) {
        openFilePreview({ artifactId: item.id, name: item.name, filePath: item.filePath, initialShowPath });
      } else if (item.id.startsWith('svg_') && item.messageId) {
        const idx = Number(item.id.split('_').pop() ?? '0');
        openFilePreview({
          svgMessageId: item.messageId,
          svgIndex: idx,
          name: item.name,
          filePath: item.filePath,
          initialShowPath,
        });
      } else if (item.filePath) {
        openFilePreview({ path: item.filePath, name: item.name, filePath: item.filePath, initialShowPath });
      }
      return;
    }
    setOpenIndex(index);
  };

  const handleCopyLightboxPath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
      setPathCopied(true);
      toast.success(t('File path copied to clipboard'));
      window.setTimeout(() => setPathCopied(false), 1500);
    } catch {
      toast.error(t('Could not copy file path'));
    }
  };

  const handleRevealLightboxPath = async (filePath: string) => {
    try {
      await api.revealFilePath({ path: filePath });
      toast.info(t('Opened file location in Explorer'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not open file location'));
    }
  };

  return (
    <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: '1 1 220px',
            padding: '0 12px',
            height: 34,
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--surface-1)',
            color: 'var(--text-tertiary)',
          }}
        >
          <Search size={14} strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpenIndex(null);
            }}
            placeholder={t('Search images & documents…')}
            aria-label={t('Search images')}
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 0,
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 13,
            }}
          />
        </div>
        <div
          style={{
            display: 'inline-flex',
            padding: 2,
            gap: 2,
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-full)',
          }}
        >
          {FILTERS.map((item) => {
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className="transition-atelier"
                onClick={() => {
                  setFilter(item.id);
                  setOpenIndex(null);
                }}
                style={{
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: active ? 'var(--surface-2)' : 'transparent',
                }}
              >
                {t(item.label)}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={load} title={t('Reload')} aria-label={t('Reload')} className="transition-atelier" style={iconButton}>
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </div>

      {error ? (
        <div style={{ color: 'var(--agent-red)', fontSize: 13 }}>{error}</div>
      ) : items === null ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('Loading library…')}</div>
      ) : visible.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '56px 16px',
            color: 'var(--text-tertiary)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          <ImageIcon size={28} strokeWidth={1.25} />
          {items.length === 0
            ? t('No images yet. Attach an image in chat or choose a design option and it will be saved here.')
            : t('No matching images.')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(195px, 1fr))', gap: 12 }}>
          {visible.map((item, index) => {
            const pKind = itemPreviewKind(item);
            const badge = kindBadgeMeta(pKind);
            const isVisual = isImageOrSvg(item);
            return (
              <div
                key={`${item.source}-${item.id}`}
                className="transition-atelier"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface-1)',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  onClick={() => openItemPreview(item, index, false)}
                  title={item.name}
                  style={{
                    padding: 0,
                    border: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'block',
                  }}
                >
                  {isVisual ? (
                    <div
                      style={{
                        aspectRatio: '4 / 3',
                        background:
                          'repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 50% / 16px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <img
                        src={item.url}
                        alt={item.name}
                        loading="lazy"
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      />
                    </div>
                  ) : (
                    <div
                      style={{
                        aspectRatio: '4 / 3',
                        background: 'var(--surface-2)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        padding: 16,
                      }}
                    >
                      <FileKindIcon kind={pKind} size={30} />
                      <span
                        style={{
                          padding: '2px 9px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: 11,
                          fontWeight: 600,
                          color: badge.color,
                          background: badge.bg,
                        }}
                      >
                        {badge.label}
                      </span>
                    </div>
                  )}
                </button>
                <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span
                    title={item.name}
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.name}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.source === 'attachment'
                        ? t('Upload')
                        : item.source === 'workspace'
                          ? t('Workspace')
                          : t('Design')}{' '}
                      · {formatSize(item.sizeBytes)} · {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 'auto', paddingTop: 4 }}>
                    <button
                      type="button"
                      onClick={() => openItemPreview(item, index, false)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 8px',
                        borderRadius: 6,
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-secondary)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      <Eye size={11} strokeWidth={1.7} />
                      {t('Preview')}
                    </button>
                    {item.filePath && (
                      <button
                        type="button"
                        onClick={() => openItemPreview(item, index, true)}
                        title={item.filePath}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        <FolderOpen size={11} strokeWidth={1.7} />
                        {t('Show file path')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={current.name}
          onClick={() => setOpenIndex(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(8, 8, 12, 0.88)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--text-primary)',
              fontSize: 13,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
              {current.name}
            </span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              {(openIndex ?? 0) + 1} / {visible.length}
            </span>
            {current.filePath && (
              <button
                type="button"
                onClick={() => setShowPathInLightbox((v) => !v)}
                title={current.filePath}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  height: 30,
                  padding: '0 11px',
                  borderRadius: 'var(--radius-full)',
                  border: `1px solid ${showPathInLightbox ? 'rgba(59, 141, 247, 0.45)' : 'var(--border-subtle)'}`,
                  background: showPathInLightbox ? 'rgba(59, 141, 247, 0.16)' : 'var(--surface-2)',
                  color: showPathInLightbox ? 'var(--agent-blue)' : 'var(--text-primary)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <FolderOpen size={13} strokeWidth={1.75} />
                {showPathInLightbox ? t('Hide file path') : t('Show file path')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const item = current;
                const idx = openIndex ?? 0;
                setOpenIndex(null);
                openItemPreview(item, idx, true);
              }}
              title={t('Open in full previewer')}
              style={iconButton}
            >
              <Maximize2 size={14} strokeWidth={1.75} />
            </button>
            <a href={current.url} download={downloadName(current)} title={t('Download')} aria-label={t('Download')} style={iconButton}>
              <Download size={14} strokeWidth={1.75} />
            </a>
            <button type="button" onClick={() => setOpenIndex(null)} title={t('Close')} aria-label={t('Close')} style={iconButton}>
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>

          {showPathInLightbox && current.filePath && (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-default)',
                maxWidth: 'min(90vw, 880px)',
                flexWrap: 'wrap',
              }}
            >
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  userSelect: 'all',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {current.filePath}
              </code>
              <button
                type="button"
                onClick={() => void handleCopyLightboxPath(current.filePath!)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 9px',
                  borderRadius: 6,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  color: pathCopied ? 'var(--agent-green)' : 'var(--text-primary)',
                  fontSize: 11.5,
                  cursor: 'pointer',
                }}
              >
                {pathCopied ? <Check size={12} /> : <Copy size={12} />}
                {pathCopied ? t('Copied!') : t('Copy path')}
              </button>
              <button
                type="button"
                onClick={() => void handleRevealLightboxPath(current.filePath!)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 9px',
                  borderRadius: 6,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  fontSize: 11.5,
                  cursor: 'pointer',
                }}
              >
                <FolderOpen size={12} />
                {t('Reveal in Explorer')}
              </button>
            </div>
          )}

          <div
            onClick={(event) => event.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: '100%', minHeight: 0 }}
          >
            <button
              type="button"
              onClick={() => setOpenIndex((i) => Math.max(0, (i ?? 0) - 1))}
              disabled={(openIndex ?? 0) === 0}
              aria-label={t('Previous')}
              style={{ ...iconButton, opacity: (openIndex ?? 0) === 0 ? 0.35 : 1 }}
            >
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
            <img
              src={current.url}
              alt={current.name}
              style={{
                maxWidth: 'min(80vw, 1100px)',
                maxHeight: '72vh',
                objectFit: 'contain',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)',
              }}
            />
            <button
              type="button"
              onClick={() => setOpenIndex((i) => Math.min(visible.length - 1, (i ?? 0) + 1))}
              disabled={(openIndex ?? 0) >= visible.length - 1}
              aria-label={t('Next')}
              style={{ ...iconButton, opacity: (openIndex ?? 0) >= visible.length - 1 ? 0.35 : 1 }}
            >
              <ChevronRight size={16} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
