import { useState } from 'react';
import type { MessageMemoryUsed } from '@atelier/contracts';
import { Brain } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';

type Item = { id: string; source: string; kind: string; title: string; line: string; pinned: boolean };

/**
 * Inspector kecil di bawah balasan agent: memory apa yang dikirim (push) dan yang ditarik agent
 * sendiri (recall) di turn itu. Hanya muncul bila selective memory aktif saat turn berjalan.
 */
export function MemoryChip({ used, scope }: { used?: MessageMemoryUsed; scope: string | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  if (!used || (used.pushed.length === 0 && used.recalled.length === 0)) return null;

  const ids = [...new Set([...used.pushed, ...used.recalled])];
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !items) {
      try {
        setItems((await api.memoryItems(scope, ids)).items);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('Could not load memory.'));
      }
    }
  };
  const recalled = new Set(used.recalled);

  return (
    <div style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--text-tertiary)' }}>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
          borderRadius: 'var(--radius-full)', background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)', color: 'inherit', fontSize: 11, cursor: 'pointer',
        }}
      >
        <Brain size={11} strokeWidth={1.75} />
        {t('{count} memory · {tokens} tok', { count: ids.length, tokens: used.tokens })}
      </button>
      {open && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {error && <li role="alert">{error}</li>}
          {!items && !error && <li>{t('Loading…')}</li>}
          {items?.map((item) => (
            <li key={item.id} title={item.line}>
              <code>{item.id}</code> · {item.kind} · {item.title.slice(0, 80)}
              {recalled.has(item.id) ? ` · ${t('recalled')}` : item.pinned ? ` · ${t('pinned')}` : ''}
            </li>
          ))}
          {items && items.length < ids.length && <li>{t('{count} items are no longer available.', { count: ids.length - items.length })}</li>}
        </ul>
      )}
    </div>
  );
}
