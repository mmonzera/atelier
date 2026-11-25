import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { LoopGuard } from '../src/channels/loop-guard.js';
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
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('LoopGuard (maxHops, chain budget, continueChain, queue dedupe, §4.4 & §10.9)', () => {
  it('enforces maxHops, tracks 80% warning and 100% pause, and resumes with continueChain', () => {
    const dir = makeTempDir('atelier-loop-unit-');
    const dbPath = path.join(dir, 'atelier.db');
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
      const { project } = store.createProject({ name: 'Loop Project' });
      const room = store.channels.getRoomByProject(project.id)!;
      const guard = new LoopGuard(db.sqlite);

      // maxHops = 6 -> hop 7 is rejected
      const ok6 = guard.canEnqueue({ rootMessageId: 'msg_root', channelId: room.id, hop: 6, maxHops: 6 });
      expect(ok6.allowed).toBe(true);
      const stop7 = guard.canEnqueue({ rootMessageId: 'msg_root', channelId: room.id, hop: 7, maxHops: 6 });
      expect(stop7.allowed).toBe(false);
      expect(stop7.reason).toBe('max_hops');

      // Budget of 5 turns -> 4th turn triggers 80% warning, 5th pauses, continueChain adds +6
      guard.ensureChain('msg_budget', room.id, { maxTurns: 5, maxTokens: 100_000 });
      for (let i = 1; i <= 3; i += 1) {
        const res = guard.recordTurn('msg_budget', room.id, { tokens: 100, costUsd: 0.001 });
        expect(res.justWarned).toBe(false);
        expect(res.justPaused).toBe(false);
      }
      const turn4 = guard.recordTurn('msg_budget', room.id, { tokens: 100, costUsd: 0.001 });
      expect(turn4.justWarned).toBe(true);
      expect(turn4.justPaused).toBe(false);

      const turn5 = guard.recordTurn('msg_budget', room.id, { tokens: 100, costUsd: 0.001 });
      expect(turn5.justPaused).toBe(true);
      expect(turn5.chain.status).toBe('paused');

      const blocked = guard.canEnqueue({ rootMessageId: 'msg_budget', channelId: room.id, hop: 1 });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('chain_budget_exhausted');

      const resumed = guard.continueChain('msg_budget', 6)!;
      expect(resumed.status).toBe('active');
      expect(resumed.maxTurns).toBe(11);
      expect(guard.canEnqueue({ rootMessageId: 'msg_budget', channelId: room.id, hop: 1 }).allowed).toBe(true);
    } finally {
      db.close();
    }
  });

  it('stops ping-pong @mentions between A and B at maxHops and posts loop_stopped event', async () => {
    const dir = makeTempDir('atelier-pingpong-');
    const dbPath = path.join(dir, 'atelier.db');
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
      const { project, agents } = store.createProject({
        name: 'PingPong',
        starterAgents: [
          { name: 'Alpha', role: 'A' },
          { name: 'Beta', role: 'B' },
        ],
      });
      const [alpha, beta] = agents as [typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;
      store.channels.updateChannel(room.id, { settings: { maxHops: 2 } });

      let turns = 0;
      const runner: AgentRunner = {
        async run(turn, cb) {
          turns += 1;
          const reply = turn.agent.id === alpha.id ? '@Beta over to you' : '@Alpha back to you';
          cb.onText(reply);
          return { finalText: reply };
        },
      };

      const runtime = new AgentRuntime(store, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }), runner);
      runtime.postToChannel(room.id, { text: '@Alpha start ping pong', mentionAgentIds: [alpha.id] });

      await waitFor(() =>
        store.channels
          .listChannelMessages(room.id)
          .messages.some((m) => m.metadata?.event?.kind === 'loop_stopped'),
      );
      expect(turns).toBe(3); // hop 0 (Alpha), hop 1 (Beta), hop 2 (Alpha) -> hop 3 rejected
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});
