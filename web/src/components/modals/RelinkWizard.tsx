import type { RelinkCandidate } from '@atelier/contracts';
import { CheckCircle2, FolderOpen, GitBranch, Unlink } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { toast } from '../Toast';
import { ModalShell, primaryBtnStyle, secondaryBtnStyle } from './ModalShell';

type RowState = { state: 'pending' | 'busy' | 'done'; note?: string; error?: string };

/**
 * After importing a backup on a new laptop, repo folders usually live at a different path.
 * Each project can be pointed at its folder, re-cloned from GitHub, or left unlinked for now.
 */
export function RelinkWizard({ candidates, onClose }: { candidates: RelinkCandidate[]; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(candidates.map((c) => [c.projectId, { state: 'pending' as const }])),
  );

  const set = (id: string, next: RowState) => setRows((prev) => ({ ...prev, [id]: next }));

  const run = async (c: RelinkCandidate, action: 'folder' | 'clone' | 'unlink') => {
    try {
      if (action === 'folder') {
        const picked = await api.pickFolder();
        if (!picked.path) return;
        set(c.projectId, { state: 'busy' });
        await api.linkRepo(c.projectId, { localPath: picked.path, fullName: c.repoFullName });
        set(c.projectId, { state: 'done', note: picked.path });
      } else if (action === 'clone') {
        set(c.projectId, { state: 'busy', note: 'Cloning…' });
        const { project } = await api.linkRepo(c.projectId, { fullName: c.repoFullName });
        set(c.projectId, { state: 'done', note: project.repo?.localPath ?? 'Cloned' });
      } else {
        set(c.projectId, { state: 'busy' });
        await api.unlinkRepo(c.projectId);
        set(c.projectId, { state: 'done', note: 'Dilepas — bisa ditautkan lagi kapan saja' });
      }
    } catch (err) {
      set(c.projectId, { state: 'pending', error: err instanceof Error ? err.message : 'Gagal' });
    }
  };

  const remaining = candidates.filter((c) => rows[c.projectId]?.state !== 'done').length;

  return (
    <ModalShell
      title="Tautkan ulang folder repo"
      subtitle={`${candidates.length} project menunjuk ke folder yang tidak ada di laptop ini.`}
      width={620}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {candidates.map((c) => {
          const row = rows[c.projectId] ?? { state: 'pending' };
          const busy = row.state === 'busy';
          return (
            <div
              key={c.projectId}
              style={{
                padding: 12,
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{c.projectName}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{c.repoFullName}</div>
                  <div
                    title={c.previousPath}
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textDecoration: row.state === 'done' ? 'line-through' : undefined,
                    }}
                  >
                    {c.previousPath}
                  </div>
                </div>
                {row.state === 'done' && (
                  <CheckCircle2 size={16} strokeWidth={1.6} style={{ color: 'var(--agent-green)', flexShrink: 0 }} />
                )}
              </div>

              {row.state === 'done' ? (
                <div style={{ fontSize: 11.5, color: 'var(--agent-green)', fontFamily: 'var(--font-mono)' }}>{row.note}</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button type="button" disabled={busy} onClick={() => run(c, 'folder')} style={secondaryBtnStyle}>
                    <FolderOpen size={13} strokeWidth={1.6} /> Pilih folder…
                  </button>
                  {c.canClone && (
                    <button type="button" disabled={busy} onClick={() => run(c, 'clone')} style={secondaryBtnStyle}>
                      <GitBranch size={13} strokeWidth={1.6} /> Clone dari GitHub
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => run(c, 'unlink')} style={secondaryBtnStyle}>
                    <Unlink size={13} strokeWidth={1.6} /> Lewati
                  </button>
                  {busy && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', alignSelf: 'center' }}>{row.note ?? 'Menautkan…'}</span>}
                </div>
              )}
              {row.error && <div style={{ fontSize: 11.5, color: 'var(--agent-red)' }}>{row.error}</div>}
            </div>
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            style={primaryBtnStyle}
            onClick={() => {
              if (remaining === 0) toast.success('Semua repo sudah tertaut');
              onClose();
            }}
          >
            {remaining === 0 ? 'Selesai' : `Nanti saja (${remaining} tersisa)`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
