import type {
  BrowserProfile,
  BrowserStatusInfo,
  DetectedSitePreset,
  Settings,
  SiteCredential,
  SiteLoginStatus,
  SitePreset,
  TestSiteCredentialResult,
} from '@atelier/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, browserApi } from '../api';
import {
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from '../components/modals/ModalShell';
import { Select } from '../components/Select';
import { toast } from '../components/Toast';
import { useT } from '../i18n';

const cardStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function statusColor(status?: SiteLoginStatus): string {
  switch (status) {
    case 'ok':
      return 'var(--agent-green)';
    case 'needs_verification':
      return 'var(--agent-amber)';
    case 'wrong_password':
    case 'blocked':
    case 'error':
      return 'var(--agent-red)';
    default:
      return 'var(--text-tertiary)';
  }
}

function statusLabel(t: (k: string) => string, status?: SiteLoginStatus): string {
  switch (status) {
    case 'ok':
      return t('Signed in');
    case 'needs_verification':
      return t('Needs verification');
    case 'wrong_password':
      return t('Wrong password');
    case 'blocked':
      return t('Blocked / Captcha');
    case 'error':
      return t('Login error');
    default:
      return t('Not tested');
  }
}

function formatRelative(iso?: string | null): string {
  if (!iso) return '';
  const diffSec = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(diffSec) || diffSec < 0) return '';
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export function BrowserSettingsPanel({ settings }: { settings: Settings }) {
  const t = useT();
  const [status, setStatus] = useState<BrowserStatusInfo | null>(null);
  const [presets, setPresets] = useState<SitePreset[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [credentials, setCredentials] = useState<SiteCredential[]>([]);
  const [loading, setLoading] = useState(true);

  // Add/edit credential inline form
  const [credFormOpen, setCredFormOpen] = useState(false);
  const [editingCredId, setEditingCredId] = useState<string | null>(null);
  const [credPresetId, setCredPresetId] = useState<string>('mobbin');
  const [credLabel, setCredLabel] = useState('Mobbin');
  const [credOrigin, setCredOrigin] = useState('https://mobbin.com');
  const [credLoginUrl, setCredLoginUrl] = useState('https://mobbin.com/login');
  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credProfileId, setCredProfileId] = useState<string>('');
  const [savingCred, setSavingCred] = useState(false);

  // Credential testing & deletion
  const [testingCredId, setTestingCredId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ credId: string; res: TestSiteCredentialResult } | null>(null);
  const [confirmDeleteCredId, setConfirmDeleteCredId] = useState<string | null>(null);

  // Profiles inline form
  const [newProfileName, setNewProfileName] = useState('');
  const [addingProfile, setAddingProfile] = useState(false);
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);

  // Site presets inline form
  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetLoginUrl, setPresetLoginUrl] = useState('');
  const [presetOrigin, setPresetOrigin] = useState('');
  const [presetFlow, setPresetFlow] = useState<'single' | 'two_step'>('single');
  const [presetAdvancedOpen, setPresetAdvancedOpen] = useState(false);
  const [presetSelUser, setPresetSelUser] = useState('');
  const [presetSelPass, setPresetSelPass] = useState('');
  const [presetSelNext, setPresetSelNext] = useState('');
  const [presetSelSubmit, setPresetSelSubmit] = useState('');
  const [presetSuccessUrl, setPresetSuccessUrl] = useState('');
  const [presetSuccessSel, setPresetSuccessSel] = useState('');
  const [presetVerifySel, setPresetVerifySel] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectedPreview, setDetectedPreview] = useState<DetectedSitePreset | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [st, pr, pf, cr] = await Promise.all([
        browserApi.status(),
        browserApi.presets(),
        browserApi.listProfiles(),
        browserApi.listCredentials(),
      ]);
      setStatus(st);
      setPresets(pr.presets);
      setProfiles(pf.profiles);
      setCredentials(cr.credentials);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load browser settings'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, settings.sitePresets]);

  const applyPresetToCredForm = (pid: string) => {
    setCredPresetId(pid);
    if (pid === '__custom') {
      if (!editingCredId) {
        setCredLabel('');
        setCredOrigin('');
        setCredLoginUrl('');
      }
      return;
    }
    const found = presets.find((p) => p.id === pid);
    if (found) {
      setCredLabel(found.name);
      setCredOrigin(found.origin);
      setCredLoginUrl(found.loginUrl);
      const matchingProf = profiles.find(
        (pf) => pf.name.toLowerCase() === (found.defaultProfileName || found.name).toLowerCase(),
      );
      setCredProfileId(matchingProf?.id ?? '');
    }
  };

  const openAddCredForm = () => {
    setEditingCredId(null);
    const defaultPreset = presets[0];
    if (defaultPreset) {
      setCredPresetId(defaultPreset.id);
      setCredLabel(defaultPreset.name);
      setCredOrigin(defaultPreset.origin);
      setCredLoginUrl(defaultPreset.loginUrl);
      const matchingProf = profiles.find(
        (pf) => pf.name.toLowerCase() === (defaultPreset.defaultProfileName || defaultPreset.name).toLowerCase(),
      );
      setCredProfileId(matchingProf?.id ?? '');
    } else {
      setCredPresetId('__custom');
      setCredLabel('');
      setCredOrigin('');
      setCredLoginUrl('');
      setCredProfileId('');
    }
    setCredUsername('');
    setCredPassword('');
    setCredFormOpen(true);
  };

  const openEditCredForm = (c: SiteCredential) => {
    setEditingCredId(c.id);
    setCredPresetId(c.presetId || '__custom');
    setCredLabel(c.label);
    setCredOrigin(c.origin);
    setCredLoginUrl(c.loginUrl);
    setCredUsername(c.username);
    setCredPassword('');
    setCredProfileId(c.profileId);
    setCredFormOpen(true);
  };

  const saveCred = async (runTestAfter: boolean) => {
    const label = credLabel.trim();
    const loginUrl = credLoginUrl.trim();
    let origin = credOrigin.trim();
    if (!origin && loginUrl) {
      try {
        origin = new URL(loginUrl).origin;
      } catch {
        // validation below
      }
    }
    if (!label || !loginUrl || !origin || !credUsername.trim()) {
      toast.error(t('Fill site label, URL, and username.'));
      return;
    }
    if (!editingCredId && !credPassword) {
      toast.error(t('Password is required.'));
      return;
    }

    setSavingCred(true);
    try {
      let saved: SiteCredential;
      if (editingCredId) {
        const res = await browserApi.updateCredential(editingCredId, {
          label,
          presetId: credPresetId === '__custom' ? null : credPresetId,
          origin,
          loginUrl,
          username: credUsername.trim(),
          ...(credPassword ? { password: credPassword } : {}),
          ...(credProfileId ? { profileId: credProfileId } : {}),
        });
        saved = res.credential;
      } else {
        const res = await browserApi.createCredential({
          label,
          presetId: credPresetId === '__custom' ? null : credPresetId,
          origin,
          loginUrl,
          username: credUsername.trim(),
          password: credPassword,
          profileId: credProfileId || null,
        });
        saved = res.credential;
      }
      setCredFormOpen(false);
      setCredPassword('');
      await loadAll();
      toast.success(t('Saved login for {label}', { label: saved.label }));
      if (runTestAfter) {
        await runCredTest(saved.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save login'));
    } finally {
      setSavingCred(false);
    }
  };

  const runCredTest = async (id: string) => {
    setTestingCredId(id);
    try {
      const res = await browserApi.testCredential(id);
      setTestResult({ credId: id, res });
      await loadAll();
      if (res.status === 'ok') toast.success(res.message);
      else if (res.status === 'needs_verification') toast.info(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Login test failed'));
    } finally {
      setTestingCredId(null);
    }
  };

  const handleDeleteCred = async (id: string) => {
    try {
      await browserApi.deleteCredential(id);
      setConfirmDeleteCredId(null);
      if (testResult?.credId === id) setTestResult(null);
      await loadAll();
      toast.deleted(t('Login removed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to remove login'));
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    setAddingProfile(true);
    try {
      await browserApi.createProfile(newProfileName.trim());
      setNewProfileName('');
      await loadAll();
      toast.success(t('Browser profile created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to create profile'));
    } finally {
      setAddingProfile(false);
    }
  };

  const openAddPresetForm = () => {
    setEditingPresetId(null);
    setPresetName('');
    setPresetLoginUrl('');
    setPresetOrigin('');
    setPresetFlow('single');
    setPresetAdvancedOpen(false);
    setPresetSelUser('');
    setPresetSelPass('');
    setPresetSelNext('');
    setPresetSelSubmit('');
    setPresetSuccessUrl('');
    setPresetSuccessSel('');
    setPresetVerifySel('');
    setDetectedPreview(null);
    setPresetFormOpen(true);
  };

  const openEditPresetForm = (p: SitePreset) => {
    setEditingPresetId(p.id);
    setPresetName(p.name);
    setPresetLoginUrl(p.loginUrl);
    setPresetOrigin(p.origin);
    setPresetFlow(p.flow);
    setPresetAdvancedOpen(true);
    setPresetSelUser(p.selectors.username ?? '');
    setPresetSelPass(p.selectors.password ?? '');
    setPresetSelNext(p.selectors.next ?? '');
    setPresetSelSubmit(p.selectors.submit ?? '');
    setPresetSuccessUrl(p.successUrlIncludes ?? '');
    setPresetSuccessSel(p.successSelector ?? '');
    setPresetVerifySel(p.verifySelector ?? '');
    setDetectedPreview(null);
    setPresetFormOpen(true);
  };

  const handleDetectPreset = async () => {
    if (!presetLoginUrl.trim()) {
      toast.error(t('Enter a login URL first.'));
      return;
    }
    setDetecting(true);
    try {
      const { detected } = await browserApi.detectPreset(presetLoginUrl.trim());
      setDetectedPreview(detected);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Auto-detect failed'));
    } finally {
      setDetecting(false);
    }
  };

  const applyDetectedPreset = () => {
    if (!detectedPreview) return;
    setPresetOrigin(detectedPreview.origin);
    setPresetLoginUrl(detectedPreview.loginUrl);
    setPresetFlow(detectedPreview.flow);
    setPresetSelUser(detectedPreview.selectors.username ?? '');
    setPresetSelPass(detectedPreview.selectors.password ?? '');
    setPresetSelNext(detectedPreview.selectors.next ?? '');
    setPresetSelSubmit(detectedPreview.selectors.submit ?? '');
    setPresetAdvancedOpen(true);
    if (!presetName.trim()) {
      try {
        setPresetName(new URL(detectedPreview.origin).hostname.replace(/^www\./, ''));
      } catch {
        // ignore
      }
    }
  };

  const savePreset = async () => {
    const name = presetName.trim();
    const loginUrl = presetLoginUrl.trim();
    let origin = presetOrigin.trim();
    if (!origin && loginUrl) {
      try {
        origin = new URL(loginUrl).origin;
      } catch {
        // handled below
      }
    }
    if (!name || !loginUrl || !origin) {
      toast.error(t('Fill preset name and login URL.'));
      return;
    }
    setSavingPreset(true);
    try {
      const customList = (settings.sitePresets ?? []).slice();
      const id = editingPresetId ?? `custom_${Date.now().toString(36)}`;
      const nextPreset: SitePreset = {
        id,
        name,
        origin,
        loginUrl,
        flow: presetFlow,
        selectors: {
          ...(presetSelUser.trim() ? { username: presetSelUser.trim() } : {}),
          ...(presetSelPass.trim() ? { password: presetSelPass.trim() } : {}),
          ...(presetSelNext.trim() ? { next: presetSelNext.trim() } : {}),
          ...(presetSelSubmit.trim() ? { submit: presetSelSubmit.trim() } : {}),
        },
        ...(presetSuccessUrl.trim() ? { successUrlIncludes: presetSuccessUrl.trim() } : {}),
        ...(presetSuccessSel.trim() ? { successSelector: presetSuccessSel.trim() } : {}),
        ...(presetVerifySel.trim() ? { verifySelector: presetVerifySel.trim() } : {}),
        builtIn: false,
      };
      const idx = customList.findIndex((p) => p.id === id);
      if (idx === -1) customList.push(nextPreset);
      else customList[idx] = nextPreset;
      await api.updateSettings({ sitePresets: customList });
      setPresetFormOpen(false);
      await loadAll();
      toast.success(t('Preset saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save preset'));
    } finally {
      setSavingPreset(false);
    }
  };

  const deleteCustomPreset = async (id: string) => {
    const customList = (settings.sitePresets ?? []).filter((p) => p.id !== id);
    await api.updateSettings({ sitePresets: customList });
    await loadAll();
    toast.deleted(t('Preset removed'));
  };

  const exportPresetsJson = () => {
    const customOnly = (settings.sitePresets ?? []).filter((p) => !p.builtIn);
    const data = customOnly.length > 0 ? customOnly : presets;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'atelier-site-presets.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importPresetsJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const existing = (settings.sitePresets ?? []).slice();
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const p = item as Partial<SitePreset>;
        if (!p.name || !p.loginUrl || !p.origin) continue;
        const id = p.id && !p.builtIn ? p.id : `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
        const normalized: SitePreset = {
          id,
          name: String(p.name),
          origin: String(p.origin),
          loginUrl: String(p.loginUrl),
          flow: p.flow === 'two_step' ? 'two_step' : 'single',
          selectors: p.selectors ?? {},
          ...(p.successUrlIncludes ? { successUrlIncludes: p.successUrlIncludes } : {}),
          ...(p.successSelector ? { successSelector: p.successSelector } : {}),
          ...(p.verifySelector ? { verifySelector: p.verifySelector } : {}),
          builtIn: false,
        };
        const idx = existing.findIndex((e) => e.id === normalized.id);
        if (idx === -1) existing.push(normalized);
        else existing[idx] = normalized;
      }
      await api.updateSettings({ sitePresets: existing });
      await loadAll();
      toast.success(t('Presets imported'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Invalid preset JSON'));
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '20px 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        {t('Loading browser settings…')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Browser executable status */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={15} style={{ color: status?.available ? 'var(--agent-green)' : 'var(--agent-amber)' }} />
            <span style={eyebrowStyle}>{t('Local browser engine')}</span>
          </div>
          {status?.available && (
            <span style={{ fontSize: 11.5, color: 'var(--agent-green)' }}>
              {status.browserName}
            </span>
          )}
        </div>
        {status?.available ? (
          <div className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
            {t('Using {name} ({path})', { name: status.browserName ?? 'Browser', path: status.executablePath ?? '' })}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--agent-amber)' }}>
            <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              {t('No Chrome or Edge found. Install Google Chrome / Microsoft Edge or set ATELIER_BROWSER_PATH.')}
            </span>
          </div>
        )}
      </div>

      {/* Saved Logins */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <KeyRound size={15} style={{ color: 'var(--text-secondary)' }} />
            <span style={eyebrowStyle}>{t('Saved site logins')}</span>
          </div>
          {!credFormOpen && (
            <button
              type="button"
              onClick={openAddCredForm}
              style={{ ...primaryBtnStyle, height: 28, padding: '0 10px', fontSize: 11.5 }}
            >
              <Plus size={13} /> {t('Add login')}
            </button>
          )}
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {t('Passwords are encrypted on this machine and never sent to AI models.')}
        </div>

        {credFormOpen && (
          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
              {editingCredId ? t('Edit login') : t('New site login')}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>{t('Site preset')}</label>
                <Select
                  ariaLabel={t('Site preset')}
                  value={credPresetId}
                  onChange={applyPresetToCredForm}
                  options={[
                    ...presets.map((p) => ({ value: p.id, label: p.name })),
                    { value: '__custom', label: t('Custom URL') },
                  ]}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('Label')}</label>
                <input
                  value={credLabel}
                  onChange={(e) => setCredLabel(e.target.value)}
                  placeholder="Mobbin"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>{t('Login URL')}</label>
                <input
                  value={credLoginUrl}
                  onChange={(e) => {
                    const next = e.target.value;
                    setCredLoginUrl(next);
                    if (!credOrigin || credPresetId === '__custom') {
                      try {
                        setCredOrigin(new URL(next).origin);
                      } catch {
                        // wait for complete URL
                      }
                    }
                  }}
                  placeholder="https://mobbin.com/login"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('Allowed origin (password binding)')}</label>
                <input
                  value={credOrigin}
                  onChange={(e) => setCredOrigin(e.target.value)}
                  placeholder="https://mobbin.com"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>{t('Email / username')}</label>
                <input
                  value={credUsername}
                  onChange={(e) => setCredUsername(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="off"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  {editingCredId ? t('New password (leave blank to keep)') : t('Password')}
                </label>
                <input
                  type="password"
                  value={credPassword}
                  onChange={(e) => setCredPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  style={inputStyle}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>{t('Browser profile')}</label>
              <Select
                ariaLabel={t('Browser profile')}
                value={credProfileId || '__auto'}
                onChange={(v) => setCredProfileId(v === '__auto' ? '' : v)}
                options={[
                  { value: '__auto', label: t('Auto-create / match site name') },
                  ...profiles.map((pf) => ({ value: pf.id, label: pf.name })),
                ]}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setCredFormOpen(false)}
                style={{ ...secondaryBtnStyle, height: 30, fontSize: 12 }}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                disabled={savingCred}
                onClick={() => void saveCred(false)}
                style={{ ...secondaryBtnStyle, height: 30, fontSize: 12 }}
              >
                {t('Save')}
              </button>
              <button
                type="button"
                disabled={savingCred}
                onClick={() => void saveCred(true)}
                style={{ ...primaryBtnStyle, height: 30, fontSize: 12 }}
              >
                {savingCred ? t('Saving…') : t('Save & test login')}
              </button>
            </div>
          </div>
        )}

        {credentials.length === 0 && !credFormOpen ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '6px 0' }}>
            {t('No saved logins yet. Add one so agents can sign in without seeing your password.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {credentials.map((cred) => {
              const profName = profiles.find((p) => p.id === cred.profileId)?.name;
              const isTesting = testingCredId === cred.id;
              const activeResult = testResult?.credId === cred.id ? testResult.res : null;
              return (
                <div
                  key={cred.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                          {cred.label}
                        </span>
                        <span className="mono-num" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                          {cred.maskedUsername ?? cred.username}
                        </span>
                        {profName && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {profName}</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 11.5 }}>
                        <span style={{ color: statusColor(cred.lastLogin?.status) }}>
                          {statusLabel(t, cred.lastLogin?.status)}
                        </span>
                        {cred.lastLogin?.at && (
                          <span style={{ color: 'var(--text-muted)' }}>
                            · {formatRelative(cred.lastLogin.at)}
                          </span>
                        )}
                        {cred.lastLogin?.message && (
                          <span style={{ color: 'var(--text-tertiary)' }}>
                            — {cred.lastLogin.message}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        disabled={isTesting}
                        onClick={() => void runCredTest(cred.id)}
                        style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
                      >
                        <RefreshCw size={11} className={isTesting ? 'spin' : undefined} />{' '}
                        {isTesting ? t('Testing…') : t('Test')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditCredForm(cred)}
                        style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
                      >
                        {t('Edit')}
                      </button>
                      {confirmDeleteCredId === cred.id ? (
                        <button
                          type="button"
                          onClick={() => void handleDeleteCred(cred.id)}
                          style={{
                            ...secondaryBtnStyle,
                            height: 26,
                            padding: '0 9px',
                            fontSize: 11.5,
                            color: 'var(--agent-red)',
                            borderColor: 'rgba(248, 113, 113, 0.45)',
                          }}
                        >
                          {t('Confirm')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteCredId(cred.id)}
                          style={{ ...secondaryBtnStyle, height: 26, padding: '0 7px', color: 'var(--agent-red)' }}
                          title={t('Remove')}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {activeResult && (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                          {activeResult.status === 'ok' ? (
                            <CheckCircle2 size={14} style={{ color: 'var(--agent-green)' }} />
                          ) : (
                            <AlertTriangle size={14} style={{ color: statusColor(activeResult.status) }} />
                          )}
                          <span style={{ color: 'var(--text-primary)' }}>{activeResult.message}</span>
                        </div>
                        {(activeResult.status === 'needs_verification' ||
                          activeResult.status === 'blocked') && (
                          <div>
                            <button
                              type="button"
                              onClick={() =>
                                void browserApi.openProfileWindow(cred.profileId, cred.loginUrl)
                              }
                              style={{ ...primaryBtnStyle, height: 26, padding: '0 10px', fontSize: 11.5 }}
                            >
                              <ExternalLink size={12} /> {t('Finish in browser window')}
                            </button>
                          </div>
                        )}
                      </div>
                      {activeResult.screenshotUrl && (
                        <img
                          src={activeResult.screenshotUrl}
                          alt={cred.label}
                          style={{
                            width: 140,
                            height: 88,
                            objectFit: 'cover',
                            borderRadius: 6,
                            border: '1px solid var(--border-subtle)',
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Site Presets (§5.3) */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={15} style={{ color: 'var(--text-secondary)' }} />
            <span style={eyebrowStyle}>{t('Site login presets')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importPresetsJson(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
            >
              <Upload size={11} /> {t('Import JSON')}
            </button>
            <button
              type="button"
              onClick={exportPresetsJson}
              style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
            >
              <Download size={11} /> {t('Export JSON')}
            </button>
            {!presetFormOpen && (
              <button
                type="button"
                onClick={openAddPresetForm}
                style={{ ...primaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
              >
                <Plus size={12} /> {t('Add preset')}
              </button>
            )}
          </div>
        </div>

        {presetFormOpen && (
          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-default)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>{t('Preset name')}</label>
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Dribbble"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('Login URL')}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={presetLoginUrl}
                    onChange={(e) => {
                      setPresetLoginUrl(e.target.value);
                      if (!presetOrigin) {
                        try {
                          setPresetOrigin(new URL(e.target.value).origin);
                        } catch {
                          // ignore
                        }
                      }
                    }}
                    placeholder="https://example.com/login"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    disabled={detecting}
                    onClick={() => void handleDetectPreset()}
                    style={{ ...secondaryBtnStyle, height: 34, padding: '0 10px', fontSize: 11.5, flexShrink: 0 }}
                  >
                    {detecting ? t('Detecting…') : t('Auto-detect form')}
                  </button>
                </div>
              </div>
            </div>

            {detectedPreview && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    <strong>{t('Detected flow')}:</strong>{' '}
                    {detectedPreview.flow === 'two_step' ? t('Two-step') : t('Single form')}
                  </div>
                  <div className="mono-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {JSON.stringify(detectedPreview.selectors)}
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={applyDetectedPreset}
                      style={{ ...primaryBtnStyle, height: 25, padding: '0 10px', fontSize: 11 }}
                    >
                      {t('Use detected selectors')}
                    </button>
                  </div>
                </div>
                {detectedPreview.screenshotUrl && (
                  <img
                    src={detectedPreview.screenshotUrl}
                    alt="Detected form"
                    style={{
                      width: 150,
                      height: 94,
                      objectFit: 'cover',
                      borderRadius: 6,
                      border: '1px solid var(--border-subtle)',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>{t('Origin')}</label>
                <input
                  value={presetOrigin}
                  onChange={(e) => setPresetOrigin(e.target.value)}
                  placeholder="https://example.com"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('Login flow')}</label>
                <Select
                  ariaLabel={t('Login flow')}
                  value={presetFlow}
                  onChange={(v) => setPresetFlow(v as 'single' | 'two_step')}
                  options={[
                    { value: 'single', label: t('Single form (email + password)') },
                    { value: 'two_step', label: t('Two-step (email -> next -> password)') },
                  ]}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setPresetAdvancedOpen((v) => !v)}
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--text-secondary)',
              }}
            >
              {presetAdvancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t('Advanced selectors')}
            </button>

            {presetAdvancedOpen && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input
                  value={presetSelUser}
                  onChange={(e) => setPresetSelUser(e.target.value)}
                  placeholder={t('Username selector (optional)')}
                  style={inputStyle}
                />
                <input
                  value={presetSelPass}
                  onChange={(e) => setPresetSelPass(e.target.value)}
                  placeholder={t('Password selector (optional)')}
                  style={inputStyle}
                />
                <input
                  value={presetSelNext}
                  onChange={(e) => setPresetSelNext(e.target.value)}
                  placeholder={t('Next button selector (optional)')}
                  style={inputStyle}
                />
                <input
                  value={presetSelSubmit}
                  onChange={(e) => setPresetSelSubmit(e.target.value)}
                  placeholder={t('Submit button selector (optional)')}
                  style={inputStyle}
                />
                <input
                  value={presetSuccessUrl}
                  onChange={(e) => setPresetSuccessUrl(e.target.value)}
                  placeholder={t('Success URL contains (optional)')}
                  style={inputStyle}
                />
                <input
                  value={presetVerifySel}
                  onChange={(e) => setPresetVerifySel(e.target.value)}
                  placeholder={t('Verify/2FA selector (optional)')}
                  style={inputStyle}
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setPresetFormOpen(false)}
                style={{ ...secondaryBtnStyle, height: 28, fontSize: 11.5 }}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                disabled={savingPreset}
                onClick={() => void savePreset()}
                style={{ ...primaryBtnStyle, height: 28, fontSize: 11.5 }}
              >
                {savingPreset ? t('Saving…') : t('Save preset')}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {presets.map((p) => (
            <div
              key={p.id}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</span>
                <span className="mono-num" style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {p.loginUrl}
                </span>
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  {p.flow === 'two_step' ? t('two-step') : t('single form')}
                  {p.builtIn ? ` · ${t('built-in')}` : ''}
                </span>
              </div>
              {!p.builtIn && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => openEditPresetForm(p)}
                    style={{ ...secondaryBtnStyle, height: 24, padding: '0 8px', fontSize: 11 }}
                  >
                    {t('Edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteCustomPreset(p.id)}
                    style={{ ...secondaryBtnStyle, height: 24, padding: '0 7px', color: 'var(--agent-red)' }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Browser Profiles */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderOpen size={15} style={{ color: 'var(--text-secondary)' }} />
            <span style={eyebrowStyle}>{t('Browser profiles (saved cookies)')}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder={t('New profile name…')}
              style={{ ...inputStyle, width: 160, height: 28, fontSize: 11.5 }}
            />
            <button
              type="button"
              disabled={addingProfile || !newProfileName.trim()}
              onClick={() => void handleCreateProfile()}
              style={{ ...secondaryBtnStyle, height: 28, padding: '0 10px', fontSize: 11.5 }}
            >
              <Plus size={12} /> {t('Add')}
            </button>
          </div>
        </div>

        {profiles.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('Profiles are created automatically when you add a login or start browsing.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {profiles.map((prof) => (
              <div
                key={prof.id}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {prof.name}
                  </span>
                  {prof.lastUsedAt && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                      {t('Used {ago} ago', { ago: formatRelative(prof.lastUsedAt) })}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => void browserApi.openProfileWindow(prof.id)}
                    style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
                  >
                    <ExternalLink size={11} /> {t('Open window')}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await browserApi.clearProfileCookies(prof.id);
                      toast.info(t('Cleared cookies for {name}', { name: prof.name }));
                    }}
                    style={{ ...secondaryBtnStyle, height: 26, padding: '0 9px', fontSize: 11.5 }}
                  >
                    {t('Clear cookies')}
                  </button>
                  {confirmDeleteProfileId === prof.id ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await browserApi.deleteProfile(prof.id);
                        setConfirmDeleteProfileId(null);
                        await loadAll();
                        toast.deleted(t('Profile deleted'));
                      }}
                      style={{
                        ...secondaryBtnStyle,
                        height: 26,
                        padding: '0 9px',
                        fontSize: 11.5,
                        color: 'var(--agent-red)',
                        borderColor: 'rgba(248, 113, 113, 0.45)',
                      }}
                    >
                      {t('Confirm')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteProfileId(prof.id)}
                      style={{ ...secondaryBtnStyle, height: 26, padding: '0 7px', color: 'var(--agent-red)' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
