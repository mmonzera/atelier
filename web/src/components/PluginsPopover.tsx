import type { Agent, McpServerConfig, Settings } from '@atelier/contracts';
import { ArrowUpRight, Plug, Search } from 'lucide-react';
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
}: {
  agent: Agent | null;
  settings: Settings;
  oauth: OAuth;
  onManage: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

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
        {list.length === 0 ? (
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
