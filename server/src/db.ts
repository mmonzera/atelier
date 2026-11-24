import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class AtelierDb {
  public readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_oauth (
        server_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_secrets (
        provider TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        port INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_queue (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        project_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at
        ON usage_logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS qa_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_qa_runs_project_created
        ON qa_runs(project_id, created_at DESC);

      -- Machine-local tables: never exported in backups, never overwritten on import.
      CREATE TABLE IF NOT EXISTS app_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backup_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `);

    this.migrateGlobalAgentsSchema();
  }

  private migrateGlobalAgentsSchema(): void {
    const agentsMeta = this.sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'`)
      .get() as { sql?: string } | undefined;

    if (!agentsMeta?.sql || !/project_id\s+TEXT\s+NOT\s+NULL/i.test(agentsMeta.sql)) {
      return;
    }

    this.sqlite.exec('PRAGMA foreign_keys = OFF;');
    this.sqlite.exec('BEGIN;');
    try {
      this.sqlite.exec(`
        CREATE TABLE agents_new (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        INSERT INTO agents_new (id, project_id, created_at, data)
        SELECT id, project_id, created_at, data FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;

        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        INSERT INTO messages_new (id, project_id, agent_id, created_at, data)
        SELECT id, project_id, agent_id, created_at, data FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;

        CREATE TABLE activities_new (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        INSERT INTO activities_new (id, project_id, agent_id, created_at, data)
        SELECT id, project_id, agent_id, created_at, data FROM activities;
        DROP TABLE activities;
        ALTER TABLE activities_new RENAME TO activities;

        CREATE TABLE agent_queue_new (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          project_id TEXT,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        INSERT INTO agent_queue_new (seq, id, agent_id, project_id, created_at, data)
        SELECT seq, id, agent_id, project_id, created_at, data FROM agent_queue;
        DROP TABLE agent_queue;
        ALTER TABLE agent_queue_new RENAME TO agent_queue;
      `);

      const projects = this.sqlite
        .prepare(`SELECT id, data FROM projects`)
        .all() as Array<{ id: string; data: string }>;
      for (const p of projects) {
        const parsed = JSON.parse(p.data) as Record<string, unknown>;
        if (!Array.isArray(parsed.agentIds)) {
          const rows = this.sqlite
            .prepare(`SELECT id FROM agents WHERE project_id = ? ORDER BY created_at ASC`)
            .all(p.id) as Array<{ id: string }>;
          parsed.agentIds = rows.map((r) => r.id);
          this.sqlite
            .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
            .run(JSON.stringify(parsed), p.id);
        }
      }

      this.sqlite.exec('COMMIT;');
    } catch (err) {
      this.sqlite.exec('ROLLBACK;');
      throw err;
    } finally {
      this.sqlite.exec('PRAGMA foreign_keys = ON;');
    }
  }

  public close(): void {
    this.sqlite.close();
  }
}
