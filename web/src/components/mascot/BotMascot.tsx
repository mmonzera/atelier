import type { AgentAvatarShape, AgentColor, AgentStatus } from '@atelier/contracts';
import { useEffect, useRef, useState } from 'react';
import { hashSeed } from './mascotConfig';
import { mascotEngine } from './mascotEngine';
import { getPointerState, prefersReducedMotion, subscribeMascotFrame } from './mascotPointer';

export interface BotMascotProps {
  size?: number;
  color?: AgentColor;
  shape?: AgentAvatarShape;
  seed?: string;
  status?: AgentStatus;
  interactive?: boolean;
  hoverAnimate?: boolean;
  active?: boolean;
  clickable?: boolean;
  className?: string;
}

export function BotMascot({
  size = 32,
  color = 'green',
  shape,
  seed,
  status = 'idle',
  interactive = true,
  hoverAnimate = false,
  active = false,
  clickable = false,
  className,
}: BotMascotProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState(false);

  const propsRef = useRef({
    size,
    color,
    shape,
    seed,
    status,
    interactive,
    active,
    hovered,
  });
  propsRef.current = {
    size,
    color,
    shape,
    seed,
    status,
    interactive,
    active,
    hovered,
  };

  const animRef = useRef({
    lookX: interactive ? 0 : 0.18,
    lookY: interactive ? 0 : 0.08,
    blink: 0,
    hoverMix: 0,
    hopMix: 0,
    nextBlinkAt: 0,
    blinkEndAt: 0,
    lastRectAt: 0,
    cx: 0,
    cy: 0,
    phase: hashSeed(seed) * Math.PI * 2,
  });

  useEffect(() => {
    animRef.current.phase = hashSeed(seed) * Math.PI * 2;
  }, [seed]);

  const shouldAnimate = interactive || (hoverAnimate && hovered);

  // Static initial/prop render when idle (or before first rAF tick)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (shouldAnimate && !prefersReducedMotion()) return;

    mascotEngine.render(canvas, {
      size,
      color,
      shape,
      seed,
      lookX: interactive ? 0.08 : 0.18,
      lookY: interactive ? 0.04 : 0.08,
      blink: 0,
      breath: 0,
      hover: active ? 0.45 : 0,
      working: status === 'working' ? 0.5 : 0,
      error: status === 'error' ? 1 : 0,
    });
  }, [size, color, shape, seed, status, interactive, active, shouldAnimate]);

  // Animated frame subscription (shared global rAF + single global pointer listener)
  useEffect(() => {
    if (!shouldAnimate) return;
    if (prefersReducedMotion()) return;

    const st = animRef.current;
    const nowInit = performance.now();
    if (!st.nextBlinkAt) {
      st.nextBlinkAt = nowInit + 1400 + hashSeed(seed) * 2800;
    }

    const renderNow = (nowMs: number, dtSec: number) => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      if (!canvas || !host) return;

      const cur = propsRef.current;
      const ptr = getPointerState();

      // Refresh host bounding box at most ~8 times/sec when pointer is active
      if (nowMs - st.lastRectAt > 120 || st.lastRectAt === 0) {
        const rect = host.getBoundingClientRect();
        st.cx = rect.left + rect.width * 0.5;
        st.cy = rect.top + rect.height * 0.5;
        st.lastRectAt = nowMs;
      }

      let targetX = Math.sin(nowMs * 0.0008 + st.phase) * 0.14;
      let targetY = Math.cos(nowMs * 0.0006 + st.phase) * 0.08;

      if (ptr.active) {
        const dx = ptr.x - st.cx;
        const dy = ptr.y - st.cy;
        targetX = Math.tanh(dx / 220);
        targetY = Math.tanh(-dy / 220);
      }

      const damp = 1 - Math.exp(-12 * dtSec);
      st.lookX += (targetX - st.lookX) * damp;
      st.lookY += (targetY - st.lookY) * damp;

      // Natural blinking cycle
      if (nowMs >= st.nextBlinkAt) {
        st.blinkEndAt = nowMs + 145;
        st.nextBlinkAt = nowMs + 2800 + Math.random() * 3400;
      }
      let targetBlink = 0;
      if (nowMs < st.blinkEndAt) {
        const progress = 1 - (st.blinkEndAt - nowMs) / 145;
        targetBlink = Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI);
      }
      st.blink = targetBlink;

      const hoverTarget = cur.hovered || cur.active ? 1 : 0;
      st.hoverMix += (hoverTarget - st.hoverMix) * (1 - Math.exp(-10 * dtSec));
      st.hopMix = Math.max(0, st.hopMix - dtSec * 2.8);

      const isWorking = cur.status === 'working';
      const breathSpeed = isWorking ? 0.0068 : 0.0024;
      const breath = Math.sin(nowMs * breathSpeed + st.phase);

      mascotEngine.render(canvas, {
        size: cur.size,
        color: cur.color,
        shape: cur.shape,
        seed: cur.seed,
        lookX: st.lookX,
        lookY: st.lookY,
        blink: st.blink,
        breath,
        hover: Math.min(1, st.hoverMix + st.hopMix * 0.7),
        working: isWorking ? 1 : st.hopMix,
        error: cur.status === 'error' ? 1 : 0,
      });
    };

    renderNow(nowInit, 1 / 60);
    return subscribeMascotFrame(renderNow);
  }, [shouldAnimate, seed]);

  const handleClick = clickable
    ? () => {
        const st = animRef.current;
        const now = performance.now();
        st.blinkEndAt = now + 160;
        st.hopMix = 1;
      }
    : undefined;

  return (
    <span
      ref={hostRef}
      className={className}
      onPointerEnter={hoverAnimate || interactive ? () => setHovered(true) : undefined}
      onPointerLeave={hoverAnimate || interactive ? () => setHovered(false) : undefined}
      onClick={handleClick}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        position: 'relative',
        cursor: clickable ? 'pointer' : undefined,
        userSelect: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: size,
          height: size,
          display: 'block',
          pointerEvents: 'none',
        }}
      />
    </span>
  );
}
