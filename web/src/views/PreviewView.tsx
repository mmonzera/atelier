import type { FilePreviewData, PreviewFileKind, Project, QaRun, WorkspaceFileEntry } from '@atelier/contracts';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FlaskConical,
  FolderOpen,
  Globe,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  FileKindIcon,
  FilePreviewSurface,
  formatFileSize,
  kindBadgeMeta,
} from '../components/FilePreviewModal';
import { QaReportCard } from '../components/QaReportCard';
import { toast } from '../components/Toast';
import { useT } from '../i18n';

interface PreviewViewProps {
  project: Project;
  onSavePreviewUrl: (url: string | null) => Promise<void>;
  onOpenTasks: () => void;
  onSendQaToAgent?: (run: QaRun) => void;
}

type PreviewMode = 'live-url' | 'files';
type FileCategoryFilter = 'all' | 'markdown' | 'word' | 'excel' | 'powerpoint' | 'pdf' | 'image';

const FILE_CATEGORIES: Array<{ id: FileCategoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'word', label: 'Word' },
  { id: 'excel', label: 'Excel' },
  { id: 'powerpoint', label: 'PowerPoint' },
  { id: 'pdf', label: 'PDF' },
  { id: 'image', label: 'Images' },
];

export function PreviewView({
  project,
  onSavePreviewUrl,
  onOpenTasks,
  onSendQaToAgent,
}: PreviewViewProps) {
  const t = useT();
  const [mode, setMode] = useState<PreviewMode>('live-url');
  const [urlInput, setUrlInput] = useState(project.previewUrl ?? '');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [watchLive, setWatchLive] = useState(false);
  const [runningQa, setRunningQa] = useState(false);
  const [qaRuns, setQaRuns] = useState<QaRun[]>([]);
  const [reportOpen, setReportOpen] = useState(false);

  // Files & Docs Preview state
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileCategory, setFileCategory] = useState<FileCategoryFilter>('all');
  const [fileQuery, setFileQuery] = useState('');
  const [customPathInput, setCustomPathInput] = useState('');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [activeFilePreview, setActiveFilePreview] = useState<FilePreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setUrlInput(project.previewUrl ?? '');
    setIframeLoaded(false);
    api
      .listProjectQaRuns(project.id)
      .then((res) => setQaRuns(res.runs))
      .catch(() => setQaRuns([]));
  }, [project.id, project.previewUrl]);

  const loadFilePreview = useCallback(
    (targetPath: string) => {
      setSelectedFilePath(targetPath);
      setLoadingPreview(true);
      setPreviewError(null);
      api
        .filePreview({ path: targetPath, scope: project.id })
        .then((res) => {
          setActiveFilePreview(res.preview);
        })
        .catch((err: unknown) => {
          setActiveFilePreview(null);
          setPreviewError(err instanceof Error ? err.message : t('Could not load file preview.'));
        })
        .finally(() => {
          setLoadingPreview(false);
        });
    },
    [project.id, t],
  );

  const loadWorkspaceFiles = useCallback(() => {
    setLoadingFiles(true);
    api
      .workspaceFiles(project.id)
      .then((res) => {
        setWorkspaceFiles(res.files);
        if (res.files.length > 0 && !selectedFilePath) {
          loadFilePreview(res.files[0]!.filePath);
        }
      })
      .catch(() => {
        setWorkspaceFiles([]);
      })
      .finally(() => {
        setLoadingFiles(false);
      });
  }, [project.id, selectedFilePath, loadFilePreview]);

  useEffect(() => {
    if (mode === 'files') {
      loadWorkspaceFiles();
    }
  }, [mode, loadWorkspaceFiles]);

  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    return workspaceFiles.filter((f) => {
      if (q && !f.relativePath.toLowerCase().includes(q) && !f.name.toLowerCase().includes(q)) {
        return false;
      }
      if (fileCategory === 'all') return true;
      if (fileCategory === 'image') return f.kind === 'image' || f.kind === 'svg';
      return f.kind === (fileCategory as PreviewFileKind);
    });
  }, [workspaceFiles, fileQuery, fileCategory]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = urlInput.trim();
    await onSavePreviewUrl(cleaned || null);
    setReloadNonce((n) => n + 1);
  };

  const handleOpenCustomPath = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = customPathInput.trim();
    if (!cleaned) return;
    loadFilePreview(cleaned);
  };

  const handleRunQa = async () => {
    const targetUrl = (urlInput.trim() || project.previewUrl || '').trim();
    if (!targetUrl) {
      toast.info(t('Enter a local preview URL first.'));
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
        toast.success(t('Browser QA Passed ({browserName})', { browserName: res.run.browserName }));
      } else {
        toast.info(t('Browser QA found issues · see report below'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Browser QA failed'));
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
      {/* Mode Switcher: Live Dev Server URL vs Files & Documents Previewer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            padding: 3,
            gap: 3,
            background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-full)',
          }}
        >
          <button
            type="button"
            onClick={() => setMode('live-url')}
            className="transition-atelier"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              borderRadius: 'var(--radius-full)',
              fontSize: 12,
              fontWeight: mode === 'live-url' ? 500 : 400,
              color: mode === 'live-url' ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: mode === 'live-url' ? 'var(--surface-2)' : 'transparent',
            }}
          >
            <Globe size={13} strokeWidth={1.65} />
            {t('Live App URL')}
          </button>
          <button
            type="button"
            onClick={() => setMode('files')}
            className="transition-atelier"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              borderRadius: 'var(--radius-full)',
              fontSize: 12,
              fontWeight: mode === 'files' ? 500 : 400,
              color: mode === 'files' ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: mode === 'files' ? 'var(--surface-2)' : 'transparent',
            }}
          >
            <FileCode size={13} strokeWidth={1.65} />
            {t('Files & Documents (MD / PDF / Word / Excel)')}
          </button>
        </div>
      </div>

      {mode === 'files' ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* Custom file path input bar */}
          <form
            onSubmit={handleOpenCustomPath}
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
            <FolderOpen size={15} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <input
              type="text"
              value={customPathInput}
              onChange={(e) => setCustomPathInput(e.target.value)}
              placeholder={t('Enter file path to preview (.md, .pdf, .docx, .xlsx, .pptx, .csv, .png, .svg)…')}
              className="mono-num"
              style={{
                flex: 1,
                minWidth: 200,
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
                padding: '0 11px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              {t('Preview File')}
            </button>
            <button
              type="button"
              onClick={loadWorkspaceFiles}
              title={t('Refresh workspace files')}
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
          </form>

          {/* Split pane: Workspace file list on the left, FilePreviewSurface on the right */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: '270px 1fr',
              gap: 12,
            }}
          >
            {/* Left sidebar: Workspace Files */}
            <div
              style={{
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: 10,
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 9px',
                    height: 28,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  <Search size={12} strokeWidth={1.75} />
                  <input
                    type="text"
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    placeholder={t('Filter files…')}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 12,
                    }}
                  />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {FILE_CATEGORIES.map((cat) => {
                    const active = fileCategory === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setFileCategory(cat.id)}
                        style={{
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: 11,
                          fontWeight: active ? 600 : 400,
                          background: active ? 'var(--surface-3)' : 'transparent',
                          border: `1px solid ${active ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                          color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                        }}
                      >
                        {t(cat.label)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {loadingFiles ? (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                    {t('Scanning workspace files…')}
                  </div>
                ) : filteredFiles.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                    {t('No matching files in workspace. Paste a file path above to preview.')}
                  </div>
                ) : (
                  filteredFiles.map((f) => {
                    const isSelected = selectedFilePath === f.filePath;
                    const badge = kindBadgeMeta(f.kind);
                    return (
                      <button
                        key={f.filePath}
                        type="button"
                        onClick={() => loadFilePreview(f.filePath)}
                        title={f.filePath}
                        className="transition-atelier"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 3,
                          padding: '7px 9px',
                          borderRadius: 'var(--radius-sm)',
                          background: isSelected ? 'var(--surface-3)' : 'transparent',
                          border: `1px solid ${isSelected ? 'var(--border-default)' : 'transparent'}`,
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                          <FileKindIcon kind={f.kind} size={14} />
                          <span
                            style={{
                              fontSize: 12.5,
                              fontWeight: isSelected ? 600 : 500,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1,
                            }}
                          >
                            {f.name}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: badge.color,
                              background: badge.bg,
                              padding: '1px 6px',
                              borderRadius: 'var(--radius-full)',
                              flexShrink: 0,
                            }}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            fontSize: 11,
                            color: 'var(--text-tertiary)',
                            paddingLeft: 21,
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.relativePath}
                          </span>
                          <span className="mono-num" style={{ flexShrink: 0 }}>
                            {formatFileSize(f.sizeBytes)}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Pane: Rich Preview Surface with "Show file path" */}
            <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {loadingPreview ? (
                <div
                  style={{
                    flex: 1,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                  }}
                >
                  <Loader2 size={20} className="atelier-spin" style={{ color: 'var(--agent-blue)' }} />
                  <span>{t('Loading file preview…')}</span>
                </div>
              ) : previewError ? (
                <div
                  style={{
                    flex: 1,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    padding: 24,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: 'var(--agent-red)', fontSize: 13.5 }}>{previewError}</div>
                </div>
              ) : activeFilePreview ? (
                <FilePreviewSurface preview={activeFilePreview} initialShowPath={true} />
              ) : (
                <div
                  style={{
                    flex: 1,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    padding: 32,
                    textAlign: 'center',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  <FileCode size={28} strokeWidth={1.4} />
                  <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {t('Select a file to preview')}
                  </div>
                  <div style={{ fontSize: 12.5, maxWidth: 380 }}>
                    {t('Choose a Markdown, PDF, Word (.docx), Excel (.xlsx / .csv), or Image file from the workspace list, or enter a path above.')}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
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
              placeholder={t('http://localhost:3000 or local dev server URL')}
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
              {t('Apply')}
            </button>

            {(project.previewUrl || urlInput.trim()) && (
              <>
                <button
                  type="button"
                  onClick={() => setWatchLive((v) => !v)}
                  title={
                    watchLive
                      ? t('Watch live: opens visible browser window during QA')
                      : t('Headless: runs silently in background')
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
                  {watchLive ? t('Watch live') : t('Headless')}
                </button>

                <button
                  type="button"
                  disabled={runningQa}
                  onClick={() => void handleRunQa()}
                  title={t('Run automated Browser E2E QA & screenshot check')}
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
                  {runningQa ? t('Testing…') : t('Run Browser QA')}
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
                  title={t('Reload preview')}
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
                  title={t('Open preview in new tab')}
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
                  {t('Latest Browser QA:')}{' '}
                  <strong style={{ color: latestRun.passed ? 'var(--agent-green)' : 'var(--agent-red)' }}>
                    {latestRun.passed ? t('Passed') : t('Failed')}
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
                    {t('Loading preview…')}
                  </div>
                )}
                <iframe
                  key={`${project.previewUrl}-${reloadNonce}`}
                  src={project.previewUrl}
                  onLoad={() => setIframeLoaded(true)}
                  title={t('Build Preview — {name}', { name: project.name })}
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
                  {t('No preview URL yet')}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  {t(
                    'Dispatch a task to an agent with shell permissions to spin up a local dev server, or enter a local preview URL above.',
                  )}
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
                  {t('Open Tasks')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
