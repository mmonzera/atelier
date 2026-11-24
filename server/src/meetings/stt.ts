export interface SttProvider {
  prepare(): Promise<void>;
  transcribe(
    wav: Buffer,
    opts: { language: 'auto' | 'id' | 'en'; prompt?: string; signal: AbortSignal },
  ): Promise<{ text: string }>;
  release(): Promise<void>;
  /**
   * true while a meeting is being recorded: transcribe only with CPU nobody else wants (Windows
   * "Idle" priority) so the meeting app and Atelier stay responsive. false after Stop, to finish fast.
   */
  setBackground?(background: boolean): void;
}
