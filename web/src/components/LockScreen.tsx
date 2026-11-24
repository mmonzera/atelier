import { KeyRound, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, authApi } from '../api';
import { inputStyle, labelStyle, primaryBtnStyle } from './modals/ModalShell';
import { RecoveryKeyNotice } from './RecoveryKeyNotice';
import { useT } from '../i18n';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const t = useT();
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
      setError(err instanceof ApiError || err instanceof Error ? err.message : t('Could not unlock.'));
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
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>{t('Atelier is locked')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {mode === 'password' ? t('Agents keep running in the background. Enter your password to unlock.') : t('Use your recovery key to set a new password.')}
            </div>
          </div>
        </div>

        {freshKey ? (
          <>
            <RecoveryKeyNotice recoveryKey={freshKey} title={t('Password changed — here is your new recovery key')} />
            <button type="button" style={primaryBtnStyle} onClick={onUnlocked}>{t('I’ve saved it, open Atelier')}
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {mode === 'password' ? (
              <div>
                <label style={labelStyle} htmlFor="lock-password">{t('Password')}
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
                  <label style={labelStyle} htmlFor="lock-recovery">{t('Recovery key')}
                  </label>
                  <input
                    id="lock-recovery"
                    ref={inputRef}
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                    placeholder={t('XXXXX-XXXXX-XXXXX-XXXXX-XXXXX')}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...inputStyle, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="lock-new-password">{t('New password (min. 8 characters)')}
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
              {busy ? t('Checking…') : mode === 'password' ? t('Unlock') : t('Reset password')}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === 'password' ? 'recover' : 'password');
                setError(null);
              }}
              style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'center' }}
            >
              {mode === 'password' ? t('Forgot your password? Use your recovery key') : t('Back to password')}
            </button>

            {mode === 'recover' && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('Lost the recovery key too? Close Atelier, then run')} <code>npm run lock:reset</code>{t('(source version) or')} <code>Atelier.exe --reset-lock</code>{t('(installer version) on this laptop.')}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
