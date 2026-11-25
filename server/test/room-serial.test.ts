import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { RoomScheduler } from '../src/channels/scheduler.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Room serial execution, task ordering, watchdog, fallback release & skip (§4.7, §10.1, §10.6)', () => {
  it('runs mentioned agents serially (never overlapping) and orders by task status/priority then mention order', async () => {
    const dir = makeTempDir('atelier-serial-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }));
      const { project, agents } = store.createProject({
        name: 'Serial Room',
        starterAgents: [
          { name: 'Builder', role: 'Dev' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, qa] = agents as [typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      // QA has an in_progress task so QA should be scheduled BEFORE Builder (whose task is todo)
      store.createTask(project.id, { title: 'B task', assigneeAgentId: builder.id, status: 'todo', priority: 'medium' });
      store.createTask(project.id, { title: 'Q task', assigneeAgentId: qa.id, status: 'in_progress', priority: 'high' });

      let concurrent = 0;
      let maxConcurrent = 0;
      const runOrder: string[] = [];
      const runner: AgentRunner = {
        async run(turn, cb) {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          runOrder.push(turn.agent.name);
          await new Promise((r) => setTimeout(r, 40));
          cb.onText(`${turn.agent.name} done.`);
          concurrent -= 1;
          return { finalText: `${turn.agent.name} done.` };
        },
      };

      const runtime = new AgentRuntime(store, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }), runner);
      runtime.postToChannel(room.id, {
        text: '@Builder @QA please check',
        mentionAgentIds: [builder.id, qa.id],
      });

      await waitFor(() => runOrder.length === 2);
      expect(maxConcurrent).toBe(1);
      expect(runOrder).toEqual(['QA', 'Builder']);
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });

  it('skips blocked tasks in pickNext until blocker is done', () => {
    const scheduler = new RoomScheduler({ sweepIntervalMs: 0 });
    const tasks = [
      {
        id: 't1',
        identifier: 'AT-1',
        projectId: 'p1',
        title: 'Blocker',
        description: '',
        status: 'in_progress' as const,
        priority: 'high' as const,
        assigneeAgentId: 'a1',
        branch: null,
        prUrl: null,
        deliverableSummary: null,
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
      {
        id: 't2',
        identifier: 'AT-2',
        projectId: 'p1',
        title: 'Blocked',
        description: '',
        status: 'todo' as const,
        priority: 'urgent' as const,
        assigneeAgentId: 'a2',
        blockedBy: ['t1'],
        branch: null,
        prUrl: null,
        deliverableSummary: null,
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
    ];
    const items = [
      { id: 'q2', agentId: 'a2', projectId: 'p1', channelId: 'c1', kind: 'task' as const, prompt: 'run t2', refId: 't2', triggerRowid: 1, createdAt: '2026-11-25T00:00:00Z' },
      { id: 'q1', agentId: 'a1', projectId: 'p1', channelId: 'c1', kind: 'task' as const, prompt: 'run t1', refId: 't1', triggerRowid: 2, createdAt: '2026-11-25T00:00:01Z' },
    ];
    const picked = scheduler.pickNext(items, tasks);
    expect(picked?.id).toBe('q1');
    scheduler.close();
  });

  it('releases lease after idle timeout (fake timers) while keeping active streaming alive', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const scheduler = new RoomScheduler({
      idleTimeoutMin: 10,
      maxTurnMin: 45,
      sweepIntervalMs: 15_000,
      onTimeout: (lease) => {
        timedOut.push(lease.queueItemId);
        scheduler.release(lease.channelId, 'idle_timeout');
      },
    });

    const lease = scheduler.tryAcquire('chn_1', 'agt_1', 'q_idle')!;
    expect(lease).not.toBeNull();
    vi.advanceTimersByTime(10 * 60_000 + 20_000);
    expect(timedOut).toEqual(['q_idle']);
    expect(lease.abort.signal.aborted).toBe(true);
    expect(scheduler.getLease('chn_1')).toBeNull();

    // Streaming with heartbeats stays alive past 10 minutes
    const activeLease = scheduler.tryAcquire('chn_1', 'agt_1', 'q_stream')!;
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(5 * 60_000);
      scheduler.heartbeat('chn_1');
    }
    expect(activeLease.abort.signal.aborted).toBe(false);
    expect(timedOut).toEqual(['q_idle']);
    scheduler.close();
  });

  it('releases room lock on pendingFallback and supports skipRoomTurn', async () => {
    const dir = makeTempDir('atelier-fallback-skip-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }));
      const { project, agents } = store.createProject({
        name: 'Skip Room',
        starterAgents: [
          { name: 'Builder', role: 'Dev' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, qa] = agents as [typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      const runner: AgentRunner = {
        async run(turn, cb) {
          if (turn.agent.id === builder.id) {
            throw new Error('rate limit exceeded 429');
          }
          cb.onText('QA continued.');
          return { finalText: 'QA continued.' };
        },
      };

      const runtime = new AgentRuntime(store, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }), runner);
      runtime.postToChannel(room.id, {
        text: '@Builder @QA go',
        mentionAgentIds: [builder.id, qa.id],
      });

      await waitFor(() =>
        store.channels.listChannelMessages(room.id).messages.some((m) => m.agentId === qa.id && m.text.includes('QA continued.')),
      );
      expect(store.getAgent(builder.id)?.status).toBe('error');
      expect(runtime.scheduler.getLease(room.id)).toBeNull();
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});
