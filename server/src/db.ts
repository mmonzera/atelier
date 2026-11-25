import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyGroupChatMigration } from './channels/migration.js';

export class AtelierDb {
  public readonly sqlite: DatabaseSync;
  /** Naik setiap kali isi tabel diganti dari luar (restore backup) sehingga index memory harus dibangun ulang. */
  public memoryGeneration = 0;
  public readonly hasMemoryFts: boolean;
  public readonly hasMessageFts: boolean;
  private backfill?: NodeJS.Immediate;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.initSchema(path.dirname(dbPath));
    this.hasMessageFts = this.initMessageFts();
    this.hasMemoryFts = this.initMemoryFts();
  }

  private initSchema(dataDir?: string): void {
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
        channel_id TEXT,
        project_id TEXT,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canon (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_canon_project ON canon(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_active_key
        ON canon(json_extract(data, '$.scopeKey'), json_extract(data, '$.key'))
        WHERE json_extract(data, '$.supersededBy') IS NULL;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL,
        content BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);

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

      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_credentials (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        secret BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_chunks (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        text TEXT,
        audio_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (meeting_id, seq)
      );

      -- One row per transcribed sentence, on the recording timeline (pauses excluded).
      CREATE TABLE IF NOT EXISTS meeting_segments (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        side TEXT,
        speaker_id TEXT,
        PRIMARY KEY (meeting_id, seq, idx)
      );

      CREATE TABLE IF NOT EXISTS meeting_speakers (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT,
        color TEXT NOT NULL,
        is_me INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (meeting_id, id)
      );

      -- Machine-local tables: never exported in backups, never overwritten on import.
      -- Proyeksi (cache) dari Canon, ringkasan, task, dan artifact. Selalu bisa dibangun ulang.
      CREATE TABLE IF NOT EXISTS memory_items (
        id         TEXT PRIMARY KEY,
        scope_key  TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        owner      TEXT NOT NULL DEFAULT '',
        source     TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        pinned     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_source ON memory_items(source, source_id);
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_items(scope_key, source);

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
    applyGroupChatMigration(this.sqlite, { dataDir });
    this.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_messages_scope_agent ON messages(project_id, agent_id, created_at)');
    this.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at)');
    // Chunks recorded before timestamps existed have no position on the timeline.
    this.ensureColumn('room_sessions', 'name', 'TEXT');
    this.ensureColumn('meeting_chunks', 'start_ms', 'INTEGER');
    this.ensureColumn('meeting_chunks', 'energy_path', 'TEXT');
    this.ensureColumn('agent_queue', 'channel_id', 'TEXT');
    this.ensureColumn('agent_queue', 'trigger_rowid', 'INTEGER');
    this.ensureColumn('agent_queue', 'mention_index', 'INTEGER');
    this.ensureColumn('agent_queue', 'manual_order', 'INTEGER');
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private initMessageFts(): boolean {
    try {
      this.sqlite.exec('CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, scope UNINDEXED)');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('no such module: fts5')) throw err;
      console.warn('SQLite FTS5 unavailable; memory search uses the recent archive window.');
      return false;
    }
    const insert = `
      INSERT INTO messages_fts(rowid, text, message_id, scope)
      SELECT new.rowid, json_extract(new.data, '$.text'), new.id, coalesce(new.project_id, 'direct')
      WHERE coalesce(json_extract(new.data, '$.streaming'), 0) = 0
        AND coalesce(json_extract(new.data, '$.metadata.compacted'), 0) = 0;
    `;
    this.sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        ${insert}
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
      WHEN coalesce(json_extract(old.data, '$.streaming'), 0) = 0
        OR coalesce(json_extract(new.data, '$.streaming'), 0) = 0
      BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        ${insert}
      END;
    `);
    let cursor = 0;
    const nextBatch = () => {
      const rows = this.sqlite.prepare('SELECT rowid FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 250')
        .all(cursor) as { rowid: number }[];
      const next = rows.at(-1)?.rowid;
      if (next === undefined) return;
      this.sqlite.prepare(`
        INSERT INTO messages_fts(rowid, text, message_id, scope)
        SELECT m.rowid, json_extract(m.data, '$.text'), m.id, coalesce(m.project_id, 'direct')
        FROM messages m WHERE m.rowid > ? AND m.rowid <= ?
          AND coalesce(json_extract(m.data, '$.streaming'), 0) = 0
          AND coalesce(json_extract(m.data, '$.metadata.compacted'), 0) = 0
          AND NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.rowid = m.rowid)
      `).run(cursor, next);
      cursor = next;
      if (rows.length === 250) this.backfill = setImmediate(nextBatch).unref();
    };
    this.backfill = setImmediate(nextBatch).unref();
    return true;
  }

  private initMemoryFts(): boolean {
    try {
      this.sqlite.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')`,
      );
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('no such module: fts5')) throw err;
      return false;
    }
    this.sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_items_fts_delete AFTER DELETE ON memory_items BEGIN
        DELETE FROM memory_fts WHERE rowid = old.rowid;
      END;
    `);
    return true;
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
    if (this.backfill) clearImmediate(this.backfill);
    this.sqlite.close();
  }
}
