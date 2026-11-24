import { useEffect, useMemo, useRef } from 'react';
import patternSource from '../assets/atelier-pattern.svg?raw';
import { isAnimationActive } from '../state/animationGate';

/**
 * Atelier "patron de coupe" background: ~40 static SVG paths (a few KB of GPU work, no per-frame
 * redraw). Strands bend away from the pointer; that motion only runs while the pointer moves.
 *
 * The SVG file is shipped as-is (assets/atelier-pattern.svg). Its embedded <script> never runs when
 * injected as markup, so it is stripped and the same pointer behaviour is implemented below.
 */
const MARKUP = patternSource
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace('<svg ', '<svg width="100%" height="100%" ');

interface Strand {
  el: SVGPathElement;
  original: string;
  coords: number[];
  dirty: boolean;
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
      return { el, original, coords: (original.match(/-?[\d.]+/g) ?? []).map(Number), dirty: false };
    });

    let target: DOMPoint | null = null;
    let x = 0;
    let y = 0;
    let power = 0;
    let frame = 0;

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    function draw() {
      frame = 0;
      if (target) {
        x += (target.x - x) * 0.26;
        y += (target.y - y) * 0.26;
      }
      power += ((target ? 1 : 0) - power) * 0.18;
      if (!target && power < 0.003) power = 0;

      for (const strand of strands) {
        const c = strand.coords;
        if (!power) {
          if (strand.dirty) {
            strand.el.setAttribute('d', strand.original);
            strand.dirty = false;
          }
          continue;
        }
        let changed = false;
        const out: string[] = [];
        for (let k = 0; k < c.length; k += 2) {
          const dx = c[k] - x;
          const dy = c[k + 1] - y;
          const d = Math.hypot(dx, dy);
          const f = power * Math.max(0, 1 - d / 145) ** 2;
          if (f) changed = true;
          out.push(`${(c[k] + f * (26 + dx * 0.44)).toFixed(1)} ${(c[k + 1] + f * (dy * 0.32 - 10)).toFixed(1)}`);
        }
        if (changed) {
          strand.el.setAttribute('d', `M${out[0]} Q${out.slice(1, -1).join(' ')} T${out[out.length - 1]}`);
        } else if (strand.dirty) {
          strand.el.setAttribute('d', strand.original);
        }
        strand.dirty = changed;
      }

      const settling = target ? Math.hypot(target.x - x, target.y - y) > 0.1 || power < 0.998 : power;
      if (settling) schedule();
    }

    const onMove = (e: PointerEvent) => {
      if (!isAnimationActive()) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      target = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      if (!power) {
        x = target.x;
        y = target.y;
      }
      schedule();
    };
    const onLeave = () => {
      target = null;
      schedule();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointercancel', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointercancel', onLeave);
      window.removeEventListener('blur', onLeave);
      if (frame) cancelAnimationFrame(frame);
      for (const s of strands) if (s.dirty) s.el.setAttribute('d', s.original);
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
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 400ms var(--ease-atelier)',
      }}
    />
  );
}
