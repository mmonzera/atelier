import {
  MCP_PRESETS,
  type McpPreset,
  type McpProbeResult,
  type McpServerConfig,
  type Settings,
} from '@atelier/contracts';
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Check,
  ChevronDown,
  FileSpreadsheet,
  FlaskConical,
  Link2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { Switch } from '../components/Switch';
import { toast } from '../components/Toast';
import { McpIcon } from '../components/modals/McpIcon';
import { McpModal } from '../components/modals/McpModal';
import { useMcpOAuth } from '../state/useMcpOAuth';
import { useT } from '../i18n';

type Filter = 'all' | 'connectors' | 'local';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'local', label: 'Local' },
];

const PREVIEW_COUNT = 4;

function matchesFilter(transport: string, filter: Filter): boolean {
  if (filter === 'all') return true;
  return filter === 'local' ? transport === 'stdio' : transport !== 'stdio';
}

function kindLabel(transport: string, oauth: boolean): string {
  if (transport === 'stdio') return 'Local MCP server';
  return oauth ? 'Connector' : 'Custom connector';
}

function endpointOf(s: McpServerConfig): string {
  return s.transport === 'stdio'
    ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
    : (s.url ?? '');
}

const pillBase: CSSProperties = {
  fontSize: 11,
  padding: '2px 9px',
  borderRadius: 'var(--radius-full)',
  whiteSpace: 'nowrap',
};

const pageTitleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 500,
  lineHeight: '28px',
  color: 'var(--text-primary)',
  margin: '0 0 22px',
};

const ghostBtn: CSSProperties = {
  height: 28,
  padding: '0 12px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);
  return ref;
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-atelier"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 10px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12.5,
        textAlign: 'left',
        color: danger ? 'var(--agent-red)' : 'var(--text-primary)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon}
      {label}
    </button>
  );
}

const menuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  minWidth: 190,
  background: 'var(--surface-1)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  padding: 6,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
      }}
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
        {title}
      </h2>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12.5,
            color: 'var(--text-secondary)',
          }}
        >
          {action.label}
          <ArrowRight size={14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

function RowMenu({
  testing,
  onTest,
  onRemove,
}: {
  testing: boolean;
  onTest: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={t('More actions')}
        onClick={() => setOpen((v) => !v)}
        className="transition-atelier"
        style={{
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-sm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          background: open ? 'var(--surface-2)' : 'transparent',
        }}
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="popover-shadow" style={menuStyle}>
          <MenuItem
            icon={<FlaskConical size={14} strokeWidth={1.5} />}
            label={testing ? t('Testing…') : t('Test connection')}
            onClick={() => {
              setOpen(false);
              onTest();
            }}
          />
          <MenuItem
            danger
            icon={<Trash2 size={14} strokeWidth={1.5} />}
            label={t('Remove')}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          />
        </div>
      )}
    </div>
  );
}

export function PluginsView({ settings, onBack }: { settings: Settings; onBack: () => void }) {
  const t = useT();
  const oauth = useMcpOAuth();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showAllMine, setShowAllMine] = useState(false);
  const [showAllDirectory, setShowAllDirectory] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addDialog, setAddDialog] = useState<
    { mode: 'preset' | 'custom' | 'json'; presetId?: string } | null
  >(null);
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const addRef = useOutsideClose(addMenuOpen, () => setAddMenuOpen(false));
  const directoryRef = useRef<HTMLElement | null>(null);

  const needle = query.trim().toLowerCase();

  const mine = useMemo(
    () =>
      settings.mcpServers.filter(
        (s) =>
          matchesFilter(s.transport, filter) &&
          (!needle || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle)),
      ),
    [settings.mcpServers, filter, needle],
  );

  const directory = useMemo(
    () =>
      MCP_PRESETS.filter(
        (p) =>
          p.id !== 'custom-stdio' &&
          p.id !== 'custom-http' &&
          matchesFilter(p.transport, filter) &&
          (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)),
      ),
    [filter, needle],
  );

  const addedPresetIds = useMemo(
    () => new Set(settings.mcpServers.map((s) => s.presetId).filter(Boolean)),
    [settings.mcpServers],
  );
  const composioPreset = useMemo(() => MCP_PRESETS.find((p) => p.id === 'composio') ?? null, []);
  const composioServer = useMemo(
    () =>
      settings.mcpServers.find(
        (s) => s.presetId === 'composio' || s.name.toLowerCase() === 'composio',
      ) ?? null,
    [settings.mcpServers],
  );
  const composioConnected = Boolean(composioServer && oauth.status[composioServer.id]?.connected);

  const handleConnectAllCloud = () => {
    if (composioServer) {
      void oauth.connect(composioServer.id);
      return;
    }
    if (!composioPreset) return;
    void oauth.addAndConnect(composioPreset, async (server) => {
      try {
        const state = await api.getState();
        await Promise.all(
          state.agents.map((agt) => {
            const current = agt.mcpServerIds ?? [];
            if (current.includes(server.id)) return Promise.resolve();
            return api.updateAgent(agt.id, { mcpServerIds: [...current, server.id] });
          }),
        );
      } catch {
        // best-effort auto-attach to existing agents
      }
    });
  };

  const visibleMine = showAllMine || needle ? mine : mine.slice(0, PREVIEW_COUNT);
  const visibleDirectory = showAllDirectory || needle ? directory : directory.slice(0, 8);

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await api.testMcpServer({ id });
      setProbes((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      setProbes((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          tools: [],
          error: err instanceof Error ? err.message : t('Test failed'),
          durationMs: 0,
        },
      }));
    } finally {
      setTestingId((cur) => (cur === id ? null : cur));
    }
  };

  const handleToggle = async (s: McpServerConfig, enabled: boolean) => {
    try {
      await api.updateMcpServer(s.id, { enabled });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update plugin'));
    }
  };

  const handleRemove = async (s: McpServerConfig) => {
    try {
      await api.deleteMcpServer(s.id);
      toast.deleted(t('“{name}” removed', { name: s.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to remove plugin'));
    }
  };

  const renderRow = (s: McpServerConfig, last: boolean) => {
    const isOauth = s.auth === 'oauth';
    const connected = Boolean(oauth.status[s.id]?.connected);
    const needsLogin = isOauth && !connected;
    const probe = probes[s.id];
    const connecting = oauth.connectingId === s.id;
    return (
      <div
        key={s.id}
        style={{
          padding: '14px 2px',
          borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <McpIcon presetId={s.presetId} name={s.name} size={32} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </span>
              {isOauth && connected && (
                <Check size={13} strokeWidth={2} style={{ color: 'var(--agent-green)' }} />
              )}
            </div>
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t(kindLabel(s.transport, isOauth))} · {s.transport} ·{' '}
              <span className="mono-num">{endpointOf(s) || t('not configured')}</span>
            </div>
          </div>

          {needsLogin && (
            <>
              <span
                style={{
                  ...pillBase,
                  background: 'rgba(244, 188, 46, 0.14)',
                  color: 'var(--agent-amber)',
                }}
              >
                {connecting ? t('Waiting for login…') : t('Sign-in needed')}
              </span>
              <button
                type="button"
                disabled={connecting}
                onClick={() => void oauth.connect(s.id)}
                style={ghostBtn}
              >{t('Reconnect')}
              </button>
            </>
          )}
          {isOauth && connected && (
            <button type="button" onClick={() => void oauth.disconnect(s.id)} style={ghostBtn}>{t('Log out')}
            </button>
          )}
          {!needsLogin && (
            <Switch
              checked={s.enabled}
              label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
              onChange={(next) => void handleToggle(s, next)}
            />
          )}
          <RowMenu
            testing={testingId === s.id}
            onTest={() => void handleTest(s.id)}
            onRemove={() => void handleRemove(s)}
          />
        </div>

        {probe && (
          <div
            style={{
              marginLeft: 44,
              fontSize: 12,
              color: probe.ok ? 'var(--agent-green)' : 'var(--agent-red)',
            }}
          >
            {probe.ok ? t('Connected ({durationMs}ms) · {length} tool{v2}{v3}', { durationMs: probe.durationMs, length: probe.tools.length, v2: probe.tools.length === 1 ? '' : 's', v3: probe.tools.length > 0
                    ? `: ${probe.tools.slice(0, 6).join(', ')}${probe.tools.length > 6 ? '…' : ''}`
                    : '' }) : probe.error || t('Connection test failed')}
          </div>
        )}
      </div>
    );
  };

  const renderPreset = (p: McpPreset) => {
    const added = addedPresetIds.has(p.id);
    return (
      <button
        key={p.id}
        type="button"
        disabled={added}
        onClick={() => setAddDialog({ mode: 'preset', presetId: p.id })}
        className="transition-atelier"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          textAlign: 'left',
          padding: '14px 10px',
          borderRadius: 'var(--radius-md)',
          cursor: added ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => {
          if (!added) e.currentTarget.style.background = 'var(--surface-1)';
        }}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <McpIcon presetId={p.id} name={p.name} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>
            {p.name}
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: '17px',
              color: 'var(--text-tertiary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              marginTop: 1,
            }}
          >
            {t(p.description)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            {p.transport === 'stdio' ? t('Local MCP server') : t('Connector')} ·{' '}
            {p.auth === 'oauth' ? t('Login') : p.transport}
          </div>
        </div>
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: '9999px',
            border: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: added ? 'var(--agent-green)' : 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          {added ? <Check size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={1.75} />}
        </span>
      </button>
    );
  };

  // Adding a plugin is a step inside this page (no dialog): back returns to the list.
  if (addDialog) {
    const preset = addDialog.presetId
      ? MCP_PRESETS.find((p) => p.id === addDialog.presetId)
      : undefined;
    const title = preset
      ? t('Add {name}', { name: preset.name })
      : addDialog.mode === 'json'
        ? t('Paste MCP JSON')
        : t('Custom connector');
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 4px 40px' }}>
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '8px 12px 0' }}>
          <button
            type="button"
            onClick={() => setAddDialog(null)}
            className="transition-atelier"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              color: 'var(--text-secondary)',
              marginBottom: 18,
            }}
          >
            <ArrowLeft size={14} strokeWidth={1.5} />{t('Back to plugins')}
          </button>
          <h1 style={pageTitleStyle}>{title}</h1>
          <McpModal
            inline
            addOnly
            settings={settings}
            initialMode={addDialog.mode}
            initialPresetId={addDialog.presetId}
            onClose={() => setAddDialog(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 4px 40px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '8px 12px 0' }}>
        <button
          type="button"
          onClick={onBack}
          className="transition-atelier"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: 'var(--text-secondary)',
            marginBottom: 18,
          }}
        >
          <ArrowLeft size={14} strokeWidth={1.5} />{t('Back to chat')}
        </button>

        <h1 style={pageTitleStyle}>{t('Plugins')}</h1>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 30 }}>
          <label
            style={{
              flex: 1,
              height: 38,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '0 12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-tertiary)',
            }}
          >
            <Search size={15} strokeWidth={1.5} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search')}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 13.5,
                color: 'var(--text-primary)',
              }}
            />
          </label>

          <div
            role="tablist"
            style={{
              display: 'inline-flex',
              padding: 3,
              gap: 2,
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {FILTERS.map((f) => {
              const on = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilter(f.id)}
                  className="transition-atelier"
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 'var(--radius-full)',
                    fontSize: 12.5,
                    fontWeight: on ? 500 : 400,
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: on ? 'var(--surface-3)' : 'transparent',
                  }}
                >
                  {t(f.label)}
                </button>
              );
            })}
          </div>

          <div ref={addRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((v) => !v)}
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--action-primary)',
                color: 'var(--action-primary-fg)',
                fontSize: 13,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >{t('Add')}
              <ChevronDown size={14} strokeWidth={1.75} />
            </button>
            {addMenuOpen && (
              <div className="popover-shadow" style={menuStyle}>
                <MenuItem
                  icon={<Search size={14} strokeWidth={1.5} />}
                  label={t('Browse directory')}
                  onClick={() => {
                    setAddMenuOpen(false);
                    setShowAllDirectory(true);
                    directoryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                />
                <MenuItem
                  icon={<Link2 size={14} strokeWidth={1.5} />}
                  label={t('Custom connector')}
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddDialog({ mode: 'custom' });
                  }}
                />
                <MenuItem
                  icon={<Plus size={14} strokeWidth={1.5} />}
                  label={t('Paste MCP JSON')}
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddDialog({ mode: 'json' });
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Built-in & All-in-One Workspace */}
        <section style={{ marginBottom: 30 }}>
          <SectionHeader title={t('Built-in & All-in-One Workspace')} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 12,
            }}
          >
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: 'rgba(56, 201, 118, 0.14)',
                  color: 'var(--agent-green)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <FileSpreadsheet size={18} strokeWidth={1.6} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {t('Local Office')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {t('Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF')}
                </div>
              </div>
              <span
                style={{
                  ...pillBase,
                  background: 'rgba(56, 201, 118, 0.14)',
                  color: 'var(--agent-green)',
                  fontWeight: 500,
                }}
              >
                {t('Built-in · Active')}
              </span>
            </div>

            <div
              style={{
                padding: '14px 16px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: 'rgba(251, 113, 133, 0.14)',
                  color: '#fb7185',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Blocks size={18} strokeWidth={1.6} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {t('All Cloud Apps')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {t('Microsoft 365, Google Workspace & Slack (Composio)')}
                </div>
              </div>
              {composioConnected ? (
                <span
                  style={{
                    ...pillBase,
                    background: 'rgba(56, 201, 118, 0.14)',
                    color: 'var(--agent-green)',
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <Check size={12} strokeWidth={2} />
                  {t('Connected')}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={
                    oauth.connectingId === 'composio' ||
                    (composioServer ? oauth.connectingId === composioServer.id : false)
                  }
                  onClick={handleConnectAllCloud}
                  style={{
                    ...ghostBtn,
                    background: 'var(--action-primary)',
                    borderColor: 'transparent',
                    color: 'var(--action-primary-fg)',
                    fontWeight: 500,
                  }}
                >
                  {oauth.connectingId === 'composio' ||
                  (composioServer && oauth.connectingId === composioServer.id)
                    ? t('Waiting…')
                    : composioServer
                      ? t('Reconnect')
                      : t('Connect all cloud apps')}
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Your plugins */}
        <section style={{ marginBottom: 38 }}>
          <SectionHeader
            title={t('Your plugins')}
            action={
              mine.length > PREVIEW_COUNT && !needle
                ? {
                    label: showAllMine ? t('Show less') : t('Show all'),
                    onClick: () => setShowAllMine((v) => !v),
                  }
                : undefined
            }
          />
          {visibleMine.length === 0 ? (
            <div
              style={{
                padding: '22px 4px',
                fontSize: 13,
                color: 'var(--text-tertiary)',
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              {settings.mcpServers.length === 0 ? t('No plugins yet. Pick one from the directory below, or use Add.') : t('No plugin matches your search.')}
            </div>
          ) : (
            <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {visibleMine.map((s, i) => renderRow(s, i === visibleMine.length - 1))}
            </div>
          )}
          {oauth.error && (
            <div style={{ fontSize: 12, color: 'var(--agent-red)', marginTop: 8 }}>{oauth.error}</div>
          )}
        </section>

        {/* Directory */}
        <section ref={directoryRef}>
          <SectionHeader
            title={t('Directory')}
            action={
              directory.length > 8 && !needle
                ? {
                    label: showAllDirectory ? t('Show less') : t('Show all'),
                    onClick: () => setShowAllDirectory((v) => !v),
                  }
                : undefined
            }
          />
          {visibleDirectory.length === 0 ? (
            <div style={{ padding: '14px 4px', fontSize: 13, color: 'var(--text-tertiary)' }}>{t('Nothing in the directory matches.')}
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                columnGap: 24,
              }}
            >
              {visibleDirectory.map(renderPreset)}
            </div>
          )}
        </section>
      </div>

    </div>
  );
}
