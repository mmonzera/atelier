import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('RoomContextBuilder (stubs, cursor delta, tailTokens, DM digest)', () => {
  it('renders full text for own/mentioned/user/decision msgs and 1-line stubs for unrelated agent msgs', () => {
    const dir = makeTempDir('atelier-ctx-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }));
      const { project, agents } = store.createProject({
        name: 'Ctx Project',
        starterAgents: [
          { name: 'Builder', role: 'Frontend' },
          { name: 'Writer', role: 'Copy' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, writer, qa] = agents as [typeof agents[number], typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      // Unrelated message from Writer -> QA (should become a stub for Builder)
      const { message: writerMsg } = store.channels.postMessage({
        channelId: room.id,
        author: 'agent',
        agentId: writer.id,
        text: 'Long copywriting details for QA that Builder does not need in full. Second sentence ignored in stub.',
        metadata: { mentions: [qa.id], toAgentIds: [qa.id] },
      });
      store.finalizeMessage(writerMsg.id, { streaming: false, text: writerMsg.text });

      // Message with a recorded decision (must stay full even for Builder)
      const { message: decisionMsg } = store.channels.postMessage({
        channelId: room.id,
        author: 'agent',
        agentId: qa.id,
        text: 'Decision: keep dark mode default everywhere.',
        metadata: {
          activities: [{ id: 'act_1', kind: 'status', label: 'atelier.record_decision', createdAt: new Date().toISOString() }],
        },
      });
      store.finalizeMessage(decisionMsg.id, { streaming: false, text: decisionMsg.text });

      const { message: userTrigger } = store.channels.postMessage({
        channelId: room.id,
        author: 'user',
        agentId: null,
        text: '@Builder please check layout',
        metadata: { mentions: [builder.id] },
      });

      const builderCtx = new RoomContextBuilder(store.channels).build({
        channel: room,
        agent: builder,
        project,
        projectAgents: agents,
        allAgents: agents,
        tasks: [],
        triggerMessage: userTrigger,
        currentPrompt: userTrigger.text,
        hasResumeSession: false,
      });

      expect(builderCtx.fullPrompt).toContain(`[Writer→QA] Long copywriting details for QA that Builder does not need in full.`);
      expect(builderCtx.fullPrompt).toContain(`(${writerMsg.id})`);
      expect(builderCtx.fullPrompt).not.toContain('Second sentence ignored in stub');
      expect(builderCtx.fullPrompt).toContain('Decision: keep dark mode default everywhere.');
      expect(builderCtx.memoryTokens.stubs).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('emits only cursor delta when resuming a provider session and builds DM project digest', () => {
    const dir = makeTempDir('atelier-delta-');
    const db = new AtelierDb(path.join(dir, 'atelier.db'));
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') }));
      const { project, agents } = store.createProject({
        name: 'Delta Project',
        starterAgents: [
          { name: 'Builder', role: 'Frontend' },
          { name: 'QA', role: 'QA' },
        ],
      });
      const [builder, qa] = agents as [typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      const first = store.channels.postMessage({
        channelId: room.id,
        author: 'agent',
        agentId: builder.id,
        text: 'Old builder message before cursor',
      });
      store.channels.upsertCursor(room.id, builder.id, first.rowid, first.message.id);

      store.channels.postMessage({
        channelId: room.id,
        author: 'agent',
        agentId: qa.id,
        text: 'New QA finding after cursor',
        metadata: { mentions: [builder.id] },
      });
      const trigger = store.channels.postMessage({
        channelId: room.id,
        author: 'user',
        agentId: null,
        text: '@Builder fix QA finding',
      });

      const resumed = new RoomContextBuilder(store.channels).build({
        channel: room,
        agent: builder,
        project,
        projectAgents: agents,
        allAgents: agents,
        tasks: [],
        triggerMessage: trigger.message,
        currentPrompt: trigger.message.text,
        hasResumeSession: true,
      });

      expect(resumed.usedDelta).toBe(true);
      expect(resumed.fullPrompt).toContain('Since your last turn in the room:');
      expect(resumed.fullPrompt).toContain('New QA finding after cursor');
      expect(resumed.fullPrompt).not.toContain('Old builder message before cursor');

      // DM channel gets project task digest
      store.createTask(project.id, { title: 'Polish footer', assigneeAgentId: builder.id, status: 'in_progress' });
      const dm = store.channels.getDmByAgent(builder.id)!;
      const dmCtx = new RoomContextBuilder(store.channels).build({
        channel: dm,
        agent: builder,
        project: null,
        projectAgents: [builder],
        allAgents: agents,
        tasks: store.listProjectTasks(project.id),
        triggerMessage: null,
        currentPrompt: 'How is work going?',
        hasResumeSession: false,
      });
      expect(dmCtx.fullPrompt).toContain('Project work digest for Builder:');
      expect(dmCtx.fullPrompt).toContain('AT-1 [in_progress] "Polish footer"');
    } finally {
      db.close();
    }
  });
});
