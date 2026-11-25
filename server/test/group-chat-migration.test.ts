import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGroupChatMigration, planGroupChatMigration } from '../src/channels/migration.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function seedLegacyDb(dbPath: string): DatabaseSync {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE activities (id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
  `);
  sqlite.prepare(`INSERT INTO settings (id, data) VALUES (1, ?)`).run(JSON.stringify({ provider: 'claude', model: 'sonnet' }));
  sqlite.prepare(`INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)`).run(
    'prj_1',
    '2026-11-25T08:00:00.000Z',
    JSON.stringify({ id: 'prj_1', name: 'Landing', agentIds: ['agt_a', 'agt_b', 'agt_c'] }),
  );
  for (const [id, name, role] of [
    ['agt_a', 'Lead', 'Chief of Staff'],
    ['agt_b', 'Builder', 'Frontend'],
    ['agt_c', 'QA', 'QA'],
  ]) {
    sqlite.prepare(`INSERT INTO agents (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`).run(
      id,
      'prj_1',
      '2026-11-25T08:00:01.000Z',
      JSON.stringify({
        id,
        projectId: 'prj_1',
        name,
        role,
        sessions: { prj_1: `ses_${id}`, direct: `dm_${id}` },
        contextCompactions: {
          prj_1: {
            summary: `Summary from ${name}`,
            lastCompactedMessageId: 'msg_old',
            compactedAt: '2026-11-25T08:00:05.000Z',
            compactedMessageCount: 5,
          },
        },
      }),
    );
  }
  return sqlite;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Group chat migration (§10.2)', () => {
  it('dry-run produces an accurate plan without mutating the SQLite file', () => {
    const dir = makeTempDir('atelier-mig-dry-');
    const dbPath = path.join(dir, 'atelier.db');
    const sqlite = seedLegacyDb(dbPath);
    const ins = sqlite.prepare(`INSERT INTO messages (id, project_id, agent_id, created_at, data) VALUES (?, ?, ?, ?, ?)`);
    for (const [id, agt, ts] of [
      ['msg_u1', 'agt_a', '2026-11-25T09:00:00.000Z'],
      ['msg_u2', 'agt_b', '2026-11-25T09:00:00.500Z'],
      ['msg_u3', 'agt_c', '2026-11-25T09:00:01.000Z'],
    ]) {
      ins.run(
        id,
        'prj_1',
        agt,
        ts,
        JSON.stringify({ id, projectId: 'prj_1', agentId: agt, author: 'user', text: '@all hello', streaming: false, durationMs: null, createdAt: ts }),
      );
    }
    sqlite.close();

    const hashBefore = sha256File(dbPath);
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const plan = planGroupChatMigration(ro);
      expect(plan.rooms).toBe(1);
      expect(plan.dms).toBe(3);
      expect(plan.messagesIn).toBe(3);
      expect(plan.messagesOut).toBe(1);
      expect(plan.dropped).toBe(2);
      expect(plan.merges).toHaveLength(1);
      expect(plan.merges[0]!.keep).toBe('msg_u1');
    } finally {
      ro.close();
    }
    expect(sha256File(dbPath)).toBe(hashBefore);
  });

  it('dedupes fanout, preserves intentional same-agent repeats, handles paired/unpaired teammate msgs, keeps DMs intact, and writes backup', () => {
    const dir = makeTempDir('atelier-mig-apply-');
    const dbPath = path.join(dir, 'atelier.db');
    const sqlite = seedLegacyDb(dbPath);
    const ins = sqlite.prepare(`INSERT INTO messages (id, project_id, agent_id, created_at, data) VALUES (?, ?, ?, ?, ?)`);
    const insAct = sqlite.prepare(`INSERT INTO activities (id, project_id, agent_id, created_at, data) VALUES (?, ?, ?, ?, ?)`);

    // Fanout across 3 agents -> merge to 1
    ins.run('msg_f1', 'prj_1', 'agt_a', '2026-11-25T09:00:00.000Z', JSON.stringify({ id: 'msg_f1', projectId: 'prj_1', agentId: 'agt_a', author: 'user', text: 'Ship AT-1', streaming: false, durationMs: null, createdAt: '2026-11-25T09:00:00.000Z' }));
    ins.run('msg_f2', 'prj_1', 'agt_b', '2026-11-25T09:00:00.400Z', JSON.stringify({ id: 'msg_f2', projectId: 'prj_1', agentId: 'agt_b', author: 'user', text: 'Ship AT-1', streaming: false, durationMs: null, createdAt: '2026-11-25T09:00:00.400Z' }));
    ins.run('msg_f3', 'prj_1', 'agt_c', '2026-11-25T09:00:00.800Z', JSON.stringify({ id: 'msg_f3', projectId: 'prj_1', agentId: 'agt_c', author: 'user', text: 'Ship AT-1', streaming: false, durationMs: null, createdAt: '2026-11-25T09:00:00.800Z' }));

    // Same agent twice within 1s -> NOT fanout, keep both
    ins.run('msg_s1', 'prj_1', 'agt_b', '2026-11-25T09:05:00.000Z', JSON.stringify({ id: 'msg_s1', projectId: 'prj_1', agentId: 'agt_b', author: 'user', text: 'ping', streaming: false, durationMs: null, createdAt: '2026-11-25T09:05:00.000Z' }));
    ins.run('msg_s2', 'prj_1', 'agt_b', '2026-11-25T09:05:00.500Z', JSON.stringify({ id: 'msg_s2', projectId: 'prj_1', agentId: 'agt_b', author: 'user', text: 'ping', streaming: false, durationMs: null, createdAt: '2026-11-25T09:05:00.500Z' }));

    // Paired teammate message + reply
    insAct.run('act_1', 'prj_1', 'agt_a', '2026-11-25T09:06:00.000Z', JSON.stringify({ id: 'act_1', projectId: 'prj_1', agentId: 'agt_a', kind: 'tool', label: 'atelier.message_agent', detail: JSON.stringify({ targetAgentId: 'agt_b' }), createdAt: '2026-11-25T09:06:00.000Z' }));
    ins.run('msg_tm1', 'prj_1', 'agt_b', '2026-11-25T09:06:01.000Z', JSON.stringify({ id: 'msg_tm1', projectId: 'prj_1', agentId: 'agt_b', author: 'teammate', text: 'Message from Lead: Check header', streaming: false, durationMs: null, createdAt: '2026-11-25T09:06:01.000Z' }));
    ins.run('msg_b_reply', 'prj_1', 'agt_b', '2026-11-25T09:06:10.000Z', JSON.stringify({ id: 'msg_b_reply', projectId: 'prj_1', agentId: 'agt_b', author: 'agent', text: 'Header looks good.', streaming: false, durationMs: 100, createdAt: '2026-11-25T09:06:10.000Z' }));
    ins.run('msg_tm_rep', 'prj_1', 'agt_a', '2026-11-25T09:06:11.000Z', JSON.stringify({ id: 'msg_tm_rep', projectId: 'prj_1', agentId: 'agt_a', author: 'teammate', text: 'Builder replied: Header looks good.', streaming: false, durationMs: null, createdAt: '2026-11-25T09:06:11.000Z' }));

    // Unpaired teammate reply -> kept, not dropped
    ins.run('msg_tm_unp', 'prj_1', 'agt_a', '2026-11-25T09:08:00.000Z', JSON.stringify({ id: 'msg_tm_unp', projectId: 'prj_1', agentId: 'agt_a', author: 'teammate', text: 'QA replied: Orphan note', streaming: false, durationMs: null, createdAt: '2026-11-25T09:08:00.000Z' }));

    // Global DM -> untouched
    ins.run('msg_dm', null, 'agt_b', '2026-11-25T09:10:00.000Z', JSON.stringify({ id: 'msg_dm', projectId: null, agentId: 'agt_b', author: 'user', text: 'DM hello', streaming: false, durationMs: null, createdAt: '2026-11-25T09:10:00.000Z' }));

    let plan: ReturnType<typeof applyGroupChatMigration>;
    try {
      plan = applyGroupChatMigration(sqlite, { dataDir: dir });
      expect(plan).not.toBeNull();
      expect(plan!.dropped).toBe(3); // 2 fanout + 1 paired teammate reply

      const backupDir = path.join(dir, 'backup');
      expect(fs.readdirSync(backupDir).some((f) => f.startsWith('pre-group-chat-'))).toBe(true);

      const droppedCount = (sqlite.prepare(`SELECT COUNT(*) AS cnt FROM messages_migrated_dropped`).get() as { cnt: number }).cnt;
      expect(droppedCount).toBe(3);

      // Same-agent repeats both survived
      const pingCount = (sqlite.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE json_extract(data, '$.text') = 'ping'`).get() as { cnt: number }).cnt;
      expect(pingCount).toBe(2);

      // Unpaired teammate message survived
      const unpRow = sqlite.prepare(`SELECT data FROM messages WHERE id = 'msg_tm_unp'`).get() as { data: string } | undefined;
      expect(unpRow).toBeDefined();

      // Direct session preserved while project session cleared
      const agtB = JSON.parse((sqlite.prepare(`SELECT data FROM agents WHERE id = 'agt_b'`).get() as { data: string }).data) as { sessions?: Record<string, string> };
      expect(agtB.sessions?.direct).toBe('dm_agt_b');
      expect(agtB.sessions?.prj_1).toBeUndefined();

      // DM message lives in DM channel
      const dmMsg = JSON.parse((sqlite.prepare(`SELECT data FROM messages WHERE id = 'msg_dm'`).get() as { data: string }).data) as { channelId?: string };
      const dmCh = sqlite.prepare(`SELECT id FROM channels WHERE agent_id = 'agt_b' AND kind = 'dm'`).get() as { id: string };
      expect(dmMsg.channelId).toBe(dmCh.id);
    } finally {
      sqlite.close();
    }
  });
});
