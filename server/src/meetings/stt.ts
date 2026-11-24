export interface SttProvider {
  prepare(): Promise<void>;
  transcribe(
    wav: Buffer,
    opts: { language: 'auto' | 'id' | 'en'; prompt?: string; signal: AbortSignal },
  ): Promise<{ text: string }>;
  release(): Promise<void>;
}
