import type { AppUpdateState, AppUpdateStatus } from '@atelier/contracts';

const VALID_STATES = new Set<AppUpdateState>([
  'idle',
  'checking',
  'available',
  'downloading',
  'up_to_date',
  'error',
]);

/**
 * Bridges desktop updater events between the Tauri shell (via sidecar stdio) and the HTTP/WS web UI.
 */
export class AppUpdateBridge {
  private status: AppUpdateStatus;
  private readonly onRequestAction?: (action: 'check' | 'install') => void;
  private readonly onBroadcast?: (status: AppUpdateStatus) => void;

  constructor(opts: {
    supported: boolean;
    currentVersion: string;
    onRequestAction?: (action: 'check' | 'install') => void;
    onBroadcast?: (status: AppUpdateStatus) => void;
  }) {
    this.status = {
      supported: opts.supported,
      currentVersion: opts.currentVersion,
      state: 'idle',
      availableVersion: null,
      notes: null,
      progressPercent: null,
      error: null,
      checkedAt: null,
    };
    this.onRequestAction = opts.onRequestAction;
    this.onBroadcast = opts.onBroadcast;
  }

  public getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  public requestCheck(): AppUpdateStatus {
    if (!this.status.supported) return this.getStatus();
    if (this.status.state !== 'downloading') {
      this.status = {
        ...this.status,
        state: 'checking',
        error: null,
      };
      this.onBroadcast?.(this.getStatus());
      this.onRequestAction?.('check');
    }
    return this.getStatus();
  }

  public requestInstall(): AppUpdateStatus {
    if (!this.status.supported) return this.getStatus();
    this.status = {
      ...this.status,
      state: 'downloading',
      progressPercent: this.status.progressPercent ?? 0,
      error: null,
    };
    this.onBroadcast?.(this.getStatus());
    this.onRequestAction?.('install');
    return this.getStatus();
  }

  public applyShellStatus(raw: Record<string, unknown>): AppUpdateStatus {
    const rawState = typeof raw.state === 'string' && VALID_STATES.has(raw.state as AppUpdateState)
      ? (raw.state as AppUpdateState)
      : this.status.state;
    const availableVersion =
      raw.availableVersion === null
        ? null
        : typeof raw.availableVersion === 'string'
          ? raw.availableVersion
          : this.status.availableVersion;
    const notes =
      raw.notes === null
        ? null
        : typeof raw.notes === 'string'
          ? raw.notes
          : this.status.notes;
    const progressPercent =
      raw.progressPercent === null
        ? null
        : typeof raw.progressPercent === 'number' && Number.isFinite(raw.progressPercent)
          ? Math.max(0, Math.min(100, Math.round(raw.progressPercent)))
          : this.status.progressPercent;
    const error =
      raw.error === null
        ? null
        : typeof raw.error === 'string'
          ? raw.error
          : this.status.error;

    this.status = {
      ...this.status,
      state: rawState,
      availableVersion,
      notes,
      progressPercent,
      error,
      checkedAt: new Date().toISOString(),
    };
    this.onBroadcast?.(this.getStatus());
    return this.getStatus();
  }
}
