import { useSyncExternalStore } from 'react';
import { id } from './id';

/**
 * Two-language UI (English / Bahasa Indonesia).
 *
 * Source strings are written in English and wrapped in `t('English text')`. Indonesian lives in
 * ./id.ts keyed by that same English text; a missing key simply shows the English text.
 * `t('Saved {name}', { name })` fills `{name}` placeholders.
 *
 * Inside components call `const t = useT()` so the screen re-renders when the language changes;
 * anywhere else (toasts, helpers) the plain `t` import works because it reads the current language.
 */
export type Lang = 'en' | 'id';

export const LANGUAGES: Array<{ value: Lang; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'id', label: 'Bahasa Indonesia' },
];

const STORAGE_KEY = 'atelier.language';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'id') return saved;
  } catch {
    // storage can be unavailable; fall through to the browser language
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('id')
    ? 'id'
    : 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  document.documentElement.lang = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

export const t: TFn = (key, vars) => {
  const text = current === 'id' ? (id[key] ?? key) : key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
};

/** Hook form of `t`: re-renders the component when the language changes. */
export function useT(): TFn {
  useSyncExternalStore(subscribe, getLang, getLang);
  return t;
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

if (typeof document !== 'undefined') document.documentElement.lang = current;
