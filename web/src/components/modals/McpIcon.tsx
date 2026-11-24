import {
  BookOpen,
  Blocks,
  Brain,
  Bug,
  Triangle,
  Database,
  Folder,
  Github,
  Globe,
  Link2,
  ListTree,
  MonitorPlay,
  NotebookText,
  Plug,
  Search,
  Slack,
  SquareTerminal,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import {
  siBrave,
  siGithub,
  siLinear,
  siNotion,
  siPostgresql,
  siSentry,
  siVercel,
} from 'simple-icons';

interface Look {
  icon: LucideIcon;
  /** official brand glyph (simple-icons path, 24x24 viewBox); preferred over `icon` */
  path?: string;
  /** brand-ish accent used for the glyph and the tile tint */
  color: string;
}

const LOOKS: Record<string, Look> = {
  composio: { icon: Blocks, color: '#fb7185' },
  filesystem: { icon: Folder, color: '#fbbf24' },
  github: { icon: Github, path: siGithub.path, color: '#e6e6ee' },
  slack: { icon: Slack, color: '#f472b6' },
  notion: { icon: NotebookText, path: siNotion.path, color: '#e6e6ee' },
  'notion-oauth': { icon: NotebookText, path: siNotion.path, color: '#e6e6ee' },
  'github-oauth': { icon: Github, path: siGithub.path, color: '#e6e6ee' },
  sentry: { icon: Bug, path: siSentry.path, color: '#a78bfa' },
  vercel: { icon: Triangle, path: siVercel.path, color: '#e6e6ee' },
  postgres: { icon: Database, path: siPostgresql.path, color: '#6b93d6' },
  'brave-search': { icon: Search, path: siBrave.path, color: '#fb923c' },
  playwright: { icon: MonitorPlay, color: '#4ade80' },
  memory: { icon: Brain, color: '#c4b5fd' },
  'sequential-thinking': { icon: ListTree, color: '#f0abfc' },
  context7: { icon: BookOpen, color: '#38bdf8' },
  fetch: { icon: Globe, color: '#34d399' },
  linear: { icon: Waypoints, path: siLinear.path, color: '#a5b4fc' },
  'custom-stdio': { icon: SquareTerminal, color: '#9494a3' },
  'custom-http': { icon: Link2, color: '#9494a3' },
};

const FALLBACK: Look = { icon: Plug, color: '#9494a3' };

/** Resolve an icon from a preset id, falling back to a name match, then a generic plug. */
export function lookFor(key?: string | null, name?: string): Look {
  if (key && LOOKS[key]) return LOOKS[key];
  const n = name?.toLowerCase().trim();
  if (n && LOOKS[n]) return LOOKS[n];
  return FALLBACK;
}

export function McpIcon({
  presetId,
  name,
  size = 36,
}: {
  presetId?: string | null;
  name?: string;
  size?: number;
}) {
  const { icon: Icon, path, color } = lookFor(presetId, name);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Math.round(size * 0.3),
        color,
        background: `linear-gradient(145deg, ${color}26, ${color}0d)`,
        border: `1px solid ${color}30`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
      }}
    >
      {path ? (
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.5)}
          height={Math.round(size * 0.5)}
          fill="currentColor"
        >
          <path d={path} />
        </svg>
      ) : (
        <Icon size={Math.round(size * 0.5)} strokeWidth={1.6} />
      )}
    </span>
  );
}
