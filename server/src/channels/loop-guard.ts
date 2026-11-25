import type { DatabaseSync } from 'node:sqlite';

export interface RoomChainState {
  rootMessageId: string;
  channelId: string;
  turnsUsed: number;
  tokensUsed: number;
  costUsd: number;
  status: 'active' | 'paused' | 'stopped';
  maxTurns: number;
  maxTokens: number;
  warned: boolean;
}

export interface LoopCheckResult {
  allowed: boolean;
  reason?: 'max_hops' | 'chain_budget_exhausted';
  maxHops?: number;
  chain?: RoomChainState;
}

const DEFAULT_MAX_HOPS = 6;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOKENS = 150_000;

/**
 * Enforces agent-to-agent hop limits and per-root-message turn/token budgets (§4.4 & §10.9).
 */
export class LoopGuard {
  constructor(private readonly sqlite: DatabaseSync) {}

  public ensureChain(
    rootMessageId: string,
    channelId: string,
    limits?: { maxTurns?: number; maxTokens?: number },
  ): RoomChainState {
    const existing = this.getChain(rootMessageId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const maxTurns = limits?.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxTokens = limits?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO room_chains (root_message_id, channel_id, turns_used, tokens_used, cost_usd, status, max_turns, max_tokens, warned, created_at, updated_at)
         VALUES (?, ?, 0, 0, 0, 'active', ?, ?, 0, ?, ?)`,
      )
      .run(rootMessageId, channelId, maxTurns, maxTokens, now, now);
    return this.getChain(rootMessageId)!;
  }

  public getChain(rootMessageId: string): RoomChainState | null {
    const row = this.sqlite
      .prepare(
        `SELECT root_message_id, channel_id, turns_used, tokens_used, cost_usd, status, max_turns, max_tokens, warned
         FROM room_chains WHERE root_message_id = ?`,
      )
      .get(rootMessageId) as
      | {
          root_message_id: string;
          channel_id: string;
          turns_used: number;
          tokens_used: number;
          cost_usd: number;
          status: 'active' | 'paused' | 'stopped';
          max_turns: number;
          max_tokens: number;
          warned: number;
        }
      | undefined;
    if (!row) return null;
    return {
      rootMessageId: row.root_message_id,
      channelId: row.channel_id,
      turnsUsed: row.turns_used,
      tokensUsed: row.tokens_used,
      costUsd: row.cost_usd,
      status: row.status,
      maxTurns: row.max_turns,
      maxTokens: row.max_tokens,
      warned: Boolean(row.warned),
    };
  }

  public canEnqueue(input: {
    rootMessageId: string;
    channelId: string;
    hop: number;
    maxHops?: number;
    maxTurns?: number;
    maxTokens?: number;
  }): LoopCheckResult {
    const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
    if (input.hop > maxHops) {
      return { allowed: false, reason: 'max_hops', maxHops };
    }
    const chain = this.ensureChain(input.rootMessageId, input.channelId, {
      maxTurns: input.maxTurns,
      maxTokens: input.maxTokens,
    });
    if (
      chain.status !== 'active' ||
      chain.turnsUsed >= chain.maxTurns ||
      chain.tokensUsed >= chain.maxTokens
    ) {
      return { allowed: false, reason: 'chain_budget_exhausted', chain };
    }
    return { allowed: true, chain };
  }

  /** Records a completed turn against its root chain and returns whether warning/pause threshold was crossed. */
  public recordTurn(
    rootMessageId: string,
    channelId: string,
    delta: { tokens: number; costUsd: number; maxTurns?: number; maxTokens?: number },
  ): { chain: RoomChainState; justWarned: boolean; justPaused: boolean } {
    const before = this.ensureChain(rootMessageId, channelId, {
      maxTurns: delta.maxTurns,
      maxTokens: delta.maxTokens,
    });
    const nextTurns = before.turnsUsed + 1;
    const nextTokens = before.tokensUsed + Math.max(0, delta.tokens);
    const nextCost = before.costUsd + Math.max(0, delta.costUsd);
    const exhausted = nextTurns >= before.maxTurns || nextTokens >= before.maxTokens;
    const nearWarning =
      !exhausted &&
      !before.warned &&
      (nextTurns >= Math.ceil(before.maxTurns * 0.8) ||
        nextTokens >= Math.ceil(before.maxTokens * 0.8));

    const nextStatus = exhausted ? 'paused' : before.status;
    const nextWarned = before.warned || nearWarning ? 1 : 0;

    this.sqlite
      .prepare(
        `UPDATE room_chains
         SET turns_used = ?, tokens_used = ?, cost_usd = ?, status = ?, warned = ?, updated_at = ?
         WHERE root_message_id = ?`,
      )
      .run(
        nextTurns,
        nextTokens,
        nextCost,
        nextStatus,
        nextWarned,
        new Date().toISOString(),
        rootMessageId,
      );

    return {
      chain: this.getChain(rootMessageId)!,
      justWarned: nearWarning,
      justPaused: exhausted && before.status === 'active',
    };
  }

  public continueChain(rootMessageId: string, extraTurns = 6): RoomChainState | null {
    const existing = this.getChain(rootMessageId);
    if (!existing) return null;
    const nextMaxTurns = Math.max(existing.turnsUsed, existing.maxTurns) + extraTurns;
    const nextMaxTokens =
      existing.tokensUsed >= existing.maxTokens
        ? existing.tokensUsed + Math.round(DEFAULT_MAX_TOKENS * 0.5)
        : existing.maxTokens;
    this.sqlite
      .prepare(
        `UPDATE room_chains SET max_turns = ?, max_tokens = ?, status = 'active', warned = 0, updated_at = ? WHERE root_message_id = ?`,
      )
      .run(nextMaxTurns, nextMaxTokens, new Date().toISOString(), rootMessageId);
    return this.getChain(rootMessageId);
  }
}
