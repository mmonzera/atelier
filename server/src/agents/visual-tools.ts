import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { AtelierStore } from '../store.js';

export interface SvgOptimizeResult {
  svg: string;
  originalBytes: number;
  optimizedBytes: number;
  viewBox: string | null;
  warnings: string[];
}

const DEFAULT_OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image-preview';

/**
 * Validates and minifies SVG markup in-process without spawning external Node/Python tools.
 */
export function optimizeSvgContent(rawSvg: string): SvgOptimizeResult {
  const input = rawSvg.trim();
  const originalBytes = Buffer.byteLength(input, 'utf8');
  if (!/<svg\b[^>]*>/i.test(input) || !/<\/svg>/i.test(input)) {
    throw new Error('Invalid SVG markup: expected an <svg> root and closing </svg> tag.');
  }

  let svg = input
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>\s*/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>\s*/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/gi, '')
    .replace(/<defs\b[^>]*>\s*<\/defs>/gi, '')
    .replace(/\s+xmlns:(?:sodipodi|inkscape)=["'][^"']*["']/gi, '')
    .replace(/\s+(?:sodipodi|inkscape):[a-zA-Z0-9_-]+=["'][^"']*["']/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const warnings: string[] = [];
  const rootMatch = svg.match(/<svg\b([^>]*)>/i);
  let viewBox: string | null = null;
  if (rootMatch) {
    const attrs = rootMatch[1] ?? '';
    const vbMatch = attrs.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
    if (vbMatch) {
      viewBox = vbMatch[1]!.trim().replace(/\s+/g, ' ');
    } else {
      const wMatch = attrs.match(/\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i);
      const hMatch = attrs.match(/\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i);
      if (wMatch && hMatch) {
        viewBox = `0 0 ${wMatch[1]} ${hMatch[1]}`;
        svg = svg.replace(/<svg\b([^>]*)>/i, `<svg$1 viewBox="${viewBox}">`);
      } else {
        warnings.push('Missing viewBox attribute.');
      }
    }
  }

  const optimizedBytes = Buffer.byteLength(svg, 'utf8');
  return { svg, originalBytes, optimizedBytes, viewBox, warnings };
}

/** Resolves `targetPath` strictly inside `cwd`, throwing if it escapes the workspace root. */
export function resolveInsideWorkspace(cwd: string, targetPath: string): string {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path must stay inside workspace (${root}): ${targetPath}`);
  }
  return resolved;
}

function decodeBase64DataUrl(rawUrl: string): { mime: string; bytes: Buffer } | null {
  const match = rawUrl.trim().match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mime = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) return null;
  return { mime, bytes };
}

function extractImageFromOpenRouterPayload(payload: Record<string, unknown>): { mime: string; bytes: Buffer } | null {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const msg =
    choices[0] && typeof choices[0] === 'object'
      ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined)
      : undefined;
  if (!msg) return null;

  const images = Array.isArray(msg.images) ? msg.images : [];
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const rec = img as Record<string, unknown>;
    const imgUrl =
      typeof rec.url === 'string'
        ? rec.url
        : rec.image_url && typeof rec.image_url === 'object'
          ? String((rec.image_url as Record<string, unknown>).url ?? '')
          : '';
    const decoded = imgUrl ? decodeBase64DataUrl(imgUrl) : null;
    if (decoded) return decoded;
  }

  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== 'object') continue;
      const rec = part as Record<string, unknown>;
      const imgUrl =
        rec.image_url && typeof rec.image_url === 'object'
          ? String((rec.image_url as Record<string, unknown>).url ?? '')
          : '';
      const decoded = imgUrl ? decodeBase64DataUrl(imgUrl) : null;
      if (decoded) return decoded;
    }
  }

  if (typeof msg.content === 'string') {
    const inlineMatch = msg.content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (inlineMatch) {
      const decoded = decodeBase64DataUrl(inlineMatch[0]);
      if (decoded) return decoded;
    }
  }

  return null;
}

export type ImageGenerationResult =
  | { ok: true; bytes: Buffer; mime: string; providerUsed: string; modelUsed: string }
  | { ok: false; reason: string; hint: string };

/**
 * Generates a raster image through configured OpenRouter or OpenAI credentials.
 * Fails fast when no image API key is configured so agents fall back to SVG instead of looping.
 */
export async function generateImageWithProvider(opts: {
  prompt: string;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  model?: string;
  store: AtelierStore;
  config?: AppConfig;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult> {
  const openrouterKey =
    opts.store.getProviderSecret('openrouter') || opts.config?.openrouterApiKey || null;
  if (openrouterKey) {
    const baseUrl = (opts.config?.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const model = opts.model?.trim() || DEFAULT_OPENROUTER_IMAGE_MODEL;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openrouterKey}`,
        'HTTP-Referer': 'https://github.com/mmonzera/atelier',
        'X-Title': 'Atelier',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: opts.prompt }],
        modalities: ['image', 'text'],
        ...(opts.aspectRatio ? { image_config: { aspect_ratio: opts.aspectRatio } } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `openrouter_error_${res.status}`,
        hint: `OpenRouter image generation failed (${res.status}): ${errText.slice(0, 200) || res.statusText}`,
      };
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const decoded = extractImageFromOpenRouterPayload(payload);
    if (!decoded) {
      return {
        ok: false,
        reason: 'openrouter_no_image',
        hint: 'OpenRouter response did not contain image bytes. Try crisp SVG in <atelier-design> instead.',
      };
    }
    return {
      ok: true,
      bytes: decoded.bytes,
      mime: decoded.mime,
      providerUsed: 'openrouter',
      modelUsed: model,
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY?.trim() || null;
  if (openaiKey) {
    const model = opts.model?.trim() || 'gpt-image-1';
    const size =
      opts.aspectRatio === '16:9' || opts.aspectRatio === '4:3'
        ? '1536x1024'
        : opts.aspectRatio === '9:16' || opts.aspectRatio === '3:4'
          ? '1024x1536'
          : '1024x1024';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model, prompt: opts.prompt, size }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `openai_error_${res.status}`,
        hint: `OpenAI image generation failed (${res.status}): ${errText.slice(0, 200) || res.statusText}`,
      };
    }
    const payload = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) {
      return {
        ok: false,
        reason: 'openai_no_image',
        hint: 'OpenAI response did not return base64 image data.',
      };
    }
    return {
      ok: true,
      bytes: Buffer.from(b64, 'base64'),
      mime: 'image/png',
      providerUsed: 'openai',
      modelUsed: model,
    };
  }

  return {
    ok: false,
    reason: 'no_image_api_key',
    hint: 'No raster image API key (OpenRouter or OPENAI_API_KEY) is configured. Do NOT write Python/Chrome scripts to fake raster images; present crisp inline SVG in <atelier-design> or ask the user to connect OpenRouter in Models & Login.',
  };
}

/** Ensures parent directories exist and writes UTF-8 or binary content safely inside `cwd`. */
export function writeWorkspaceFile(cwd: string, relativePath: string, data: string | Buffer): string {
  const fullPath = resolveInsideWorkspace(cwd, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, data);
  return fullPath;
}
