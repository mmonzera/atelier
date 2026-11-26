import type { Agent, MessageAttachment, ModelProvider, PermissionGrant, Project } from '@atelier/contracts';
import type { DetectedPermissionDenial } from './permissions.js';

export interface Turn {
  agent: Agent;
  project: Project | null;
  channelId?: string | null;
  trust?: 'user' | 'teammate';
  turnPurpose?: 'dispatch' | 'work';
  rootMessageId?: string | null;
  prompt: string;
  /** Files the user attached to this turn's message (already listed in `prompt`). */
  attachments?: MessageAttachment[];
  resumeSessionId: string | null;
  currentMessageId?: string | null;
  replyMessageId?: string | null;
  canonText?: string;
  canonChanged?: boolean;
  /** Selective memory: blok memory untuk turn ini (ditaruh di user prompt, bukan system prompt). */
  memoryBlock?: string;
  /** Selective memory: ringkasan compaction tidak ikut system prompt/room summary. */
  omitCompaction?: boolean;
  memoryOnly?: boolean;
  recallContinuation?: boolean;
  providerOverride?: ModelProvider;
  modelOverride?: string;
  oneTimeGrants?: PermissionGrant[];
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onTool(name: string, input: unknown): void;
  onSession(sessionId: string): void;
  onPermissionDenied?(denial: DetectedPermissionDenial): void;
  /** `costUsd` is the provider-reported cost when available (e.g. OpenRouter); otherwise it is estimated. */
  onUsage?(inputTokens: number, outputTokens: number, costUsd?: number): void;
  onContextTokens?(tokens: number): void;
  onMemoryTail?(tokens: number, extras?: { stubs?: number; delta?: number }): void;
}

export interface AgentRunner {
  run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }>;
  /** `opts.systemPrompt` replaces the built-in (agent memory) summary instructions, e.g. for meeting notes. */
  summarize?(provider: ModelProvider, model: string | undefined, input: string, signal: AbortSignal, opts?: { systemPrompt?: string }): Promise<string>;
}
