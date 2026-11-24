/**
 * One shared switch for every decorative animation (halftone fire, mascots).
 *
 * Animations only run while the window is actually being looked at: visible, focused, and not
 * tucked into the system tray. Background agents keep working; only the eye candy sleeps, which
 * is what keeps the GPU process idle while Atelier sits next to other windows or in the tray.
 */
type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let attached = false;
let hiddenByShell = false;
let last: boolean | null = null;

export function isAnimationActive(): boolean {
  if (typeof document === 'undefined') return false;
  return !document.hidden && document.hasFocus() && !hiddenByShell;
}

function emit(): void {
  const now = isAnimationActive();
  if (now === last) return;
  last = now;
  // CSS animations (fire glow) pause through this attribute; see tokens.css.
  document.documentElement.dataset.animations = now ? 'on' : 'off';
  for (const l of listeners) l(now);
}

function attach(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  last = isAnimationActive();
  document.documentElement.dataset.animations = last ? 'on' : 'off';
  window.addEventListener('focus', emit);
  window.addEventListener('blur', emit);
  document.addEventListener('visibilitychange', emit);
  // Dispatched by the desktop shell when the window is hidden to / restored from the tray.
  window.addEventListener('atelier-shell-hidden', () => {
    hiddenByShell = true;
    emit();
  });
  window.addEventListener('atelier-shell-shown', () => {
    hiddenByShell = false;
    emit();
  });
}

/** Calls `listener` whenever animations should start (true) or stop (false). Returns unsubscribe. */
export function subscribeAnimationGate(listener: Listener): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
