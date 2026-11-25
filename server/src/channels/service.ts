import crypto from 'node:crypto';
import type {
  Agent,
  Channel,
  ChannelSettings,
  Message,
  MessageAuthor,
  MessageMetadata,
  RoomSession,
  ServerEvent,
  ThreadCompaction,
} from '@atelier/contracts';
import type { DatabaseSync } from 'node:sqlite';

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface ChannelMessageWithRowid {
  rowid: number;
  message: Message;
}

export interface ChannelListResult {
  messages: Message[];
  oldestRowid: number | null;
  hasMore: boolean;
}

export interface ChannelCursor {
  channelId: string;
  agentId: string;
  lastSeenMessageId: string | null;
  lastSeenRowid: number;
}

/**
 * Manages project group-chat rooms, global 1-on-1 DM channels, room sessions,
 * per-agent read cursors, cursor pagination, and message forwarding.
 */
export class ChannelService {
  /** Dipanggil setelah ringkasan channel berubah (untuk menyegarkan index memory). */
  public onCompactionChange?: (channel: Channel) => void;

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly broadcast: (events: ServerEvent[]) => void,
  ) {}

  public listChannels(): Channel[] {
    const rows = this.sqlite
      .prepare(`SELECT data FROM channels ORDER BY created_at ASC`)
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Channel);
  }

  public getChannel(id: string): Channel | null {
    const row = this.sqlite
      .prepare(`SELECT data FROM channels WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Channel) : null;
  }

  public getRoomByProject(projectId: string): Channel | null {
    const row = this.sqlite
      .prepare(`SELECT data FROM channels WHERE project_id = ? AND kind = 'room'`)
      .get(projectId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Channel) : null;
  }

  public getDmByAgent(agentId: string): Channel | null {
    const row = this.sqlite
      .prepare(`SELECT data FROM channels WHERE agent_id = ? AND kind = 'dm'`)
      .get(agentId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Channel) : null;
  }

  public ensureRoom(
    projectId: string,
    projectName: string,
    projectAgents: Agent[],
  ): Channel {
    const existing = this.getRoomByProject(projectId);
    if (existing) {
      // Refresh defaultResponderAgentId if it was unset or points to a removed agent.
      const stillInProject =
        existing.defaultResponderAgentId &&
        projectAgents.some((a) => a.id === existing.defaultResponderAgentId);
      if (!stillInProject && projectAgents.length > 0) {
        const cos =
          projectAgents.find((a) => /chief of staff/i.test(a.role)) ?? projectAgents[0]!;
        return this.updateChannel(existing.id, { defaultResponderAgentId: cos.id }) ?? existing;
      }
      return existing;
    }

    const cos =
      projectAgents.find((a) => /chief of staff/i.test(a.role)) ?? projectAgents[0] ?? null;
    const chId = newId('chn');
    const sessId = newId('ses');
    const createdAt = nowIso();
    const channel: Channel = {
      id: chId,
      projectId,
      kind: 'room',
      agentId: null,
      name: projectName,
      defaultResponderAgentId: cos?.id ?? null,
      currentSessionId: sessId,
      compaction: null,
      createdAt,
    };
    const session: RoomSession = {
      id: sessId,
      channelId: chId,
      seq: 1,
      startedAt: createdAt,
      startedBy: 'system',
      carryoverSummary: null,
    };

    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      this.sqlite
        .prepare(
          `INSERT INTO channels (id, project_id, kind, agent_id, created_at, data) VALUES (?, ?, 'room', NULL, ?, ?)`,
        )
        .run(channel.id, channel.projectId, channel.createdAt, JSON.stringify(channel));
      this.sqlite
        .prepare(
          `INSERT INTO room_sessions (id, channel_id, seq, started_at, started_by, carryover_summary) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.channelId,
          session.seq,
          session.startedAt,
          session.startedBy,
          session.carryoverSummary,
        );
      this.sqlite.exec('COMMIT');
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }

    this.broadcast([
      { type: 'channel-upserted', payload: channel },
      { type: 'room-session-upserted', payload: session },
    ]);
    return channel;
  }

  public ensureDm(agentId: string, agentName: string): Channel {
    const existing = this.getDmByAgent(agentId);
    if (existing) return existing;

    const channel: Channel = {
      id: newId('chn'),
      projectId: null,
      kind: 'dm',
      agentId,
      name: agentName,
      defaultResponderAgentId: agentId,
      currentSessionId: null,
      compaction: null,
      createdAt: nowIso(),
    };

    this.sqlite
      .prepare(
        `INSERT INTO channels (id, project_id, kind, agent_id, created_at, data) VALUES (?, NULL, 'dm', ?, ?, ?)`,
      )
      .run(channel.id, channel.agentId, channel.createdAt, JSON.stringify(channel));

    this.broadcast([{ type: 'channel-upserted', payload: channel }]);
    return channel;
  }

  public updateChannel(
    channelId: string,
    patch: {
      name?: string;
      defaultResponderAgentId?: string | null;
      currentSessionId?: string | null;
      compaction?: ThreadCompaction | null;
      settings?: ChannelSettings;
    },
  ): Channel | null {
    const existing = this.getChannel(channelId);
    if (!existing) return null;
    const updated: Channel = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.defaultResponderAgentId !== undefined
        ? { defaultResponderAgentId: patch.defaultResponderAgentId }
        : {}),
      ...(patch.currentSessionId !== undefined
        ? { currentSessionId: patch.currentSessionId }
        : {}),
      ...(patch.compaction !== undefined ? { compaction: patch.compaction } : {}),
      ...(patch.settings !== undefined
        ? { settings: { ...(existing.settings ?? {}), ...patch.settings } }
        : {}),
    };
    this.sqlite
      .prepare(`UPDATE channels SET data = ? WHERE id = ?`)
      .run(JSON.stringify(updated), channelId);
    this.broadcast([{ type: 'channel-upserted', payload: updated }]);
    if (patch.compaction !== undefined) this.onCompactionChange?.(updated);
    return updated;
  }

  public listRoomSessions(channelId?: string): RoomSession[] {
    const rows = channelId
      ? (this.sqlite
          .prepare(
            `SELECT id, channel_id, seq, started_at, started_by, carryover_summary FROM room_sessions WHERE channel_id = ? ORDER BY seq ASC`,
          )
          .all(channelId) as Array<{
          id: string;
          channel_id: string;
          seq: number;
          started_at: string;
          started_by: 'user' | 'system';
          carryover_summary: string | null;
        }>)
      : (this.sqlite
          .prepare(
            `SELECT id, channel_id, seq, started_at, started_by, carryover_summary FROM room_sessions ORDER BY started_at ASC, seq ASC`,
          )
          .all() as Array<{
          id: string;
          channel_id: string;
          seq: number;
          started_at: string;
          started_by: 'user' | 'system';
          carryover_summary: string | null;
        }>);
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      seq: r.seq,
      startedAt: r.started_at,
      startedBy: r.started_by,
      carryoverSummary: r.carryover_summary,
    }));
  }

  public getRoomSession(sessionId: string): RoomSession | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, channel_id, seq, started_at, started_by, carryover_summary FROM room_sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          id: string;
          channel_id: string;
          seq: number;
          started_at: string;
          started_by: 'user' | 'system';
          carryover_summary: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channel_id,
      seq: row.seq,
      startedAt: row.started_at,
      startedBy: row.started_by,
      carryoverSummary: row.carryover_summary,
    };
  }

  public updateSessionCarryover(sessionId: string, carryoverSummary: string | null): RoomSession | null {
    const existing = this.getRoomSession(sessionId);
    if (!existing) return null;
    this.sqlite
      .prepare(`UPDATE room_sessions SET carryover_summary = ? WHERE id = ?`)
      .run(carryoverSummary, sessionId);
    const updated: RoomSession = { ...existing, carryoverSummary };
    this.broadcast([{ type: 'room-session-upserted', payload: updated }]);
    return updated;
  }

  public getMessageRowid(messageId: string): number | null {
    const row = this.sqlite
      .prepare(`SELECT rowid FROM messages WHERE id = ?`)
      .get(messageId) as { rowid: number } | undefined;
    return row ? Number(row.rowid) : null;
  }

  public getMessage(messageId: string): Message | null {
    const row = this.sqlite
      .prepare(`SELECT data FROM messages WHERE id = ?`)
      .get(messageId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Message) : null;
  }

  public postMessage(input: {
    id?: string;
    channelId: string;
    author: MessageAuthor;
    agentId: string | null;
    text: string;
    streaming?: boolean;
    durationMs?: number | null;
    metadata?: MessageMetadata;
    sessionId?: string | null;
  }): { message: Message; rowid: number } {
    const channel = this.getChannel(input.channelId);
    const sessionId =
      input.sessionId !== undefined ? input.sessionId : (channel?.currentSessionId ?? null);
    const message: Message = {
      id: input.id ?? newId('msg'),
      channelId: input.channelId,
      sessionId,
      projectId: channel?.projectId ?? null,
      agentId: input.agentId,
      author: input.author,
      text: input.text,
      streaming: input.streaming ?? false,
      durationMs: input.durationMs ?? null,
      metadata: input.metadata,
      createdAt: nowIso(),
    };

    const info = this.sqlite
      .prepare(
        `INSERT INTO messages (id, channel_id, project_id, agent_id, session_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.channelId ?? null,
        message.projectId,
        message.agentId,
        message.sessionId ?? null,
        message.createdAt,
        JSON.stringify(message),
      );

    const rowid = Number(info.lastInsertRowid);
    this.broadcast([{ type: 'message-upserted', payload: message }]);
    return { message, rowid };
  }

  public updateMessageMetadata(messageId: string, patch: Partial<MessageMetadata>): Message | null {
    const existing = this.getMessage(messageId);
    if (!existing) return null;
    const updated: Message = {
      ...existing,
      metadata: { ...(existing.metadata ?? {}), ...patch },
    };
    this.sqlite
      .prepare(`UPDATE messages SET data = ? WHERE id = ?`)
      .run(JSON.stringify(updated), messageId);
    this.broadcast([{ type: 'message-upserted', payload: updated }]);
    return updated;
  }

  public listChannelMessages(
    channelId: string,
    opts?: { beforeRowid?: number; limit?: number; sessionId?: string | null },
  ): ChannelListResult {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const params: Array<string | number> = [channelId];
    const clauses = [`channel_id = ?`];
    if (opts?.sessionId) {
      clauses.push(`session_id = ?`);
      params.push(opts.sessionId);
    }
    if (opts?.beforeRowid !== undefined) {
      clauses.push(`rowid < ?`);
      params.push(opts.beforeRowid);
    }
    params.push(limit + 1);

    const rows = this.sqlite
      .prepare(
        `SELECT rowid, data FROM messages WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...params) as Array<{ rowid: number; data: string }>;

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    slice.reverse();
    const oldestRowid = slice.length > 0 ? Number(slice[0]!.rowid) : null;
    return {
      messages: slice.map((r) => JSON.parse(r.data) as Message),
      oldestRowid,
      hasMore,
    };
  }

  public listChannelMessagesWithRowids(
    channelId: string,
    opts?: { sessionId?: string | null; afterRowid?: number; excludeAgentId?: string | null },
  ): ChannelMessageWithRowid[] {
    const clauses = [`channel_id = ?`];
    const params: Array<string | number> = [channelId];
    if (opts?.sessionId) {
      clauses.push(`session_id = ?`);
      params.push(opts.sessionId);
    }
    if (opts?.afterRowid !== undefined) {
      clauses.push(`rowid > ?`);
      params.push(opts.afterRowid);
    }
    if (opts?.excludeAgentId) {
      clauses.push(`(agent_id IS NULL OR agent_id != ?)`);
      params.push(opts.excludeAgentId);
    }
    const rows = this.sqlite
      .prepare(`SELECT rowid, data FROM messages WHERE ${clauses.join(' AND ')} ORDER BY rowid ASC`)
      .all(...params) as Array<{ rowid: number; data: string }>;
    return rows.map((r) => ({ rowid: Number(r.rowid), message: JSON.parse(r.data) as Message }));
  }

  public getCursor(channelId: string, agentId: string): ChannelCursor | null {
    const row = this.sqlite
      .prepare(
        `SELECT channel_id, agent_id, last_seen_message_id, last_seen_rowid FROM channel_cursors WHERE channel_id = ? AND agent_id = ?`,
      )
      .get(channelId, agentId) as
      | {
          channel_id: string;
          agent_id: string;
          last_seen_message_id: string | null;
          last_seen_rowid: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      channelId: row.channel_id,
      agentId: row.agent_id,
      lastSeenMessageId: row.last_seen_message_id,
      lastSeenRowid: Number(row.last_seen_rowid ?? 0),
    };
  }

  public upsertCursor(
    channelId: string,
    agentId: string,
    lastSeenRowid: number,
    lastSeenMessageId: string | null,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO channel_cursors (channel_id, agent_id, last_seen_message_id, last_seen_rowid)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, agent_id) DO UPDATE SET
           last_seen_message_id = excluded.last_seen_message_id,
           last_seen_rowid = excluded.last_seen_rowid`,
      )
      .run(channelId, agentId, lastSeenMessageId, lastSeenRowid);
  }

  public startNewSession(
    channelId: string,
    opts: {
      carryover: 'summary' | 'clean';
      carryoverSummary?: string | null;
      startedBy?: 'user' | 'system';
    },
  ): { session: RoomSession; channel: Channel; dividerMessage: Message } | null {
    const channel = this.getChannel(channelId);
    if (!channel || channel.kind !== 'room') return null;

    const existingSessions = this.listRoomSessions(channelId);
    const nextSeq = (existingSessions.at(-1)?.seq ?? 0) + 1;
    const summaryText =
      opts.carryover === 'summary' ? (opts.carryoverSummary?.trim() || null) : null;
    const session: RoomSession = {
      id: newId('ses'),
      channelId,
      seq: nextSeq,
      startedAt: nowIso(),
      startedBy: opts.startedBy ?? 'user',
      carryoverSummary: summaryText,
    };

    const updatedChannel: Channel = {
      ...channel,
      currentSessionId: session.id,
      compaction: null,
    };

    const dividerText =
      opts.carryover === 'summary' && summaryText
        ? `Session ${nextSeq} started (with summary carryover).`
        : `Session ${nextSeq} started (clean context).`;
    const dividerMsg: Message = {
      id: newId('msg'),
      channelId,
      sessionId: session.id,
      projectId: channel.projectId,
      agentId: null,
      author: 'system',
      text: dividerText,
      streaming: false,
      durationMs: null,
      metadata: {
        event: {
          kind: 'session_started',
          sessionId: session.id,
          seq: nextSeq,
          carryover: opts.carryover,
          carryoverSummary: summaryText,
        },
      },
      createdAt: session.startedAt,
    };

    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      this.sqlite
        .prepare(
          `INSERT INTO room_sessions (id, channel_id, seq, started_at, started_by, carryover_summary) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.channelId,
          session.seq,
          session.startedAt,
          session.startedBy,
          session.carryoverSummary,
        );
      this.sqlite
        .prepare(`UPDATE channels SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updatedChannel), channelId);
      this.sqlite
        .prepare(
          `INSERT INTO messages (id, channel_id, project_id, agent_id, session_id, created_at, data) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          dividerMsg.id,
          channelId,
          channel.projectId,
          session.id,
          dividerMsg.createdAt,
          JSON.stringify(dividerMsg),
        );
      // Reset per-agent cursors for this channel so old-session messages aren't treated as delta.
      this.sqlite
        .prepare(`DELETE FROM channel_cursors WHERE channel_id = ?`)
        .run(channelId);
      this.sqlite.exec('COMMIT');
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }

    this.broadcast([
      { type: 'channel-upserted', payload: updatedChannel },
      { type: 'room-session-upserted', payload: session },
      { type: 'message-upserted', payload: dividerMsg },
    ]);
    return { session, channel: updatedChannel, dividerMessage: dividerMsg };
  }

  public forwardMessages(
    targetChannelId: string,
    opts: { fromChannelId: string; messageIds: string[]; agentNameLookup?: (id: string | null) => string },
  ): { message: Message; rowid: number } | null {
    const target = this.getChannel(targetChannelId);
    if (!target || opts.messageIds.length === 0) return null;

    const sourceMsgs = opts.messageIds
      .map((id) => this.getMessage(id))
      .filter((m): m is Message => Boolean(m && m.channelId === opts.fromChannelId));
    if (sourceMsgs.length === 0) return null;

    const lines = sourceMsgs.map((m) => {
      const sender =
        m.author === 'user'
          ? 'User'
          : (opts.agentNameLookup?.(m.agentId) ?? 'Agent');
      return `> **${sender}**: ${m.text.trim().replace(/\n/g, '\n> ')}`;
    });
    const text = `Forwarded from DM:\n\n${lines.join('\n\n')}`;
    return this.postMessage({
      channelId: targetChannelId,
      author: 'user',
      agentId: null,
      text,
      metadata: {
        forwardedFrom: {
          channelId: opts.fromChannelId,
          messageIds: sourceMsgs.map((m) => m.id),
        },
      },
    });
  }
}
