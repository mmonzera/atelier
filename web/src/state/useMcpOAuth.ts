import type { McpOAuthStatus, McpPreset, McpServerConfig } from '@atelier/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../components/Toast';
import { t } from '../i18n';

const EXTERNAL_LOGIN_TIMEOUT_MS = 3 * 60_000;

/** Login (OAuth) state for MCP servers + the popup / external-browser login flow, shared by the Plugins page and chat menu. */
export function useMcpOAuth() {
  const [status, setStatus] = useState<Record<string, McpOAuthStatus>>({});
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const connectStartedAtRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getMcpOAuthStatus();
      setStatus(res.status);
      return res.status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; ok?: boolean; message?: string } | null;
      if (d?.type !== 'atelier-mcp-oauth' || e.source !== popupRef.current) return;
      setConnectingId(null);
      setError(d.ok ? null : (d.message ?? t('Login failed')));
      if (d.ok) toast.success(t('Logged in. Connection is ready.'));
      void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  // While a login window (or system browser tab) is open: watch for completion, close, or timeout
  useEffect(() => {
    if (!connectingId) return;
    const activeId = connectingId;
    const timer = window.setInterval(() => {
      void refresh().then((nextStatus) => {
        if (nextStatus?.[activeId]?.connected) {
          popupRef.current = null;
          setConnectingId(null);
          setError(null);
          toast.success(t('Logged in. Connection is ready.'));
        }
      });
      if (popupRef.current?.closed) {
        popupRef.current = null;
        setConnectingId(null);
      } else if (
        !popupRef.current &&
        connectStartedAtRef.current > 0 &&
        Date.now() - connectStartedAtRef.current > EXTERNAL_LOGIN_TIMEOUT_MS
      ) {
        setConnectingId(null);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [connectingId, refresh]);

  const connect = useCallback(async (id: string) => {
    setError(null);
    setConnectingId(id);
    connectStartedAtRef.current = Date.now();
    // open synchronously (inside the click) so browser popup blockers allow it; in desktop webviews w is null so fall back to system browser
    const w = window.open('', 'atelier-mcp-oauth', 'width=520,height=720');
    popupRef.current = w;
    try {
      const { authUrl, openedExternally } = await api.startMcpOAuth(id, {
        openInBrowser: !w,
      });
      if (openedExternally) {
        w?.close();
        popupRef.current = null;
        toast.info(t('Login opened in your browser. Complete sign-in there and return to Atelier.'));
        return;
      }
      if (!w) {
        throw new Error(t('The login window was blocked. Allow popups for this page and try again.'));
      }
      w.location.href = authUrl;
    } catch (err) {
      w?.close();
      popupRef.current = null;
      setConnectingId(null);
      const message = err instanceof Error ? err.message : t('Could not start login');
      setError(message);
      toast.error(message);
    }
  }, []);

  const addAndConnect = useCallback(
    async (
      preset: McpPreset,
      onCreated?: (server: McpServerConfig) => Promise<void> | void,
    ): Promise<McpServerConfig | null> => {
      setError(null);
      setConnectingId(preset.id);
      connectStartedAtRef.current = Date.now();
      // Open popup synchronously on click before creating the server + starting OAuth
      const w = window.open('', 'atelier-mcp-oauth', 'width=520,height=720');
      popupRef.current = w;
      try {
        const { server } = await api.createMcpServer({
          name: preset.name,
          transport: preset.transport,
          url: preset.url,
          enabled: true,
          presetId: preset.id,
          description: preset.description,
          auth: preset.auth,
          oauthScope: preset.oauthScope,
        });
        setConnectingId(server.id);
        await onCreated?.(server);
        const { authUrl, openedExternally } = await api.startMcpOAuth(server.id, {
          openInBrowser: !w,
        });
        if (openedExternally) {
          w?.close();
          popupRef.current = null;
          toast.info(t('Login opened in your browser. Complete sign-in there and return to Atelier.'));
          return server;
        }
        if (!w) {
          throw new Error(t('The login window was blocked. Allow popups for this page and try again.'));
        }
        w.location.href = authUrl;
        return server;
      } catch (err) {
        w?.close();
        popupRef.current = null;
        setConnectingId(null);
        const message = err instanceof Error ? err.message : t('Could not start login');
        setError(message);
        toast.error(message);
        return null;
      }
    },
    [],
  );

  const disconnect = useCallback(
    async (id: string) => {
      try {
        await api.disconnectMcpOAuth(id);
        await refresh();
        toast.info(t('Logged out'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('Failed to disconnect'));
      }
    },
    [refresh],
  );

  return { status, connectingId, error, connect, addAndConnect, disconnect, refresh };
}
