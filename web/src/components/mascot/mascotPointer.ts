export interface PointerState {
  x: number;
  y: number;
  active: boolean;
}

import { isAnimationActive, subscribeAnimationGate } from '../../state/animationGate';

type FrameCallback = (nowMs: number, dtSec: number) => void;

// Mascots are small; ~30 fps looks identical to 60 and halves the WebGL work per second.
const MIN_FRAME_MS = 1000 / 24;

const pointer: PointerState = {
  x: 0,
  y: 0,
  active: false,
};

const subscribers = new Set<FrameCallback>();
let rafId = 0;
let lastFrameMs = 0;
let listenersAttached = false;
let unsubscribeGate: (() => void) | null = null;

function onPointerMove(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.active = true;
}

function onPointerLeave() {
  pointer.active = false;
}

function onGateChange(active: boolean) {
  if (!active) {
    stopLoop();
  } else if (subscribers.size > 0) {
    startLoop();
  }
}

function attachGlobalListeners() {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('blur', onPointerLeave);
  unsubscribeGate = subscribeAnimationGate(onGateChange);
}

function detachGlobalListeners() {
  if (!listenersAttached || typeof window === 'undefined') return;
  listenersAttached = false;
  window.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerleave', onPointerLeave);
  window.removeEventListener('blur', onPointerLeave);
  unsubscribeGate?.();
  unsubscribeGate = null;
}

function tick(nowMs: number) {
  if (subscribers.size === 0 || !isAnimationActive()) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(tick);
  if (lastFrameMs && nowMs - lastFrameMs < MIN_FRAME_MS - 2) return;
  const rawDt = lastFrameMs ? (nowMs - lastFrameMs) / 1000 : 1 / 60;
  lastFrameMs = nowMs;
  const dtSec = Math.min(0.05, Math.max(0.001, rawDt));
  for (const cb of subscribers) {
    cb(nowMs, dtSec);
  }
}

function startLoop() {
  if (rafId || typeof window === 'undefined') return;
  if (!isAnimationActive()) return;
  lastFrameMs = performance.now();
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
  lastFrameMs = 0;
}

export function getPointerState(): PointerState {
  return pointer;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function subscribeMascotFrame(cb: FrameCallback): () => void {
  attachGlobalListeners();
  subscribers.add(cb);
  startLoop();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) {
      stopLoop();
      detachGlobalListeners();
    }
  };
}
