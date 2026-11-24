import { useState } from 'react';
import type { CanonEntry } from '@atelier/contracts';
import { api } from '../api';
import { useT } from '../i18n';

export function CanonPanel({ entries }: { entries: CanonEntry[] }) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not update Canon.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="canon-panel">
      <summary>{t('Canon')} <span>{entries.length}</span></summary>
      {entries.length === 0 && <p>{t('No saved decisions or assets yet.')}</p>}
      {error && <p role="alert">{error}</p>}
      {entries.map((entry) => (
        <div key={entry.id} className="canon-entry">
          <div className="canon-entry-key"><span>{entry.kind}</span> <code>{entry.key}</code></div>
          {entry.artifactId && (entry.path?.endsWith('.svg') || entry.key === 'brand.logo') && (
            <img
              src={`/api/projects/${encodeURIComponent(entry.scopeKey)}/canon-artifacts/${encodeURIComponent(entry.artifactId)}`}
              alt={entry.title}
              loading="lazy"
            />
          )}
          {editing === entry.id ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void save(() => api.editCanon(entry, {
                title: String(form.get('title')), value: String(form.get('value')), path: entry.path,
              }));
            }}>
              <input name="title" aria-label={t('Title')} defaultValue={entry.title} maxLength={120} required />
              <textarea name="value" aria-label={t('Value')} defaultValue={entry.value} maxLength={300} required />
              <div className="canon-entry-actions">
                <button disabled={busy}>{t('Save')}</button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>{t('Cancel')}</button>
              </div>
            </form>
          ) : (
            <>
              <div>{entry.title}</div>
              <p>{entry.value}</p>
              {entry.path && <code>{entry.path}</code>}
              <div className="canon-entry-actions">
                <button type="button" disabled={busy} onClick={() => setEditing(entry.id)}>{t('Edit')}</button>
                <button type="button" disabled={busy} onClick={() => void save(() => api.deleteCanon(entry))}>{t('Delete')}</button>
              </div>
            </>
          )}
        </div>
      ))}
    </details>
  );
}
