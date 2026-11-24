import type {
  Agent,
  AutoCompactSettings,
  Message,
  ThreadCompaction,
} from '@atelier/contracts';
import type { AtelierStore } from '../store.js';

const MAX_SUMMARY_CHARS = 2400;
const MAX_LINE_CHARS = 180;
const TASK_ID_RE = /\bAT-\d+\b/g;

export function getScopeKey(projectId: string | null | undefined): string {
  return projectId || 'direct';
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Returns completed, non-empty conversation messages in chronological order
 * strictly after the last compacted message marker (or all if uncompacted).
 */
export function getUncompactedMessages(
  messages: Message[],
  compaction?: ThreadCompaction | null,
): Message[] {
  const usable = messages.filter(
    (m) => !m.streaming && !m.metadata?.compacted && m.text.trim().length > 0,
  );
  if (!compaction?.lastCompactedMessageId) {
    return usable;
  }
  const idx = usable.findIndex((m) => m.id === compaction.lastCompactedMessageId);
  if (idx === -1) {
    return usable;
  }
  return usable.slice(idx + 1);
}

/**
 * Formats recent uncompacted messages into a compact conversational tail for turns
 * running without a native provider resume session.
 */
export function formatUncompactedConversation(
  messages: Message[],
  compaction: ThreadCompaction | null | undefined,
  currentPrompt: string,
  maxRecent = 12,
): string {
  const history = getUncompactedMessages(messages, compaction).slice(-maxRecent);
  const prior =
    history.length > 0 && history[history.length - 1]!.text === currentPrompt
      ? history.slice(0, -1)
      : history;

  if (prior.length === 0) return currentPrompt;

  const lines = prior.map((m) => `${m.author.toUpperCase()}: ${m.text}`);
  return ['Recent conversation context:', ...lines, '', `CURRENT MESSAGE: ${currentPrompt}`].join(
    '\n',
  );
}

export function estimateActiveContextTokens(
  messages: Message[],
  compaction?: ThreadCompaction | null,
  reportedScopeTokens?: number,
): number {
  const uncompacted = getUncompactedMessages(messages, compaction);
  const summaryTokens = estimateTokens(compaction?.summary ?? '');
  const messageTokens = uncompacted.reduce((acc, m) => acc + estimateTokens(m.text), 0);
  const estimated = summaryTokens + messageTokens;
  return Math.max(estimated, reportedScopeTokens ?? 0);
}

export function shouldAutoCompact(
  messages: Message[],
  compaction: ThreadCompaction | undefined | null,
  reportedScopeTokens: number | undefined,
  config: AutoCompactSettings,
): boolean {
  if (!config.enabled) return false;
  const uncompacted = getUncompactedMessages(messages, compaction);
  if (uncompacted.length <= Math.max(2, config.keepRecentMessages)) {
    return false;
  }
  if (uncompacted.length >= config.maxMessages) {
    return true;
  }
  return (
    estimateActiveContextTokens(messages, compaction, reportedScopeTokens) >=
    config.maxContextTokens
  );
}

function summarizeLine(msg: Message): string {
  const compactText = msg.text.replace(/\s+/g, ' ').trim();
  const clipped =
    compactText.length > MAX_LINE_CHARS
      ? `${compactText.slice(0, MAX_LINE_CHARS - 1)}…`
      : compactText;
  const roleLabel =
    msg.author === 'user'
      ? 'User'
      : msg.author === 'teammate'
        ? 'Teammate'
        : msg.author === 'system'
          ? 'System'
          : 'Agent';
  return `- [${roleLabel}] ${clipped}`;
}

export function buildDeterministicSummary(
  previousSummary: string | undefined,
  messagesToCompact: Message[],
): string {
  const taskIds = new Set<string>();
  const bullets: string[] = [];

  for (const msg of messagesToCompact) {
    const matches = msg.text.match(TASK_ID_RE);
    if (matches) {
      for (const id of matches) taskIds.add(id);
    }
    if (msg.metadata?.taskIdentifier) {
      taskIds.add(msg.metadata.taskIdentifier);
    }
    bullets.push(summarizeLine(msg));
  }

  // Extract individual memory bullets from prior summary so repeated compactions stay flat and bounded
  const priorBullets: string[] = [];
  if (previousSummary?.trim()) {
    for (const line of previousSummary.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- [')) {
        priorBullets.push(trimmed);
      }
    }
  }

  const combinedBullets = [...priorBullets, ...bullets];
  const taskNote = taskIds.size > 0 ? ` · Tasks referenced: ${[...taskIds].join(', ')}` : '';
  const header = `Compacted ${messagesToCompact.length} earlier messages${taskNote}:`;

  // Keep the most recent bullets that fit cleanly within MAX_SUMMARY_CHARS
  const keptBullets: string[] = [];
  let charBudget = MAX_SUMMARY_CHARS - header.length - 40;
  for (let i = combinedBullets.length - 1; i >= 0; i--) {
    const line = combinedBullets[i]!;
    if (line.length + 1 > charBudget && keptBullets.length > 0) {
      break;
    }
    keptBullets.unshift(line);
    charBudget -= line.length + 1;
  }

  const droppedCount = combinedBullets.length - keptBullets.length;
  const truncationLine =
    droppedCount > 0 ? `- [Earlier] (${droppedCount} older notes condensed)` : null;

  return [header, ...(truncationLine ? [truncationLine] : []), ...keptBullets].join('\n');
}

export interface CompactScopeResult {
  compacted: boolean;
  compaction: ThreadCompaction | null;
  compactedCount: number;
  agent: Agent | null;
}

export function compactAgentScope(
  store: AtelierStore,
  agentId: string,
  projectId: string | null,
  opts?: { force?: boolean; reason?: 'auto' | 'manual'; keepRecentMessages?: number },
): CompactScopeResult {
  const agent = store.getAgent(agentId);
  if (!agent) {
    return { compacted: false, compaction: null, compactedCount: 0, agent: null };
  }

  const scopeKey = getScopeKey(projectId);
  const prevCompaction = agent.contextCompactions?.[scopeKey] ?? null;
  const settings = store.getSettings();
  const allMessages = store.listAgentMessages(agent.id, projectId);
  const uncompacted = getUncompactedMessages(allMessages, prevCompaction);

  if (uncompacted.length < 2) {
    return { compacted: false, compaction: prevCompaction, compactedCount: 0, agent };
  }

  const targetKeep = opts?.force
    ? Math.min(2, Math.max(0, uncompacted.length - 1))
    : Math.min(
        opts?.keepRecentMessages ?? settings.autoCompact.keepRecentMessages,
        Math.max(0, uncompacted.length - 1),
      );

  const splitIdx = uncompacted.length - targetKeep;
  const toCompact = uncompacted.slice(0, splitIdx);
  const kept = uncompacted.slice(splitIdx);

  if (toCompact.length === 0) {
    return { compacted: false, compaction: prevCompaction, compactedCount: 0, agent };
  }

  const estimatedTokensBefore = estimateActiveContextTokens(
    allMessages,
    prevCompaction,
    agent.scopeTokens?.[scopeKey],
  );
  const summary = buildDeterministicSummary(prevCompaction?.summary, toCompact);
  const estimatedTokensAfter =
    estimateTokens(summary) + kept.reduce((acc, m) => acc + estimateTokens(m.text), 0);

  const compaction: ThreadCompaction = {
    summary,
    compactedMessageCount: (prevCompaction?.compactedMessageCount ?? 0) + toCompact.length,
    lastCompactedMessageId: toCompact[toCompact.length - 1]!.id,
    compactedAt: new Date().toISOString(),
    estimatedTokensBefore,
    estimatedTokensAfter,
  };

  // Rotate native CLI / SDK session for this scope so the next turn starts lightweight
  const prevScopeSession = agent.sessions?.[scopeKey];
  const nextSessions = { ...(agent.sessions ?? {}) };
  delete nextSessions[scopeKey];

  const shouldClearLegacySession =
    Boolean(prevScopeSession && agent.sessionId === prevScopeSession) ||
    (!prevScopeSession && projectId !== null && agent.projectId === projectId);

  const nextCompactions = {
    ...(agent.contextCompactions ?? {}),
    [scopeKey]: compaction,
  };
  const nextScopeTokens = {
    ...(agent.scopeTokens ?? {}),
    [scopeKey]: estimatedTokensAfter,
  };

  const updatedAgent = store.updateAgent(agent.id, {
    sessionId: shouldClearLegacySession ? null : agent.sessionId,
    sessions: nextSessions,
    contextCompactions: nextCompactions,
    scopeTokens: nextScopeTokens,
  });

  const reason = opts?.reason ?? 'manual';
  const summaryPreview = summary.replace(/\s+/g, ' ').trim().slice(0, 180);

  // Keep full message history untouched; append a visual divider marker in the timeline
  store.createMessage({
    projectId,
    agentId: agent.id,
    author: 'system',
    text: summary,
    streaming: false,
    metadata: {
      compacted: true,
      compactedCount: toCompact.length,
      compactedSummaryPreview: summaryPreview,
    },
  });

  store.addActivity({
    projectId,
    agentId: agent.id,
    kind: 'status',
    label: reason === 'auto' ? 'Auto-compacted context' : 'Compacted context',
    detail: `Summarized ${toCompact.length} messages (~${estimatedTokensBefore} → ~${estimatedTokensAfter} tokens)`,
  });

  return {
    compacted: true,
    compaction,
    compactedCount: toCompact.length,
    agent: updatedAgent ?? store.getAgent(agent.id),
  };
}
