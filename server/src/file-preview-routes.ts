import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiErrorResponse } from '@atelier/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import {
  buildFilePreviewData,
  listWorkspacePreviewFiles,
  resolvePreviewTarget,
} from './file-preview.js';
import type { AtelierStore } from './store.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

export function createFilePreviewRoutes(deps: { store: AtelierStore; config: AppConfig }): Hono {
  const { store, config } = deps;
  const api = new Hono();

  /**
   * Returns structured preview metadata + content (Markdown, Word blocks, Excel sheets, Text, or Image/PDF URLs)
   * along with the exact local `filePath` on this machine.
   */
  api.get('/files/preview', (c) => {
    const target = resolvePreviewTarget(
      {
        path: c.req.query('path'),
        attachmentId: c.req.query('attachmentId'),
        artifactId: c.req.query('artifactId'),
        svgMessageId: c.req.query('svgMessageId'),
        svgIndex: c.req.query('svgIndex'),
        scope: c.req.query('scope'),
        agentId: c.req.query('agentId'),
      },
      store,
      config,
    );

    if (!target) {
      return c.json(apiError('not_found', 'File tidak ditemukan atau berada di luar workspace.'), 404);
    }

    try {
      const preview = buildFilePreviewData(target);
      return c.json({ preview });
    } catch (err) {
      return c.json(
        apiError('preview_failed', err instanceof Error ? err.message : 'Gagal memuat preview file.'),
        400,
      );
    }
  });

  /**
   * Streams raw bytes of an allowed workspace/attachment/artifact file.
   * Images and PDFs can be rendered inline (e.g. inside <img> or PDF <iframe>); `?download=1` forces download.
   */
  api.get('/files/raw', (c) => {
    const target = resolvePreviewTarget(
      {
        path: c.req.query('path'),
        attachmentId: c.req.query('attachmentId'),
        artifactId: c.req.query('artifactId'),
        svgMessageId: c.req.query('svgMessageId'),
        svgIndex: c.req.query('svgIndex'),
        scope: c.req.query('scope'),
        agentId: c.req.query('agentId'),
      },
      store,
      config,
    );

    if (!target || !fs.existsSync(target.filePath)) {
      return c.json(apiError('not_found', 'File tidak ditemukan.'), 404);
    }

    const forceDownload = c.req.query('download') === '1';
    const bytes = fs.readFileSync(target.filePath);
    const isInlineable =
      !forceDownload && (target.kind === 'image' || target.kind === 'svg' || target.kind === 'pdf');

    const headers: Record<string, string> = {
      'Content-Type': isInlineable ? target.mime : 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${isInlineable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(target.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=60',
    };

    // Sandbox images/SVGs so embedded scripts in SVGs never execute; omit sandbox on PDF so Chromium's built-in PDF viewer works.
    if (target.kind !== 'pdf') {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers,
    });
  });

  /**
   * Lists previewable files (.md, .pdf, .docx, .xlsx, .csv, images, .svg) in a project or agent workspace.
   */
  api.get('/projects/:id/files', (c) => {
    const scope = c.req.param('id');
    const projectId = scope === 'direct' ? null : scope;
    if (projectId && !store.getProject(projectId)) {
      return c.json(apiError('not_found', 'Project tidak ditemukan.'), 404);
    }
    const agentId = c.req.query('agentId') || undefined;
    const files = listWorkspacePreviewFiles(projectId, agentId, store, config);
    return c.json({ files });
  });

  /**
   * Reveals a file in the host OS file manager (Windows Explorer `/select,<path>`).
   */
  api.post('/fs/reveal', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        path: z.string().trim().min(1).optional(),
        attachmentId: z.string().trim().min(1).optional(),
        artifactId: z.string().trim().min(1).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_path', 'Path file tidak valid.'), 400);
    }

    const target = resolvePreviewTarget(parsed.data, store, config);
    if (!target || !fs.existsSync(target.filePath)) {
      return c.json(apiError('not_found', 'File tidak ditemukan di komputer ini.'), 404);
    }

    const winPath = path.resolve(target.filePath);
    if (process.platform === 'win32') {
      execFile('explorer.exe', [`/select,${winPath}`], { windowsHide: false }, () => {
        // Explorer often exits with code 1 even on success; ignore callback error.
      });
    } else if (process.platform === 'darwin') {
      execFile('open', ['-R', winPath], () => {});
    } else {
      execFile('xdg-open', [path.dirname(winPath)], () => {});
    }

    return c.json({ ok: true, filePath: winPath });
  });

  return api;
}
