import type { Agent, Channel, Message, Task } from '@atelier/contracts';

export interface RouteResult {
  targetAgentIds: string[];
  reason:
    | 'explicit-mention'
    | 'all-mention'
    | 'reply-to-agent'
    | 'task-identifier'
    | 'name-match'
    | 'default-responder'
    | 'agent-fyi-none';
  turnPurpose: 'dispatch' | 'work';
}

const DEFAULT_MAX_FANOUT = 4;
const MAX_EXPLICIT_MENTIONS = 5;

/**
 * Deterministic router (§4.3 + §10.5) deciding which project agents should respond to a message.
 * Rules are evaluated in priority order; the first matching rule wins.
 */
export function routeRoomMessage(
  message: Pick<Message, 'author' | 'agentId' | 'text' | 'metadata'>,
  ctx: {
    channel: Channel;
    projectAgents: Agent[];
    tasks: Task[];
    replyToMessage?: Message | null;
    explicitMentionAgentIds?: string[];
    maxFanout?: number;
  },
): RouteResult {
  const memberIds = new Set(ctx.projectAgents.map((a) => a.id));
  const senderIsAgent = message.author === 'agent';
  const maxFanout = ctx.maxFanout ?? DEFAULT_MAX_FANOUT;

  // 1. Explicit @Agent mentions (passed from composer or parsed from @Name in text)
  const explicitIds = (
    ctx.explicitMentionAgentIds?.length
      ? ctx.explicitMentionAgentIds
      : extractMentionedAgentIds(message.text, ctx.projectAgents)
  ).filter((id) => memberIds.has(id) && (!senderIsAgent || id !== message.agentId));

  const dedupedExplicit = Array.from(new Set(explicitIds)).slice(0, MAX_EXPLICIT_MENTIONS);
  if (dedupedExplicit.length > 0) {
    return {
      targetAgentIds: dedupedExplicit,
      reason: 'explicit-mention',
      turnPurpose: 'work',
    };
  }

  // 2. @all / @semua (only allowed for user messages; ignored from agents)
  if (!senderIsAgent && /(?:^|\s)@(?:all|semua)(?=$|[\s.,!?:;)])/i.test(message.text)) {
    const targets = ctx.projectAgents.slice(0, maxFanout).map((a) => a.id);
    return {
      targetAgentIds: targets,
      reason: 'all-mention',
      turnPurpose: 'work',
    };
  }

  // 3. Reply pointing to a specific agent message
  if (
    ctx.replyToMessage?.author === 'agent' &&
    ctx.replyToMessage.agentId &&
    memberIds.has(ctx.replyToMessage.agentId) &&
    (!senderIsAgent || ctx.replyToMessage.agentId !== message.agentId)
  ) {
    return {
      targetAgentIds: [ctx.replyToMessage.agentId],
      reason: 'reply-to-agent',
      turnPurpose: 'work',
    };
  }

  // 4. Agent message without mention -> FYI only, never triggers a turn
  if (senderIsAgent || message.author === 'system') {
    return {
      targetAgentIds: [],
      reason: 'agent-fyi-none',
      turnPurpose: 'work',
    };
  }

  // 5. Fast deterministic routing for user messages: task identifier (AT-11) -> assignee
  const taskMatch = /\b(AT-\d+)\b/i.exec(message.text);
  if (taskMatch) {
    const ident = taskMatch[1]!.toUpperCase();
    const task = ctx.tasks.find((t) => t.identifier.toUpperCase() === ident);
    if (task?.assigneeAgentId && memberIds.has(task.assigneeAgentId)) {
      return {
        targetAgentIds: [task.assigneeAgentId],
        reason: 'task-identifier',
        turnPurpose: 'work',
      };
    }
  }

  // 6. Full agent name match (case-insensitive) without '@' -> matching agent
  const namedTargets = extractExactAgentNames(message.text, ctx.projectAgents);
  if (namedTargets.length > 0) {
    return {
      targetAgentIds: namedTargets.slice(0, MAX_EXPLICIT_MENTIONS),
      reason: 'name-match',
      turnPurpose: 'work',
    };
  }

  // 7. Fallback to room default responder (Chief of Staff, else first agent in project)
  const fallbackId =
    (ctx.channel.defaultResponderAgentId && memberIds.has(ctx.channel.defaultResponderAgentId)
      ? ctx.channel.defaultResponderAgentId
      : null) ?? ctx.projectAgents[0]?.id ?? null;

  return {
    targetAgentIds: fallbackId ? [fallbackId] : [],
    reason: 'default-responder',
    turnPurpose: fallbackId ? 'dispatch' : 'work',
  };
}

export function extractMentionedAgentIds(text: string, agents: Agent[]): string[] {
  if (!text.includes('@') || agents.length === 0) return [];
  const sorted = [...agents]
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const found: Array<{ index: number; id: string }> = [];
  for (const agent of sorted) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s.,!?:;)])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      found.push({ index: m.index, id: agent.id });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return Array.from(new Set(found.map((f) => f.id)));
}

function extractExactAgentNames(text: string, agents: Agent[]): string[] {
  const sorted = [...agents]
    .filter((a) => a.name.trim().length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  const found: Array<{ index: number; id: string }> = [];
  for (const agent of sorted) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    const m = re.exec(text);
    if (m) {
      found.push({ index: m.index, id: agent.id });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return Array.from(new Set(found.map((f) => f.id)));
}
