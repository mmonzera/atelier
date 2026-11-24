import type { LibraryImage, Project } from '@atelier/contracts';
import { ChevronLeft, ChevronRight, Download, ImageIcon, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '../api';

interface LibraryViewProps {
  project: Project;
  /** Changes when chat activity may have added images (e.g. the message count). */
  refreshKey: number;
}

type SourceFilter = 'all' | 'attachment' | 'artifact';

const FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attachment', label: 'Uploads' },
  { id: 'artifact', label: 'Designs' },
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

export function LibraryView({ project, refreshKey }: LibraryViewProps) {
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .libraryImages(project.id)
      .then((res) => setImages(res.images))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Gagal memuat library.'));
  }, [project.id]);

  useEffect(() => {
    setImages(null);
    load();
  }, [load]);

  // Quietly pick up new uploads / designs while the tab is open.
  useEffect(() => {
    load();
  }, [refreshKey, load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (images ?? []).filter(
      (image) => (filter === 'all' || image.source === filter) && (!needle || image.name.toLowerCase().includes(needle)),
    );
  }, [images, query, filter]);

  const current = openIndex === null ? null : (visible[openIndex] ?? null);

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
            placeholder="Cari gambar…"
            aria-label="Cari gambar"
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
                {item.label}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={load} title="Muat ulang" aria-label="Muat ulang" className="transition-atelier" style={iconButton}>
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </div>

      {error ? (
        <div style={{ color: 'var(--agent-red)', fontSize: 13 }}>{error}</div>
      ) : images === null ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Memuat library…</div>
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
          {images.length === 0
            ? 'Belum ada gambar. Lampirkan gambar di chat atau pilih opsi desain, dan hasilnya tersimpan di sini.'
            : 'Tidak ada gambar yang cocok.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {visible.map((image, index) => (
            <button
              key={`${image.source}-${image.id}`}
              type="button"
              onClick={() => setOpenIndex(index)}
              className="transition-atelier"
              title={image.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: 0,
                textAlign: 'left',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-1)',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
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
                  src={image.url}
                  alt={image.name}
                  loading="lazy"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              </div>
              <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {image.name}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {image.source === 'attachment' ? 'Upload' : 'Design'} · {formatSize(image.sizeBytes)} · {formatDate(image.createdAt)}
                </span>
              </div>
            </button>
          ))}
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
            background: 'rgba(8, 8, 12, 0.86)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: 24,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontSize: 13 }}
          >
            <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.name}</span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              {(openIndex ?? 0) + 1} / {visible.length}
            </span>
            <a href={current.url} download={downloadName(current)} title="Unduh" aria-label="Unduh" style={iconButton}>
              <Download size={14} strokeWidth={1.75} />
            </a>
            <button type="button" onClick={() => setOpenIndex(null)} title="Tutup" aria-label="Tutup" style={iconButton}>
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: '100%', minHeight: 0 }}
          >
            <button
              type="button"
              onClick={() => setOpenIndex((i) => Math.max(0, (i ?? 0) - 1))}
              disabled={(openIndex ?? 0) === 0}
              aria-label="Sebelumnya"
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
              aria-label="Berikutnya"
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
