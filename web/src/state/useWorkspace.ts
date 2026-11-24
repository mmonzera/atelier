import type { ServerEvent } from '@atelier/contracts';
import { useEffect, useReducer, useState } from 'react';
import { LOCKED_EVENT, api, authApi } from '../api';
import { INITIAL_WORKSPACE_STATE, workspaceReducer } from './reducer';

export function useWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let hasConnectedOnce = false;
    let hiddenAtMs: number | null = null;

    const syncSnapshot = () => {
      api
        .getState()
        .then((snapshot) => {
          if (!active) return;
          dispatch({ type: 'snapshot', payload: snapshot });
          setLoading(false);
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    };

    syncSnapshot();

    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!active) return;
        setConnected(true);
        if (hasConnectedOnce) {
          syncSnapshot();
        }
        hasConnectedOnce = true;
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as ServerEvent;
          dispatch(parsed);
          if (parsed.type === 'snapshot') {
            setLoading(false);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (!active) return;
        setConnected(false);
        if (event.code === 4401) {
          // Session revoked (idle timeout / "Lock now" / lock just enabled elsewhere).
          window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
        } else if (event.code === 1006) {
          // Upgrade refused (e.g. 401 while locked) looks like an abnormal close; ask the server.
          authApi
            .status()
            .then((s) => {
              if (s.enabled && !s.authenticated) window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
            })
            .catch(() => undefined);
        }
        reconnectTimer = window.setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const onOnline = () => {
      if (active) syncSnapshot();
    };

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAtMs = Date.now();
      } else if (hiddenAtMs !== null && Date.now() - hiddenAtMs > 15_000) {
        hiddenAtMs = null;
        syncSnapshot();
      } else {
        hiddenAtMs = null;
      }
    };

    connect();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      ws?.close();
    };
  }, []);

  return { state, connected, loading };
}
