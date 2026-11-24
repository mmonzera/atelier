import type { Agent, ModelProvider, Project } from '@atelier/contracts';

export interface Turn {
  agent: Agent;
  project: Project | null;
  prompt: string;
  resumeSessionId: string | null;
  providerOverride?: ModelProvider;
  modelOverride?: string;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onTool(name: string, input: unknown): void;
  onSession(sessionId: string): void;
  onUsage?(inputTokens: number, outputTokens: number): void;
}

export interface AgentRunner {
  run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }>;
}
