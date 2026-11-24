import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  type AutoCompactSettings,
  type Message,
} from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoCompactTrigger,
  compactAgentScope,
  estimateConversationTokens,
} from '../src/agents/compactor.js';
import type { AgentRunner } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { startAtelierServer } from '../src/index.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const openDbs: AtelierDb[] = [];

function makeTempDir(prefix = 'atelier-compact-v3-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeMessages(count: number, body = 'Short hello message'): Message[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, idx) => ({
    id: `msg_${idx + 1}`,
    projectId: 'prj_test',
    agentId: 'agt_test',
    author: idx % 2 === 0 ? 'user' : 'agent',
    text: `m${idx + 1}: ${body}`,
    streaming: false,
    durationMs: null,
    createdAt: new Date(now + idx * 1000).toISOString(),
  }));
}

function createStoreFixture() {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'atelier.db');
  const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
  const db = new AtelierDb(dbPath);
  openDbs.push(db);
  const store = new AtelierStore(db, config);
  const {
    project,
    agents: [agent],
  } = store.createProject({
    name: 'Compact Batch Project',
    starterAgents: [{ name: 'Chief of Staff', role: 'Coordinator' }],
  });
  return { dir, config, db, store, project, agent: agent! };
}

async function waitFor<T>(
  fn: () => Promise<T | false | undefined> | T | false | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Auto-compact v3 trigger, batching, session preservation, and migration', () => {
  it('1. never triggers auto-compaction for a short chat despite large provider prompt overhead', () => {
    const messages = makeFakeMessages(8, 'Quick ping from Codex chat');
    const trigger = autoCompactTrigger(messages, null, 30_000, DEFAULT_AUTO_COMPACT_SETTINGS);
    expect(trigger).toBeNull();
  });

  it('2. triggers "messages" at >= 80 uncompacted messages and compacts the full batch (>= minCompactMessages)', () => {
    const { store, project, agent } = createStoreFixture();
    for (let i = 0; i < 90; i++) {
      store.createMessage({
        agentId: agent.id,
        projectId: project.id,
        author: i % 2 === 0 ? 'user' : 'agent',
        text: `Short message #${i + 1}`,
      });
    }
    const messages = store.listAgentMessages(agent.id, project.id);
    const settings = store.getSettings().autoCompact;
    const trigger = autoCompactTrigger(messages, null, 35_000, settings);
    expect(trigger).toBe('messages');

    const result = compactAgentScope(store, agent.id, project.id, {
      reason: 'auto',
      trigger: trigger!,
    });
    expect(result.compacted).toBe(true);
    expect(result.compactedCount).toBe(90 - 14);
    expect(result.compactedCount).toBeGreaterThanOrEqual(settings.minCompactMessages ?? 10);
    expect(result.compaction?.trigger).toBe('messages');
  });

  it('3. triggers "conversation_tokens" when Atelier conversation estimate exceeds 48k across >= keep+minBatch messages', () => {
    const longBody = 'Detailed architecture discussion about storage engines and indexing. '.repeat(120);
    const messages = makeFakeMessages(30, longBody);
    expect(estimateConversationTokens(messages, null)).toBeGreaterThanOrEqual(
      DEFAULT_AUTO_COMPACT_SETTINGS.maxContextTokens,
    );
    const trigger = autoCompactTrigger(messages, null, 0, DEFAULT_AUTO_COMPACT_SETTINGS);
    expect(trigger).toBe('conversation_tokens');
  });

  it('4. waits until at least minCompactMessages can be compacted even if conversation tokens exceed maxContextTokens', () => {
    const veryLongBody = 'Extensive design specification payload for single long messages. '.repeat(220);
    // keepRecentMessages (14) + 5 = 19 uncompacted -> only 5 compactable (< minCompactMessages = 10)
    const messages = makeFakeMessages(19, veryLongBody);
    expect(estimateConversationTokens(messages, null)).toBeGreaterThan(
      DEFAULT_AUTO_COMPACT_SETTINGS.maxContextTokens,
    );
    const trigger = autoCompactTrigger(messages, null, 0, DEFAULT_AUTO_COMPACT_SETTINGS);
    expect(trigger).toBeNull();
  });

  it('5. triggers "provider_limit" emergency on small chat and compacts + resets native session', () => {
    const { store, project, agent } = createStoreFixture();
    store.updateAgent(agent.id, {
      sessionId: 'openai:thr_emerg',
      sessions: { [project.id]: 'openai:thr_emerg', direct: 'openai:thr_direct' },
      scopeTokens: { [project.id]: 120_000 },
    });
    for (let i = 0; i < 5; i++) {
      store.createMessage({
        agentId: agent.id,
        projectId: project.id,
        author: i % 2 === 0 ? 'user' : 'agent',
        text: `Emergency turn ${i + 1}`,
      });
    }
    const messages = store.listAgentMessages(agent.id, project.id);
    const trigger = autoCompactTrigger(messages, null, 120_000, store.getSettings().autoCompact);
    expect(trigger).toBe('provider_limit');

    const res = compactAgentScope(store, agent.id, project.id, {
      reason: 'auto',
      trigger: trigger!,
    });
    expect(res.compacted).toBe(true);
    expect(res.compactedCount).toBeGreaterThanOrEqual(1);
    expect(res.compaction?.trigger).toBe('provider_limit');
    expect(res.agent?.sessions?.[project.id]).toBeUndefined();
    expect(res.agent?.sessions?.direct).toBe('openai:thr_direct');
    expect(res.agent?.sessionId).toBeNull();
  });

  it('6. preserves native provider session for normal auto-compaction ("messages" and "conversation_tokens")', () => {
    // Case A: 'messages'
    {
      const { store, project, agent } = createStoreFixture();
      store.updateAgent(agent.id, {
        sessionId: 'openai:thr_msgs',
        sessions: { [project.id]: 'openai:thr_msgs', direct: 'openai:thr_direct' },
        scopeTokens: { [project.id]: 32_000 },
      });
      for (let i = 0; i < 90; i++) {
        store.createMessage({
          agentId: agent.id,
          projectId: project.id,
          author: i % 2 === 0 ? 'user' : 'agent',
          text: `Short line ${i + 1}`,
        });
      }
      const res = compactAgentScope(store, agent.id, project.id, {
        reason: 'auto',
        trigger: 'messages',
      });
      expect(res.compacted).toBe(true);
      expect(res.agent?.sessions?.[project.id]).toBe('openai:thr_msgs');
      expect(res.agent?.sessionId).toBe('openai:thr_msgs');
    }

    // Case B: 'conversation_tokens'
    {
      const { store, project, agent } = createStoreFixture();
      store.updateAgent(agent.id, {
        sessionId: 'openai:thr_toks',
        sessions: { [project.id]: 'openai:thr_toks' },
        scopeTokens: { [project.id]: 55_000 },
      });
      const longBody = 'Long conversation payload. '.repeat(250);
      for (let i = 0; i < 30; i++) {
        store.createMessage({
          agentId: agent.id,
          projectId: project.id,
          author: i % 2 === 0 ? 'user' : 'agent',
          text: `Msg ${i + 1}: ${longBody}`,
        });
      }
      const res = compactAgentScope(store, agent.id, project.id, {
        reason: 'auto',
        trigger: 'conversation_tokens',
      });
      expect(res.compacted).toBe(true);
      expect(res.agent?.sessions?.[project.id]).toBe('openai:thr_toks');
      expect(res.agent?.sessionId).toBe('openai:thr_toks');
    }
  });

  it('7. manual compaction always resets the native provider session', () => {
    const { store, project, agent } = createStoreFixture();
    store.updateAgent(agent.id, {
      sessionId: 'openai:thr_manual',
      sessions: { [project.id]: 'openai:thr_manual', direct: 'openai:thr_direct' },
    });
    for (let i = 0; i < 6; i++) {
      store.createMessage({
        agentId: agent.id,
        projectId: project.id,
        author: i % 2 === 0 ? 'user' : 'agent',
        text: `Manual compact test ${i + 1}`,
      });
    }
    const res = compactAgentScope(store, agent.id, project.id, {
      force: true,
      reason: 'manual',
    });
    expect(res.compacted).toBe(true);
    expect(res.agent?.sessions?.[project.id]).toBeUndefined();
    expect(res.agent?.sessions?.direct).toBe('openai:thr_direct');
    expect(res.agent?.sessionId).toBeNull();
  });

  it('8. migrates v2 defaults to v3 defaults while preserving custom v2 settings', () => {
    const { db, store } = createStoreFixture();
    const current = store.getSettings();
    const writeRawAutoCompact = (autoCompact: Partial<AutoCompactSettings>) => {
      db.sqlite
        .prepare('UPDATE settings SET data = ? WHERE id = 1')
        .run(JSON.stringify({ ...current, autoCompact }));
    };

    // Stored v2 untouched defaults -> migrated to v3 defaults
    writeRawAutoCompact({
      enabled: true,
      maxMessages: 60,
      keepRecentMessages: 14,
      maxContextTokens: 24000,
      settingsVersion: 2,
    });
    expect(store.getSettings().autoCompact).toEqual({
      enabled: true,
      settingsVersion: 3,
      maxMessages: 80,
      keepRecentMessages: 14,
      maxContextTokens: 48000,
      minCompactMessages: 10,
      providerContextLimit: 100000,
      tailTokens: 6000,
    });

    // Stored custom user setting -> custom maxContextTokens preserved, new fields defaulted, version bumped to 3
    writeRawAutoCompact({
      enabled: true,
      maxMessages: 60,
      keepRecentMessages: 14,
      maxContextTokens: 70000,
      settingsVersion: 2,
    });
    expect(store.getSettings().autoCompact).toEqual({
      enabled: true,
      settingsVersion: 3,
      maxMessages: 60,
      keepRecentMessages: 14,
      maxContextTokens: 70000,
      minCompactMessages: 10,
      providerContextLimit: 100000,
      tailTokens: 6000,
    });
  });

  it('9. records the maximum single-round onContextTokens in scopeTokens instead of summing rounds', async () => {
    const { config, store, project, agent } = createStoreFixture();
    const runner: AgentRunner = {
      async run(turn, cb) {
        cb.onSession('openai:thr_multi');
        cb.onContextTokens?.(20_000);
        cb.onContextTokens?.(25_000);
        cb.onUsage?.(45_000, 300);
        const text = `Done: ${turn.prompt}`;
        cb.onText(text);
        return { finalText: text };
      },
    };
    const runtime = new AgentRuntime(store, config, runner);
    try {
      runtime.enqueue({
        agentId: agent.id,
        projectId: project.id,
        kind: 'user',
        prompt: 'Multi-round Codex check',
      });
      const finished = await waitFor(() => {
        const a = store.getAgent(agent.id);
        return a && a.status === 'idle' && (a.scopeTokens?.[project.id] ?? 0) > 0 ? a : false;
      });
      expect(finished.scopeTokens?.[project.id]).toBe(25_000);
      expect(finished.conversationTokens?.[project.id]).toBeGreaterThan(0);
      expect(finished.conversationTokens?.[project.id]).toBeLessThan(1000);
    } finally {
      await runtime.shutdown();
    }
  });

  it('10. server integration: 6 consecutive turns with 40k reported provider context trigger zero auto-compactions', async () => {
    const dir = makeTempDir('atelier-compact-srv-');
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: () => ({
        async run(turn, cb) {
          cb.onSession('openai:thr_int');
          cb.onContextTokens?.(40_000);
          cb.onUsage?.(40_000, 120);
          const text = `Reply: ${turn.prompt}`;
          cb.onText(text);
          return { finalText: text };
        },
      }),
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Short Chat Project' }),
      });
      const { project } = (await projRes.json()) as { project: { id: string } };

      const agtRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Codex Bot', role: 'Chief of Staff', providerOverride: 'openai' }),
      });
      const { agent } = (await agtRes.json()) as { agent: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/agents/${agent.id}`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
      });

      for (let i = 1; i <= 6; i++) {
        const msgRes = await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: `Short user turn ${i}`, projectId: project.id }),
        });
        expect(msgRes.status).toBe(202);
        await waitFor(async () => {
          const state = (await (
            await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
          ).json()) as {
            agents: Array<{ id: string; status: string }>;
            messages: Array<{ agentId: string; projectId: string | null; author: string }>;
          };
          const a = state.agents.find((x) => x.id === agent.id);
          const replies = state.messages.filter(
            (m) => m.agentId === agent.id && m.projectId === project.id && m.author === 'agent',
          ).length;
          return a && a.status === 'idle' && replies === i ? state : false;
        });
      }

      const finalState = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        agents: Array<{
          id: string;
          sessions?: Record<string, string>;
          contextCompactions?: Record<string, unknown>;
          scopeTokens?: Record<string, number>;
          conversationTokens?: Record<string, number>;
        }>;
        messages: Array<{
          agentId: string;
          projectId: string | null;
          author: string;
          metadata?: { compacted?: boolean };
        }>;
      };

      const finalAgent = finalState.agents.find((x) => x.id === agent.id)!;
      expect(finalAgent.contextCompactions?.[project.id]).toBeUndefined();
      expect(finalAgent.sessions?.[project.id]).toBe('openai:thr_int');
      expect(finalAgent.scopeTokens?.[project.id]).toBe(40_000);
      expect(finalAgent.conversationTokens?.[project.id]).toBeGreaterThan(0);
      expect(finalAgent.conversationTokens?.[project.id]).toBeLessThan(1000);
      expect(
        finalState.messages.some(
          (m) => m.agentId === agent.id && m.projectId === project.id && m.metadata?.compacted,
        ),
      ).toBe(false);
    } finally {
      await handle.close();
    }
  });
});
