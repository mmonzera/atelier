import type { QueueItem, RoomQueueSnapshot, Task, TaskPriority, TaskStatus } from '@atelier/contracts';

export type LeaseReleaseReason =
  | 'done'
  | 'error'
  | 'idle_timeout'
  | 'hard_timeout'
  | 'skipped'
  | 'stopped'
  | 'awaiting_fallback';

export interface RoomLease {
  channelId: string;
  agentId: string;
  queueItemId: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
  abort: AbortController;
}

const STATUS_RANK: Record<TaskStatus, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
  cancelled: 5,
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function isTaskBlocked(task: Task | undefined, allTasks: Task[]): boolean {
  if (!task?.blockedBy?.length) return false;
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const byIdent = new Map(allTasks.map((t) => [t.identifier.toUpperCase(), t]));
  return task.blockedBy.some((ref) => {
    const dep = byId.get(ref) ?? byIdent.get(ref.toUpperCase());
    return dep ? dep.status !== 'done' : false;
  });
}

/**
 * Serial per-room turn scheduler (§4.7, §10.1, §10.6):
 * - At most one agent runs per room at a time (unless `parallel` is explicitly enabled).
 * - Enforces an always-on idle watchdog + hard turn cap via heartbeats.
 * - Orders waiting queue items deterministically by resume priority, manual order, FIFO rowid,
 *   unblocked task status/priority, and mention order.
 */
export class RoomScheduler {
  private readonly leases = new Map<string, RoomLease>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private idleMs: number;
  private hardMs: number;

  constructor(
    private readonly opts: {
      idleTimeoutMin?: number;
      maxTurnMin?: number;
      sweepIntervalMs?: number;
      onTimeout?: (lease: RoomLease, reason: 'idle_timeout' | 'hard_timeout') => void;
    } = {},
  ) {
    this.idleMs = Math.max(1, opts.idleTimeoutMin ?? 10) * 60_000;
    this.hardMs = Math.max(1, opts.maxTurnMin ?? 45) * 60_000;
    const interval = opts.sweepIntervalMs ?? 15_000;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref();
    }
  }

  public setTimeouts(idleTimeoutMin?: number, maxTurnMin?: number): void {
    if (typeof idleTimeoutMin === 'number' && idleTimeoutMin > 0) {
      this.idleMs = idleTimeoutMin * 60_000;
    }
    if (typeof maxTurnMin === 'number' && maxTurnMin > 0) {
      this.hardMs = maxTurnMin * 60_000;
    }
  }

  public getLease(channelId: string): RoomLease | null {
    return this.leases.get(channelId) ?? null;
  }

  public tryAcquire(
    channelId: string,
    agentId: string,
    queueItemId: string,
    abort = new AbortController(),
    parallel = false,
  ): RoomLease | null {
    if (!parallel) {
      const existing = this.leases.get(channelId);
      if (existing && existing.queueItemId !== queueItemId) {
        return null;
      }
    }
    const now = Date.now();
    const lease: RoomLease = {
      channelId,
      agentId,
      queueItemId,
      acquiredAt: now,
      lastHeartbeatAt: now,
      abort,
    };
    this.leases.set(channelId, lease);
    return lease;
  }

  public heartbeat(channelId: string): void {
    const lease = this.leases.get(channelId);
    if (lease) {
      lease.lastHeartbeatAt = Date.now();
    }
  }

  /**
   * Releases the room lease. When `queueItemId` is given, only the lease held by that item is
   * released, so a late `finally` from a timed-out turn can never free a newer agent's lease.
   * Returns true when a lease was actually removed.
   */
  public release(channelId: string, _reason: LeaseReleaseReason, queueItemId?: string): boolean {
    const lease = this.leases.get(channelId);
    if (!lease) return false;
    if (queueItemId && lease.queueItemId !== queueItemId) return false;
    this.leases.delete(channelId);
    return true;
  }

  public skip(channelId: string): RoomLease | null {
    const lease = this.leases.get(channelId);
    if (!lease) return null;
    lease.abort.abort();
    return lease;
  }

  public sweep(now = Date.now()): void {
    for (const lease of [...this.leases.values()]) {
      if (now - lease.lastHeartbeatAt > this.idleMs) {
        lease.abort.abort();
        this.opts.onTimeout?.(lease, 'idle_timeout');
      } else if (now - lease.acquiredAt > this.hardMs) {
        lease.abort.abort();
        this.opts.onTimeout?.(lease, 'hard_timeout');
      }
    }
  }

  /** Selects the next eligible queue item in a room according to §10.6 ordering rules. */
  public pickNext(queuedItems: QueueItem[], projectTasks: Task[]): QueueItem | null {
    if (queuedItems.length === 0) return null;
    const sorted = this.sortQueueItems(queuedItems, projectTasks);
    for (const item of sorted) {
      const task = this.findTaskForItem(item, projectTasks);
      if (isTaskBlocked(task, projectTasks)) continue;
      return item;
    }
    return null;
  }

  public sortQueueItems(queuedItems: QueueItem[], projectTasks: Task[]): QueueItem[] {
    return [...queuedItems].sort((a, b) => {
      const pa = a.priority === 'resume' ? 0 : 1;
      const pb = b.priority === 'resume' ? 0 : 1;
      if (pa !== pb) return pa - pb;

      const ma = a.manualOrder ?? Number.MAX_SAFE_INTEGER;
      const mb = b.manualOrder ?? Number.MAX_SAFE_INTEGER;
      if (ma !== mb) return ma - mb;

      const ra = a.triggerRowid ?? Number.MAX_SAFE_INTEGER;
      const rb = b.triggerRowid ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;

      const ta = this.findTaskForItem(a, projectTasks);
      const tb = this.findTaskForItem(b, projectTasks);
      const ba = isTaskBlocked(ta, projectTasks) ? 1 : 0;
      const bb = isTaskBlocked(tb, projectTasks) ? 1 : 0;
      if (ba !== bb) return ba - bb;

      const sra = ta ? STATUS_RANK[ta.status] : 99;
      const srb = tb ? STATUS_RANK[tb.status] : 99;
      if (sra !== srb) return sra - srb;

      const pra = ta ? PRIORITY_RANK[ta.priority] : 99;
      const prb = tb ? PRIORITY_RANK[tb.priority] : 99;
      if (pra !== prb) return pra - prb;

      const mia = a.mentionIndex ?? 0;
      const mib = b.mentionIndex ?? 0;
      if (mia !== mib) return mia - mib;

      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  public snapshot(channelId: string, queuedItems: QueueItem[], projectTasks: Task[]): RoomQueueSnapshot {
    const lease = this.leases.get(channelId);
    const ordered = this.sortQueueItems(
      queuedItems.filter((q) => q.channelId === channelId && q.id !== lease?.queueItemId),
      projectTasks,
    );
    return {
      channelId,
      activeAgentId: lease?.agentId ?? null,
      activeQueueItemId: lease?.queueItemId ?? null,
      queued: ordered.map((q) => ({
        queueItemId: q.id,
        agentId: q.agentId,
        triggerMessageId: q.triggerMessageId ?? null,
        manualOrder: q.manualOrder ?? null,
      })),
    };
  }

  private findTaskForItem(item: QueueItem, tasks: Task[]): Task | undefined {
    if (item.kind === 'task' && item.refId) {
      return tasks.find((t) => t.id === item.refId);
    }
    return tasks
      .filter((t) => t.assigneeAgentId === item.agentId && t.status !== 'done' && t.status !== 'cancelled')
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])[0];
  }

  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
