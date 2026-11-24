import type {
  Agent,
  AutoCompactSettings,
  CompactTrigger,
  Message,
  StructuredMemory,
  ThreadCompaction,
} from '@atelier/contracts';
import { summarizeDesignBlocks } from '@atelier/contracts';
import { z } from 'zod';
import type { AtelierStore } from '../store.js';

export type { CompactTrigger } from '@atelier/contracts';

const MAX_SUMMARY_CHARS = 8000;
export const DEFAULT_TAIL_TOKENS = 6000;

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
function designPicks(messages: Message[]) {
  const picks = new Map<string, Map<number, string>>();
  for (const message of messages) {
    const pick = message.metadata?.designPick;
    if (!pick) continue;
    const options = picks.get(pick.messageId) ?? new Map<number, string>();
    options.set(pick.segmentIndex ?? 0, pick.optionId);
    picks.set(pick.messageId, options);
  }
  return picks;
}

function archiveText(message: Message, picks?: ReadonlyMap<number, string>): string {
  return summarizeDesignBlocks(message.text, message.metadata?.designArtifacts, picks);
}

function trimHistory(text: string, id: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n… [trimmed, full text in archive ${id}]\n${tail ? text.slice(-tail) : ''}`;
}

export function conversationTail(
  messages: Message[],
  compaction: ThreadCompaction | null | undefined,
  currentPrompt: string,
  budget = DEFAULT_TAIL_TOKENS,
  attachmentNote?: (m: Message) => string,
  currentMessageId?: string | null,
): string {
  const history = getUncompactedMessages(messages, compaction);
  const last = history.at(-1);
  const current = currentMessageId ?? (last?.author === 'user' &&
    (currentPrompt === last.text || currentPrompt.startsWith(last.text + (attachmentNote?.(last) || '\n')))
    ? last.id : undefined);
  const picks = designPicks(messages);
  const header = 'Recent conversation context:';
  let remaining = Math.min(DEFAULT_TAIL_TOKENS, Math.max(0, budget)) * 4 - header.length;
  const lines: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.id === current) continue;
    const text = archiveText(message, picks.get(message.id));
    const body = message.author === 'user'
      ? trimHistory(text, message.id, 4800, 0)
      : trimHistory(text, message.id, 1200, 600);
    const author = `${message.author.toUpperCase()}: `;
    const attachment = (attachmentNote?.(message) ?? '').slice(0, 1200);
    let line = author + body + attachment;
    if (!lines.length && line.length + 1 > remaining) {
      const available = remaining - author.length - attachment.length - 60 - message.id.length;
      if (available > 0) {
        const tail = message.author === 'user' ? 0 : Math.min(600, Math.floor(available / 3));
        line = author + trimHistory(text, message.id, available - tail, tail) + attachment;
      }
    }
    remaining -= line.length + 1;
    if (remaining < 0) break;
    lines.push(line);
  }
  return lines.length ? [header, ...lines.reverse()].join('\n') : '';
}

export function formatUncompactedConversation(
  messages: Message[],
  compaction: ThreadCompaction | null | undefined,
  currentPrompt: string,
  tailTokens = DEFAULT_TAIL_TOKENS,
  /** Appends the attached-file list for messages that had attachments. */
  attachmentNote?: (m: Message) => string,
  currentMessageId?: string | null,
): string {
  const tail = conversationTail(messages, compaction, currentPrompt, tailTokens, attachmentNote, currentMessageId);
  return tail ? `${tail}\n\nCURRENT MESSAGE: ${currentPrompt}` : currentPrompt;
}

/** Perkiraan token yang dikendalikan Atelier: ringkasan + pesan yang belum dipadatkan. */
export function estimateConversationTokens(
  messages: Message[],
  compaction?: ThreadCompaction | null,
): number {
  const uncompacted = getUncompactedMessages(messages, compaction);
  const picks = designPicks(messages);
  return (
    estimateTokens(compaction?.summary ?? '') +
    uncompacted.reduce((acc, m) => acc + estimateTokens(archiveText(m, picks.get(m.id))), 0)
  );
}

export function estimateActiveContextTokens(
  messages: Message[],
  compaction?: ThreadCompaction | null,
  reportedScopeTokens?: number,
): number {
  return Math.max(estimateConversationTokens(messages, compaction), reportedScopeTokens ?? 0);
}

export function autoCompactTrigger(
  messages: Message[],
  compaction: ThreadCompaction | undefined | null,
  reportedProviderTokens: number | undefined,
  config: AutoCompactSettings,
): CompactTrigger | null {
  if (!config.enabled) return null;
  const uncompacted = getUncompactedMessages(messages, compaction);
  const compactable = uncompacted.length - config.keepRecentMessages;
  const minBatch = config.minCompactMessages ?? 10;

  // darurat: prompt provider hampir penuh → padatkan apa pun yang bisa (≥ 2 pesan)
  const providerLimit = config.providerContextLimit ?? 100000;
  if ((reportedProviderTokens ?? 0) >= providerLimit && uncompacted.length >= 3) {
    return 'provider_limit';
  }

  if (compactable < minBatch) return null;
  if (uncompacted.length >= config.maxMessages) return 'messages';
  if (estimateConversationTokens(messages, compaction) >= config.maxContextTokens) {
    return 'conversation_tokens';
  }
  return null;
}

export function shouldAutoCompact(
  messages: Message[],
  compaction: ThreadCompaction | undefined | null,
  reportedScopeTokens: number | undefined,
  config: AutoCompactSettings,
): boolean {
  return autoCompactTrigger(messages, compaction, reportedScopeTokens, config) !== null;
}

const PATH_RE = /\b(?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]+\b/gi;
// Explicit decision phrasing only. Bare words like "use", "pakai", "harus", "jangan" appear in
// nearly every message and flooded DECISIONS; real decisions belong in Canon (record_decision).
const DECISION_RE = /\b(?:decided|diputuskan|from now on|mulai sekarang|always|never|we(?:'ll| will| use| chose| choose)|kita pakai|fix(?:ed)? pakai)\b/i;
const MAX_DECISIONS = 30;
// Per-section char budgets (sum ≈ MAX_SUMMARY_CHARS) so DECISIONS can't starve DONE/OPEN.
const SECTION_BUDGET = [0, 2000, 2800, 1800, 1200] as const;
const clean = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

function unique<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

export function buildDeterministicMemory(
  previous: ThreadCompaction | null,
  messages: Message[],
  allMessages = messages,
): StructuredMemory {
  const previousMemory = previous?.structured;
  const picks = designPicks(allMessages);
  const decisions = [...(previousMemory?.decisions ?? [])];
  const done = [...(previousMemory?.done ?? (previous?.summary ? [{ text: clean(previous.summary, 800) }] : []))];
  const open = [...(previousMemory?.open ?? [])];
  const artifacts = [...(previousMemory?.artifacts ?? [])];
  let goal = previousMemory?.goal ?? '';
  for (const message of messages) {
    const text = archiveText(message, picks.get(message.id));
    const short = clean(text, message.author === 'user' ? 400 : 180);
    if (message.author === 'user') {
      goal ||= short;
      if (DECISION_RE.test(short) || message.metadata?.designPick) decisions.push(short);
      else open.push(short);
    } else {
      const paths = [...new Set(text.match(PATH_RE) ?? [])].slice(0, 12);
      done.push({ text: short, ...(paths.length ? { paths } : {}) });
    }
    for (const [option, id] of Object.entries(message.metadata?.designArtifacts ?? {})) {
      artifacts.push({ id, label: `Design option ${option.split(':').at(-1)}` });
    }
  }
  return {
    goal,
    decisions: [...new Set(decisions)].slice(-MAX_DECISIONS),
    done: unique(done, (item) => item.text).slice(-100),
    open: [...new Set(open)].slice(-40),
    artifacts: unique(artifacts, (item) => item.id).slice(-100),
  };
}

export function renderStructuredMemory(memory: StructuredMemory): string {
  const sections = [
    ['GOAL', clean(memory.goal, 400)],
    ['DECISIONS'],
    ['DONE'],
    ['OPEN'],
    ['ARTIFACTS'],
  ];
  let remaining = MAX_SUMMARY_CHARS - sections.flat().join('\n').length - 5;
  const add = (section: number, lines: string[]) => {
    let budget = SECTION_BUDGET[section as 1 | 2 | 3 | 4];
    for (const line of lines) {
      const cost = line.length + 3;
      if (cost > remaining || cost > budget) continue;
      sections[section]!.push('- ' + line);
      remaining -= cost;
      budget -= cost;
    }
  };
  add(1, memory.decisions.map((decision) => clean(decision, 400)));
  add(4, memory.artifacts.slice().reverse().map((item) =>
    clean(`${item.id} ${item.label}${item.path ? ' ' + item.path : ''}`, 350)));
  add(2, memory.done.slice().reverse().map((item) =>
    clean([item.text, ...(item.paths ?? [])].join(' · '), 550)));
  add(3, memory.open.slice().reverse().map((item) => clean(item, 400)));
  return sections.flat().join('\n');
}

export function buildDeterministicSummary(previousSummary: string | undefined, messages: Message[]): string {
  const previous = previousSummary ? { summary: previousSummary } as ThreadCompaction : null;
  return renderStructuredMemory(buildDeterministicMemory(previous, messages));
}

const memoryLine = z.string().trim().max(550);
const ModelMemorySchema = z.object({
  goal: memoryLine,
  decisions: z.array(memoryLine).max(50),
  done: z.array(z.object({ text: memoryLine, paths: z.array(memoryLine).max(12).optional() })).max(50),
  open: z.array(memoryLine).max(50),
  artifacts: z.array(z.object({ id: z.string().regex(/^art_[a-z0-9-]+$/i), label: memoryLine, path: memoryLine.optional() })).max(50),
});

export function mergeModelMemory(output: string, fallback: StructuredMemory): StructuredMemory {
  if (output.length > 32000) throw new Error('Invalid summary length.');
  const payload = output.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const model = ModelMemorySchema.parse(JSON.parse(payload));
  return {
    goal: model.goal || fallback.goal,
    decisions: [...new Set([...fallback.decisions, ...model.decisions])],
    done: unique([...fallback.done.filter((item) => item.paths?.length), ...model.done], (item) => item.text),
    open: model.open,
    artifacts: fallback.artifacts,
  };
}

export interface CompactScopeResult {
  compacted: boolean;
  compaction: ThreadCompaction | null;
  compactedCount: number;
  agent: Agent | null;
  summarizerInput?: string;
}

export function compactAgentScope(
  store: AtelierStore,
  agentId: string,
  projectId: string | null,
  opts?: { force?: boolean; reason?: 'auto' | 'manual'; keepRecentMessages?: number; trigger?: CompactTrigger },
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

  const keepBudget = opts?.keepRecentMessages ?? settings.autoCompact.keepRecentMessages;
  const targetKeep = opts?.force
    ? Math.min(2, Math.max(0, uncompacted.length - 1))
    : opts?.trigger === 'provider_limit'
      ? Math.min(keepBudget, Math.max(2, uncompacted.length - 2))
      : Math.min(keepBudget, Math.max(0, uncompacted.length - 1));

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
  const structured = buildDeterministicMemory(prevCompaction, toCompact, allMessages);
  const picks = designPicks(allMessages);
  const summary = renderStructuredMemory(structured);
  const estimatedTokensAfter =
    estimateTokens(summary) + estimateTokens(conversationTail(kept, null, '', settings.autoCompact.tailTokens));

  const compaction: ThreadCompaction = {
    summary,
    structured,
    compactedMessageCount: (prevCompaction?.compactedMessageCount ?? 0) + toCompact.length,
    lastCompactedMessageId: toCompact[toCompact.length - 1]!.id,
    compactedAt: new Date().toISOString(),
    estimatedTokensBefore,
    estimatedTokensAfter,
    ...(opts?.trigger ? { trigger: opts.trigger } : {}),
  };

  // Manual compaction explicitly resets the session. Automatic compaction only rotates on provider limit.
  const prevScopeSession = agent.sessions?.[scopeKey];
  const reportedTokens = agent.scopeTokens?.[scopeKey] ?? 0;
  const rotate = opts?.reason !== 'auto' || opts?.trigger === 'provider_limit';
  const nextSessions = { ...(agent.sessions ?? {}) };
  if (rotate) delete nextSessions[scopeKey];

  const shouldClearLegacySession = rotate && (
    Boolean(prevScopeSession && agent.sessionId === prevScopeSession) ||
    (!prevScopeSession && projectId !== null && agent.projectId === projectId));

  const conversationTokensAfter =
    estimateTokens(summary) +
    kept.reduce((acc, m) => acc + estimateTokens(archiveText(m, picks.get(m.id))), 0);

  const nextCompactions = {
    ...(agent.contextCompactions ?? {}),
    [scopeKey]: compaction,
  };
  const nextScopeTokens = {
    ...(agent.scopeTokens ?? {}),
    [scopeKey]: rotate ? estimatedTokensAfter : reportedTokens,
  };
  const nextConversationTokens = {
    ...(agent.conversationTokens ?? {}),
    [scopeKey]: conversationTokensAfter,
  };

  const updatedAgent = store.updateAgent(agent.id, {
    sessionId: shouldClearLegacySession ? null : agent.sessionId,
    sessions: nextSessions,
    contextCompactions: nextCompactions,
    scopeTokens: nextScopeTokens,
    conversationTokens: nextConversationTokens,
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
    summarizerInput: JSON.stringify({
      previous: prevCompaction?.summary.slice(0, MAX_SUMMARY_CHARS),
      messages: toCompact.slice(-60).map((message) => ({
        id: message.id,
        author: message.author,
        text: trimHistory(archiveText(message, picks.get(message.id)), message.id, 400, 200),
      })),
    }),
  };
}
