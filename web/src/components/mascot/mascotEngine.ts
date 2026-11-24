import type { AgentAvatarShape, AgentColor } from '@atelier/contracts';
import { MASCOT_SHAPE_MAP, resolveMascotColor, resolveMascotShape } from './mascotConfig';
import { MASCOT_FRAG_SRC, MASCOT_VERT_SRC } from './mascotShader';

export interface MascotRenderParams {
  size: number;
  color?: AgentColor;
  shape?: AgentAvatarShape;
  seed?: string;
  lookX: number;
  lookY: number;
  blink: number;
  breath: number;
  hover: number;
  working: number;
  error: number;
}

const OFFSCREEN_SIZE = 256;

interface Uniforms {
  uResolution: WebGLUniformLocation | null;
  uPixelSize: WebGLUniformLocation | null;
  uShape: WebGLUniformLocation | null;
  uBaseColor: WebGLUniformLocation | null;
  uDeepColor: WebGLUniformLocation | null;
  uRimColor: WebGLUniformLocation | null;
  uEyeLayout: WebGLUniformLocation | null;
  uLook: WebGLUniformLocation | null;
  uBlink: WebGLUniformLocation | null;
  uBreath: WebGLUniformLocation | null;
  uHover: WebGLUniformLocation | null;
  uWorking: WebGLUniformLocation | null;
  uError: WebGLUniformLocation | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[MascotEngine] shader compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

class MascotEngine {
  private glCanvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: Uniforms | null = null;
  private contextLost = false;
  private glFailed = false;

  private ensureWebGL(): boolean {
    if (this.glFailed || this.contextLost) return false;
    if (this.gl && this.program && this.vao && this.uniforms) return true;
    if (typeof document === 'undefined') return false;

    const canvas = document.createElement('canvas');
    canvas.width = OFFSCREEN_SIZE;
    canvas.height = OFFSCREEN_SIZE;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power', // tiny 2D-ish shader: never wake the discrete GPU
    });

    if (!gl) {
      this.glFailed = true;
      return false;
    }

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.program = null;
      this.vao = null;
      this.uniforms = null;
    });

    const vs = compileShader(gl, gl.VERTEX_SHADER, MASCOT_VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, MASCOT_FRAG_SRC);
    if (!vs || !fs) {
      this.glFailed = true;
      return false;
    }

    const prog = gl.createProgram();
    if (!prog) {
      this.glFailed = true;
      return false;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[MascotEngine] program link failed:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      this.glFailed = true;
      return false;
    }

    const vao = gl.createVertexArray();
    if (!vao) {
      gl.deleteProgram(prog);
      this.glFailed = true;
      return false;
    }

    this.glCanvas = canvas;
    this.gl = gl;
    this.program = prog;
    this.vao = vao;
    this.uniforms = {
      uResolution: gl.getUniformLocation(prog, 'uResolution'),
      uPixelSize: gl.getUniformLocation(prog, 'uPixelSize'),
      uShape: gl.getUniformLocation(prog, 'uShape'),
      uBaseColor: gl.getUniformLocation(prog, 'uBaseColor'),
      uDeepColor: gl.getUniformLocation(prog, 'uDeepColor'),
      uRimColor: gl.getUniformLocation(prog, 'uRimColor'),
      uEyeLayout: gl.getUniformLocation(prog, 'uEyeLayout'),
      uLook: gl.getUniformLocation(prog, 'uLook'),
      uBlink: gl.getUniformLocation(prog, 'uBlink'),
      uBreath: gl.getUniformLocation(prog, 'uBreath'),
      uHover: gl.getUniformLocation(prog, 'uHover'),
      uWorking: gl.getUniformLocation(prog, 'uWorking'),
      uError: gl.getUniformLocation(prog, 'uError'),
    };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);

    return true;
  }

  public render(targetCanvas: HTMLCanvasElement, params: MascotRenderParams): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const px = Math.min(OFFSCREEN_SIZE, Math.max(32, Math.round(params.size * dpr)));

    if (targetCanvas.width !== px || targetCanvas.height !== px) {
      targetCanvas.width = px;
      targetCanvas.height = px;
    }

    const ctx2d = targetCanvas.getContext('2d');
    if (!ctx2d) return;

    if (!this.ensureWebGL() || !this.gl || !this.glCanvas || !this.program || !this.vao || !this.uniforms) {
      renderMascot2DFallback(ctx2d, px, params);
      return;
    }

    const gl = this.gl;
    const u = this.uniforms;
    const colorSpec = resolveMascotColor(params.color);
    const shapeId = resolveMascotShape(params.shape, params.seed);
    const shapeSpec = MASCOT_SHAPE_MAP[shapeId];

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.scissor(0, 0, px, px);
    gl.viewport(0, 0, px, px);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(u.uResolution, px, px);
    gl.uniform1f(u.uPixelSize, px);
    gl.uniform1i(u.uShape, shapeSpec.shaderIndex);
    gl.uniform3f(u.uBaseColor, colorSpec.base[0], colorSpec.base[1], colorSpec.base[2]);
    gl.uniform3f(u.uDeepColor, colorSpec.deep[0], colorSpec.deep[1], colorSpec.deep[2]);
    gl.uniform3f(u.uRimColor, colorSpec.rim[0], colorSpec.rim[1], colorSpec.rim[2]);
    gl.uniform2f(u.uEyeLayout, shapeSpec.eyeLayout[0], shapeSpec.eyeLayout[1]);
    gl.uniform2f(u.uLook, params.lookX, params.lookY);
    gl.uniform1f(u.uBlink, params.blink);
    gl.uniform1f(u.uBreath, params.breath);
    gl.uniform1f(u.uHover, params.hover);
    gl.uniform1f(u.uWorking, params.working);
    gl.uniform1f(u.uError, params.error);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // WebGL viewport (0, 0, px, px) draws into the bottom-left of glCanvas;
    // Canvas 2D drawImage uses top-left coordinates, so sample from sy = OFFSCREEN_SIZE - px.
    ctx2d.clearRect(0, 0, px, px);
    ctx2d.drawImage(this.glCanvas, 0, OFFSCREEN_SIZE - px, px, px, 0, 0, px, px);
  }
}

export const mascotEngine = new MascotEngine();

/* ───────── Software 2D plush fallback if WebGL2 is unavailable ───────── */

function toRgbCss(c: [number, number, number], alpha = 1): string {
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawPolygonPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  sides: number,
  radius: number,
  rotationRad: number,
) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = rotationRad + (i * Math.PI * 2) / sides;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function traceShape2D(
  ctx: CanvasRenderingContext2D,
  shape: AgentAvatarShape,
  cx: number,
  cy: number,
  r: number,
) {
  switch (shape) {
    case 'triangle':
      drawPolygonPath(ctx, cx, cy + r * 0.1, 3, r * 0.92, -Math.PI / 2);
      return;
    case 'hex':
      drawPolygonPath(ctx, cx, cy, 6, r * 0.88, Math.PI / 6);
      return;
    case 'pentagon':
      drawPolygonPath(ctx, cx, cy + r * 0.04, 5, r * 0.88, -Math.PI / 2);
      return;
    case 'diamond':
      drawPolygonPath(ctx, cx, cy, 4, r * 0.9, 0);
      return;
    case 'squircle':
    case 'cube': {
      const w = r * 1.44;
      const h = shape === 'cube' ? r * 1.44 : r * 1.36;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r * 0.42);
      return;
    }
    case 'pill': {
      const w = r * 1.66;
      const h = r * 1.1;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
      return;
    }
    case 'barrel': {
      const w = r * 1.24;
      const h = r * 1.56;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r * 0.36);
      return;
    }
    case 'cloud': {
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.2, r * 0.48, 0, Math.PI * 2);
      ctx.arc(cx - r * 0.38, cy + r * 0.04, r * 0.42, 0, Math.PI * 2);
      ctx.arc(cx + r * 0.38, cy + r * 0.04, r * 0.42, 0, Math.PI * 2);
      ctx.arc(cx, cy + r * 0.24, r * 0.45, 0, Math.PI * 2);
      return;
    }
    case 'pebble':
    case 'blob': {
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * 0.05, r * 0.82, r * 0.72, shape === 'pebble' ? -0.15 : 0, 0, Math.PI * 2);
      return;
    }
    default:
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  }
}

function renderMascot2DFallback(
  ctx: CanvasRenderingContext2D,
  px: number,
  params: MascotRenderParams,
) {
  const colorSpec = resolveMascotColor(params.color);
  const shapeId = resolveMascotShape(params.shape, params.seed);
  const shapeSpec = MASCOT_SHAPE_MAP[shapeId];

  ctx.clearRect(0, 0, px, px);
  const cx = px * 0.5 + params.lookX * px * 0.025;
  const cy = px * 0.5 - params.lookY * px * 0.02 - params.working * Math.abs(params.breath) * px * 0.025;
  const r = px * 0.38;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Soft outer fur fuzz ring
  traceShape2D(ctx, shapeId, cx, cy, r);
  ctx.strokeStyle = toRgbCss(colorSpec.rim, 0.38);
  ctx.lineWidth = Math.max(2, px * 0.09);
  ctx.stroke();

  // 3D sphere-like radial gradient body
  const grad = ctx.createRadialGradient(
    cx - r * 0.28 + params.lookX * r * 0.14,
    cy - r * 0.32 - params.lookY * r * 0.14,
    r * 0.1,
    cx,
    cy,
    r * 1.05,
  );
  grad.addColorStop(0, toRgbCss(colorSpec.rim, 1));
  grad.addColorStop(0.32, toRgbCss(colorSpec.base, 1));
  grad.addColorStop(1, toRgbCss(colorSpec.deep, 1));
  ctx.fillStyle = grad;
  ctx.fill();

  // Cursor-tracking 3D cream capsule eyes
  const eyeCenterX = cx + params.lookX * r * 0.36;
  const eyeCenterY = cy - shapeSpec.eyeLayout[1] * r * 1.4 - params.lookY * r * 0.28;
  const eyeSpacing = shapeSpec.eyeLayout[0] * r * 2.15;
  const eyeW = Math.max(2, r * 0.19);
  const eyeH = Math.max(1.5, r * 0.36 * (1 - 0.85 * params.blink) * (1 - 0.25 * params.error));

  for (const dir of [-1, 1]) {
    const ex = eyeCenterX + dir * eyeSpacing;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.roundRect(ex - eyeW * 0.6, eyeCenterY - eyeH * 0.55, eyeW * 1.2, eyeH * 1.25, eyeW);
    ctx.fill();

    ctx.fillStyle = '#faf4e9';
    ctx.beginPath();
    ctx.roundRect(ex - eyeW * 0.5, eyeCenterY - eyeH * 0.5, eyeW, eyeH, eyeW * 0.5);
    ctx.fill();
  }

  ctx.restore();
}
