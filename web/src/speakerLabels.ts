import type { AgentColor, MeetingSpeaker } from '@atelier/contracts';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** The name to show: the one the user gave, else an automatic one in the UI language. */
export function speakerName(t: TFn, speaker: Pick<MeetingSpeaker, 'id' | 'name'>): string {
  const own = speaker.name?.trim();
  if (own) return own;
  return automaticSpeakerName(t, speaker.id);
}

export function automaticSpeakerName(t: TFn, id: string): string {
  if (id === 'me') return t('Me');
  if (id === 'others') return t('Others');
  const n = /^spk_(\d+)$/.exec(id)?.[1];
  return n ? t('Speaker {n}', { n }) : id;
}

export function speakerColor(color: AgentColor | undefined): string {
  return `var(--agent-${color ?? 'slate'})`;
}

/** 0:12 or 1:02:05 */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
