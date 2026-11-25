import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Channel, Message, RoomSession, ThreadCompaction } from '@atelier/contracts';

export const GROUP_CHAT_SCHEMA_VERSION = 2;

export interface MigrationMergePlan {
  keep: string;
  drop: string[];
  rule: 'mention-fanout';
}

export interface MigrationConversionPlan {
  id: string;
  rule: 'teammate-paired' | 'teammate-unpaired' | 'teammate-reply-drop';
  fromAgent: string | null;
}

export interface MigrationUncertainItem {
  id: string;
  possibleDuplicateOf: string;
  reason: string;
}

export interface GroupChatMigrationPlan {
  rooms: number;
  dms: number;
  messagesIn: number;
  messagesOut: number;
  dropped: number;
  merges: MigrationMergePlan[];
  conversions: MigrationConversionPlan[];
  uncertain: MigrationUncertainItem[];
}

interface RawRow {
  rowid: number;
  id: string;
  project_id: string | null;
  agent_id: string | null;
  channel_id?: string | null;
  session_id?: string | null;
  created_at: string;
  data: string;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tableColumns(sqlite: DatabaseSync, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function tableExists(sqlite: DatabaseSync, table: string): boolean {
  const row = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function attachmentsEqual(a: Message, b: Message): boolean {
  const attA = a.metadata?.attachments ?? [];
  const attB = b.metadata?.attachments ?? [];
  if (attA.length !== attB.length) return false;
  return JSON.stringify(attA) === JSON.stringify(attB);
}

function ensureGroupChatTables(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_room ON channels(project_id) WHERE kind = 'room';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm   ON channels(agent_id)   WHERE kind = 'dm';

    CREATE TABLE IF NOT EXISTS channel_cursors (
      channel_id           TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      agent_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      last_seen_message_id TEXT,
      last_seen_rowid      INTEGER,
      PRIMARY KEY (channel_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS room_sessions (
      id               TEXT PRIMARY KEY,
      channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      seq              INTEGER NOT NULL,
      started_at       TEXT NOT NULL,
      started_by       TEXT NOT NULL,
      carryover_summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_room_sessions_channel ON room_sessions(channel_id, seq);

    CREATE TABLE IF NOT EXISTS room_chains (
      root_message_id TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      turns_used      INTEGER NOT NULL DEFAULT 0,
      tokens_used     INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',
      max_turns       INTEGER NOT NULL DEFAULT 12,
      max_tokens      INTEGER NOT NULL DEFAULT 150000,
      warned          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages_migrated_dropped (
      id         TEXT PRIMARY KEY,
      project_id TEXT,
      agent_id   TEXT,
      created_at TEXT NOT NULL,
      rule       TEXT NOT NULL,
      kept_id    TEXT,
      data       TEXT NOT NULL
    );
  `);
}

interface ParsedMessageRow {
  rowid: number;
  id: string;
  projectId: string | null;
  agentId: string | null;
  createdAt: string;
  msg: Message;
}

interface ComputedMigration {
  plan: GroupChatMigrationPlan;
  projects: Array<{ id: string; name: string; agentIds: string[] }>;
  agents: Array<{ id: string; name: string; role: string; projectId: string | null; raw: Record<string, unknown> }>;
  kept: Array<{
    row: ParsedMessageRow;
    updatedMsg: Message;
  }>;
  droppedRows: Array<{
    row: ParsedMessageRow;
    rule: string;
    keptId: string | null;
  }>;
}

function computeMigration(sqlite: DatabaseSync): ComputedMigration {
  const projectRows = sqlite
    .prepare(`SELECT id, created_at, data FROM projects ORDER BY created_at ASC`)
    .all() as Array<{ id: string; created_at: string; data: string }>;
  const projects = projectRows.map((r) => {
    const d = JSON.parse(r.data) as { name?: string; agentIds?: string[] };
    return {
      id: r.id,
      name: d.name || 'Project',
      agentIds: Array.isArray(d.agentIds) ? d.agentIds : [],
    };
  });

  const agentRows = sqlite
    .prepare(`SELECT id, project_id, created_at, data FROM agents ORDER BY created_at ASC`)
    .all() as Array<{ id: string; project_id: string | null; created_at: string; data: string }>;
  const agents = agentRows.map((r) => {
    const raw = JSON.parse(r.data) as Record<string, unknown>;
    return {
      id: r.id,
      name: typeof raw.name === 'string' ? raw.name : 'Agent',
      role: typeof raw.role === 'string' ? raw.role : '',
      projectId: r.project_id,
      raw,
    };
  });

  const cols = tableColumns(sqlite, 'messages');
  const selectSql = cols.has('channel_id')
    ? `SELECT rowid, id, project_id, agent_id, channel_id, session_id, created_at, data FROM messages ORDER BY created_at ASC, rowid ASC`
    : `SELECT rowid, id, project_id, agent_id, created_at, data FROM messages ORDER BY created_at ASC, rowid ASC`;
  const rawMsgs = sqlite.prepare(selectSql).all() as unknown as RawRow[];

  const parsedRows: ParsedMessageRow[] = rawMsgs.map((r) => {
    const msg = JSON.parse(r.data) as Message;
    return {
      rowid: r.rowid,
      id: r.id,
      projectId: r.project_id ?? msg.projectId ?? null,
      agentId: r.agent_id ?? msg.agentId ?? null,
      createdAt: r.created_at || msg.createdAt,
      msg,
    };
  });

  // Load activities to detect paired message_agent calls
  const activityRows = tableExists(sqlite, 'activities')
    ? (sqlite
        .prepare(`SELECT agent_id, project_id, created_at, data FROM activities`)
        .all() as Array<{ agent_id: string; project_id: string | null; created_at: string; data: string }>)
    : [];
  const messageAgentActivities = activityRows
    .map((r) => {
      try {
        const d = JSON.parse(r.data) as { label?: string; detail?: string };
        if (d.label !== 'atelier.message_agent') return null;
        let targetAgentId: string | null = null;
        if (d.detail) {
          try {
            const parsedDetail = JSON.parse(d.detail) as { targetAgentId?: string };
            targetAgentId = parsedDetail.targetAgentId ?? null;
          } catch {
            // ignore
          }
        }
        return {
          agentId: r.agent_id,
          projectId: r.project_id,
          createdAtMs: Date.parse(r.created_at),
          targetAgentId,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentByNameLower = new Map<string, (typeof agents)[number]>();
  for (const a of agents) {
    agentByNameLower.set(a.name.trim().toLowerCase(), a);
  }

  const droppedIds = new Map<string, { rule: string; keptId: string | null }>();
  const merges: MigrationMergePlan[] = [];
  const conversions: MigrationConversionPlan[] = [];
  const uncertain: MigrationUncertainItem[] = [];
  const updatedOverrides = new Map<string, Partial<Message>>();

  // 1. Strict fanout dedupe for project user messages
  const projectUserMsgs = parsedRows.filter(
    (r) => r.projectId !== null && r.msg.author === 'user' && !r.msg.channelId,
  );
  const visitedUserIds = new Set<string>();
  for (let i = 0; i < projectUserMsgs.length; i += 1) {
    const anchor = projectUserMsgs[i]!;
    if (visitedUserIds.has(anchor.id)) continue;
    const anchorMs = Date.parse(anchor.createdAt);
    const group: ParsedMessageRow[] = [anchor];
    const seenAgents = new Set<string>(anchor.agentId ? [anchor.agentId] : []);

    for (let j = i + 1; j < projectUserMsgs.length; j += 1) {
      const cand = projectUserMsgs[j]!;
      if (visitedUserIds.has(cand.id)) continue;
      if (cand.projectId !== anchor.projectId) continue;
      const diffMs = Math.abs(Date.parse(cand.createdAt) - anchorMs);
      if (diffMs > 2000) continue;

      if (
        cand.msg.text === anchor.msg.text &&
        attachmentsEqual(cand.msg, anchor.msg)
      ) {
        if (cand.agentId && !seenAgents.has(cand.agentId) && group.length < 5) {
          seenAgents.add(cand.agentId);
          group.push(cand);
        } else if (cand.agentId && seenAgents.has(cand.agentId)) {
          // Same agent twice: NOT a fanout duplicate, keep both
          continue;
        }
      } else if (
        cand.agentId &&
        cand.agentId !== anchor.agentId &&
        normalizeText(cand.msg.text) === normalizeText(anchor.msg.text)
      ) {
        // Near-duplicate (whitespace differs): mark uncertain and keep
        uncertain.push({
          id: cand.id,
          possibleDuplicateOf: anchor.id,
          reason: 'whitespace-normalized-match',
        });
        updatedOverrides.set(cand.id, {
          metadata: {
            ...cand.msg.metadata,
            migration: { possibleDuplicateOf: anchor.id, rule: 'uncertain' },
          },
        });
      }
    }

    if (group.length > 1) {
      for (const item of group) visitedUserIds.add(item.id);
      const dropIds = group.slice(1).map((g) => g.id);
      const mentions = Array.from(
        new Set(group.map((g) => g.agentId).filter((id): id is string => Boolean(id))),
      );
      updatedOverrides.set(anchor.id, {
        agentId: null,
        metadata: {
          ...anchor.msg.metadata,
          mentions,
          toAgentIds: mentions,
        },
      });
      for (const id of dropIds) {
        droppedIds.set(id, { rule: 'mention-fanout', keptId: anchor.id });
      }
      merges.push({ keep: anchor.id, drop: dropIds, rule: 'mention-fanout' });
    }
  }

  // 2. Paired teammate conversion inside projects
  const projectAgentReplies = parsedRows.filter(
    (r) => r.projectId !== null && r.msg.author === 'agent',
  );
  for (const row of parsedRows) {
    if (row.projectId === null || row.msg.author !== 'teammate' || row.msg.channelId) continue;
    const replyMatch = /^(.+?)\s+replied:\s*([\s\S]+)$/.exec(row.msg.text);
    if (replyMatch) {
      const senderName = replyMatch[1]!.trim();
      const body = replyMatch[2]!.trim();
      const senderAgent = agentByNameLower.get(senderName.toLowerCase()) ?? null;
      const pairedReply = projectAgentReplies.find(
        (r) =>
          r.projectId === row.projectId &&
          (!senderAgent || r.agentId === senderAgent.id) &&
          r.msg.text.trim() === body &&
          Math.abs(Date.parse(r.createdAt) - Date.parse(row.createdAt)) <= 5 * 60_000,
      );
      if (pairedReply) {
        droppedIds.set(row.id, { rule: 'teammate-reply-drop', keptId: pairedReply.id });
        conversions.push({
          id: row.id,
          rule: 'teammate-reply-drop',
          fromAgent: senderAgent?.id ?? null,
        });
        continue;
      }
      // Unpaired: keep as agent/system note without deleting
      updatedOverrides.set(row.id, {
        author: senderAgent ? 'agent' : 'system',
        agentId: senderAgent?.id ?? null,
        metadata: {
          ...row.msg.metadata,
          migration: { rule: 'teammate-unpaired' },
        },
      });
      conversions.push({
        id: row.id,
        rule: 'teammate-unpaired',
        fromAgent: senderAgent?.id ?? null,
      });
      continue;
    }

    const msgMatch = /^Message from\s+([^:]+):\s*([\s\S]+)$/.exec(row.msg.text);
    if (msgMatch) {
      const senderName = msgMatch[1]!.trim();
      const body = msgMatch[2]!.trim();
      const senderAgent = agentByNameLower.get(senderName.toLowerCase()) ?? null;
      const targetId = row.agentId;
      const rowMs = Date.parse(row.createdAt);
      const hasActivityPair =
        senderAgent &&
        messageAgentActivities.some(
          (a) =>
            a.agentId === senderAgent.id &&
            a.projectId === row.projectId &&
            Math.abs(a.createdAtMs - rowMs) <= 5 * 60_000 &&
            (!a.targetAgentId || a.targetAgentId === targetId || a.targetAgentId === agentById.get(targetId ?? '')?.name),
        );
      const rule = hasActivityPair ? 'teammate-paired' : 'teammate-unpaired';
      const mentions = targetId ? [targetId] : undefined;
      updatedOverrides.set(row.id, {
        author: senderAgent ? 'agent' : 'system',
        agentId: senderAgent?.id ?? null,
        text: body,
        metadata: {
          ...row.msg.metadata,
          ...(mentions ? { mentions, toAgentIds: mentions } : {}),
          migration: { rule },
        },
      });
      conversions.push({ id: row.id, rule, fromAgent: senderAgent?.id ?? null });
    }
  }

  const kept: ComputedMigration['kept'] = [];
  const droppedRows: ComputedMigration['droppedRows'] = [];
  for (const row of parsedRows) {
    const droppedInfo = droppedIds.get(row.id);
    if (droppedInfo) {
      droppedRows.push({ row, ...droppedInfo });
      continue;
    }
    const override = updatedOverrides.get(row.id);
    const updatedMsg: Message = {
      ...row.msg,
      ...override,
      agentId:
        override && 'agentId' in override
          ? override.agentId ?? null
          : row.projectId !== null && row.msg.author === 'user'
            ? null
            : row.msg.agentId,
    };
    kept.push({ row, updatedMsg });
  }

  return {
    plan: {
      rooms: projects.length,
      dms: agents.length,
      messagesIn: parsedRows.length,
      messagesOut: kept.length,
      dropped: droppedRows.length,
      merges,
      conversions,
      uncertain,
    },
    projects,
    agents,
    kept,
    droppedRows,
  };
}

/** Read-only dry-run plan for converting legacy per-agent threads into project rooms. */
export function planGroupChatMigration(sqlite: DatabaseSync): GroupChatMigrationPlan {
  return computeMigration(sqlite).plan;
}

/**
 * Thrown when the group-chat migration cannot run safely. The database is left exactly as it was
 * (the transaction is rolled back, or nothing was started), so fixing the cause and restarting
 * retries the migration.
 */
export class GroupChatMigrationError extends Error {
  constructor(
    message: string,
    public readonly backupPath: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GroupChatMigrationError';
  }
}

function writePreMigrationBackup(sqlite: DatabaseSync, dataDir: string): string | null {
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `pre-group-chat-${stamp}.sqlite`);
  try {
    sqlite.exec(`VACUUM INTO ${sqlString(target)}`);
    return target;
  } catch {
    return null;
  }
}

function mergeProjectCompactions(
  agents: ComputedMigration['agents'],
  projectId: string,
): ThreadCompaction | null {
  const summaries: string[] = [];
  let maxMsgCount = 0;
  let latestAt = '';
  let latestId: string | null = null;
  for (const a of agents) {
    const map = a.raw.contextCompactions as Record<string, ThreadCompaction> | undefined;
    const comp = map?.[projectId];
    if (!comp || !comp.summary?.trim()) continue;
    summaries.push(`[${a.name}] ${comp.summary.trim()}`);
    if (comp.compactedMessageCount > maxMsgCount) maxMsgCount = comp.compactedMessageCount;
    if (comp.compactedAt > latestAt) {
      latestAt = comp.compactedAt;
      latestId = comp.lastCompactedMessageId;
    }
  }
  if (summaries.length === 0) return null;
  const combined =
    summaries.length === 1
      ? summaries[0]!
      : `Combined from ${summaries.length} agent threads:\n${summaries.join('\n\n')}`;
  return {
    summary: combined.slice(0, 6000),
    lastCompactedMessageId: latestId ?? '',
    compactedAt: latestAt || new Date().toISOString(),
    compactedMessageCount: maxMsgCount,
  };
}

function isUserVersionAtLeast(sqlite: DatabaseSync, version: number): boolean {
  const row = sqlite.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0) >= version;
}

/**
 * Safely migrates an Atelier SQLite DB to the Group Chat (`channels`, `room_sessions`,
 * `channel_cursors`, nullable `messages.agent_id`) schema inside a single transaction.
 */
export function applyGroupChatMigration(
  sqlite: DatabaseSync,
  opts?: { dataDir?: string; forceReconcile?: boolean },
): GroupChatMigrationPlan | null {
  const alreadyMigrated =
    !opts?.forceReconcile &&
    isUserVersionAtLeast(sqlite, GROUP_CHAT_SCHEMA_VERSION) &&
    tableExists(sqlite, 'channels');
  if (alreadyMigrated) {
    return null;
  }

  const msgCols = tableColumns(sqlite, 'messages');
  const hasAnyMessages =
    (sqlite.prepare(`SELECT COUNT(*) AS cnt FROM messages`).get() as { cnt: number }).cnt > 0;
  const needsRebuild =
    !msgCols.has('channel_id') ||
    !msgCols.has('session_id') ||
    (() => {
      const mSql = sqlite
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
        .get() as { sql?: string } | undefined;
      return Boolean(mSql?.sql && /agent_id\s+TEXT\s+NOT\s+NULL/i.test(mSql.sql));
    })();

  let backupPath: string | null = null;
  if (hasAnyMessages && opts?.dataDir && !opts?.forceReconcile) {
    backupPath = writePreMigrationBackup(sqlite, opts.dataDir);
    if (!backupPath) {
      // Never migrate real chat history without a restorable copy.
      throw new GroupChatMigrationError(
        'Group chat migration aborted: could not write the pre-migration backup. Your data was not changed. Free disk space or check permissions on the data folder, then restart.',
      );
    }
  }

  let computed: ComputedMigration;
  try {
    computed = computeMigration(sqlite);
  } catch (err) {
    // Planning only reads; nothing has been written yet.
    throw new GroupChatMigrationError(
      `Group chat migration could not read your existing chats; your data was not changed.${
        backupPath ? ` A pre-migration backup is at ${backupPath}.` : ''
      } Cause: ${err instanceof Error ? err.message : String(err)}`,
      backupPath,
      { cause: err },
    );
  }
  const now = new Date().toISOString();

  sqlite.exec('PRAGMA foreign_keys = OFF;');
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    ensureGroupChatTables(sqlite);

    // Ensure 1 room + initial session per project
    const roomByProject = new Map<string, Channel>();
    const sessionByChannel = new Map<string, RoomSession>();
    for (const proj of computed.projects) {
      const existingRow = sqlite
        .prepare(`SELECT data FROM channels WHERE project_id = ? AND kind = 'room'`)
        .get(proj.id) as { data: string } | undefined;
      if (existingRow) {
        const ch = JSON.parse(existingRow.data) as Channel;
        roomByProject.set(proj.id, ch);
        if (ch.currentSessionId) {
          const sRow = sqlite
            .prepare(`SELECT id, channel_id, seq, started_at, started_by, carryover_summary FROM room_sessions WHERE id = ?`)
            .get(ch.currentSessionId) as
            | {
                id: string;
                channel_id: string;
                seq: number;
                started_at: string;
                started_by: 'user' | 'system';
                carryover_summary: string | null;
              }
            | undefined;
          if (sRow) {
            sessionByChannel.set(ch.id, {
              id: sRow.id,
              channelId: sRow.channel_id,
              seq: sRow.seq,
              startedAt: sRow.started_at,
              startedBy: sRow.started_by,
              carryoverSummary: sRow.carryover_summary,
            });
          }
        }
        continue;
      }

      const projAgents = computed.agents.filter((a) => proj.agentIds.includes(a.id) || a.projectId === proj.id);
      const cos = projAgents.find((a) => /chief of staff/i.test(a.role)) ?? projAgents[0] ?? null;
      const chId = newId('chn');
      const sessId = newId('ses');
      const mergedCompaction = mergeProjectCompactions(projAgents, proj.id);
      const ch: Channel = {
        id: chId,
        projectId: proj.id,
        kind: 'room',
        agentId: null,
        name: proj.name,
        defaultResponderAgentId: cos?.id ?? null,
        currentSessionId: sessId,
        compaction: mergedCompaction,
        createdAt: now,
      };
      const sess: RoomSession = {
        id: sessId,
        channelId: chId,
        seq: 1,
        startedAt: now,
        startedBy: 'system',
        carryoverSummary: null,
      };
      sqlite
        .prepare(`INSERT INTO channels (id, project_id, kind, agent_id, created_at, data) VALUES (?, ?, 'room', NULL, ?, ?)`)
        .run(ch.id, ch.projectId, ch.createdAt, JSON.stringify(ch));
      sqlite
        .prepare(`INSERT INTO room_sessions (id, channel_id, seq, started_at, started_by, carryover_summary) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sess.id, sess.channelId, sess.seq, sess.startedAt, sess.startedBy, sess.carryoverSummary);
      roomByProject.set(proj.id, ch);
      sessionByChannel.set(ch.id, sess);
    }

    // Ensure 1 DM per agent
    const dmByAgent = new Map<string, Channel>();
    for (const a of computed.agents) {
      const existingRow = sqlite
        .prepare(`SELECT data FROM channels WHERE agent_id = ? AND kind = 'dm'`)
        .get(a.id) as { data: string } | undefined;
      if (existingRow) {
        dmByAgent.set(a.id, JSON.parse(existingRow.data) as Channel);
        continue;
      }
      const ch: Channel = {
        id: newId('chn'),
        projectId: null,
        kind: 'dm',
        agentId: a.id,
        name: a.name,
        defaultResponderAgentId: a.id,
        currentSessionId: null,
        createdAt: now,
      };
      sqlite
        .prepare(`INSERT INTO channels (id, project_id, kind, agent_id, created_at, data) VALUES (?, NULL, 'dm', ?, ?, ?)`)
        .run(ch.id, ch.agentId, ch.createdAt, JSON.stringify(ch));
      dmByAgent.set(a.id, ch);
    }

    // Rebuild messages table if legacy schema, otherwise update in place
    if (needsRebuild) {
      sqlite.exec(`
        DROP TRIGGER IF EXISTS messages_fts_insert;
        DROP TRIGGER IF EXISTS messages_fts_delete;
        DROP TRIGGER IF EXISTS messages_fts_update;
        CREATE TABLE messages_new (
          id         TEXT PRIMARY KEY,
          channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
          project_id TEXT,
          agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
          session_id TEXT,
          created_at TEXT NOT NULL,
          data       TEXT NOT NULL
        );
      `);
    } else {
      sqlite.exec(`DELETE FROM messages;`);
    }

    const insertTarget = needsRebuild ? 'messages_new' : 'messages';
    const insertStmt = sqlite.prepare(
      `INSERT INTO ${insertTarget} (id, channel_id, project_id, agent_id, session_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const lastRowByChannelAgent = new Map<string, { messageId: string; rowid: number }>();

    for (const { row, updatedMsg } of computed.kept) {
      let channelId = updatedMsg.channelId ?? null;
      let sessionId = updatedMsg.sessionId ?? null;
      if (!channelId) {
        if (row.projectId !== null) {
          const room = roomByProject.get(row.projectId);
          if (room) {
            channelId = room.id;
            sessionId = room.currentSessionId;
          }
        } else if (row.agentId) {
          const dm = dmByAgent.get(row.agentId);
          if (dm) channelId = dm.id;
        }
      }
      const finalMsg: Message = {
        ...updatedMsg,
        ...(channelId ? { channelId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
      const info = insertStmt.run(
        finalMsg.id,
        channelId,
        finalMsg.projectId,
        finalMsg.agentId,
        sessionId,
        finalMsg.createdAt,
        JSON.stringify(finalMsg),
      );
      if (channelId && finalMsg.agentId) {
        const rid = Number(info.lastInsertRowid);
        lastRowByChannelAgent.set(`${channelId}:${finalMsg.agentId}`, {
          messageId: finalMsg.id,
          rowid: rid,
        });
      }
    }

    // Store dropped messages safely for one release
    const dropStmt = sqlite.prepare(
      `INSERT OR IGNORE INTO messages_migrated_dropped (id, project_id, agent_id, created_at, rule, kept_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of computed.droppedRows) {
      dropStmt.run(
        d.row.id,
        d.row.projectId,
        d.row.agentId,
        d.row.createdAt,
        d.rule,
        d.keptId,
        JSON.stringify(d.row.msg),
      );
    }

    if (needsRebuild) {
      sqlite.exec(`
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
      `);
    }

    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_scope_agent ON messages(project_id, agent_id, created_at);
    `);

    // Initialize channel_cursors
    const cursorStmt = sqlite.prepare(
      `INSERT OR REPLACE INTO channel_cursors (channel_id, agent_id, last_seen_message_id, last_seen_rowid) VALUES (?, ?, ?, ?)`,
    );
    for (const [key, pos] of lastRowByChannelAgent) {
      const [channelId, agentId] = key.split(':');
      if (channelId && agentId) {
        cursorStmt.run(channelId, agentId, pos.messageId, pos.rowid);
      }
    }

    // Clear stale project provider sessions on agents (preserve 'direct' sessions)
    const updateAgentStmt = sqlite.prepare(`UPDATE agents SET data = ? WHERE id = ?`);
    for (const a of computed.agents) {
      const sessions = a.raw.sessions as Record<string, string> | undefined;
      if (!sessions) continue;
      let changed = false;
      const nextSessions: Record<string, string> = {};
      for (const [scope, sid] of Object.entries(sessions)) {
        if (scope === 'direct' || scope.startsWith('chn_')) {
          nextSessions[scope] = sid;
        } else {
          changed = true;
        }
      }
      if (changed) {
        a.raw.sessions = nextSessions;
        updateAgentStmt.run(JSON.stringify(a.raw), a.id);
      }
    }

    // Verify invariant before commit
    const actualOut = (sqlite.prepare(`SELECT COUNT(*) AS cnt FROM messages`).get() as { cnt: number }).cnt;
    if (actualOut + computed.droppedRows.length !== computed.plan.messagesIn) {
      throw new Error(
        `Group chat migration invariant failed: out(${actualOut}) + dropped(${computed.droppedRows.length}) !== in(${computed.plan.messagesIn})`,
      );
    }

    // Post one system summary message per migrated room that had project messages
    const summaryInsertStmt = sqlite.prepare(
      `INSERT INTO messages (id, channel_id, project_id, agent_id, session_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const proj of computed.projects) {
      const room = roomByProject.get(proj.id);
      if (!room) continue;
      const projMsgCount = computed.kept.filter((k) => k.row.projectId === proj.id).length;
      const projDrops = computed.droppedRows.filter((d) => d.row.projectId === proj.id).length;
      if (projMsgCount === 0 && projDrops === 0) continue;
      const alreadyHasSummary = computed.kept.some(
        (k) =>
          k.row.projectId === proj.id &&
          k.updatedMsg.metadata?.event?.kind === 'migration_summary',
      );
      if (alreadyHasSummary) continue;

      const threadCount = new Set(
        computed.kept
          .filter((k) => k.row.projectId === proj.id && k.row.agentId)
          .map((k) => k.row.agentId!),
      ).size;
      const summaryMsg: Message = {
        id: newId('msg'),
        channelId: room.id,
        sessionId: room.currentSessionId,
        projectId: proj.id,
        agentId: null,
        author: 'system',
        text: `Project chat merged from ${Math.max(1, threadCount)} agent threads (${projMsgCount} messages, ${projDrops} duplicates merged).`,
        streaming: false,
        durationMs: null,
        metadata: {
          event: {
            kind: 'migration_summary',
            threadCount: Math.max(1, threadCount),
            messageCount: projMsgCount,
            mergedDuplicates: projDrops,
          },
        },
        createdAt: now,
      };
      summaryInsertStmt.run(
        summaryMsg.id,
        room.id,
        proj.id,
        null,
        room.currentSessionId,
        summaryMsg.createdAt,
        JSON.stringify(summaryMsg),
      );
    }

    // Rebuild FTS if it exists
    if (tableExists(sqlite, 'messages_fts')) {
      sqlite.exec(`DELETE FROM messages_fts;`);
      sqlite.exec(`
        INSERT INTO messages_fts(rowid, text, message_id, scope)
        SELECT m.rowid, json_extract(m.data, '$.text'), m.id, coalesce(m.project_id, 'direct')
        FROM messages m
        WHERE coalesce(json_extract(m.data, '$.streaming'), 0) = 0
          AND coalesce(json_extract(m.data, '$.metadata.compacted'), 0) = 0;
      `);
    }

    sqlite.exec(`PRAGMA user_version = ${GROUP_CHAT_SCHEMA_VERSION};`);
    sqlite.exec('COMMIT;');
    return computed.plan;
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw new GroupChatMigrationError(
      `Group chat migration failed and was rolled back; your data was not changed.${
        backupPath ? ` A pre-migration backup is at ${backupPath}.` : ''
      } Cause: ${err instanceof Error ? err.message : String(err)}`,
      backupPath,
      { cause: err },
    );
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;');
  }
}

/** Reconciles an imported pre-group-chat backup into channels & rooms. */
export function reconcileImportedGroupChat(sqlite: DatabaseSync): GroupChatMigrationPlan | null {
  return applyGroupChatMigration(sqlite, { forceReconcile: true });
}
