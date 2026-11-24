import type { Agent, MessageAttachment, ModelProvider, Project } from '@atelier/contracts';

export interface Turn {
  agent: Agent;
  project: Project | null;
  prompt: string;
  /** Files the user attached to this turn's message (already listed in `prompt`). */
  attachments?: MessageAttachment[];
  resumeSessionId: string | null;
  currentMessageId?: string | null;
  canonText?: string;
  canonChanged?: boolean;
  memoryOnly?: boolean;
  recallContinuation?: boolean;
  providerOverride?: ModelProvider;
  modelOverride?: string;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onTool(name: string, input: unknown): void;
  onSession(sessionId: string): void;
  /** `costUsd` is the provider-reported cost when available (e.g. OpenRouter); otherwise it is estimated. */
  onUsage?(inputTokens: number, outputTokens: number, costUsd?: number): void;
  onContextTokens?(tokens: number): void;
  onMemoryTail?(tokens: number): void;
}

export interface AgentRunner {
  run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }>;
  summarize?(provider: ModelProvider, model: string | undefined, input: string, signal: AbortSignal): Promise<string>;
}
