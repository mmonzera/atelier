import { KeyRound, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, authApi } from '../api';
import { inputStyle, labelStyle, primaryBtnStyle } from './modals/ModalShell';
import { RecoveryKeyNotice } from './RecoveryKeyNotice';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [mode, setMode] = useState<'password' | 'recover'>('password');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'password') {
        await authApi.login(password);
        onUnlocked();
      } else {
        const res = await authApi.recover(recoveryKey, newPassword);
        setFreshKey(res.recoveryKey);
      }
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Gagal membuka kunci.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(circle at 50% 30%, var(--bg-glow), var(--bg-base) 70%)',
        padding: 20,
        zIndex: 1000,
      }}
    >
      <div
        className="popover-shadow"
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-xl)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-3)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text-primary)',
            }}
          >
            {mode === 'password' ? <Lock size={17} strokeWidth={1.6} /> : <KeyRound size={17} strokeWidth={1.6} />}
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>Atelier terkunci</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {mode === 'password'
                ? 'Agent tetap jalan di background. Masukkan password untuk membuka.'
                : 'Pakai recovery key untuk membuat password baru.'}
            </div>
          </div>
        </div>

        {freshKey ? (
          <>
            <RecoveryKeyNotice recoveryKey={freshKey} title="Password diganti — ini recovery key barumu" />
            <button type="button" style={primaryBtnStyle} onClick={onUnlocked}>
              Sudah saya simpan, buka Atelier
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {mode === 'password' ? (
              <div>
                <label style={labelStyle} htmlFor="lock-password">
                  Password
                </label>
                <input
                  id="lock-password"
                  ref={inputRef}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={inputStyle}
                />
              </div>
            ) : (
              <>
                <div>
                  <label style={labelStyle} htmlFor="lock-recovery">
                    Recovery key
                  </label>
                  <input
                    id="lock-recovery"
                    ref={inputRef}
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="lock-new-password">
                    Password baru (min. 8 karakter)
                  </label>
                  <input
                    id="lock-new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    style={inputStyle}
                  />
                </div>
              </>
            )}

            {error && (
              <div role="alert" style={{ fontSize: 12, color: 'var(--agent-red)' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || (mode === 'password' ? !password : !recoveryKey || newPassword.length < 8)}
              style={{ ...primaryBtnStyle, opacity: busy ? 0.7 : 1 }}
            >
              {busy ? 'Memeriksa…' : mode === 'password' ? 'Buka' : 'Reset password'}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === 'password' ? 'recover' : 'password');
                setError(null);
              }}
              style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'center' }}
            >
              {mode === 'password' ? 'Lupa password? Pakai recovery key' : 'Kembali ke password'}
            </button>

            {mode === 'recover' && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Recovery key juga hilang? Tutup Atelier, lalu jalankan <code>npm run lock:reset</code> (versi
                source) atau <code>Atelier.exe --reset-lock</code> (versi installer) di laptop ini.
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
