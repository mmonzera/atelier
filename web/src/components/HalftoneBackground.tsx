import { useEffect, useRef } from 'react';
import { isAnimationActive, subscribeAnimationGate } from '../state/animationGate';

type FireData = typeof import('../assets/halftone-fire.json');

/**
 * Halftone "fire" background (from the Halftone Background SVG).
 *
 * The 9.8k dots are drawn on one canvas (far cheaper than 9.8k SVG nodes) and
 * animated with:
 *  - per-dot flicker (radius + brightness)
 *  - a heat wave that travels upward through the flames
 *  - slight sway / shimmer, stronger toward flame tips
 *  - pointer repulsion (same spring model as the original SVG script)
 * Respects prefers-reduced-motion (static frame) and pauses when the tab is hidden.
 */

const STRIDE = 6; // x, y, r*100, R, G, B
const POINTER_RADIUS = 135; // in SVG units
const POINTER_STRENGTH = 42;
const ALPHA_LEVELS = 5;
const FRAME_MS = 1000 / 15; // fire doesn't need 60fps; saves CPU/GPU/battery

interface Dots {
  n: number;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
  lift: Float32Array; // 0 at flame base .. 1 at flame tip
  dx: Float32Array; // pointer displacement (spring state)
  dy: Float32Array;
  bucket: Uint8Array; // palette bucket index per dot
  palette: string[];
  col: Float32Array; // quantized r,g,b (0..1) per dot, for the WebGL renderer
}

function hash(i: number): number {
  let n = Math.imul(i + 1, 374761393);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function buildDots(fire: FireData): Dots {
  const groups = [fire.left, fire.right];
  const n = groups.reduce((s, g) => s + g.length / STRIDE, 0);
  const d: Dots = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    r: new Float32Array(n),
    phase: new Float32Array(n),
    speed: new Float32Array(n),
    lift: new Float32Array(n),
    dx: new Float32Array(n),
    dy: new Float32Array(n),
    bucket: new Uint8Array(n),
    palette: [],
    col: new Float32Array(n * 3),
  };
  const rgb = new Array<[number, number, number]>(n);
  let i = 0;
  for (const g of groups) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 1; k < g.length; k += STRIDE) {
      minY = Math.min(minY, g[k]);
      maxY = Math.max(maxY, g[k]);
    }
    const span = Math.max(1, maxY - minY);
    for (let k = 0; k < g.length; k += STRIDE, i += 1) {
      d.x[i] = g[k];
      d.y[i] = g[k + 1];
      d.r[i] = g[k + 2] / 100;
      rgb[i] = [g[k + 3], g[k + 4], g[k + 5]];
      d.phase[i] = hash(i) * Math.PI * 2;
      d.speed[i] = 0.7 + hash(i + 7919) * 1.1;
      d.lift[i] = 1 - (g[k + 1] - minY) / span;
    }
  }
  // Quantize colours into a small palette so each frame needs only a few fills.
  const q = (v: number) => Math.round(v / 12) * 12;
  const index = new Map<string, number>();
  for (let j = 0; j < n; j += 1) {
    const key = `${q(rgb[j][0])},${q(rgb[j][1])},${q(rgb[j][2])}`;
    let b = index.get(key);
    if (b === undefined) {
      b = d.palette.length;
      d.palette.push(`rgb(${key})`);
      index.set(key, b);
    }
    d.bucket[j] = b;
    d.col[j * 3] = q(rgb[j][0]) / 255;
    d.col[j * 3 + 1] = q(rgb[j][1]) / 255;
    d.col[j * 3 + 2] = q(rgb[j][2]) / 255;
  }
  return d;
}

const VERT = `
attribute vec4 a_dot; // x, y (css px), radius (css px), alpha
attribute vec3 a_col;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_max;
varying vec3 v_col;
varying float v_a;
void main() {
  vec2 clip = (a_dot.xy / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = clamp(a_dot.z * 2.0 * u_dpr + 1.0, 1.0, u_max);
  v_col = a_col;
  v_a = a_dot.w;
}`;

const FRAG = `
precision mediump float;
varying vec3 v_col;
varying float v_a;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float m = 1.0 - smoothstep(0.7, 1.0, d);
  if (m <= 0.0) discard;
  float a = v_a * m;
  gl_FragColor = vec4(v_col * a, a);
}`;

interface GLRenderer {
  resize(cssW: number, cssH: number, dpr: number): void;
  draw(data: Float32Array, n: number): void;
  dispose(): void;
}

/**
 * All dots in a single draw call (point sprites). The previous 2D-canvas version rasterised
 * ~10k arcs per frame, which kept the GPU process near 100% of a core even when idle.
 */
function createGLRenderer(canvas: HTMLCanvasElement, col: Float32Array, n: number): GLRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const dyn = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, dyn);
  gl.bufferData(gl.ARRAY_BUFFER, n * 16, gl.DYNAMIC_DRAW);
  const aDot = gl.getAttribLocation(prog, 'a_dot');
  gl.enableVertexAttribArray(aDot);
  gl.vertexAttribPointer(aDot, 4, gl.FLOAT, false, 0, 0);

  const stat = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, stat);
  gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(prog, 'a_col');
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uDpr = gl.getUniformLocation(prog, 'u_dpr');
  gl.uniform1f(
    gl.getUniformLocation(prog, 'u_max'),
    (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1],
  );
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  let lost = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    resize(cssW, cssH, dpr) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, cssW, cssH);
      gl.uniform1f(uDpr, dpr);
    },
    draw(data, count) {
      if (lost) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, dyn);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.bindBuffer(gl.ARRAY_BUFFER, stat);
      gl.drawArrays(gl.POINTS, 0, count);
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export function HalftoneBackground({ dimmed = false }: { dimmed?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    let gl: GLRenderer | null = null;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void import('../assets/halftone-fire.json').then((mod) => {
      if (cancelled) return;
      const fire: FireData = mod.default;
      const dots = buildDots(fire);
      gl = createGLRenderer(canvas, dots.col, dots.n);
      if (!gl) ctx = canvas.getContext('2d');
      if (!gl && !ctx) return;
      const glBuf = new Float32Array(dots.n * 4);
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      let scale = 1;
      let offX = 0;
      let offY = 0;
      let pointer: { x: number; y: number } | null = null; // SVG units
      let raf = 0;
      let running = false;

      const resize = () => {
        // Soft decorative dots don't need retina resolution; 1x cuts fill cost 2-4x.
        const dpr = gl ? Math.min(window.devicePixelRatio || 1, 1.5) : 1;
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (gl) {
          gl.resize(w, h, dpr);
        } else {
          canvas.width = Math.floor(w * dpr);
          canvas.height = Math.floor(h * dpr);
          canvas.style.width = `${w}px`;
          canvas.style.height = `${h}px`;
        }
        // "slice": cover the viewport like preserveAspectRatio="xMidYMid slice"
        scale = Math.max(w / fire.w, h / fire.h);
        offX = (w - fire.w * scale) / 2;
        offY = (h - fire.h * scale) / 2;
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!running) frame(performance.now());
      };

      const frame = (now: number) => {
        const t = reduceMotion ? 0 : now / 1000;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx?.clearRect(0, 0, w, h);

        const P = dots.palette.length;
        const paths: Path2D[] = new Array(P * ALPHA_LEVELS);

        for (let i = 0; i < dots.n; i += 1) {
          const bx = dots.x[i];
          const by = dots.y[i];
          const lift = dots.lift[i];
          const ph = dots.phase[i];

          // pointer repulsion (spring), same model as the source SVG
          let tx = 0;
          let ty = 0;
          if (pointer && !reduceMotion) {
            const px = bx - pointer.x;
            const py = by - pointer.y;
            const dist = Math.hypot(px, py);
            if (dist < POINTER_RADIUS) {
              const force = POINTER_STRENGTH * (1 - dist / POINTER_RADIUS) ** 2;
              tx = (force * px) / (dist || 1);
              ty = (force * py) / (dist || 1);
            }
          }
          if (tx || ty || dots.dx[i] || dots.dy[i]) {
            dots.dx[i] += (tx - dots.dx[i]) * 0.18;
            dots.dy[i] += (ty - dots.dy[i]) * 0.18;
            if (Math.abs(dots.dx[i] - tx) + Math.abs(dots.dy[i] - ty) < 0.08) {
              dots.dx[i] = tx;
              dots.dy[i] = ty;
            }
          }

          // flicker + heat wave rising through the flames
          const sp = dots.speed[i];
          const flick = 0.5 + 0.5 * Math.sin(t * sp * 2.1 + ph);
          const wave = 0.5 + 0.5 * Math.sin(t * 1.5 - by * 0.022 + bx * 0.006 + ph * 0.15);
          const e = reduceMotion ? 0.55 : 0.55 * wave + 0.45 * flick;

          const sway = reduceMotion ? 0 : lift;
          const x = bx + dots.dx[i] + Math.sin(t * 0.8 + by * 0.012 + ph) * 1.4 * sway;
          const y = by + dots.dy[i] - (0.5 + 0.5 * Math.sin(t * sp + ph)) * 2.2 * sway;
          const rad = dots.r[i] * (0.8 + 0.5 * e + 0.25 * lift * wave);

          const cx = offX + x * scale;
          const cy = offY + y * scale;
          const r = rad * scale;
          if (gl) {
            const o = i * 4;
            glBuf[o] = cx;
            glBuf[o + 1] = cy;
            glBuf[o + 2] = r;
            glBuf[o + 3] = 0.5 + 0.5 * Math.min(1, e);
            continue;
          }
          const a = Math.min(ALPHA_LEVELS - 1, Math.floor(e * ALPHA_LEVELS));
          const key = dots.bucket[i] * ALPHA_LEVELS + a;
          const path = paths[key] ?? (paths[key] = new Path2D());
          path.moveTo(cx + r, cy);
          path.arc(cx, cy, r, 0, Math.PI * 2);
        }

        if (gl) {
          gl.draw(glBuf, dots.n);
          return;
        }
        if (!ctx) return;

        for (let key = 0; key < paths.length; key += 1) {
          const path = paths[key];
          if (!path) continue;
          ctx.globalAlpha = 0.5 + (0.5 * ((key % ALPHA_LEVELS) + 0.5)) / ALPHA_LEVELS;
          ctx.fillStyle = dots.palette[Math.floor(key / ALPHA_LEVELS)];
          ctx.fill(path);
        }
        ctx.globalAlpha = 1;
      };

      let last = 0;
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (now - last < FRAME_MS) return;
        last = now;
        frame(now);
      };
      const start = () => {
        if (running || reduceMotion || !isAnimationActive()) return;
        running = true;
        raf = requestAnimationFrame(loop);
      };
      const stop = () => {
        running = false;
        cancelAnimationFrame(raf);
      };

      const onMove = (e: PointerEvent) => {
        pointer = { x: (e.clientX - offX) / scale, y: (e.clientY - offY) / scale };
      };
      const onLeave = () => {
        pointer = null;
      };
      // Sleep (keeping the last frame) while unfocused / hidden / in the tray.
      const unsubscribeGate = subscribeAnimationGate((active) => (active ? start() : stop()));

      resize();
      start();
      window.addEventListener('resize', resize);
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('pointerleave', onLeave);
      window.addEventListener('blur', onLeave);
      cleanup = () => {
        unsubscribeGate();
        gl?.dispose();
        stop();
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('blur', onLeave);
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        overflow: 'hidden',
        background: 'radial-gradient(circle at 50% 45%, #1b1c20 0%, #0b0c0e 100%)',
      }}
    >
      <div className="fire-glow fire-glow-left" />
      <div className="fire-glow fire-glow-right" />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'block',
          opacity: dimmed ? 0.3 : 1,
          transition: 'opacity 400ms var(--ease-atelier)',
        }}
      />
    </div>
  );
}
