import type { Activity, Agent, ModelProvider, Settings, Task } from '@atelier/contracts';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Eye,
  FileImage,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getColorVar } from './Atoms';
import { useFilePreview } from './FilePreviewModal';
import { ProviderIcon } from './ProviderIcon';

export interface WorkPoint {
  id: string;
  title: string;
  status: 'done' | 'in_progress' | 'pending' | 'error';
  count: number;
  filePath?: string;
  artifactId?: string;
}

export type WorkPointActivity = Pick<Activity, 'id' | 'kind' | 'label' | 'createdAt'> & {
  detail?: string | null;
};

export function formatElapsedCompact(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '1s';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function LiveElapsed({ startIso, compactSeconds }: { startIso: string; compactSeconds?: boolean }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startMs = new Date(startIso).getTime() || Date.now();
    const tick = () => setElapsedMs(Math.max(0, Date.now() - startMs));
    tick();
    const id = window.setInterval(tick, compactSeconds ? 500 : 200);
    return () => window.clearInterval(id);
  }, [startIso, compactSeconds]);

  const secs = elapsedMs / 1000;
  return (
    <span className="mono-num">
      {compactSeconds ? `${Math.max(1, Math.round(secs))}s` : `${secs.toFixed(1)}s`}
    </span>
  );
}

function parseJsonDetail(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function fileBasename(rawPath: string | null): string | null {
  if (!rawPath) return null;
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? rawPath;
}

function trimMiddle(text: string, max = 46): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function hostFromUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname || raw;
  } catch {
    return trimMiddle(raw, 36);
  }
}

function extractActivityFileTarget(act: WorkPointActivity): { filePath?: string; artifactId?: string } {
  const detail = parseJsonDetail(act.detail);
  if (detail) {
    const artifactId = firstString(detail, ['artifactId']) ?? undefined;
    let filePath =
      firstString(detail, [
        'file_path',
        'path',
        'TargetFile',
        'AbsolutePath',
        'outputPath',
        'inputPath',
        'workspacePath',
      ]) ?? undefined;
    if (!filePath && Array.isArray(detail.changes) && detail.changes[0] && typeof detail.changes[0] === 'object') {
      filePath =
        firstString(detail.changes[0] as Record<string, unknown>, ['path', 'file_path']) ?? undefined;
    }
    if (filePath || artifactId) return { filePath, artifactId };
  }
  if (act.detail && !act.detail.trim().startsWith('{')) {
    const arrowIdx = act.detail.indexOf('->');
    const candidate = (arrowIdx >= 0 ? act.detail.slice(arrowIdx + 2) : act.detail).trim();
    if (/^(?:[a-zA-Z]:[\\/]|\/)[^\n"*?<>|]+\.[a-zA-Z0-9]+$/i.test(candidate)) {
      return { filePath: candidate };
    }
  }
  return {};
}

function activityToTitle(act: WorkPointActivity, agents: Agent[]): string {
  const label = act.label.trim();
  const lower = label.toLowerCase();
  const detail = parseJsonDetail(act.detail);

  if (lower === 'read' || lower === 'view_file' || lower === 'read_file') {
    const base = fileBasename(firstString(detail, ['file_path', 'path', 'TargetFile', 'AbsolutePath']));
    return base ? `Read ${base}` : 'Read file';
  }

  if (
    lower === 'edit' ||
    lower === 'write' ||
    lower === 'write_to_file' ||
    lower === 'replace_file_content' ||
    lower === 'multi_replace_file_content'
  ) {
    if (detail && Array.isArray(detail.changes)) {
      const n = detail.changes.length;
      if (n > 1) return `Edited ${n} files`;
      const first = detail.changes[0];
      const base =
        first && typeof first === 'object'
          ? fileBasename(firstString(first as Record<string, unknown>, ['path', 'file_path']))
          : null;
      return base ? `Edited ${base}` : 'Edited file';
    }
    const base = fileBasename(firstString(detail, ['file_path', 'path', 'TargetFile', 'AbsolutePath']));
    return base ? `Edited ${base}` : 'Edited file';
  }

  if (lower === 'atelier.generate_image' || lower.startsWith('generated image')) {
    const base = fileBasename(
      firstString(detail, ['path', 'outputPath', 'workspacePath']) ??
        extractActivityFileTarget(act).filePath ??
        null,
    );
    const prompt = firstString(detail, ['prompt']);
    if (base) return `Generated image · ${base}`;
    if (prompt) return `Generated image · ${trimMiddle(prompt, 34)}`;
    return 'Generated image';
  }

  if (lower === 'atelier.optimize_svg' || lower.startsWith('optimized svg')) {
    const base = fileBasename(
      firstString(detail, ['path', 'outputPath', 'inputPath', 'workspacePath']) ??
        extractActivityFileTarget(act).filePath ??
        null,
    );
    return base ? `Optimized SVG · ${base}` : 'Optimized SVG';
  }

  if (lower === 'bash' || lower === 'run_command' || lower === 'shell') {
    const cmd = firstString(detail, ['command', 'CommandLine', 'cmd']);
    return cmd ? `Ran ${trimMiddle(cmd.replace(/\s+/g, ' '), 44)}` : 'Ran command';
  }

  if (
    lower === 'glob' ||
    lower === 'grep' ||
    lower === 'find_by_name' ||
    lower === 'grep_search' ||
    lower === 'list_dir'
  ) {
    const query =
      firstString(detail, ['pattern', 'Pattern', 'Query', 'query']) ??
      fileBasename(firstString(detail, ['path', 'SearchDirectory', 'DirectoryPath']));
    return query ? `Searched ${trimMiddle(query, 40)}` : 'Searched workspace';
  }

  if (lower.startsWith('browser_')) {
    const action = lower.slice('browser_'.length).replace(/_/g, ' ');
    const urlHost = hostFromUrl(firstString(detail, ['url']));
    return urlHost ? `Browser: ${action} (${urlHost})` : `Browser: ${action}`;
  }

  if (lower === 'atelier.message_agent') {
    const targetId = firstString(detail, ['targetAgentId']);
    const target = targetId ? agents.find((a) => a.id === targetId) : undefined;
    return target ? `Delegated to ${target.name}` : 'Messaged teammate';
  }

  if (lower === 'atelier.create_task' || lower === 'atelier.update_task') {
    const id = firstString(detail, ['identifier']);
    const title = firstString(detail, ['title']);
    const verb = lower.endsWith('create_task') ? 'Created task' : 'Updated task';
    if (id && title) return `${verb} ${id}: ${trimMiddle(title, 34)}`;
    if (id) return `${verb} ${id}`;
    if (title) return `${verb}: ${trimMiddle(title, 38)}`;
    return verb;
  }

  if (lower === 'atelier.run_browser_qa') {
    const host = hostFromUrl(firstString(detail, ['url']));
    return host ? `Browser QA: ${host}` : 'Browser QA';
  }

  if (lower.startsWith('atelier.')) {
    const action = label.slice('atelier.'.length).replace(/_/g, ' ');
    const key = firstString(detail, ['key', 'id', 'query']);
    return key ? `${action}: ${trimMiddle(key, 36)}` : action;
  }

  if (act.detail && !act.detail.trim().startsWith('{')) {
    return `${label} · ${trimMiddle(act.detail.trim(), 44)}`;
  }

  return label;
}

/** Collapses raw tool call activities into concise Antigravity-style work points. */
export function summarizeActivitiesToWorkPoints(
  activities: WorkPointActivity[],
  isStreaming: boolean,
  agents: Agent[] = [],
): WorkPoint[] {
  const points: WorkPoint[] = [];
  for (const act of activities) {
    const status: WorkPoint['status'] = act.kind === 'error' ? 'error' : 'done';
    const title = activityToTitle(act, agents);
    const { filePath, artifactId } = extractActivityFileTarget(act);
    const prev = points[points.length - 1];
    if (prev && prev.title === title && prev.status === status) {
      prev.count += 1;
      if (filePath && !prev.filePath) prev.filePath = filePath;
      if (artifactId && !prev.artifactId) prev.artifactId = artifactId;
    } else {
      points.push({
        id: act.id,
        title,
        status,
        count: 1,
        ...(filePath ? { filePath } : {}),
        ...(artifactId ? { artifactId } : {}),
      });
    }
  }
  if (isStreaming && points.length > 0) {
    const last = points[points.length - 1]!;
    if (last.status !== 'error') {
      last.status = 'in_progress';
    }
  }
  return points;
}

export interface GeneratedMediaItem {
  id: string;
  label: string;
  filePath?: string;
  artifactId?: string;
  rawUrl: string;
}

export function extractGeneratedMediaFromActivities(
  activities: WorkPointActivity[],
): GeneratedMediaItem[] {
  const out: GeneratedMediaItem[] = [];
  const seen = new Set<string>();
  for (const act of activities) {
    if (act.kind === 'error') continue;
    const lower = act.label.trim().toLowerCase();
    const isGenImg = lower === 'atelier.generate_image' || lower.startsWith('generated image');
    const isOptSvg = lower === 'atelier.optimize_svg' || lower.startsWith('optimized svg');
    if (!isGenImg && !isOptSvg) continue;

    const detail = parseJsonDetail(act.detail);
    if (detail && detail.ok === false) continue;
    const { filePath, artifactId } = extractActivityFileTarget(act);
    if (!filePath && !artifactId) continue;

    const dedupeKey = artifactId ?? filePath!;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const qs = new URLSearchParams();
    if (artifactId) qs.set('artifactId', artifactId);
    else if (filePath) qs.set('path', filePath);

    const label =
      fileBasename(filePath ?? null) ??
      firstString(detail, ['prompt'])?.slice(0, 40) ??
      (isOptSvg ? 'optimized.svg' : 'generated-image.png');

    out.push({
      id: act.id,
      label,
      filePath,
      artifactId,
      rawUrl: `/api/files/raw?${qs.toString()}`,
    });
  }
  return out;
}

export function GeneratedMediaStrip({ activities }: { activities: WorkPointActivity[] }) {
  const tr = useT();
  const { openFilePreview } = useFilePreview();
  const items = extractGeneratedMediaFromActivities(activities);
  if (items.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {items.map((item) => (
        <div
          key={item.id}
          style={{
            width: 240,
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <button
            type="button"
            onClick={() =>
              openFilePreview({
                path: item.filePath,
                artifactId: item.artifactId,
                name: item.label,
              })
            }
            title={tr('Preview {name}', { name: item.label })}
            style={{
              padding: 0,
              border: 0,
              background: '#0a0a0e',
              cursor: 'zoom-in',
              display: 'block',
            }}
          >
            <img
              src={item.rawUrl}
              alt={item.label}
              loading="lazy"
              style={{
                width: '100%',
                height: 140,
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </button>
          <div
            style={{
              padding: '7px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text-primary)',
              }}
            >
              <FileImage size={12} strokeWidth={1.6} style={{ flexShrink: 0, color: 'var(--agent-purple)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
            </span>
            <button
              type="button"
              onClick={() =>
                openFilePreview({
                  path: item.filePath,
                  artifactId: item.artifactId,
                  name: item.label,
                  initialShowPath: true,
                })
              }
              title={item.filePath ?? tr('Show file path')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                borderRadius: 6,
                background: 'var(--surface-3)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <FolderOpen size={11} strokeWidth={1.7} />
              {tr('Show file path')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkPointStatusIcon({ status }: { status: WorkPoint['status'] }) {
  if (status === 'done') {
    return (
      <CheckCircle2
        size={13}
        strokeWidth={1.75}
        style={{ color: 'var(--agent-green)', flexShrink: 0 }}
      />
    );
  }
  if (status === 'in_progress') {
    return (
      <Loader2
        size={13}
        strokeWidth={1.75}
        className="atelier-spin"
        style={{ color: 'var(--agent-blue)', flexShrink: 0 }}
      />
    );
  }
  if (status === 'error') {
    return (
      <AlertCircle
        size={13}
        strokeWidth={1.75}
        style={{ color: 'var(--agent-red)', flexShrink: 0 }}
      />
    );
  }
  return (
    <Circle
      size={12}
      strokeWidth={1.5}
      style={{ color: 'var(--text-muted)', flexShrink: 0 }}
    />
  );
}

export function WorkPointsChecklist({
  activities,
  streaming,
  durationMs,
  createdAt,
  agents,
  pendingTasks = [],
  expanded,
  onToggle,
}: {
  activities: WorkPointActivity[];
  streaming: boolean;
  durationMs: number | null;
  createdAt: string;
  agents: Agent[];
  pendingTasks?: Task[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const tr = useT();
  const { openFilePreview } = useFilePreview();
  const points = summarizeActivitiesToWorkPoints(activities, streaming, agents);
  const queuedItems: WorkPoint[] = streaming
    ? pendingTasks.slice(0, 3).map((t) => ({
        id: `pending-${t.id}`,
        title: `${t.identifier} · ${t.title}`,
        status: 'pending' as const,
        count: 1,
      }))
    : [];
  const allItems = [...points, ...queuedItems];

  if (!streaming && !expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          className="transition-atelier"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12.5,
            lineHeight: '18px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>{tr('Worked for {v0}', { v0: formatElapsedCompact(durationMs) })}</span>
          <ChevronRight size={13} strokeWidth={1.6} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        onClick={onToggle}
        className="transition-atelier"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12.5,
          lineHeight: '18px',
          color: 'var(--text-secondary)',
          alignSelf: 'flex-start',
        }}
      >
        {streaming ? (
          <Loader2
            size={13}
            strokeWidth={1.75}
            className="atelier-spin"
            style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
          />
        ) : null}
        <span style={{ color: streaming ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {streaming
            ? tr('Working')
            : tr('Worked for {v0}', { v0: formatElapsedCompact(durationMs) })}
        </span>
        {streaming && (
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            <LiveElapsed startIso={createdAt} />
          </span>
        )}
        {allItems.length > 0 &&
          (expanded ? (
            <ChevronDown size={13} strokeWidth={1.6} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.6} />
          ))}
      </button>

      {expanded && allItems.length > 0 && (
        <div
          className="transition-expand"
          style={{
            marginLeft: 4,
            paddingLeft: 10,
            borderLeft: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          {allItems.map((pt) => (
            <div
              key={pt.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                minWidth: 0,
                fontSize: 12.5,
                lineHeight: '18px',
                color:
                  pt.status === 'in_progress'
                    ? 'var(--text-primary)'
                    : pt.status === 'error'
                      ? 'var(--agent-red)'
                      : pt.status === 'pending'
                        ? 'var(--text-muted)'
                        : 'var(--text-secondary)',
              }}
            >
              <WorkPointStatusIcon status={pt.status} />
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {pt.title}
              </span>
              {pt.count > 1 && (
                <span
                  className="mono-num"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    flexShrink: 0,
                  }}
                >
                  ×{pt.count}
                </span>
              )}
              {(pt.filePath || pt.artifactId) && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() =>
                      openFilePreview({
                        path: pt.filePath,
                        artifactId: pt.artifactId,
                        name: fileBasename(pt.filePath ?? null) ?? pt.title,
                      })
                    }
                    title={tr('Preview file')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '1px 6px',
                      borderRadius: 5,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      fontSize: 10.5,
                    }}
                  >
                    <Eye size={10} strokeWidth={1.75} />
                    {tr('Preview')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openFilePreview({
                        path: pt.filePath,
                        artifactId: pt.artifactId,
                        name: fileBasename(pt.filePath ?? null) ?? pt.title,
                        initialShowPath: true,
                      })
                    }
                    title={pt.filePath ?? tr('Show file path')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '1px 6px',
                      borderRadius: 5,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      fontSize: 10.5,
                    }}
                  >
                    <FolderOpen size={10} strokeWidth={1.75} />
                    {tr('Path')}
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ParallelAgentsStrip({
  agents,
  settings,
  earliestActiveIso,
  onSelectAgent,
  onStopAgents,
}: {
  agents: Agent[];
  settings?: Settings;
  earliestActiveIso: string;
  onSelectAgent: (agentId: string) => void;
  onStopAgents: (agentIds: string[]) => Promise<void> | void;
}) {
  const tr = useT();
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);

  if (agents.length === 0) return null;

  const visibleIcons = agents.slice(0, 3);
  const extraCount = agents.length - visibleIcons.length;
  const taskSummary = agents
    .map((a) => (a.currentTask ? trimMiddle(a.currentTask.trim(), 38) : a.name))
    .join(', ');

  const handleStop = async (ids: string[]) => {
    setStopping(true);
    try {
      await onStopAgents(ids);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 4,
      }}
    >
      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 12,
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {visibleIcons.map((a, idx) => {
                const prov: ModelProvider = a.providerOverride ?? settings?.provider ?? 'claude';
                return (
                  <span
                    key={a.id}
                    style={{
                      width: 24,
                      height: 24,
                      marginLeft: idx === 0 ? 0 : -7,
                      borderRadius: '9999px',
                      background: '#141418',
                      border: '2px solid var(--bg-base)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      zIndex: 4 - idx,
                    }}
                  >
                    <ProviderIcon provider={prov} size={13} />
                  </span>
                );
              })}
              {extraCount > 0 && (
                <span
                  className="mono-num"
                  style={{
                    minWidth: 24,
                    height: 24,
                    padding: '0 5px',
                    marginLeft: -7,
                    borderRadius: '9999px',
                    background: 'var(--surface-3)',
                    border: '2px solid var(--bg-base)',
                    color: 'var(--text-primary)',
                    fontSize: 10.5,
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 0,
                  }}
                >
                  +{extraCount}
                </span>
              )}
            </div>

            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: '17px',
                  color: 'var(--text-primary)',
                }}
              >
                {tr('{count} agents', { count: agents.length })}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  lineHeight: '15px',
                  color: 'var(--agent-blue)',
                }}
              >
                {tr('{count} working', { count: agents.length })}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            <LiveElapsed startIso={earliestActiveIso} compactSeconds />
            {expanded ? (
              <ChevronUp size={14} strokeWidth={1.6} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.6} />
            )}
          </div>
        </button>

        {expanded && (
          <div
            className="transition-expand"
            style={{
              marginTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              paddingLeft: 4,
            }}
          >
            {agents.map((a) => {
              const prov: ModelProvider = a.providerOverride ?? settings?.provider ?? 'claude';
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '4px 6px',
                    borderRadius: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectAgent(a.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                      flex: 1,
                      textAlign: 'left',
                    }}
                  >
                    <ProviderIcon provider={prov} size={12} />
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '9999px',
                        background: getColorVar(a.color),
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        flexShrink: 0,
                      }}
                    >
                      {a.name}
                    </span>
                    {a.currentTask && (
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.currentTask}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={stopping}
                    onClick={() => void handleStop([a.id])}
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                    }}
                  >
                    {tr('Stop')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          fontSize: 12.5,
          lineHeight: '18px',
        }}
      >
        <Loader2
          size={13}
          strokeWidth={1.75}
          className="atelier-spin"
          style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
        />
        <span style={{ color: 'var(--text-secondary)', fontWeight: 500, flexShrink: 0 }}>
          {tr('Waiting on {count} agents', { count: agents.length })}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {taskSummary}
        </span>
        <button
          type="button"
          disabled={stopping}
          onClick={() => void handleStop(agents.map((a) => a.id))}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--text-primary)',
            flexShrink: 0,
          }}
        >
          {tr('Stop')}
        </button>
      </div>
    </div>
  );
}
