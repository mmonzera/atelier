import type {
  ExcelPreviewSheet,
  FilePreviewData,
  PreviewFileKind,
  WordPreviewBlock,
  WordPreviewRun,
} from '@atelier/contracts';
import {
  Check,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useT } from '../i18n';
import { Markdown, tokenize } from './Markdown';
import { toast } from './Toast';

export interface FilePreviewRequest {
  /** Local file path (absolute or workspace-relative). */
  path?: string;
  /** Chat attachment ID (att_...). */
  attachmentId?: string;
  /** Saved artifact ID (art_...). */
  artifactId?: string;
  /** Inline SVG block from an agent chat message. */
  svgMessageId?: string;
  svgIndex?: number;
  /** Scope for workspace-relative paths (projectId or 'direct'). */
  scope?: string | null;
  agentId?: string;
  /** Optional inline Markdown content (e.g. from a fenced ```markdown block in chat). */
  inlineMarkdown?: string;
  /** Optional inline SVG content. */
  inlineSvg?: string;
  /** Display name override for inline previews. */
  name?: string;
  /** Known file path on disk (for inline previews or pre-populated items). */
  filePath?: string;
  /** Automatically expand the "Show file path" bar when opened. */
  initialShowPath?: boolean;
}

interface FilePreviewContextValue {
  openFilePreview: (req: FilePreviewRequest) => void;
  closeFilePreview: () => void;
}

const FilePreviewContext = createContext<FilePreviewContextValue>({
  openFilePreview: () => {},
  closeFilePreview: () => {},
});

export function useFilePreview(): FilePreviewContextValue {
  return useContext(FilePreviewContext);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function kindBadgeMeta(kind: PreviewFileKind): { label: string; color: string; bg: string } {
  switch (kind) {
    case 'markdown':
      return { label: 'Markdown', color: 'var(--agent-blue)', bg: 'rgba(59, 141, 247, 0.14)' };
    case 'pdf':
      return { label: 'PDF', color: 'var(--agent-red)', bg: 'rgba(248, 113, 113, 0.14)' };
    case 'word':
      return { label: 'Word', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.15)' };
    case 'excel':
      return { label: 'Excel', color: 'var(--agent-green)', bg: 'rgba(56, 201, 118, 0.14)' };
    case 'svg':
      return { label: 'SVG', color: 'var(--agent-amber)', bg: 'rgba(245, 158, 11, 0.14)' };
    case 'image':
      return { label: 'Image', color: 'var(--agent-purple)', bg: 'rgba(168, 85, 247, 0.14)' };
    case 'text':
      return { label: 'Code / Text', color: 'var(--text-secondary)', bg: 'var(--surface-3)' };
    default:
      return { label: 'File', color: 'var(--text-secondary)', bg: 'var(--surface-3)' };
  }
}

export function FileKindIcon({ kind, size = 15 }: { kind: PreviewFileKind; size?: number }) {
  const meta = kindBadgeMeta(kind);
  const style = { color: meta.color, flexShrink: 0 };
  switch (kind) {
    case 'image':
    case 'svg':
      return <FileImage size={size} strokeWidth={1.6} style={style} />;
    case 'excel':
      return <FileSpreadsheet size={size} strokeWidth={1.6} style={style} />;
    case 'text':
    case 'markdown':
      return <FileCode size={size} strokeWidth={1.6} style={style} />;
    default:
      return <FileText size={size} strokeWidth={1.6} style={style} />;
  }
}

const toolbarBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 28,
  padding: '0 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

function excelColumnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function renderWordRuns(runs: WordPreviewRun[], keyPrefix: string): ReactNode {
  return runs.map((run, idx) => {
    let node: ReactNode = run.text;
    if (run.code) {
      node = (
        <code
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
            padding: '1px 5px',
            borderRadius: 4,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {node}
        </code>
      );
    }
    if (run.bold) node = <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{node}</strong>;
    if (run.italic) node = <em>{node}</em>;
    if (run.underline) node = <span style={{ textDecoration: 'underline' }}>{node}</span>;
    if (run.strike) node = <span style={{ textDecoration: 'line-through' }}>{node}</span>;
    if (run.href) {
      node = (
        <a
          href={run.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--agent-blue)', textDecoration: 'underline' }}
        >
          {node}
        </a>
      );
    }
    return <span key={`${keyPrefix}-${idx}`}>{node}</span>;
  });
}

function WordDocumentViewer({ blocks }: { blocks: WordPreviewBlock[] }) {
  const t = useT();
  if (blocks.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
        {t('No readable text content found in this Word document.')}
      </div>
    );
  }
  const headingSizes = [22, 18, 16, 14.5, 13.5, 13];
  return (
    <div
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '24px 28px',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 13.5,
        lineHeight: 1.6,
        color: 'var(--text-primary)',
      }}
    >
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          return (
            <div
              key={i}
              role="heading"
              aria-level={block.level}
              style={{
                fontSize: headingSizes[block.level - 1] ?? 14,
                fontWeight: 600,
                lineHeight: 1.35,
                color: 'var(--text-primary)',
                marginTop: i > 0 ? 8 : 0,
              }}
            >
              {renderWordRuns(block.runs, `wh-${i}`)}
            </div>
          );
        }
        if (block.type === 'list-item') {
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 8,
                paddingLeft: block.level * 20,
              }}
            >
              <span style={{ color: 'var(--text-tertiary)', minWidth: 16, textAlign: 'right', flexShrink: 0 }}>
                {block.ordered ? '•' : '•'}
              </span>
              <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>
                {renderWordRuns(block.runs, `wl-${i}`)}
              </div>
            </div>
          );
        }
        if (block.type === 'image') {
          return (
            <div key={i} style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
              <img
                src={block.src}
                alt={block.alt ?? 'Document image'}
                style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 8, objectFit: 'contain' }}
              />
            </div>
          );
        }
        if (block.type === 'table') {
          return (
            <div
              key={i}
              style={{
                overflowX: 'auto',
                borderRadius: 10,
                border: '1px solid var(--border-subtle)',
                margin: '4px 0',
              }}
            >
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      style={{
                        background: rIdx === 0 ? 'var(--surface-2)' : rIdx % 2 === 1 ? 'rgba(255,255,255,0.015)' : undefined,
                      }}
                    >
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          style={{
                            padding: '7px 11px',
                            borderBottom: rIdx === block.rows.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                            borderRight: cIdx === row.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                            fontWeight: rIdx === 0 ? 600 : 400,
                            color: rIdx === 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                            verticalAlign: 'top',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {renderWordRuns(cell, `wt-${i}-${rIdx}-${cIdx}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <div key={i} style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
            {renderWordRuns(block.runs, `wp-${i}`)}
          </div>
        );
      })}
    </div>
  );
}

function ExcelWorkbookViewer({ sheets }: { sheets: ExcelPreviewSheet[] }) {
  const t = useT();
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [filterText, setFilterText] = useState('');

  useEffect(() => {
    setActiveSheetIdx(0);
    setFilterText('');
  }, [sheets]);

  const sheet = sheets[activeSheetIdx] ?? sheets[0];
  const filteredRows = useMemo(() => {
    if (!sheet) return [];
    const q = filterText.trim().toLowerCase();
    if (!q) return sheet.rows.map((cells, idx) => ({ rowNum: idx + 1, cells }));
    return sheet.rows
      .map((cells, idx) => ({ rowNum: idx + 1, cells }))
      .filter((r, idx) => idx === 0 || r.cells.some((c) => c.toLowerCase().includes(q)));
  }, [sheet, filterText]);

  if (!sheet || sheet.rows.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
        {t('This spreadsheet is empty.')}
      </div>
    );
  }

  const colCount = Math.max(1, sheet.rows.reduce((m, r) => Math.max(m, r.length), 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {sheets.map((s, idx) => {
            const active = idx === activeSheetIdx;
            return (
              <button
                key={`${s.name}-${idx}`}
                type="button"
                onClick={() => setActiveSheetIdx(idx)}
                className="transition-atelier"
                style={{
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  background: active ? 'var(--surface-3)' : 'var(--surface-1)',
                  border: `1px solid ${active ? 'var(--agent-green)' : 'var(--border-subtle)'}`,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {s.name}
              </button>
            );
          })}
          <span className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginLeft: 4 }}>
            {t('{rows} rows × {cols} cols', { rows: sheet.totalRows, cols: sheet.totalCols })}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            height: 28,
            borderRadius: 'var(--radius-full)',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-tertiary)',
            minWidth: 190,
          }}
        >
          <Search size={12} strokeWidth={1.75} />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t('Filter rows…')}
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 12,
              width: '100%',
            }}
          />
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-1)',
        }}
      >
        <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 2 }}>
              <th
                style={{
                  padding: '5px 8px',
                  borderBottom: '1px solid var(--border-default)',
                  borderRight: '1px solid var(--border-subtle)',
                  color: 'var(--text-muted)',
                  fontWeight: 500,
                  textAlign: 'center',
                  width: 38,
                  position: 'sticky',
                  left: 0,
                  background: 'var(--surface-2)',
                }}
              >
                #
              </th>
              {Array.from({ length: colCount }).map((_, cIdx) => (
                <th
                  key={cIdx}
                  className="mono-num"
                  style={{
                    padding: '5px 10px',
                    borderBottom: '1px solid var(--border-default)',
                    borderRight: '1px solid var(--border-subtle)',
                    color: 'var(--text-tertiary)',
                    fontWeight: 600,
                    textAlign: 'left',
                    minWidth: 90,
                  }}
                >
                  {excelColumnName(cIdx)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(({ rowNum, cells }, rIdx) => {
              const isHeaderRow = rowNum === 1 && sheet.rows.length > 1;
              return (
                <tr
                  key={rowNum}
                  style={{
                    background: isHeaderRow
                      ? 'rgba(255, 255, 255, 0.04)'
                      : rIdx % 2 === 1
                        ? 'rgba(255, 255, 255, 0.015)'
                        : undefined,
                  }}
                >
                  <td
                    className="mono-num"
                    style={{
                      padding: '5px 8px',
                      borderBottom: '1px solid var(--border-subtle)',
                      borderRight: '1px solid var(--border-subtle)',
                      color: 'var(--text-muted)',
                      textAlign: 'right',
                      fontSize: 11,
                      background: 'var(--surface-2)',
                      position: 'sticky',
                      left: 0,
                    }}
                  >
                    {rowNum}
                  </td>
                  {Array.from({ length: colCount }).map((_, cIdx) => {
                    const val = cells[cIdx] ?? '';
                    return (
                      <td
                        key={cIdx}
                        style={{
                          padding: '6px 10px',
                          borderBottom: '1px solid var(--border-subtle)',
                          borderRight: '1px solid var(--border-subtle)',
                          color: isHeaderRow ? 'var(--text-primary)' : 'var(--text-secondary)',
                          fontWeight: isHeaderRow ? 600 : 400,
                          maxWidth: 320,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={val}
                      >
                        {val}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TOKEN_COLORS: Record<string, string | undefined> = {
  keyword: 'var(--agent-purple)',
  string: 'var(--agent-green)',
  comment: 'var(--text-muted)',
  number: 'var(--agent-amber)',
  plain: undefined,
};

/**
 * Reusable File Preview surface used both inside the modal dialog and inside the Project Preview tab.
 * Includes the "Show file path" toggle bar, Copy Path, Open in Explorer, and format-specific viewers.
 */
export function FilePreviewSurface({
  preview,
  initialShowPath = false,
  onClose,
}: {
  preview: FilePreviewData;
  initialShowPath?: boolean;
  onClose?: () => void;
}) {
  const t = useT();
  const [showPath, setShowPath] = useState(initialShowPath);
  const [pathCopied, setPathCopied] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setShowPath(initialShowPath);
    setShowSource(false);
    setZoom(1);
  }, [preview.filePath, preview.name, initialShowPath]);

  const badge = kindBadgeMeta(preview.kind);
  const hasFilePath = Boolean(preview.filePath && preview.filePath.trim());
  const copyableText = preview.markdown ?? preview.text ?? '';

  const handleCopyPath = async () => {
    if (!preview.filePath) return;
    try {
      await navigator.clipboard.writeText(preview.filePath);
      setPathCopied(true);
      toast.success(t('File path copied to clipboard'));
      window.setTimeout(() => setPathCopied(false), 1600);
    } catch {
      toast.error(t('Could not copy file path'));
    }
  };

  const handleRevealInExplorer = async () => {
    if (!preview.filePath) return;
    try {
      await api.revealFilePath({ path: preview.filePath });
      toast.info(t('Opened file location in Explorer'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Could not open file location'));
    }
  };

  const handleCopyContent = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard.writeText(copyableText);
      setContentCopied(true);
      window.setTimeout(() => setContentCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: 'var(--bg-base)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
      }}
    >
      {/* Top Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--surface-1)',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flex: 1 }}>
          <FileKindIcon kind={preview.kind} size={17} />
          <span
            title={preview.name}
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {preview.name}
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 'var(--radius-full)',
              fontSize: 11,
              fontWeight: 600,
              color: badge.color,
              background: badge.bg,
              flexShrink: 0,
            }}
          >
            {badge.label}
          </span>
          {preview.sizeBytes > 0 && (
            <span className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
              {formatFileSize(preview.sizeBytes)}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
          {hasFilePath && (
            <button
              type="button"
              onClick={() => setShowPath((v) => !v)}
              className="transition-atelier"
              title={preview.filePath}
              style={{
                ...toolbarBtn,
                background: showPath ? 'rgba(59, 141, 247, 0.16)' : 'var(--surface-2)',
                borderColor: showPath ? 'rgba(59, 141, 247, 0.45)' : 'var(--border-subtle)',
                color: showPath ? 'var(--agent-blue)' : 'var(--text-primary)',
                fontWeight: 500,
              }}
            >
              <FolderOpen size={13} strokeWidth={1.7} />
              {showPath ? t('Hide file path') : t('Show file path')}
            </button>
          )}

          {(preview.kind === 'markdown' || preview.kind === 'svg') && copyableText && (
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              className="transition-atelier"
              style={toolbarBtn}
            >
              {showSource ? <Eye size={13} strokeWidth={1.7} /> : <Code size={13} strokeWidth={1.7} />}
              {showSource ? t('Preview') : t('Source')}
            </button>
          )}

          {(preview.kind === 'image' || (preview.kind === 'svg' && !showSource)) && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2))))}
                title={t('Zoom out')}
                style={{ ...toolbarBtn, padding: '0 7px' }}
              >
                <ZoomOut size={13} />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                title={t('Reset zoom')}
                className="mono-num"
                style={{ ...toolbarBtn, padding: '0 8px', fontSize: 11.5 }}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
                title={t('Zoom in')}
                style={{ ...toolbarBtn, padding: '0 7px' }}
              >
                <ZoomIn size={13} />
              </button>
            </div>
          )}

          {copyableText && (
            <button type="button" onClick={() => void handleCopyContent()} style={toolbarBtn}>
              {contentCopied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
              {contentCopied ? t('Copied') : t('Copy')}
            </button>
          )}

          {preview.downloadUrl && (
            <a
              href={preview.downloadUrl}
              download={preview.name}
              title={t('Download')}
              style={toolbarBtn}
            >
              <Download size={13} strokeWidth={1.75} />
              {t('Download')}
            </a>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t('Close')}
              aria-label={t('Close')}
              style={{ ...toolbarBtn, padding: '0 8px' }}
            >
              <X size={15} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Collapsible File Path Bar */}
      {showPath && hasFilePath && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '8px 14px',
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              {t('File path')}
            </span>
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '3px 8px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                userSelect: 'all',
                flex: 1,
                minWidth: 0,
              }}
              title={preview.filePath}
            >
              {preview.filePath}
            </code>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => void handleCopyPath()}
              style={{
                ...toolbarBtn,
                height: 26,
                fontSize: 11.5,
                background: 'var(--surface-1)',
                color: pathCopied ? 'var(--agent-green)' : 'var(--text-primary)',
              }}
            >
              {pathCopied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
              {pathCopied ? t('Copied!') : t('Copy path')}
            </button>
            {!preview.filePath.startsWith('inline:') && (
              <button
                type="button"
                onClick={() => void handleRevealInExplorer()}
                style={{
                  ...toolbarBtn,
                  height: 26,
                  fontSize: 11.5,
                  background: 'var(--surface-1)',
                  color: 'var(--text-primary)',
                }}
              >
                <FolderOpen size={12} strokeWidth={1.75} />
                {t('Reveal in Explorer')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: preview.kind === 'pdf' ? 0 : 18,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {preview.kind === 'markdown' ? (
          showSource ? (
            <pre
              style={{
                margin: 0,
                padding: '16px 18px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-1)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: '20px',
                color: 'var(--text-primary)',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <code>{preview.markdown ?? preview.text ?? ''}</code>
            </pre>
          ) : (
            <div
              style={{
                maxWidth: 840,
                width: '100%',
                margin: '0 auto',
                padding: '22px 26px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-1)',
                fontSize: 13.5,
                lineHeight: '22px',
                color: 'var(--text-primary)',
              }}
            >
              <Markdown text={preview.markdown ?? preview.text ?? ''} />
            </div>
          )
        ) : preview.kind === 'image' || preview.kind === 'svg' ? (
          preview.kind === 'svg' && showSource ? (
            <pre
              style={{
                margin: 0,
                padding: '16px 18px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface-1)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: '19px',
                color: 'var(--text-primary)',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              <code>{preview.text ?? ''}</code>
            </pre>
          ) : (
            <div
              style={{
                flex: 1,
                minHeight: 280,
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
                background:
                  'repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 50% / 18px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'auto',
                padding: 20,
              }}
            >
              <img
                src={
                  preview.rawUrl ||
                  (preview.kind === 'svg' && preview.text
                    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.text)}`
                    : '')
                }
                alt={preview.name}
                style={{
                  maxWidth: zoom === 1 ? '100%' : 'none',
                  maxHeight: zoom === 1 ? '72vh' : 'none',
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: 'center center',
                  objectFit: 'contain',
                  borderRadius: 6,
                  transition: 'transform 120ms ease',
                }}
              />
            </div>
          )
        ) : preview.kind === 'pdf' ? (
          <div style={{ flex: 1, minHeight: 420, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <iframe
              src={preview.rawUrl}
              title={preview.name}
              style={{
                width: '100%',
                height: '100%',
                flex: 1,
                border: 'none',
                background: '#141419',
              }}
            />
            <div
              style={{
                padding: '6px 14px',
                background: 'var(--surface-1)',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              <span>{t('PDF Document Preview')}</span>
              <a
                href={preview.rawUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  color: 'var(--agent-blue)',
                  textDecoration: 'none',
                }}
              >
                <ExternalLink size={12} />
                {t('Open PDF in new tab')}
              </a>
            </div>
          </div>
        ) : preview.kind === 'word' && preview.word ? (
          <WordDocumentViewer blocks={preview.word.blocks} />
        ) : preview.kind === 'excel' && preview.excel ? (
          <ExcelWorkbookViewer sheets={preview.excel.sheets} />
        ) : preview.kind === 'text' ? (
          <pre
            style={{
              margin: 0,
              padding: '16px 18px',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--surface-1)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              lineHeight: '19px',
              color: 'var(--text-primary)',
              overflowX: 'auto',
              tabSize: 2,
            }}
          >
            <code>
              {tokenize(preview.text ?? '', preview.lang ?? '').map((token, idx) => (
                <span
                  key={idx}
                  style={{
                    color: TOKEN_COLORS[token.kind],
                    fontStyle: token.kind === 'comment' ? 'italic' : undefined,
                  }}
                >
                  {token.text}
                </span>
              ))}
            </code>
          </pre>
        ) : (
          <div
            style={{
              margin: 'auto',
              padding: 36,
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              color: 'var(--text-secondary)',
            }}
          >
            <FileKindIcon kind={preview.kind} size={32} />
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{preview.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {t('This file format cannot be rendered inline, but you can inspect its file path or download it.')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FilePreviewProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [requestState, setRequestState] = useState<FilePreviewRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewData | null>(null);

  const openFilePreview = useCallback((req: FilePreviewRequest) => {
    setRequestState(req);
    setError(null);

    if (req.inlineMarkdown !== undefined) {
      const blobUrl = URL.createObjectURL(new Blob([req.inlineMarkdown], { type: 'text/markdown;charset=utf-8' }));
      setPreview({
        name: req.name || 'document.md',
        filePath: req.filePath || (req.path ?? ''),
        sizeBytes: new Blob([req.inlineMarkdown]).size,
        mime: 'text/markdown',
        kind: 'markdown',
        rawUrl: blobUrl,
        downloadUrl: blobUrl,
        markdown: req.inlineMarkdown,
        text: req.inlineMarkdown,
        lang: 'markdown',
      });
      setLoading(false);
      return;
    }

    if (req.inlineSvg !== undefined && !req.svgMessageId && !req.path && !req.artifactId) {
      const blobUrl = URL.createObjectURL(new Blob([req.inlineSvg], { type: 'image/svg+xml;charset=utf-8' }));
      setPreview({
        name: req.name || 'illustration.svg',
        filePath: req.filePath || (req.path ?? ''),
        sizeBytes: new Blob([req.inlineSvg]).size,
        mime: 'image/svg+xml',
        kind: 'svg',
        rawUrl: blobUrl,
        downloadUrl: blobUrl,
        text: req.inlineSvg,
        lang: 'svg',
      });
      setLoading(false);
      return;
    }

    setLoading(true);
    setPreview(null);
    api
      .filePreview({
        path: req.path ?? req.filePath,
        attachmentId: req.attachmentId,
        artifactId: req.artifactId,
        svgMessageId: req.svgMessageId,
        svgIndex: req.svgIndex,
        scope: req.scope,
        agentId: req.agentId,
      })
      .then((res) => {
        setPreview(res.preview);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('Could not load file preview.'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [t]);

  const closeFilePreview = useCallback(() => {
    setRequestState(null);
    setPreview(null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!requestState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFilePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestState, closeFilePreview]);

  const ctxValue = useMemo(
    () => ({ openFilePreview, closeFilePreview }),
    [openFilePreview, closeFilePreview],
  );

  return (
    <FilePreviewContext.Provider value={ctxValue}>
      {children}
      {requestState &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={preview?.name ?? requestState.name ?? t('File preview')}
            onClick={closeFilePreview}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1100,
              background: 'rgba(6, 6, 10, 0.84)',
              backdropFilter: 'blur(6px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(94vw, 1120px)',
                height: 'min(88vh, 860px)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {loading ? (
                <div
                  style={{
                    flex: 1,
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-lg)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                  }}
                >
                  <Loader2 size={22} className="atelier-spin" style={{ color: 'var(--agent-blue)' }} />
                  <span>{t('Loading file preview…')}</span>
                </div>
              ) : error ? (
                <div
                  style={{
                    flex: 1,
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-lg)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    padding: 24,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: 'var(--agent-red)', fontSize: 13.5, fontWeight: 500 }}>{error}</div>
                  {(requestState.filePath || requestState.path) && (
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        background: 'var(--surface-2)',
                        padding: '4px 10px',
                        borderRadius: 6,
                      }}
                    >
                      {requestState.filePath ?? requestState.path}
                    </code>
                  )}
                  <button type="button" onClick={closeFilePreview} style={toolbarBtn}>
                    {t('Close')}
                  </button>
                </div>
              ) : preview ? (
                <FilePreviewSurface
                  preview={preview}
                  initialShowPath={Boolean(requestState.initialShowPath)}
                  onClose={closeFilePreview}
                />
              ) : null}
            </div>
          </div>,
          document.body,
        )}
    </FilePreviewContext.Provider>
  );
}
