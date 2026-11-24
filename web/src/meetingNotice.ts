import type { ModelProvider, Settings } from '@atelier/contracts';

export const DEFAULT_NOTICE_ID =
  'Info: saya memakai asisten AI di laptop saya untuk mencatat poin penting meeting ini. Kalau ada yang keberatan, kabari saya.';
export const DEFAULT_NOTICE_EN =
  "Heads-up: I'm using an AI assistant on my laptop to take notes during this meeting. Let me know if you'd rather I didn't.";

export const PROVIDER_DISPLAY_NAMES: Record<ModelProvider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'ChatGPT (OpenAI)',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
};

/** The message to paste into the meeting chat, with a note when the summary uses an external provider. */
export function buildMeetingNotice(settings: Settings, lang: 'en' | 'id', draft?: string): string {
  const meeting = settings.meeting;
  const saved = lang === 'id' ? meeting?.noticeTextId : meeting?.noticeTextEn;
  const base = draft?.trim() || saved?.trim() || (lang === 'id' ? DEFAULT_NOTICE_ID : DEFAULT_NOTICE_EN);
  if (settings.provider === 'opencode') return base;
  const provider = PROVIDER_DISPLAY_NAMES[settings.provider] ?? settings.provider;
  return lang === 'id'
    ? `${base}\nAudio diproses di laptop saya. Teks transkrip dikirim ke ${provider} untuk membuat ringkasan.`
    : `${base}\nAudio is processed on my laptop. Transcript text is sent to ${provider} to create the summary.`;
}
