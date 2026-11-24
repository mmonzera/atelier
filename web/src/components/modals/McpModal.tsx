import {
  MCP_PRESETS,
  type McpPreset,
  type McpOAuthStatus,
  type McpProbeResult,
  type McpServerConfig,
  type McpTransport,
  type Settings,
} from '@atelier/contracts';
import { Check, FlaskConical, LogIn, LogOut, Plug, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { Select } from '../Select';
import { toast } from '../Toast';
import { McpIcon } from './McpIcon';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';

type AddMode = 'preset' | 'custom' | 'json';

function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    const colonIdx = line.indexOf(':');
    const sepIdx =
      eqIdx >= 0 && (colonIdx < 0 || eqIdx < colonIdx) ? eqIdx : colonIdx;
    if (sepIdx <= 0) continue;
    const key = line.slice(0, sepIdx).trim();
    const val = line.slice(sepIdx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function parseArgsInput(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    return lines[0].split(/\s+/).filter(Boolean);
  }
  return lines;
}

export function McpModal({
  settings,
  onClose,
  addOnly = false,
  inline = false,
  initialMode = 'preset',
  initialPresetId,
}: {
  settings: Settings;
  onClose: () => void;
  /** Render the add form in the page itself (no dialog); the page already chose preset/custom/json. */
  inline?: boolean;
  /** Hide the configured-servers list (the Plugins page shows it already). */
  addOnly?: boolean;
  initialMode?: AddMode;
  initialPresetId?: string;
}) {
  const initialPreset = initialPresetId
    ? (MCP_PRESETS.find((p) => p.id === initialPresetId) ?? null)
    : null;
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [selectedPreset, setSelectedPreset] = useState<McpPreset | null>(initialPreset);
  const [presetName, setPresetName] = useState(initialPreset?.name ?? '');
  const [presetExtraArg, setPresetExtraArg] = useState('');
  const [presetSecrets, setPresetSecrets] = useState<Record<string, string>>({});

  const [customName, setCustomName] = useState('');
  const [customTransport, setCustomTransport] = useState<McpTransport>('stdio');
  const [customCommand, setCustomCommand] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [customEnvText, setCustomEnvText] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customHeadersText, setCustomHeadersText] = useState('');

  const [jsonText, setJsonText] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpProbeResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── login (OAuth) connections ──
  const [oauthStatus, setOauthStatus] = useState<Record<string, McpOAuthStatus>>({});
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const popupRef = useRef<Window | null>(null);

  const refreshOauth = useCallback(async () => {
    try {
      const res = await api.getMcpOAuthStatus();
      setOauthStatus(res.status);
      setRedirectUri(res.redirectUri);
    } catch {
      // status is best-effort
    }
  }, []);

  useEffect(() => {
    void refreshOauth();
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; ok?: boolean; message?: string } | null;
      if (d?.type !== 'atelier-mcp-oauth' || e.source !== popupRef.current) return;
      setConnectingId(null);
      setError(d.ok ? null : (d.message ?? 'Login failed'));
      if (d.ok) {
        toast.success('Logged in. Connection is ready.');
        if (addOnly) onClose();
      }
      void refreshOauth();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshOauth]);

  // while a login window is open: watch for completion or the window being closed
  useEffect(() => {
    if (!connectingId) return;
    const timer = window.setInterval(() => {
      void refreshOauth();
      if (popupRef.current?.closed) setConnectingId(null);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [connectingId, refreshOauth]);

  const connect = async (id: string, creds?: { clientId: string; clientSecret?: string }) => {
    setError(null);
    setConnectingId(id);
    // open synchronously (inside the click) so popup blockers allow it, then point it at the login page
    const w = window.open('', 'atelier-mcp-oauth', 'width=520,height=720');
    popupRef.current = w;
    try {
      const { authUrl } = await api.startMcpOAuth(id, creds);
      if (!w) throw new Error('The login window was blocked. Allow popups for this page and try again.');
      w.location.href = authUrl;
    } catch (err) {
      w?.close();
      setConnectingId(null);
      setError(err instanceof Error ? err.message : 'Could not start login');
    }
  };

  const disconnect = async (id: string) => {
    try {
      await api.disconnectMcpOAuth(id);
      await refreshOauth();
      toast.info('Logged out');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    }
  };

  const selectPreset = (preset: McpPreset) => {
    setSelectedPreset(preset);
    setPresetName(preset.name);
    setPresetExtraArg('');
    setPresetSecrets({});
    setOauthClientId('');
    setOauthClientSecret('');
    setError(null);
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await api.testMcpServer({ id });
      setTestResults((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          tools: [],
          error: err instanceof Error ? err.message : 'Test failed',
          durationMs: 0,
        },
      }));
    } finally {
      setTestingId((cur) => (cur === id ? null : cur));
    }
  };

  const handleToggle = async (s: McpServerConfig) => {
    try {
      await api.updateMcpServer(s.id, { enabled: !s.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle MCP server');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const removed = settings.mcpServers.find((m) => m.id === id);
      await api.deleteMcpServer(id);
      toast.deleted(`MCP server “${removed?.name ?? 'server'}” removed`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove MCP server');
    }
  };

  const handleAddPreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPreset) return;
    setBusy(true);
    setError(null);
    try {
      const name = presetName.trim() || selectedPreset.name;
      if (selectedPreset.auth === 'oauth') {
        const needsClient = selectedPreset.oauthClient === 'manual';
        if (needsClient && !oauthClientId.trim()) {
          setError('Enter the Client ID of your OAuth app.');
          return;
        }
        const { server } = await api.createMcpServer({
          name,
          transport: selectedPreset.transport,
          url: selectedPreset.url ?? '',
          enabled: true,
          presetId: selectedPreset.id,
          description: selectedPreset.description,
          auth: 'oauth',
          ...(selectedPreset.oauthScope ? { oauthScope: selectedPreset.oauthScope } : {}),
        });
        setSelectedPreset(null);
        void connect(
          server.id,
          needsClient
            ? { clientId: oauthClientId.trim(), clientSecret: oauthClientSecret.trim() || undefined }
            : undefined,
        );
        return;
      }
      if (selectedPreset.transport === 'stdio') {
        const baseArgs = [...(selectedPreset.args ?? [])];
        if (presetExtraArg.trim()) baseArgs.push(presetExtraArg.trim());
        const env: Record<string, string> = {};
        for (const k of selectedPreset.envKeys ?? []) {
          const val = presetSecrets[k]?.trim();
          if (val) env[k] = val;
        }
        await api.createMcpServer({
          name,
          transport: 'stdio',
          command: selectedPreset.command ?? '',
          args: baseArgs,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          enabled: true,
          presetId: selectedPreset.id,
          description: selectedPreset.description,
        });
      } else {
        const headers: Record<string, string> = {};
        for (const k of selectedPreset.headerKeys ?? []) {
          const val = presetSecrets[k]?.trim();
          if (val) headers[k] = val;
        }
        await api.createMcpServer({
          name,
          transport: selectedPreset.transport,
          url: presetExtraArg.trim() || selectedPreset.url || '',
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          enabled: true,
          presetId: selectedPreset.id,
          description: selectedPreset.description,
        });
      }
      setSelectedPreset(null);
      toast.success(`MCP server “${name}” added`);
      if (addOnly) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add preset MCP server');
    } finally {
      setBusy(false);
    }
  };

  const handleAddCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (customTransport === 'stdio') {
        const env = parseKvLines(customEnvText);
        await api.createMcpServer({
          name: customName.trim(),
          transport: 'stdio',
          command: customCommand.trim(),
          args: parseArgsInput(customArgs),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          enabled: true,
        });
      } else {
        const headers = parseKvLines(customHeadersText);
        await api.createMcpServer({
          name: customName.trim(),
          transport: customTransport,
          url: customUrl.trim(),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          enabled: true,
        });
      }
      setCustomName('');
      setCustomCommand('');
      setCustomArgs('');
      setCustomEnvText('');
      setCustomUrl('');
      setCustomHeadersText('');
      toast.success('Custom MCP server added');
      if (addOnly) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add custom MCP server');
    } finally {
      setBusy(false);
    }
  };

  const handleImportJson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jsonText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.importMcpJson(jsonText.trim());
      setJsonText('');
      toast.success('MCP servers imported');
      if (addOnly) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid MCP JSON');
    } finally {
      setBusy(false);
    }
  };

  const presetCatalog = MCP_PRESETS.filter(
    (p) => p.id !== 'custom-stdio' && p.id !== 'custom-http',
  );

  const body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Configured MCP servers */}
        <div style={{ display: addOnly ? 'none' : 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={labelStyle}>
              Configured servers ({settings.mcpServers.length})
            </span>
          </div>

          {settings.mcpServers.length === 0 ? (
            <div
              style={{
                padding: '18px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px dashed var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: 12.5,
                lineHeight: '18px',
                color: 'var(--text-tertiary)',
              }}
            >
              <Plug size={18} strokeWidth={1.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
              <span>
                No MCP connections yet. Pick a preset below, or add a custom command/URL or pasted JSON.
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {settings.mcpServers.map((s) => {
                const probe = testResults[s.id];
                const isOauth = s.auth === 'oauth';
                const oauthConnected = Boolean(oauthStatus[s.id]?.connected);
                const dotColor = probe
                  ? probe.ok
                    ? 'var(--agent-green)'
                    : 'var(--agent-red)'
                  : isOauth
                    ? oauthConnected
                      ? 'var(--agent-green)'
                      : 'var(--agent-amber)'
                    : 'var(--text-muted)';
                const endpoint =
                  s.transport === 'stdio'
                    ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
                    : s.url ?? '';

                return (
                  <div
                    key={s.id}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                        <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                          <McpIcon presetId={s.presetId} name={s.name} size={30} />
                          <span
                            title={probe ? (probe.ok ? 'Connected' : 'Failed') : 'Not tested'}
                            style={{
                              position: 'absolute',
                              right: -2,
                              bottom: -2,
                              width: 9,
                              height: 9,
                              borderRadius: '9999px',
                              background: dotColor,
                              border: '2px solid var(--surface-2)',
                            }}
                          />
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                          {s.name}
                        </span>
                        <span
                          className="mono-num"
                          style={{
                            fontSize: 10.5,
                            padding: '1px 6px',
                            borderRadius: 'var(--radius-full)',
                            background: 'var(--surface-3)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {s.transport}
                        </span>
                        {isOauth && (
                          <span
                            style={{
                              fontSize: 10.5,
                              padding: '1px 7px',
                              borderRadius: 'var(--radius-full)',
                              background: oauthConnected
                                ? 'rgba(52, 211, 153, 0.12)'
                                : 'rgba(251, 191, 36, 0.12)',
                              color: oauthConnected ? 'var(--agent-green)' : 'var(--agent-amber)',
                            }}
                          >
                            {connectingId === s.id
                              ? 'Waiting for login…'
                              : oauthConnected
                                ? 'Logged in'
                                : 'Login needed'}
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {isOauth && (
                          <button
                            type="button"
                            disabled={connectingId === s.id}
                            onClick={() => void (oauthConnected ? disconnect(s.id) : connect(s.id))}
                            style={{
                              ...secondaryBtnStyle,
                              height: 26,
                              padding: '0 9px',
                              fontSize: 11.5,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                            }}
                          >
                            {oauthConnected ? (
                              <LogOut size={12} strokeWidth={1.5} />
                            ) : (
                              <LogIn size={12} strokeWidth={1.5} />
                            )}
                            {oauthConnected ? 'Log out' : 'Log in'}
                          </button>
                        )}
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            fontSize: 11.5,
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={() => void handleToggle(s)}
                          />
                          Enabled
                        </label>
                        <button
                          type="button"
                          disabled={testingId === s.id}
                          onClick={() => void handleTest(s.id)}
                          style={{
                            ...secondaryBtnStyle,
                            height: 26,
                            padding: '0 9px',
                            fontSize: 11.5,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                          }}
                        >
                          <FlaskConical size={12} strokeWidth={1.5} />
                          {testingId === s.id ? 'Testing…' : 'Test'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(s.id)}
                          title="Delete MCP server"
                          style={{ color: 'var(--text-muted)', padding: 4 }}
                        >
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      </div>
                    </div>

                    <div
                      className="mono-num"
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {endpoint}
                    </div>

                    {probe && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: probe.ok ? 'var(--agent-green)' : 'var(--agent-red)',
                        }}
                      >
                        {probe.ok
                          ? `Connected (${probe.durationMs}ms) · ${probe.tools.length} tool${
                              probe.tools.length === 1 ? '' : 's'
                            }${probe.tools.length > 0 ? `: ${probe.tools.slice(0, 6).join(', ')}${probe.tools.length > 6 ? '…' : ''}` : ''}`
                          : probe.error || 'Connection test failed'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add Mode Tabs */}
        <div
          style={{
            paddingTop: inline ? 0 : 12,
            borderTop: inline ? 'none' : '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: inline ? 'none' : 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 2,
              padding: 3,
              borderRadius: 'var(--radius-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {(
              [
                { id: 'preset', label: 'Preset' },
                { id: 'custom', label: 'Custom' },
                { id: 'json', label: 'Paste JSON' },
              ] as const
            ).map((tab) => {
              const active = mode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setMode(tab.id);
                    setError(null);
                  }}
                  className="transition-atelier"
                  style={{
                    height: 28,
                    borderRadius: 'var(--radius-full)',
                    background: active ? 'var(--surface-3)' : 'transparent',
                    boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
                    fontSize: 12,
                    fontWeight: active ? 500 : 400,
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {mode === 'preset' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div
                style={{
                  display: inline ? 'none' : 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 8,
                }}
              >
                {presetCatalog.map((preset) => {
                  const selected = selectedPreset?.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => selectPreset(preset)}
                      className="transition-atelier"
                      style={{
                        textAlign: 'left',
                        padding: 11,
                        borderRadius: 'var(--radius-md)',
                        background: selected ? 'var(--surface-3)' : 'var(--surface-2)',
                        border: `1px solid ${selected ? 'rgba(255,255,255,0.22)' : 'var(--border-subtle)'}`,
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 11,
                        minHeight: 72,
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) e.currentTarget.style.borderColor = 'var(--border-default)';
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) e.currentTarget.style.borderColor = 'var(--border-subtle)';
                      }}
                    >
                      <McpIcon presetId={preset.id} name={preset.name} size={36} />
                      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {preset.name}
                          </span>
                          <span
                            className="mono-num"
                            style={{
                              fontSize: 9.5,
                              padding: '1px 6px',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--surface-3)',
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              flexShrink: 0,
                            }}
                          >
                            {preset.auth === 'oauth' ? 'login' : preset.transport}
                          </span>
                          {selected && (
                            <Check
                              size={13}
                              strokeWidth={2}
                              style={{ marginLeft: 'auto', color: 'var(--agent-green)', flexShrink: 0 }}
                            />
                          )}
                        </div>
                        <span
                          style={{
                            fontSize: 11.5,
                            lineHeight: '16px',
                            color: 'var(--text-tertiary)',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {preset.description}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {selectedPreset && (
                <form
                  onSubmit={handleAddPreset}
                  style={{
                    padding: 12,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-default)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500 }}>
                    <McpIcon presetId={selectedPreset.id} name={selectedPreset.name} size={24} />
                    <span>Configure {selectedPreset.name}</span>
                  </div>

                  <div>
                    <label style={labelStyle}>Server name</label>
                    <input
                      type="text"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      style={inputStyle}
                    />
                  </div>

                  {selectedPreset.auth === 'oauth' && (
                    <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-tertiary)' }}>
                      You’ll log in to {selectedPreset.name} in a small window. No token to copy, and
                      you can log out any time.
                    </div>
                  )}

                  {selectedPreset.oauthClient === 'manual' && (
                    <>
                      <div
                        style={{
                          fontSize: 12,
                          lineHeight: '18px',
                          color: 'var(--text-tertiary)',
                          padding: '9px 11px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--surface-1)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {selectedPreset.name} can’t register apps automatically. Create an OAuth app
                        {selectedPreset.docsUrl && (
                          <>
                            {' '}
                            at{' '}
                            <a
                              href={selectedPreset.docsUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}
                            >
                              {selectedPreset.docsUrl.replace('https://', '')}
                            </a>
                          </>
                        )}
                        , set its callback URL to{' '}
                        <code className="mono-num" style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                          {redirectUri || 'http://127.0.0.1:8787/api/mcp/oauth/callback'}
                        </code>
                        , then paste its credentials. They stay on this machine.
                      </div>
                      <div>
                        <label style={labelStyle}>Client ID</label>
                        <input
                          type="text"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          className="mono-num"
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Client secret</label>
                        <input
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          className="mono-num"
                          style={inputStyle}
                        />
                      </div>
                    </>
                  )}

                  {selectedPreset.argHint && (
                    <div>
                      <label style={labelStyle}>Target argument ({selectedPreset.argHint})</label>
                      <input
                        type="text"
                        value={presetExtraArg}
                        onChange={(e) => setPresetExtraArg(e.target.value)}
                        placeholder={selectedPreset.argHint}
                        className="mono-num"
                        style={inputStyle}
                      />
                    </div>
                  )}

                  {(selectedPreset.envKeys ?? []).map((k) => (
                    <div key={k}>
                      <label style={labelStyle}>{k}</label>
                      <input
                        type="password"
                        value={presetSecrets[k] ?? ''}
                        onChange={(e) =>
                          setPresetSecrets((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        placeholder={`Paste ${k}`}
                        className="mono-num"
                        style={inputStyle}
                      />
                    </div>
                  ))}

                  {(selectedPreset.headerKeys ?? []).map((k) => (
                    <div key={k}>
                      <label style={labelStyle}>Header: {k}</label>
                      <input
                        type="password"
                        value={presetSecrets[k] ?? ''}
                        onChange={(e) =>
                          setPresetSecrets((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        placeholder="Bearer ..."
                        className="mono-num"
                        style={inputStyle}
                      />
                    </div>
                  ))}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => (inline ? onClose() : setSelectedPreset(null))}
                      style={secondaryBtnStyle}
                    >
                      Cancel
                    </button>
                    <button type="submit" disabled={busy} style={primaryBtnStyle}>
                      {busy
                        ? 'Adding…'
                        : selectedPreset.auth === 'oauth'
                          ? 'Log in & connect'
                          : 'Add MCP server'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {mode === 'custom' && (
            <form onSubmit={handleAddCustom} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Server name</label>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="e.g. my-internal-api"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Transport</label>
                  <Select
                    ariaLabel="Transport"
                    value={customTransport}
                    onChange={(v) => setCustomTransport(v as McpTransport)}
                    options={[
                      { value: 'stdio', label: 'stdio (local command)' },
                      { value: 'http', label: 'http (Streamable HTTP)' },
                      { value: 'sse', label: 'sse (legacy SSE URL)' },
                    ]}
                  />
                </div>
              </div>

              {customTransport === 'stdio' ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 10 }}>
                    <div>
                      <label style={labelStyle}>Command</label>
                      <input
                        type="text"
                        value={customCommand}
                        onChange={(e) => setCustomCommand(e.target.value)}
                        placeholder="npx, uvx, node, python..."
                        className="mono-num"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Args (space-separated or 1 per line)</label>
                      <textarea
                        rows={2}
                        value={customArgs}
                        onChange={(e) => setCustomArgs(e.target.value)}
                        placeholder="-y @my-org/mcp-server"
                        className="mono-num"
                        style={{ ...inputStyle, resize: 'vertical' }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>Environment variables (optional, KEY=VALUE per line)</label>
                    <textarea
                      rows={2}
                      value={customEnvText}
                      onChange={(e) => setCustomEnvText(e.target.value)}
                      placeholder="API_TOKEN=..."
                      className="mono-num"
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label style={labelStyle}>Endpoint URL</label>
                    <input
                      type="url"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      className="mono-num"
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Headers (optional, Key=Value or Key: Value per line)</label>
                    <textarea
                      rows={2}
                      value={customHeadersText}
                      onChange={(e) => setCustomHeadersText(e.target.value)}
                      placeholder="Authorization: Bearer ..."
                      className="mono-num"
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                  </div>
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !customName.trim() ||
                    (customTransport === 'stdio' ? !customCommand.trim() : !customUrl.trim())
                  }
                  style={primaryBtnStyle}
                >
                  {busy ? 'Adding…' : 'Add custom MCP'}
                </button>
              </div>
            </form>
          )}

          {mode === 'json' && (
            <form onSubmit={handleImportJson} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={labelStyle}>Paste Claude Desktop / MCP JSON</label>
                <textarea
                  rows={6}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={`{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}`}
                  className="mono-num"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="submit"
                  disabled={busy || !jsonText.trim()}
                  style={primaryBtnStyle}
                >
                  {busy ? 'Importing…' : 'Import MCP JSON'}
                </button>
              </div>
            </form>
          )}

          {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}
        </div>
      </div>
  );

  if (inline) return body;
  return (
    <ModalShell
      title={addOnly ? 'Add plugin' : 'MCP connections'}
      subtitle={
        addOnly
          ? 'Pick a connector, add a custom command or URL, or paste MCP JSON.'
          : 'Connect external MCP tools via presets, custom stdio/HTTP, or JSON import, then attach them per agent.'
      }
      width={620}
      onClose={onClose}
    >
      {body}
    </ModalShell>
  );
}
