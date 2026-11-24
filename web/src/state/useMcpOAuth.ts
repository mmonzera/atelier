import type { McpOAuthStatus } from '@atelier/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../components/Toast';
import { t } from '../i18n';

/** Login (OAuth) state for MCP servers + the popup login flow, shared by the Plugins page and chat menu. */
export function useMcpOAuth() {
  const [status, setStatus] = useState<Record<string, McpOAuthStatus>>({});
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getMcpOAuthStatus();
      setStatus(res.status);
    } catch {
      // best-effort
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

  // while a login window is open: watch for completion or the window being closed
  useEffect(() => {
    if (!connectingId) return;
    const timer = window.setInterval(() => {
      void refresh();
      if (popupRef.current?.closed) setConnectingId(null);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [connectingId, refresh]);

  const connect = useCallback(async (id: string) => {
    setError(null);
    setConnectingId(id);
    // open synchronously (inside the click) so popup blockers allow it
    const w = window.open('', 'atelier-mcp-oauth', 'width=520,height=720');
    popupRef.current = w;
    try {
      const { authUrl } = await api.startMcpOAuth(id);
      if (!w) throw new Error(t('The login window was blocked. Allow popups for this page and try again.'));
      w.location.href = authUrl;
    } catch (err) {
      w?.close();
      setConnectingId(null);
      const message = err instanceof Error ? err.message : t('Could not start login');
      setError(message);
      toast.error(message);
    }
  }, []);

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

  return { status, connectingId, error, connect, disconnect, refresh };
}
