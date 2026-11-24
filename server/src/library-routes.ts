import { createHash } from 'node:crypto';
import { type ApiErrorResponse, type LibraryImage, type Message, extractSvgBlocks } from '@atelier/contracts';
import { Hono } from 'hono';
import { AttachmentStore, INLINE_IMAGE_MIMES, sniffImage } from './attachments.js';
import type { AppConfig } from './config.js';
import type { AtelierStore } from './store.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

const IMAGE_ARTIFACT_KINDS = new Set(['svg', 'image']);

/**
 * Per-project image library: images the user uploaded to chat plus image / SVG artifacts agents
 * produced (design options, brand assets). Read-only: attachments stay referenced by their message,
 * and artifacts back the Canon, so nothing here deletes data.
 */
export function createLibraryRoutes(deps: { store: AtelierStore; config: AppConfig }): Hono {
  const { store, config } = deps;
  const files = new AttachmentStore(config.dataDir);
  const api = new Hono();

  api.get('/projects/:id/library', (c) => {
    const scope = c.req.param('id');
    const projectId = scope === 'direct' ? null : scope;
    if (projectId && !store.listProjects().some((p) => p.id === projectId)) {
      return c.json(apiError('not_found', 'Project tidak ditemukan.'), 404);
    }

    // Optional per-agent view (direct chats): only that agent's uploads and artifacts it produced.
    const agentId = c.req.query('agentId') || undefined;
    if (agentId && !store.getAgent(agentId)) return c.json(apiError('not_found', 'Agent tidak ditemukan.'), 404);

    const images: LibraryImage[] = [];
    const seen = new Set<string>();

    for (const message of store.listMessagesWithAttachments(projectId, agentId)) {
      for (const attachment of (message as Message).metadata?.attachments ?? []) {
        if (attachment.kind !== 'image' || seen.has(attachment.id)) continue;
        const found = files.get(attachment.id);
        if (!found) continue;
        seen.add(attachment.id);
        images.push({
          id: attachment.id,
          source: 'attachment',
          name: attachment.name,
          mime: attachment.mime,
          sizeBytes: attachment.size,
          url: `/api/attachments/${attachment.id}/${encodeURIComponent(attachment.name)}`,
          createdAt: message.createdAt,
          messageId: message.id,
        });
      }
    }

    for (const artifact of store.listArtifacts(projectId)) {
      if (!IMAGE_ARTIFACT_KINDS.has(artifact.kind)) continue;
      if (agentId && (!artifact.sourceMessageId || store.getMessage(artifact.sourceMessageId)?.agentId !== agentId)) continue;
      images.push({
        id: artifact.id,
        source: 'artifact',
        name: artifact.label,
        mime: artifact.mime,
        sizeBytes: artifact.sizeBytes,
        url: `/api/projects/${encodeURIComponent(scope)}/library/artifacts/${artifact.id}`,
        createdAt: artifact.createdAt,
        ...(artifact.sourceMessageId ? { messageId: artifact.sourceMessageId } : {}),
      });
    }

    // SVG drawings the agent wrote in its replies (fenced code). Same drawing posted twice = one entry.
    const seenSvg = new Set<string>();
    for (const message of store.listMessagesWithSvg(projectId, agentId)) {
      for (const block of extractSvgBlocks(message.text)) {
        if (!block.closed) continue;
        const hash = createHash('sha1').update(block.svg).digest('hex');
        if (seenSvg.has(hash)) continue;
        seenSvg.add(hash);
        images.push({
          id: `svg_${message.id}_${block.index}`,
          source: 'artifact',
          name: block.name,
          mime: 'image/svg+xml',
          sizeBytes: Buffer.byteLength(block.svg),
          url: `/api/projects/${encodeURIComponent(scope)}/library/svg/${encodeURIComponent(message.id)}/${block.index}`,
          createdAt: message.createdAt,
          messageId: message.id,
        });
      }
    }

    images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json({ images });
  });

  api.get('/projects/:id/library/artifacts/:artifactId', (c) => {
    const artifact = store.getArtifact(c.req.param('artifactId'));
    const scope = c.req.param('id');
    if (!artifact || (artifact.projectId ?? 'direct') !== scope || !IMAGE_ARTIFACT_KINDS.has(artifact.kind)) {
      return c.json(apiError('not_found', 'Gambar tidak ditemukan.'), 404);
    }
    const bytes = store.readArtifact(artifact);
    let mime: string;
    if (artifact.kind === 'svg') {
      mime = 'image/svg+xml';
    } else {
      // Never trust the stored MIME for raster images; serve only what the bytes really are.
      const sniffed = sniffImage(bytes);
      if (!sniffed || !INLINE_IMAGE_MIMES.has(sniffed)) {
        return c.json(apiError('not_image', 'Bukan gambar yang valid.'), 400);
      }
      mime = sniffed;
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  // One SVG written in a chat reply, served as an image (sandboxed, so scripts inside never run).
  api.get('/projects/:id/library/svg/:messageId/:index', (c) => {
    const scope = c.req.param('id');
    const message = store.getMessage(c.req.param('messageId'));
    if (!message || message.author !== 'agent' || (message.projectId ?? 'direct') !== scope) {
      return c.json(apiError('not_found', 'Gambar tidak ditemukan.'), 404);
    }
    const block = extractSvgBlocks(message.text).find((b) => b.index === Number(c.req.param('index')));
    if (!block) return c.json(apiError('not_found', 'Gambar tidak ditemukan.'), 404);
    const bytes = Buffer.from(block.svg, 'utf8');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Length': String(bytes.length),
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  return api;
}
