import { MCP_PRESETS, type Agent, type McpServerConfig, type Settings } from '@atelier/contracts';
import { ArrowUpRight, Blocks, FileSpreadsheet, Globe, Plug, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useMcpOAuth } from '../state/useMcpOAuth';
import { McpIcon } from './modals/McpIcon';
import { Switch } from './Switch';
import { toast } from './Toast';
import { useT } from '../i18n';

type OAuth = ReturnType<typeof useMcpOAuth>;

/** True when an OAuth plugin has no live login (it cannot be used until reconnected). */
export function needsAttention(server: McpServerConfig, oauth: OAuth['status']): boolean {
  return server.auth === 'oauth' && !oauth[server.id]?.connected;
}

/** Attach / detach a plugin on one agent (the agent only uses the plugins attached to it). */
export async function setPluginAttached(agent: Agent, server: McpServerConfig, attached: boolean) {
  const current = agent.mcpServerIds ?? [];
  const next = attached
    ? current.includes(server.id)
      ? current
      : [...current, server.id]
    : current.filter((id) => id !== server.id);
  await api.updateAgent(agent.id, { mcpServerIds: next });
  // a plugin switched off globally can't run even when attached
  if (attached && !server.enabled) await api.updateMcpServer(server.id, { enabled: true });
}

/**
 * The "Plugins" submenu of the composer "+" menu: search + one toggle per plugin
 * for the current agent, a Reconnect button when a login expired, and a link to the full page.
 */
export function PluginsPopover({
  agent,
  settings,
  oauth,
  onManage,
  onOpenBrowserSettings,
}: {
  agent: Agent | null;
  settings: Settings;
  oauth: OAuth;
  onManage: () => void;
  onOpenBrowserSettings?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [officeBusy, setOfficeBusy] = useState(false);

  const showBuiltInBrowser = !query.trim() || 'browser remote web'.includes(query.trim().toLowerCase());
  const browserEnabled = Boolean(agent?.browser?.enabled);
  const showBuiltInOffice =
    !query.trim() || 'office word excel powerpoint pdf docx xlsx pptx'.includes(query.trim().toLowerCase());
  const officeEnabled = agent?.office?.enabled ?? true;
  const composioPreset = useMemo(() => MCP_PRESETS.find((p) => p.id === 'composio') ?? null, []);
  const hasComposio = useMemo(
    () => settings.mcpServers.some((s) => s.presetId === 'composio' || s.name.toLowerCase() === 'composio'),
    [settings.mcpServers],
  );
  const showQuickCloud =
    !hasComposio &&
    Boolean(composioPreset) &&
    (!query.trim() || 'composio cloud office m365 microsoft 365 google workspace slack'.includes(query.trim().toLowerCase()));

  const toggleOffice = async (next: boolean) => {
    if (!agent) return;
    setOfficeBusy(true);
    try {
      await api.updateAgent(agent.id, { office: { enabled: next } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update Local Office access'));
    } finally {
      setOfficeBusy(false);
    }
  };

  const toggleBrowser = async (next: boolean) => {
    if (!agent) return;
    setBrowserBusy(true);
    try {
      await api.updateAgent(agent.id, {
        browser: {
          enabled: next,
          allowedHosts: agent.browser?.allowedHosts ?? [],
          credentialIds: agent.browser?.credentialIds ?? [],
          confirmSensitive: agent.browser?.confirmSensitive ?? true,
          defaultProfileId: agent.browser?.defaultProfileId ?? null,
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update browser access'));
    } finally {
      setBrowserBusy(false);
    }
  };

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return settings.mcpServers
      .filter((s) => !needle || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(needsAttention(b, oauth.status)) - Number(needsAttention(a, oauth.status)),
      );
  }, [settings.mcpServers, query, oauth.status]);

  const toggle = async (server: McpServerConfig, next: boolean) => {
    if (!agent) return;
    setBusyId(server.id);
    try {
      await setPluginAttached(agent, server, next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update plugin'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="popover-shadow"
      style={{
        width: 300,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          color: 'var(--text-tertiary)',
        }}
      >
        <Search size={14} strokeWidth={1.5} />
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search plugins')}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12.5,
            color: 'var(--text-primary)',
          }}
        />
      </label>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '0 4px 4px' }} />

      <div style={{ maxHeight: 250, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {showBuiltInBrowser && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: 'rgba(56, 189, 248, 0.14)',
                color: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Globe size={13} strokeWidth={1.75} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{t('Browser')}</div>
              {onOpenBrowserSettings && (
                <button
                  type="button"
                  onClick={onOpenBrowserSettings}
                  style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textDecoration: 'underline' }}
                >
                  {t('Manage logins…')}
                </button>
              )}
            </div>
            <Switch
              checked={browserEnabled}
              disabled={!agent || browserBusy}
              label={t('Toggle Browser')}
              onChange={(next) => void toggleBrowser(next)}
            />
          </div>
        )}
        {showBuiltInOffice && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: 'rgba(56, 201, 118, 0.14)',
                color: 'var(--agent-green)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <FileSpreadsheet size={13} strokeWidth={1.75} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{t('Local Office')}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                {t('Word, Excel, PowerPoint, PDF')}
              </div>
            </div>
            <Switch
              checked={officeEnabled}
              disabled={!agent || officeBusy}
              label={t('Toggle Local Office')}
              onChange={(next) => void toggleOffice(next)}
            />
          </div>
        )}
        {showQuickCloud && composioPreset && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: 'rgba(251, 113, 133, 0.14)',
                color: '#fb7185',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Blocks size={13} strokeWidth={1.75} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{t('Cloud Apps')}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                {t('M365, Google, Slack')}
              </div>
            </div>
            <button
              type="button"
              disabled={oauth.connectingId === composioPreset.id}
              onClick={() =>
                void oauth.addAndConnect(composioPreset, async (server) => {
                  if (agent) await setPluginAttached(agent, server, true);
                })
              }
              style={{
                height: 22,
                padding: '0 9px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--surface-3)',
                fontSize: 11,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
              }}
            >
              {oauth.connectingId === composioPreset.id ? t('Waiting…') : t('Connect')}
            </button>
          </div>
        )}
        {list.length === 0 && !showBuiltInBrowser && !showBuiltInOffice && !showQuickCloud ? (
          <div style={{ padding: '14px 10px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {settings.mcpServers.length === 0 ? t('No plugins yet.') : t('No matching plugin.')}
          </div>
        ) : (
          list.map((s) => {
            const attention = needsAttention(s, oauth.status);
            const attached = Boolean(agent?.mcpServerIds?.includes(s.id)) && s.enabled;
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <McpIcon presetId={s.presetId} name={s.name} size={22} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.name}
                </span>
                {attention ? (
                  <button
                    type="button"
                    disabled={oauth.connectingId === s.id}
                    onClick={() => void oauth.connect(s.id)}
                    style={{
                      height: 22,
                      padding: '0 9px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--surface-3)',
                      fontSize: 11,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {oauth.connectingId === s.id ? t('Waiting…') : t('Reconnect')}
                  </button>
                ) : (
                  <Switch
                    checked={attached}
                    disabled={!agent || busyId === s.id}
                    label={`${attached ? 'Detach' : 'Attach'} ${s.name}`}
                    onChange={(next) => void toggle(s, next)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 4px' }} />
      <button
        type="button"
        onClick={onManage}
        className="transition-atelier"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12.5,
          color: 'var(--text-primary)',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <Plug size={15} strokeWidth={1.5} style={{ color: 'var(--text-secondary)' }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{t('Manage plugins')}</span>
        <ArrowUpRight size={14} strokeWidth={1.5} style={{ color: 'var(--text-tertiary)' }} />
      </button>
    </div>
  );
}
