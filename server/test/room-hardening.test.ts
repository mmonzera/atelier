import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner, Turn } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { GroupChatMigrationError, applyGroupChatMigration } from '../src/channels/migration.js';
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

function configFor(dir: string) {
  return loadConfig({
    dataDir: dir,
    workspacesDir: path.join(dir, 'ws'),
    dbPath: path.join(dir, 'atelier.db'),
  });
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
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('RoomScheduler lease ownership', () => {
  it('a late release from a timed-out turn does not free the next agent’s lease', () => {
    const scheduler = new RoomScheduler({ sweepIntervalMs: 0 });
    scheduler.tryAcquire('chn', 'builder', 'q_builder');
    // Builder times out and its lease is released by the sweeper...
    expect(scheduler.release('chn', 'idle_timeout', 'q_builder')).toBe(true);
    // ...QA now holds the room.
    expect(scheduler.tryAcquire('chn', 'qa', 'q_qa')).not.toBeNull();
    // Builder's aborted turn finally unwinds and releases "its" lease: must be a no-op.
    expect(scheduler.release('chn', 'error', 'q_builder')).toBe(false);
    expect(scheduler.getLease('chn')?.agentId).toBe('qa');
    // A third agent still cannot start while QA is running.
    expect(scheduler.tryAcquire('chn', 'writer', 'q_writer')).toBeNull();
    scheduler.close();
  });
});

describe('Chain budget holds queued work instead of dropping it', () => {
  it('queues a budget-exhausted item, does not run it, and runs it after Continue', async () => {
    const dir = makeTempDir('atelier-hold-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, configFor(dir));
      const { project, agents } = store.createProject({
        name: 'Hold Room',
        starterAgents: [
          { name: 'Builder', role: 'Dev' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, qa] = agents as [(typeof agents)[number], (typeof agents)[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      const ran: string[] = [];
      const runner: AgentRunner = {
        async run(turn) {
          ran.push(turn.agent.name);
          return { finalText: `${turn.agent.name} done.` };
        },
      };
      const runtime = new AgentRuntime(store, configFor(dir), runner);

      const { message } = runtime.postToChannel(room.id, {
        text: '@Builder start',
        mentionAgentIds: [builder.id],
      });
      await waitFor(() => ran.length === 1);
      await waitFor(() => store.getAgent(builder.id)?.status !== 'working');

      // Exhaust the chain budget, then a teammate request arrives for QA.
      db.sqlite.prepare('UPDATE room_chains SET max_turns = 1 WHERE root_message_id = ?').run(message.id);
      runtime.loopGuard.recordTurn(message.id, room.id, { tokens: 0, costUsd: 0 });
      expect(runtime.loopGuard.getChain(message.id)?.status).toBe('paused');
      runtime.enqueue({
        agentId: qa.id,
        projectId: project.id,
        channelId: room.id,
        triggerMessageId: message.id,
        rootMessageId: message.id,
        hop: 1,
        trust: 'teammate',
        kind: 'teammate',
        prompt: 'please check',
        refId: message.id,
      });

      // Item is retained (not dropped) but held.
      await new Promise((r) => setTimeout(r, 150));
      expect(ran).toEqual(['Builder']);
      expect(store.listAllQueuedItems(room.id).some((q) => q.agentId === qa.id)).toBe(true);

      // "Continue +6 turns" releases it.
      expect(runtime.continueRoomChain(room.id, message.id)).toBe(true);
      await waitFor(() => ran.includes('QA'));
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});

describe('Dispatch mode wiring', () => {
  it('passes turnPurpose=dispatch to the runner for a default-responder message', async () => {
    const dir = makeTempDir('atelier-dispatch-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, configFor(dir));
      const { project, agents } = store.createProject({
        name: 'Dispatch Room',
        starterAgents: [
          { name: 'Chief', role: 'Chief of Staff' },
          { name: 'Builder', role: 'Dev' },
        ],
      });
      const room = store.channels.getRoomByProject(project.id)!;
      const seen: Array<Turn['turnPurpose']> = [];
      const runner: AgentRunner = {
        async run(turn) {
          seen.push(turn.turnPurpose);
          return { finalText: 'ok' };
        },
      };
      const runtime = new AgentRuntime(store, configFor(dir), runner);
      runtime.postToChannel(room.id, { text: 'please ship the landing page' });
      await waitFor(() => seen.length === 1);
      expect(seen[0]).toBe('dispatch');
      expect(agents.length).toBe(2);
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});

describe('Approval card ("Izinkan sekali")', () => {
  it('approving re-runs the agent with trust=user and cannot be approved twice', async () => {
    const dir = makeTempDir('atelier-approve-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, configFor(dir));
      const { project, agents } = store.createProject({
        name: 'Approve Room',
        starterAgents: [{ name: 'QA', role: 'QA' }],
      });
      const qa = agents[0]!;
      const room = store.channels.getRoomByProject(project.id)!;
      const trusts: Array<Turn['trust']> = [];
      const runner: AgentRunner = {
        async run(turn) {
          trusts.push(turn.trust);
          return { finalText: 'pushed' };
        },
      };
      const runtime = new AgentRuntime(store, configFor(dir), runner);

      const { message: card } = store.channels.postMessage({
        channelId: room.id,
        author: 'system',
        agentId: null,
        text: 'QA requested approval: `git push origin feat/x`',
        metadata: { approvalRequest: { command: 'git push origin feat/x', approved: false, agentId: qa.id } },
      });

      expect(runtime.approveRoomAction(room.id, card.id)).toEqual({ ok: true });
      await waitFor(() => trusts.length === 1);
      expect(trusts[0]).toBe('user');
      expect(store.getMessage(card.id)?.metadata?.approvalRequest?.approved).toBe(true);
      expect(runtime.approveRoomAction(room.id, card.id)).toEqual({ ok: false, reason: 'already_approved' });
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});

describe('DM items are not blocked behind a waiting room item', () => {
  it('runs a direct message while an older room item waits for another agent’s turn', async () => {
    const dir = makeTempDir('atelier-dm-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, configFor(dir));
      const { project, agents } = store.createProject({
        name: 'DM Room',
        starterAgents: [
          { name: 'Builder', role: 'Dev' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, qa] = agents as [(typeof agents)[number], (typeof agents)[number]];
      const room = store.channels.getRoomByProject(project.id)!;
      const dm = store.channels.ensureDm(qa.id, qa.name);

      const ran: string[] = [];
      let releaseBuilder: (() => void) | null = null;
      const runner: AgentRunner = {
        async run(turn) {
          ran.push(`${turn.agent.name}:${turn.channelId === dm.id ? 'dm' : 'room'}`);
          if (turn.agent.id === builder.id) {
            await new Promise<void>((r) => {
              releaseBuilder = r;
            });
          }
          return { finalText: 'ok' };
        },
      };
      const runtime = new AgentRuntime(store, configFor(dir), runner);

      // Builder holds the room; QA gets a room item (must wait), then a DM (must not wait).
      runtime.postToChannel(room.id, { text: '@Builder go', mentionAgentIds: [builder.id] });
      await waitFor(() => ran.includes('Builder:room'));
      runtime.postToChannel(room.id, { text: '@QA review', mentionAgentIds: [qa.id] });
      runtime.postToChannel(dm.id, { text: 'hey QA, private question' });

      await waitFor(() => ran.includes('QA:dm'));
      expect(ran).not.toContain('QA:room');
      releaseBuilder?.();
      await waitFor(() => ran.includes('QA:room'));
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});

describe('Migration safety', () => {
  it('fails with GroupChatMigrationError, rolls back and leaves a backup when migration breaks', () => {
    const dir = makeTempDir('atelier-migfail-');
    const dbPath = path.join(dir, 'legacy.db');
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, project_id TEXT,
        agent_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      INSERT INTO messages (id, project_id, agent_id, created_at, data)
      VALUES ('m1', NULL, 'ghost', '2026-01-01T00:00:00Z', 'not-json{{');
    `);
    try {
      expect(() => applyGroupChatMigration(sqlite, { dataDir: dir })).toThrow(GroupChatMigrationError);
      // Original row is untouched and a backup of the pre-migration DB exists.
      const row = sqlite.prepare(`SELECT data FROM messages WHERE id = 'm1'`).get() as { data: string };
      expect(row.data).toBe('not-json{{');
      const backups = fs.readdirSync(path.join(dir, 'backup')).filter((f) => f.startsWith('pre-group-chat-'));
      expect(backups.length).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
