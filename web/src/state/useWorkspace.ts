import type {
  BrowserApprovalRequest,
  BrowserFrameEvent,
  BrowserSessionInfo,
  BrowserTakeoverEvent,
  MeetingStatusEvent,
  ServerEvent,
  SttDownloadProgressEvent,
} from '@atelier/contracts';
import { useEffect, useReducer, useState } from 'react';
import { LOCKED_EVENT, api, authApi } from '../api';
import { INITIAL_WORKSPACE_STATE, workspaceReducer } from './reducer';

export function useWorkspace() {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [browserSessions, setBrowserSessions] = useState<BrowserSessionInfo[]>([]);
  const [browserApprovals, setBrowserApprovals] = useState<BrowserApprovalRequest[]>([]);
  const [browserFrames, setBrowserFrames] = useState<Record<string, BrowserFrameEvent>>({});
  const [browserTakeovers, setBrowserTakeovers] = useState<Record<string, BrowserTakeoverEvent>>({});
  const [sttDownload, setSttDownload] = useState<SttDownloadProgressEvent | null>(null);
  const [activeMeeting, setActiveMeeting] = useState<MeetingStatusEvent | null>(null);

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let hasConnectedOnce = false;
    let hiddenAtMs: number | null = null;

    const applySnapshotExtras = (snapshot: {
      browserSessions?: BrowserSessionInfo[];
      browserApprovals?: BrowserApprovalRequest[];
      activeMeeting?: MeetingStatusEvent | null;
    }) => {
      if (Array.isArray(snapshot.browserSessions)) {
        setBrowserSessions(snapshot.browserSessions.filter((s) => s.status !== 'closed'));
      }
      if (Array.isArray(snapshot.browserApprovals)) {
        setBrowserApprovals(snapshot.browserApprovals);
      }
      setActiveMeeting(snapshot.activeMeeting ?? null);
    };

    const syncSnapshot = () => {
      api
        .getState()
        .then((snapshot) => {
          if (!active) return;
          dispatch({ type: 'snapshot', payload: snapshot });
          applySnapshotExtras(snapshot);
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
          if (parsed.type === 'browser-frame') {
            setBrowserFrames((prev) => ({
              ...prev,
              [parsed.payload.sessionId]: parsed.payload,
            }));
            return;
          }
          if (parsed.type === 'browser-session') {
            const next = parsed.payload;
            setBrowserSessions((prev) => {
              if (next.status === 'closed') {
                return prev.filter((s) => s.id !== next.id);
              }
              const idx = prev.findIndex((s) => s.id === next.id);
              if (idx === -1) return [...prev, next];
              const copy = prev.slice();
              copy[idx] = next;
              return copy;
            });
            if (next.status !== 'takeover') {
              setBrowserTakeovers((prev) => {
                if (!(next.id in prev)) return prev;
                const copy = { ...prev };
                delete copy[next.id];
                return copy;
              });
            }
            if (next.status === 'closed') {
              setBrowserFrames((prev) => {
                if (!(next.id in prev)) return prev;
                const copy = { ...prev };
                delete copy[next.id];
                return copy;
              });
            }
            return;
          }
          if (parsed.type === 'browser-approval') {
            setBrowserApprovals((prev) => {
              const idx = prev.findIndex((a) => a.id === parsed.payload.id);
              if (idx === -1) return [...prev, parsed.payload];
              const copy = prev.slice();
              copy[idx] = parsed.payload;
              return copy;
            });
            return;
          }
          if (parsed.type === 'browser-approval-resolved') {
            setBrowserApprovals((prev) => prev.filter((a) => a.id !== parsed.payload.id));
            return;
          }
          if (parsed.type === 'browser-takeover') {
            setBrowserTakeovers((prev) => ({
              ...prev,
              [parsed.payload.sessionId]: parsed.payload,
            }));
            return;
          }
          if (parsed.type === 'stt-download-progress') {
            setSttDownload(
              parsed.payload.status === 'done' || parsed.payload.status === 'cancelled'
                ? null
                : parsed.payload,
            );
            window.dispatchEvent(new CustomEvent('atelier:stt-progress', { detail: parsed.payload }));
            return;
          }
          if (parsed.type === 'meeting-status') {
            const st = parsed.payload.meeting.status;
            setActiveMeeting(st === 'completed' || st === 'error' ? null : parsed.payload);
            return;
          }

          dispatch(parsed);
          if (parsed.type === 'snapshot') {
            applySnapshotExtras(parsed.payload);
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

  return {
    state,
    connected,
    loading,
    browserSessions,
    browserApprovals,
    browserFrames,
    browserTakeovers,
    sttDownload,
    activeMeeting,
  };
}
