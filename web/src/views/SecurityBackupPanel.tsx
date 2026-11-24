import type { AutoBackupConfig, CloudFolderCandidate, RelinkCandidate } from '@atelier/contracts';
import {
  CloudUpload,
  Download,
  FolderOpen,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, authApi, backupApi } from '../api';
import { RecoveryKeyNotice } from '../components/RecoveryKeyNotice';
import { RelinkWizard } from '../components/modals/RelinkWizard';
import { inputStyle, labelStyle, primaryBtnStyle, secondaryBtnStyle } from '../components/modals/ModalShell';
import { toast } from '../components/Toast';
import { useAuth } from '../state/auth';

const IDLE_OPTIONS = [5, 10, 15, 30, 60, 120, 240];
const INTERVAL_OPTIONS = [1, 3, 6, 12, 24, 72, 168];

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

const hintStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 };

function errMsg(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Terjadi kesalahan.';
}

function CardHeader({ icon, title, right }: { icon: React.ReactNode; title: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-secondary)', display: 'flex' }}>{icon}</span>
        <span style={eyebrowStyle}>{title}</span>
      </div>
      {right}
    </div>
  );
}

function PasswordInput(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <label style={labelStyle} htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="password"
        autoComplete={props.autoComplete ?? 'off'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function AppLockCard() {
  const { status, refresh, lockNow } = useAuth();
  const [mode, setMode] = useState<'idle' | 'enable' | 'change' | 'disable' | 'regen'>('idle');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [current, setCurrent] = useState('');
  const [idle, setIdle] = useState(status.idleMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  useEffect(() => setIdle(status.idleMinutes), [status.idleMinutes]);

  const reset = () => {
    setMode('idle');
    setPw('');
    setPw2('');
    setCurrent('');
    setError(null);
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const mismatch = pw2.length > 0 && pw !== pw2;

  return (
    <div style={cardStyle}>
      <CardHeader
        icon={status.enabled ? <Lock size={14} strokeWidth={1.6} /> : <LockOpen size={14} strokeWidth={1.6} />}
        title="App lock"
        right={
          <span
            style={{
              fontSize: 11.5,
              padding: '2px 9px',
              borderRadius: 'var(--radius-full)',
              background: status.enabled ? 'rgba(56, 201, 118, 0.12)' : 'var(--surface-3)',
              color: status.enabled ? 'var(--agent-green)' : 'var(--text-tertiary)',
            }}
          >
            {status.enabled ? 'Aktif' : 'Mati'}
          </span>
        }
      />
      <div style={hintStyle}>
        Kunci UI & seluruh API lokal pakai password, supaya aman kalau laptop dipinjam. Password di-hash (scrypt),
        sesi pakai cookie HttpOnly dan terkunci otomatis saat idle. Agent tetap jalan di background saat terkunci.
      </div>

      {recoveryKey && (
        <>
          <RecoveryKeyNotice recoveryKey={recoveryKey} />
          <button type="button" style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }} onClick={() => setRecoveryKey(null)}>
            Sudah saya simpan
          </button>
        </>
      )}

      {!recoveryKey && !status.enabled && mode === 'idle' && (
        <button type="button" style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }} onClick={() => setMode('enable')}>
          <Lock size={13} strokeWidth={1.6} /> Nyalakan app lock
        </button>
      )}

      {!recoveryKey && status.enabled && mode === 'idle' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }} htmlFor="idle-select">
              Kunci otomatis setelah idle
            </label>
            <select
              id="idle-select"
              value={idle}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIdle(v);
                void act(async () => {
                  await authApi.setIdleMinutes(v);
                  await refresh();
                  toast.success(`Auto-lock: ${v} menit`);
                });
              }}
              style={{ ...inputStyle, width: 'auto' }}
            >
              {[...new Set([...IDLE_OPTIONS, idle])].sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} menit` : `${m / 60} jam`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" style={secondaryBtnStyle} onClick={() => void lockNow()}>
              <Lock size={13} strokeWidth={1.6} /> Kunci sekarang
            </button>
            <button type="button" style={secondaryBtnStyle} onClick={() => setMode('change')}>
              Ganti password
            </button>
            <button type="button" style={secondaryBtnStyle} onClick={() => setMode('regen')}>
              Buat recovery key baru
            </button>
            <button type="button" style={{ ...secondaryBtnStyle, color: 'var(--agent-red)' }} onClick={() => setMode('disable')}>
              Matikan
            </button>
          </div>
        </>
      )}

      {mode === 'enable' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const res = await authApi.enable(pw, idle);
              setRecoveryKey(res.recoveryKey);
              reset();
              await refresh();
            });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PasswordInput id="lock-pw" label="Password (min. 8)" value={pw} onChange={setPw} autoComplete="new-password" />
            <PasswordInput id="lock-pw2" label="Ulangi password" value={pw2} onChange={setPw2} autoComplete="new-password" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }} htmlFor="idle-new">
              Kunci otomatis setelah idle
            </label>
            <select id="idle-new" value={idle} onChange={(e) => setIdle(Number(e.target.value))} style={{ ...inputStyle, width: 'auto' }}>
              {IDLE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} menit` : `${m / 60} jam`}
                </option>
              ))}
            </select>
          </div>
          {mismatch && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>Password tidak sama.</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || pw.length < 8 || pw !== pw2} style={primaryBtnStyle}>
              {busy ? 'Menyimpan…' : 'Aktifkan'}
            </button>
            <button type="button" onClick={reset} style={secondaryBtnStyle}>
              Batal
            </button>
          </div>
        </form>
      )}

      {(mode === 'change' || mode === 'disable' || mode === 'regen') && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              if (mode === 'change') {
                await authApi.changePassword(current, pw);
                toast.success('Password diganti. Sesi lain dikunci.');
              } else if (mode === 'disable') {
                await authApi.disable(current);
                toast.success('App lock dimatikan');
              } else {
                const res = await authApi.regenerateRecoveryKey(current);
                setRecoveryKey(res.recoveryKey);
              }
              reset();
              await refresh();
            });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PasswordInput id="lock-current" label="Password sekarang" value={current} onChange={setCurrent} autoComplete="current-password" />
            {mode === 'change' && (
              <>
                <PasswordInput id="lock-new" label="Password baru" value={pw} onChange={setPw} autoComplete="new-password" />
                <PasswordInput id="lock-new2" label="Ulangi" value={pw2} onChange={setPw2} autoComplete="new-password" />
              </>
            )}
          </div>
          {mode === 'change' && mismatch && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>Password tidak sama.</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="submit"
              disabled={busy || !current || (mode === 'change' && (pw.length < 8 || pw !== pw2))}
              style={mode === 'disable' ? { ...primaryBtnStyle, background: 'var(--agent-red)', color: '#fff' } : primaryBtnStyle}
            >
              {busy ? 'Memproses…' : mode === 'change' ? 'Ganti password' : mode === 'disable' ? 'Matikan app lock' : 'Buat key baru'}
            </button>
            <button type="button" onClick={reset} style={secondaryBtnStyle}>
              Batal
            </button>
          </div>
        </form>
      )}

      {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function MigrationCard({ onRelink }: { onRelink: (c: RelinkCandidate[]) => void }) {
  const [exportPass, setExportPass] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [importPass, setImportPass] = useState('');
  const [importing, setImporting] = useState(false);
  const [needsPass, setNeedsPass] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await backupApi.exportFile({
        passphrase: exportPass || null,
        includeSecrets: includeSecrets && exportPass.length > 0,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.success(`Backup dibuat: ${filename}`);
      setExportPass('');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setExporting(false);
    }
  };

  const doImport = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const result = await backupApi.importFile(file, importPass);
      toast.success(`Import selesai: ${result.projectCount} project dari ${result.sourceHostname}`);
      setFile(null);
      setImportPass('');
      setNeedsPass(false);
      setConfirming(false);
      if (fileInput.current) fileInput.current.value = '';
      if (result.relink.length > 0) onRelink(result.relink);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'passphrase_required' || err.code === 'bad_passphrase')) {
        setNeedsPass(true);
      }
      setError(errMsg(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={cardStyle}>
      <CardHeader icon={<ShieldCheck size={14} strokeWidth={1.6} />} title="Pindah laptop (.atelier-backup)" />
      <div style={hintStyle}>
        Satu file berisi semua project, agent, chat, task & settings — snapshot konsisten lewat <code>VACUUM INTO</code>.
        Folder repo tidak ikut; setelah import kamu tinggal tautkan ulang foldernya.
      </div>

      {/* Export */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <PasswordInput
            id="export-pass"
            label="Passphrase enkripsi (opsional, min. 8)"
            value={exportPass}
            onChange={setExportPass}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={doExport}
            disabled={exporting || (exportPass.length > 0 && exportPass.length < 8)}
            style={primaryBtnStyle}
          >
            <Download size={13} strokeWidth={1.6} /> {exporting ? 'Membuat…' : 'Export backup'}
          </button>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            color: exportPass ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <input
            type="checkbox"
            disabled={!exportPass}
            checked={includeSecrets && Boolean(exportPass)}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          />
          Sertakan API key & token OAuth (hanya untuk file terenkripsi, AES-256-GCM)
        </label>
        {!exportPass && (
          <div style={{ ...hintStyle, color: 'var(--agent-amber)' }}>
            Tanpa passphrase, file tidak terenkripsi dan semua API key/token dibuang dari backup.
          </div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)' }} />

      {/* Import */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileInput}
            type="file"
            accept=".atelier-backup"
            style={{ display: 'none' }}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
              setNeedsPass(false);
              setConfirming(false);
            }}
          />
          <button type="button" style={secondaryBtnStyle} onClick={() => fileInput.current?.click()}>
            <Upload size={13} strokeWidth={1.6} /> {file ? 'Ganti file…' : 'Pilih file backup…'}
          </button>
          {file && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
        </div>

        {file && (
          <>
            <PasswordInput
              id="import-pass"
              label={needsPass ? 'Passphrase backup (wajib)' : 'Passphrase (kalau file terenkripsi)'}
              value={importPass}
              onChange={setImportPass}
            />
            {!confirming ? (
              <button type="button" style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }} onClick={() => setConfirming(true)}>
                Import…
              </button>
            ) : (
              <div
                style={{
                  padding: 10,
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(242, 140, 40, 0.07)',
                  border: '1px solid rgba(242, 140, 40, 0.3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                  Semua data Atelier di laptop ini akan diganti isi backup. Agent yang sedang jalan dihentikan. Salinan
                  data lama disimpan otomatis di <code>data/backups</code>. Password app lock & setting auto-backup
                  laptop ini tidak berubah.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={doImport} disabled={importing} style={primaryBtnStyle}>
                    {importing ? 'Mengimport…' : 'Ya, ganti data'}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} style={secondaryBtnStyle}>
                    Batal
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'flex-start' }}
          onClick={async () => {
            try {
              const { relink } = await backupApi.relink();
              if (relink.length === 0) toast.success('Semua folder repo ditemukan');
              else onRelink(relink);
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          Cek folder repo yang hilang…
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const PROVIDER_LABEL: Record<CloudFolderCandidate['provider'], string> = {
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
};

function AutoBackupCard() {
  const [config, setConfig] = useState<AutoBackupConfig | null>(null);
  const [folders, setFolders] = useState<CloudFolderCandidate[]>([]);
  const [folder, setFolder] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [intervalHours, setIntervalHours] = useState(6);
  const [keep, setKeep] = useState(10);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (c: AutoBackupConfig) => {
    setConfig(c);
    setFolder(c.folder ?? '');
    setIntervalHours(c.intervalHours);
    setKeep(c.keep);
    setIncludeSecrets(c.includeSecrets);
  };

  useEffect(() => {
    backupApi.getAuto().then((r) => apply(r.config)).catch((err) => setError(errMsg(err)));
    backupApi.cloudFolders().then((r) => setFolders(r.folders)).catch(() => undefined);
  }, []);

  const save = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { config: next } = await backupApi.updateAuto({
        enabled,
        folder: folder || null,
        intervalHours,
        keep,
        includeSecrets,
        ...(passphrase ? { passphrase } : {}),
      });
      apply(next);
      setPassphrase('');
      toast.success(enabled ? 'Auto-backup aktif' : 'Auto-backup disimpan (mati)');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { config: next } = await backupApi.runAuto();
      apply(next);
      toast.success('Backup tersimpan ke cloud folder');
    } catch (err) {
      setError(errMsg(err));
      backupApi.getAuto().then((r) => apply(r.config)).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div style={cardStyle}>
        <CardHeader icon={<CloudUpload size={14} strokeWidth={1.6} />} title="Auto-backup ke cloud drive" />
        <div style={hintStyle}>{error ?? 'Memuat…'}</div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <CardHeader
        icon={<CloudUpload size={14} strokeWidth={1.6} />}
        title="Auto-backup ke cloud drive"
        right={
          <span
            style={{
              fontSize: 11.5,
              padding: '2px 9px',
              borderRadius: 'var(--radius-full)',
              background: config.enabled ? 'rgba(56, 201, 118, 0.12)' : 'var(--surface-3)',
              color: config.enabled ? 'var(--agent-green)' : 'var(--text-tertiary)',
            }}
          >
            {config.enabled ? 'Aktif' : 'Mati'}
          </span>
        }
      />
      <div style={hintStyle}>
        Pilih folder OneDrive / Google Drive / Dropbox. Atelier menyimpan snapshot terenkripsi secara berkala dan saat
        aplikasi ditutup — aplikasi sync milikmu yang mengunggahnya. Tanpa server, tanpa biaya. Live database tidak
        pernah disentuh langsung, jadi aman dari korup.
      </div>

      {folders.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {folders.map((f) => (
            <button
              key={f.suggestedPath}
              type="button"
              onClick={() => setFolder(f.suggestedPath)}
              title={f.suggestedPath}
              style={{
                ...secondaryBtnStyle,
                height: 28,
                fontSize: 12,
                borderColor: folder === f.suggestedPath ? 'var(--text-secondary)' : undefined,
              }}
            >
              {f.label || PROVIDER_LABEL[f.provider]}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle} htmlFor="auto-folder">
            Folder tujuan
          </label>
          <input
            id="auto-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="C:\Users\kamu\OneDrive\Atelier Backups"
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </div>
        <button
          type="button"
          style={secondaryBtnStyle}
          onClick={async () => {
            const picked = await api.pickFolder().catch(() => ({ path: null }));
            if (picked.path) setFolder(picked.path);
          }}
        >
          <FolderOpen size={13} strokeWidth={1.6} /> Browse
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <PasswordInput
          id="auto-pass"
          label={config.passphraseSet ? 'Passphrase (tersimpan — isi untuk ganti)' : 'Passphrase enkripsi (wajib, min. 8)'}
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="new-password"
        />
        <div>
          <label style={labelStyle} htmlFor="auto-interval">
            Setiap
          </label>
          <select
            id="auto-interval"
            value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value))}
            style={{ ...inputStyle, width: 'auto' }}
          >
            {[...new Set([...INTERVAL_OPTIONS, intervalHours])].sort((a, b) => a - b).map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h} jam` : `${h / 24} hari`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor="auto-keep">
            Simpan
          </label>
          <select id="auto-keep" value={keep} onChange={(e) => setKeep(Number(e.target.value))} style={{ ...inputStyle, width: 'auto' }}>
            {[...new Set([3, 5, 10, 20, 50, keep])].sort((a, b) => a - b).map((k) => (
              <option key={k} value={k}>
                {k} file terakhir
              </option>
            ))}
          </select>
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
        Sertakan API key & token OAuth (terenkripsi passphrase)
      </label>

      <div style={{ ...hintStyle, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
        <span>Terakhir</span>
        <span style={{ color: config.lastStatus === 'error' ? 'var(--agent-red)' : 'var(--text-secondary)' }}>
          {formatWhen(config.lastRunAt)}
          {config.lastStatus === 'ok' && ' · berhasil'}
          {config.lastStatus === 'error' && ` · gagal: ${config.lastError ?? ''}`}
        </span>
        {config.enabled && (
          <>
            <span>Berikutnya</span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatWhen(config.nextRunAt)} (dilewati kalau tidak ada perubahan)</span>
          </>
        )}
        {config.lastFile && (
          <>
            <span>File</span>
            <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{config.lastFile}</span>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {config.enabled ? (
          <>
            <button type="button" disabled={busy} onClick={() => save(true)} style={primaryBtnStyle}>
              Simpan perubahan
            </button>
            <button type="button" disabled={busy} onClick={runNow} style={secondaryBtnStyle}>
              <RefreshCw size={13} strokeWidth={1.6} /> Backup sekarang
            </button>
            <button type="button" disabled={busy} onClick={() => save(false)} style={secondaryBtnStyle}>
              Matikan
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy || !folder || (!config.passphraseSet && passphrase.length < 8)}
            onClick={() => save(true)}
            style={primaryBtnStyle}
          >
            <CloudUpload size={13} strokeWidth={1.6} /> Aktifkan auto-backup
          </button>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--agent-red)' }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function SecurityBackupPanel() {
  const [relink, setRelink] = useState<RelinkCandidate[] | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <AppLockCard />
      <MigrationCard onRelink={setRelink} />
      <AutoBackupCard />
      {relink && relink.length > 0 && <RelinkWizard candidates={relink} onClose={() => setRelink(null)} />}
    </div>
  );
}
