import { useT } from '../../i18n';
import type { GhRepoItem, Project } from '@atelier/contracts';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import {
  ModalShell,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ModalShell';
import { toast } from '../Toast';

/* 1. New Project Modal */
export function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createProject({
        name: name.trim(),
        localPath: folder.trim() || undefined,
      });
      onCreated(res.project);
      toast.success(t('Project “{name}” created', { name: res.project.name }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to create project'));
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    setPicking(true);
    setError(null);
    try {
      const res = await api.pickFolder();
      if (res.path) {
        setFolder(res.path);
        if (!name.trim()) setName(res.path.split(/[\/]/).filter(Boolean).pop() ?? '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open folder picker'));
    } finally {
      setPicking(false);
    }
  };

  return (
    <ModalShell
      title={t('New project')}
      subtitle={t('Creates an empty workspace. Attach a project folder now, and add agents whenever you need them.')}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>{t('Project name')}</label>
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('e.g. Growth Bot Team')}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>{t('Project folder (optional)')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={t('e.g. D:\\Projects\\my-app')}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              onClick={() => void browse()}
              disabled={picking}
              style={{ ...secondaryBtnStyle, flexShrink: 0 }}
            >
              {picking ? t('Opening…') : t('Browse…')}
            </button>
          </div>
        </div>
        {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} style={secondaryBtnStyle}>{t('Cancel')}
          </button>
          <button type="submit" disabled={!name.trim() || saving} style={primaryBtnStyle}>
            {saving ? t('Creating…') : t('Create project')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* 2. Link Repository Modal */
export function LinkRepoModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const t = useT();
  const [repos, setRepos] = useState<GhRepoItem[]>([]);
  const [ghError, setGhError] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [fullName, setFullName] = useState(project.repo?.fullName ?? '');
  const [localPath, setLocalPath] = useState(project.repo?.localPath ?? '');
  const [mode, setMode] = useState<'github' | 'local'>('local');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getGithubRepos()
      .then((res) => {
        setRepos(res.repos);
        if (res.error) setGhError(res.error);
      })
      .catch((err) => {
        setGhError(err instanceof Error ? err.message : t('Unable to query GitHub CLI'));
      })
      .finally(() => setLoadingRepos(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinking(true);
    setError(null);
    try {
      if (mode === 'local') {
        await api.linkRepo(project.id, {
          localPath: localPath.trim(),
          fullName: fullName.trim() || undefined,
        });
      } else {
        const picked = repos.find((r) => r.nameWithOwner === fullName.trim());
        await api.linkRepo(project.id, {
          fullName: fullName.trim(),
          defaultBranch: picked?.defaultBranch,
        });
      }
      toast.success(t('Repository linked'));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to link repository'));
    } finally {
      setLinking(false);
    }
  };

  return (
    <ModalShell
      title={t('Link repository')}
      subtitle={t('Attach a local folder or clone via `gh` for shell-enabled bots.')}
      width={520}
      onClose={onClose}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          onClick={() => setMode('local')}
          style={{
            ...secondaryBtnStyle,
            background: mode === 'local' ? 'var(--surface-3)' : 'var(--surface-2)',
            color: mode === 'local' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >{t('Local directory')}
        </button>
        <button
          type="button"
          onClick={() => setMode('github')}
          style={{
            ...secondaryBtnStyle,
            background: mode === 'github' ? 'var(--surface-3)' : 'var(--surface-2)',
            color: mode === 'github' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >{t('GitHub (gh CLI)')}
        </button>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {mode === 'github' ? (
          <>
            {loadingRepos ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('Loading repositories from GitHub CLI…')}
              </div>
            ) : repos.length > 0 ? (
              <div
                style={{
                  maxHeight: 180,
                  overflowY: 'auto',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                {repos.map((r) => (
                  <button
                    key={r.nameWithOwner}
                    type="button"
                    onClick={() => setFullName(r.nameWithOwner)}
                    style={{
                      textAlign: 'left',
                      padding: '7px 10px',
                      borderRadius: 6,
                      background:
                        fullName === r.nameWithOwner ? 'var(--surface-3)' : 'transparent',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>{r.nameWithOwner}</span>
                    <span className="mono-num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {r.defaultBranch}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {ghError || t('No repositories returned. Enter owner/repo below or switch to Local directory.')}
              </div>
            )}

            <div>
              <label style={labelStyle}>{t('GitHub repository (owner/name)')}</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={t('owner/repo')}
                style={inputStyle}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label style={labelStyle}>{t('Local repository or folder path')}</label>
              <input
                type="text"
                autoFocus
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder={t('D:\\Projects\\my-app')}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>{t('Display name (optional)')}</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={t('org/my-app')}
                style={inputStyle}
              />
            </div>
          </>
        )}

        {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={secondaryBtnStyle}>{t('Cancel')}
          </button>
          <button
            type="submit"
            disabled={linking || (mode === 'github' ? !fullName.trim() : !localPath.trim())}
            style={primaryBtnStyle}
          >
            {linking ? t('Linking…') : mode === 'github' ? t('Clone & Link') : t('Link Local Repo')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* 3. Project Archive / Delete Modal */
export function ProjectManageModal({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [deleteRepo, setDeleteRepo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleArchive = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { archived: true });
      toast.info(t('Project “{name}” archived', { name: project.name }));
      onDeleted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await api.deleteProject(project.id, { deleteRepo });
      toast.deleted(t('Project “{name}” deleted', { name: project.name }));
      onDeleted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={t('Manage {name}', { name: project.name })}
      subtitle={t('Archive or permanently delete this project workspace.')}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{t('Hide from sidebar while keeping SQLite history.')}
          </div>
          <button type="button" disabled={busy} onClick={handleArchive} style={secondaryBtnStyle}>{t('Archive')}
          </button>
        </div>

        <div style={{ height: 1, background: 'var(--border-subtle)' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, color: 'var(--agent-red)' }}>{t('Delete project permanently')}
          </div>
          {project.repo?.localPath && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={deleteRepo}
                onChange={(e) => setDeleteRepo(e.target.checked)}
              />{t('Also delete local cloned repository folder (')}{project.repo.localPath})
            </label>
          )}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.checked)}
            />{t('Confirm permanent deletion of messages, agents, and tasks')}
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryBtnStyle}>{t('Cancel')}
            </button>
            <button
              type="button"
              disabled={!confirmDelete || busy}
              onClick={handleDelete}
              style={{
                ...secondaryBtnStyle,
                borderColor: 'rgba(248, 113, 113, 0.45)',
                color: confirmDelete ? 'var(--agent-red)' : 'var(--text-muted)',
              }}
            >{t('Delete Project')}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
