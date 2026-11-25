import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { RoomContextBuilder } from '../src/channels/context.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Room sessions ("New session" clean vs summary carryover, §4.8 & §10.12)', () => {
  it('excludes old-session messages from room context while keeping visual history & search_history access', () => {
    const dir = makeTempDir('atelier-sessions-');
    const dbPath = path.join(dir, 'atelier.db');
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
      const { project, agents } = store.createProject({
        name: 'Session Project',
        starterAgents: [{ name: 'Builder', role: 'Dev' }],
      });
      const builder = agents[0]!;
      const room = store.channels.getRoomByProject(project.id)!;

      store.channels.postMessage({
        channelId: room.id,
        author: 'user',
        agentId: null,
        text: 'Decided to use cobalt accent color #2563EB for primary CTA.',
      });
      store.channels.postMessage({
        channelId: room.id,
        author: 'agent',
        agentId: builder.id,
        text: 'Implemented cobalt CTA button in Hero.astro.',
      });

      // Start new session WITH summary carryover
      const sessRes = store.channels.startNewSession(room.id, {
        carryover: 'summary',
        carryoverSummary: 'Carryover: primary CTA color is #2563EB (cobalt).',
      });
      expect(sessRes).not.toBeNull();
      expect(sessRes!.session.seq).toBe(2);

      // Visual timeline still holds all messages across sessions
      const allTimeline = store.channels.listChannelMessages(room.id, { limit: 100 });
      expect(allTimeline.messages.some((m) => m.text.includes('cobalt accent color'))).toBe(true);
      expect(allTimeline.messages.some((m) => m.metadata?.event?.kind === 'session_started')).toBe(true);

      // Agent prompt in Session 2 does NOT include Session 1 raw messages, only carryover
      const trigger = store.channels.postMessage({
        channelId: room.id,
        author: 'user',
        agentId: null,
        text: '@Builder start AT-12',
      });
      const ctx = new RoomContextBuilder(store.channels).build({
        channel: sessRes!.channel,
        agent: builder,
        project,
        projectAgents: agents,
        allAgents: agents,
        tasks: [],
        triggerMessage: trigger.message,
        currentPrompt: trigger.message.text,
        hasResumeSession: false,
      });
      expect(ctx.fullPrompt).toContain('Carryover: primary CTA color is #2563EB');
      expect(ctx.fullPrompt).not.toContain('Implemented cobalt CTA button in Hero.astro.');

      // Clean session excludes carryover too
      const cleanRes = store.channels.startNewSession(room.id, { carryover: 'clean' });
      const cleanTrigger = store.channels.postMessage({
        channelId: room.id,
        author: 'user',
        agentId: null,
        text: '@Builder fresh check',
      });
      const cleanCtx = new RoomContextBuilder(store.channels).build({
        channel: cleanRes!.channel,
        agent: builder,
        project,
        projectAgents: agents,
        allAgents: agents,
        tasks: [],
        triggerMessage: cleanTrigger.message,
        currentPrompt: cleanTrigger.message.text,
        hasResumeSession: false,
      });
      expect(cleanCtx.fullPrompt).not.toContain('Carryover:');
      expect(cleanCtx.fullPrompt).not.toContain('Implemented cobalt CTA button in Hero.astro.');

      // search_history still reaches old sessions
      const tools = createStudioTools({
        store,
        projectId: project.id,
        actingAgentId: builder.id,
        enqueue: () => undefined,
      });
      const found = tools.memoryAction('search_history', { query: 'cobalt' }) as Array<{ snippet: string }>;
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((r) => r.snippet.toLowerCase().includes('cobalt'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
