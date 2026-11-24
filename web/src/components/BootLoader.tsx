import type { AgentAvatarShape, AgentColor } from '@atelier/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '../i18n';
import { BotMascot } from './mascot/BotMascot';

/**
 * Start-up screen: bots are lowered on Atelier's gold cables and a few tumble down into a pile,
 * around the logo and a progress bar. Mounted once at the root, so it spans both start-up steps
 * (checking the app lock, then loading the workspace) without restarting its animation.
 */

export type BootStage = 'connecting' | 'loading' | 'ready';

let stage: BootStage = 'connecting';
const listeners = new Set<() => void>();

/** Advance the start-up screen. It never goes back, and fades out once 'ready'. */
export function setBootStage(next: BootStage): void {
  const order: BootStage[] = ['connecting', 'loading', 'ready'];
  if (order.indexOf(next) <= order.indexOf(stage)) return;
  stage = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Show at least this long, so a fast start does not flash the animation. */
const MIN_VISIBLE_MS = 1500;
const FADE_MS = 450;

interface HangingBot {
  left: string;
  len: number; // rope length, vh
  size: number;
  color: AgentColor;
  shape: AgentAvatarShape;
  delay: number; // s
}

interface FallingBot {
  left: string;
  bottom: number; // px (negative = partly below the edge, like a pile)
  size: number;
  color: AgentColor;
  shape: AgentAvatarShape;
  delay: number;
  tilt: number; // deg
}

// Kept clear of the centre, where the logo and progress bar sit.
const HANGING: HangingBot[] = [
  { left: '9%', len: 30, size: 100, color: 'purple', shape: 'orb', delay: 0.05 },
  { left: '22%', len: 14, size: 80, color: 'amber', shape: 'hex', delay: 0.3 },
  { left: '34%', len: 6, size: 64, color: 'teal', shape: 'pill', delay: 0.55 },
  { left: '64%', len: 9, size: 68, color: 'magenta', shape: 'triangle', delay: 0.45 },
  { left: '77%', len: 24, size: 92, color: 'orange', shape: 'squircle', delay: 0.15 },
  { left: '90%', len: 12, size: 76, color: 'green', shape: 'hex', delay: 0.4 },
];

// Short delays: inside the app the workspace often loads in about a second.
const FALLING: FallingBot[] = [
  { left: '3%', bottom: -30, size: 140, color: 'red', shape: 'pill', delay: 0.2, tilt: -6 },
  { left: '15%', bottom: -22, size: 120, color: 'green', shape: 'hex', delay: 0.42, tilt: 8 },
  { left: '27%', bottom: -34, size: 130, color: 'purple', shape: 'orb', delay: 0.65, tilt: 0 },
  { left: '62%', bottom: -28, size: 126, color: 'amber', shape: 'hex', delay: 0.32, tilt: -4 },
  { left: '74%', bottom: -20, size: 116, color: 'magenta', shape: 'triangle', delay: 0.55, tilt: 5 },
  { left: '86%', bottom: -32, size: 136, color: 'orange', shape: 'squircle', delay: 0.78, tilt: -8 },
];

export function BootLoader() {
  const t = useT();
  const current = useSyncExternalStore(subscribe, () => stage);
  const [mountedAt] = useState(() => Date.now());
  const [progress, setProgress] = useState(8);
  const [phase, setPhase] = useState<'shown' | 'fading' | 'gone'>('shown');
  const [slow, setSlow] = useState(false);

  // Progress: each stage has a range; within it the bar creeps forward so it never looks stuck.
  useEffect(() => {
    if (current === 'ready') {
      setProgress(100);
      return;
    }
    const [floor, cap] = current === 'connecting' ? [12, 42] : [45, 92];
    setProgress((p) => Math.max(p, floor));
    const timer = window.setInterval(() => {
      setProgress((p) => (p < cap ? p + (cap - p) * 0.08 : p));
    }, 220);
    return () => window.clearInterval(timer);
  }, [current]);

  // A first start (or a big workspace) can take a while: say so instead of looking frozen.
  useEffect(() => {
    if (current === 'ready') return;
    const timer = window.setTimeout(() => setSlow(true), 9000);
    return () => window.clearTimeout(timer);
  }, [current]);

  // Fade out once ready and the minimum time has passed.
  useEffect(() => {
    if (current !== 'ready') return;
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - mountedAt)) + 250; // let the bar reach 100%
    const fade = window.setTimeout(() => setPhase('fading'), wait);
    const gone = window.setTimeout(() => setPhase('gone'), wait + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [current, mountedAt]);

  if (phase === 'gone') return null;

  const statusText =
    current === 'connecting'
      ? t('Starting Atelier…')
      : current === 'loading'
        ? t('Waking up your agents…')
        : t('Ready');

  return (
    <div
      className="boot-loader"
      role="status"
      aria-live="polite"
      aria-label={statusText}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        overflow: 'hidden',
        background: 'radial-gradient(ellipse at 50% 42%, #16161d 0%, var(--bg-base, #0d0d11) 62%)',
        opacity: phase === 'fading' ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: phase === 'fading' ? 'none' : 'auto',
      }}
    >
      {/* Bots lowered on gold cables, swaying once they settle. */}
      {HANGING.map((b, i) => (
        <div
          key={`h${i}`}
          className="boot-hang"
          style={
            {
              left: b.left,
              width: b.size,
              marginLeft: -b.size / 2,
              '--len': `${b.len}vh`,
              '--delay': `${b.delay}s`,
              '--sway': `${2.6 + (i % 3) * 0.5}s`,
            } as React.CSSProperties
          }
        >
          <div className="boot-swing">
            <span className="boot-rope" />
            <span className="boot-knot" />
            <BotMascot size={b.size} color={b.color} shape={b.shape} seed={`boot-h${i}`} interactive />
          </div>
        </div>
      ))}

      {/* A few tumble down and pile up at the bottom. */}
      {FALLING.map((b, i) => (
        <div
          key={`f${i}`}
          className="boot-fall"
          style={
            {
              left: b.left,
              bottom: b.bottom,
              '--delay': `${b.delay}s`,
              '--tilt': `${b.tilt}deg`,
            } as React.CSSProperties
          }
        >
          <BotMascot size={b.size} color={b.color} shape={b.shape} seed={`boot-f${i}`} interactive />
        </div>
      ))}

      {/* Logo, progress, status */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '44%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          textAlign: 'center',
        }}
      >
        <div className="boot-logo">
          <svg width="34" height="26" viewBox="0 0 104 80" fill="currentColor" aria-hidden>
            <path d="M3 76.5 36.9 12.5C40.3 6.2 45 3.5 51 3.5c6.3 0 11 3 14.2 9.1l15.4 28H62.7L51 19.1 19.6 76.5Z" />
            <path d="m31.3 76.5 12.6-23.6c2.7-5.1 7.4-7.5 13.1-7.5h26l16.9 31.1H82L73.6 61H56.5l-8.3 15.5Z" />
          </svg>
        </div>
        <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: '0.02em', color: 'var(--text-primary, #e4e4ea)' }}>
          Atelier
        </div>
        <div className="boot-bar" aria-hidden>
          <span className="boot-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary, #9494a3)', minHeight: 18 }}>{statusText}</div>
        {slow && current !== 'ready' && (
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary, #8a8a98)', maxWidth: 300, lineHeight: 1.45 }}>
            {t('Still starting. The first start after an update can take a little longer.')}
          </div>
        )}
      </div>
    </div>
  );
}
