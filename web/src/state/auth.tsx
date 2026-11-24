import type { AuthStatus } from '@atelier/contracts';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { LOCKED_EVENT, authApi } from '../api';
import { LockScreen } from '../components/LockScreen';

interface AuthContextValue {
  status: AuthStatus;
  refresh: () => Promise<AuthStatus | null>;
  lockNow: () => Promise<void>;
}

const DEFAULT_STATUS: AuthStatus = { enabled: false, authenticated: true, idleMinutes: 15, retryAfterSeconds: 0 };

const AuthContext = createContext<AuthContextValue>({
  status: DEFAULT_STATUS,
  refresh: async () => null,
  lockNow: async () => undefined,
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

const HEARTBEAT_EVERY_MS = 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Wraps the app: shows the lock screen while the optional app lock is on and this browser has no
 * session. While unlocked it reports real user activity (throttled heartbeat) so the server's idle
 * timer reflects the person, not background polling, and locks itself after the idle timeout.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  const lastActivity = useRef(Date.now());
  const lastBeat = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await authApi.status();
      setStatus(next);
      return next;
    } catch {
      // Server unreachable: keep current view; the workspace hook shows the reconnect banner.
      setStatus((prev) => prev ?? DEFAULT_STATUS);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onLocked = () => void refresh();
    window.addEventListener(LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(LOCKED_EVENT, onLocked);
  }, [refresh]);

  const locked = Boolean(status?.enabled && !status.authenticated);
  const guarding = Boolean(status?.enabled && status.authenticated);

  const lockNow = useCallback(async () => {
    await authApi.lockNow().catch(() => undefined);
    await refresh();
  }, [refresh]);

  // Activity tracking + client-side idle lock (server enforces the same timeout independently).
  useEffect(() => {
    if (!guarding || !status) return;
    lastActivity.current = Date.now();
    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastBeat.current > HEARTBEAT_EVERY_MS) {
        lastBeat.current = now;
        authApi.heartbeat().catch(() => undefined);
      }
    };
    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, onActivity, { passive: true });
    const idleMs = status.idleMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current > idleMs) void lockNow();
    }, 10_000);
    return () => {
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, onActivity);
      window.clearInterval(timer);
    };
  }, [guarding, status, lockNow]);

  if (!status) return null;

  if (locked) {
    return (
      <LockScreen
        onUnlocked={() => {
          lastActivity.current = Date.now();
          setGeneration((g) => g + 1); // remount the app so it re-fetches state and reconnects the socket
          void refresh();
        }}
      />
    );
  }

  return (
    <AuthContext.Provider value={{ status, refresh, lockNow }}>
      <div key={generation} style={{ display: 'contents' }}>
        {children}
      </div>
    </AuthContext.Provider>
  );
}
