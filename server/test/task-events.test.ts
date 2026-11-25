import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('Task events in room & dependency cycle protection (§4.5 & §10.6)', () => {
  it('posts task_created and task_status system events to the project room and rejects dependency cycles', () => {
    const dir = makeTempDir('atelier-task-events-');
    const dbPath = path.join(dir, 'atelier.db');
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
      const { project, agents } = store.createProject({
        name: 'Task Room',
        starterAgents: [{ name: 'Builder', role: 'Dev' }],
      });
      const builder = agents[0]!;
      const room = store.channels.getRoomByProject(project.id)!;

      const t1 = store.createTask(project.id, {
        title: 'Build hero',
        assigneeAgentId: builder.id,
        status: 'todo',
      })!;
      const t2 = store.createTask(project.id, {
        title: 'QA hero',
        blockedBy: [t1.id],
        status: 'todo',
      })!;

      store.updateTask(t1.id, { status: 'done', prUrl: 'https://github.com/org/repo/pull/12' });

      const roomMsgs = store.channels.listChannelMessages(room.id).messages;
      expect(
        roomMsgs.some(
          (m) =>
            m.author === 'system' &&
            m.metadata?.event?.kind === 'task_created' &&
            m.text.includes('AT-1') &&
            m.text.includes('@Builder'),
        ),
      ).toBe(true);
      expect(
        roomMsgs.some(
          (m) =>
            m.author === 'system' &&
            m.metadata?.event?.kind === 'task_status' &&
            m.text.includes('AT-1 → done') &&
            m.text.includes('pull/12'),
        ),
      ).toBe(true);

      // Circular dependency t1 -> blockedBy t2 (while t2 -> blockedBy t1) must throw
      expect(() => store.updateTask(t1.id, { blockedBy: [t2.id] })).toThrow(/Circular task dependency/);
    } finally {
      db.close();
    }
  });
});
