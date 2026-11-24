import { useEffect, useMemo, useRef } from 'react';
import patternSource from '../assets/atelier-pattern.svg?raw';
import { isAnimationActive, subscribeAnimationGate } from '../state/animationGate';

/**
 * Atelier "patron de coupe" background: ~40 SVG paths ("cables").
 *
 *  - Ambient drift: every cable sways slowly and continuously (a smooth wave in space and time,
 *    so neighbouring strands in a bundle move together like real cables).
 *  - Pointer: strands bend away from the cursor, same behaviour as the original SVG script.
 *
 * Cost is small by design: ~1.9k points of math at 15 fps, and the loop sleeps entirely while the
 * window is unfocused / hidden / in the tray (animationGate).
 *
 * The SVG file is shipped as-is (assets/atelier-pattern.svg). Its embedded <script> never runs when
 * injected as markup, so it is stripped and the pointer behaviour is implemented here instead.
 */
const MARKUP = patternSource
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace('<svg ', '<svg width="100%" height="100%" ');

const FRAME_MS = 1000 / 15;
/** Ambient sway amplitude in SVG units (viewBox is 1920 wide) and angular speeds in rad/s. */
const SWAY = 11;
const SWAY_SPEED_X = 0.32; // ~20 s per cycle
const SWAY_SPEED_Y = 0.25; // ~25 s per cycle

interface Strand {
  el: SVGPathElement;
  original: string;
  coords: number[];
}

export function PatternBackground({ dimmed = false }: { dimmed?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => ({ __html: MARKUP }), []);

  useEffect(() => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const strands: Strand[] = Array.from(svg.querySelectorAll('path'), (el) => {
      const original = el.getAttribute('d') ?? '';
      return { el, original, coords: (original.match(/-?[\d.]+/g) ?? []).map(Number) };
    });

    let target: DOMPoint | null = null; // pointer in SVG coordinates
    let x = 0;
    let y = 0;
    let power = 0; // 0..1 strength of the pointer effect
    let raf = 0;
    let running = false;
    let lastDraw = 0;
    let lastTick = 0;
    const t0 = performance.now();

    function draw(now: number) {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.2, lastTick ? (now - lastTick) / 1000 : FRAME_MS / 1000);
      lastTick = now;

      // frame-rate independent easing (≈ the original 0.26 / 0.18 per 60 fps frame)
      if (target) {
        const k = 1 - Math.exp(-18 * dt);
        x += (target.x - x) * k;
        y += (target.y - y) * k;
      }
      power += ((target ? 1 : 0) - power) * (1 - Math.exp(-12 * dt));
      if (!target && power < 0.003) power = 0;

      const sx = t * SWAY_SPEED_X;
      const sy = t * SWAY_SPEED_Y;
      for (const strand of strands) {
        const c = strand.coords;
        const out: string[] = [];
        for (let k = 0; k < c.length; k += 2) {
          let px = c[k] + SWAY * Math.sin(sx + c[k + 1] * 0.0042 + c[k] * 0.0021);
          let py = c[k + 1] + SWAY * 0.6 * Math.cos(sy + c[k] * 0.0033 + c[k + 1] * 0.0027);
          if (power) {
            const dx = px - x;
            const dy = py - y;
            const f = power * Math.max(0, 1 - Math.hypot(dx, dy) / 145) ** 2;
            if (f) {
              px += f * (26 + dx * 0.44);
              py += f * (dy * 0.32 - 10);
            }
          }
          out.push(`${px.toFixed(1)} ${py.toFixed(1)}`);
        }
        strand.el.setAttribute('d', `M${out[0]} Q${out.slice(1, -1).join(' ')} T${out[out.length - 1]}`);
      }
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - lastDraw < FRAME_MS) return;
      lastDraw = now;
      draw(now);
    };
    const start = () => {
      if (running || !isAnimationActive()) return;
      running = true;
      lastTick = 0;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
      target = null; // let the pointer effect relax when we wake up again
      power = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (!running) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      target = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      if (!power) {
        x = target.x;
        y = target.y;
      }
    };
    const onLeave = () => {
      target = null;
    };

    draw(performance.now()); // first frame immediately (also shown while unfocused)
    start();
    const unsubscribeGate = subscribeAnimationGate((active) => (active ? start() : stop()));
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointercancel', onLeave);
    return () => {
      unsubscribeGate();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointercancel', onLeave);
      cancelAnimationFrame(raf);
      for (const s of strands) s.el.setAttribute('d', s.original);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden
      dangerouslySetInnerHTML={html}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        overflow: 'hidden',
        background: '#101115',
        opacity: dimmed ? 0.45 : 0.78,
        transition: 'opacity 400ms var(--ease-atelier)',
      }}
    />
  );
}
