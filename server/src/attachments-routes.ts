import fs from 'node:fs';
import path from 'node:path';
import { ATTACHMENT_LIMITS, type ApiErrorResponse } from '@atelier/contracts';
import { Hono } from 'hono';
import { AttachmentError, AttachmentStore, INLINE_IMAGE_MIMES, isAttachmentId, sniffImage } from './attachments.js';
import type { AppConfig } from './config.js';
import type { AtelierStore } from './store.js';

const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Headers that make user-controlled bytes inert even though they are served from the app origin. */
const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cache-Control': 'private, max-age=3600',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

export function createAttachmentRoutes(deps: { store: AtelierStore; config: AppConfig }): Hono {
  const { store, config } = deps;
  const files = new AttachmentStore(config.dataDir);
  const api = new Hono();

  // Abandoned composer uploads are removed after a day.
  try {
    files.sweepOrphans((id) => store.isAttachmentReferenced(id));
  } catch {
    // best effort
  }

  api.post('/attachments', async (c) => {
    try {
      const form = await c.req.parseBody({ all: true });
      const raw = form.files ?? form.file;
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
      if (list.length === 0) return c.json(apiError('file_required', 'Pilih minimal satu file.'), 400);
      if (list.length > ATTACHMENT_LIMITS.maxFiles) {
        return c.json(apiError('too_many_files', `Maksimal ${ATTACHMENT_LIMITS.maxFiles} file sekaligus.`), 400);
      }
      const total = list.reduce((s, f) => s + f.size, 0);
      if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
        return c.json(apiError('too_large', 'Total ukuran file terlalu besar.'), 413);
      }
      const saved = [];
      try {
        for (const f of list) saved.push(files.save({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }));
      } catch (err) {
        for (const s of saved) files.remove(s.id); // all-or-nothing
        throw err;
      }
      return c.json({ attachments: saved });
    } catch (err) {
      if (err instanceof AttachmentError) return c.json(apiError(err.code, err.message), err.status);
      throw err;
    }
  });

  api.get('/attachments/:id/:name', (c) => {
    const id = c.req.param('id');
    const found = isAttachmentId(id) ? files.get(id) : null;
    if (!found) return c.json(apiError('not_found', 'Lampiran tidak ditemukan.'), 404);
    const bytes = fs.readFileSync(found.filePath);
    const mime = sniffImage(bytes);
    const inline = Boolean(mime && INLINE_IMAGE_MIMES.has(mime));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...SAFE_HEADERS,
        'Content-Type': inline ? (mime as string) : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`,
        'Content-Length': String(bytes.length),
      },
    });
  });

  api.delete('/attachments/:id', (c) => {
    const id = c.req.param('id');
    if (!isAttachmentId(id) || !files.get(id)) return c.json(apiError('not_found', 'Lampiran tidak ditemukan.'), 404);
    if (store.isAttachmentReferenced(id)) {
      return c.json(apiError('in_use', 'Lampiran ini sudah dikirim di chat.'), 409);
    }
    files.remove(id);
    return c.json({ ok: true });
  });

  /**
   * Image files an agent produced (e.g. a rendered mockup PNG) for the design-option cards.
   * Strictly limited to the workspaces folder, linked repos and attachments; images only.
   */
  api.get('/workspace-image', (c) => {
    const requested = c.req.query('path');
    if (!requested || requested.length > 1024) return c.json(apiError('invalid_path', 'Path tidak valid.'), 400);
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(requested));
    } catch {
      return c.json(apiError('not_found', 'Gambar tidak ditemukan.'), 404);
    }
    if (!IMAGE_EXT.has(path.extname(real).toLowerCase())) {
      return c.json(apiError('not_image', 'Hanya file gambar yang bisa ditampilkan.'), 400);
    }
    const roots = [config.workspacesDir, files.directory, ...store.listProjects().flatMap((p) => (p.repo?.localPath ? [p.repo.localPath] : []))];
    const allowed = roots.some((r) => {
      try {
        return isInside(real, fs.realpathSync(r));
      } catch {
        return false;
      }
    });
    if (!allowed) return c.json(apiError('forbidden_path', 'Gambar harus berada di workspace project.'), 403);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_IMAGE_BYTES) {
      return c.json(apiError('too_large', 'Gambar terlalu besar.'), 413);
    }
    const bytes = fs.readFileSync(real);
    const mime = sniffImage(bytes);
    if (!mime || !INLINE_IMAGE_MIMES.has(mime)) return c.json(apiError('not_image', 'Bukan gambar yang valid.'), 400);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { ...SAFE_HEADERS, 'Content-Type': mime, 'Content-Length': String(bytes.length) },
    });
  });

  return api;
}
