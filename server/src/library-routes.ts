import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ApiErrorResponse, type LibraryImage, type Message, extractSvgBlocks } from '@atelier/contracts';
import { Hono } from 'hono';
import { AttachmentStore, INLINE_IMAGE_MIMES, sanitizeFileName, sniffImage } from './attachments.js';
import type { AppConfig } from './config.js';
import { detectPreviewFileKind, listWorkspacePreviewFiles } from './file-preview.js';
import type { AtelierStore } from './store.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

const IMAGE_ARTIFACT_KINDS = new Set(['svg', 'image']);
const DOC_PREVIEW_KINDS = new Set(['markdown', 'pdf', 'word', 'excel', 'text']);

/**
 * Per-project media & document library: images and documents the user uploaded to chat, image / SVG
 * artifacts agents produced (design options, generated images, brand assets), plus workspace docs.
 * Read-only: attachments stay referenced by their message, and artifacts back the Canon.
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
    const documents: LibraryImage[] = [];
    const seen = new Set<string>();

    for (const message of store.listMessagesWithAttachments(projectId, agentId)) {
      for (const attachment of (message as Message).metadata?.attachments ?? []) {
        if (seen.has(attachment.id)) continue;
        const found = files.get(attachment.id);
        if (!found) continue;
        seen.add(attachment.id);
        const resolvedPath = path.resolve(found.filePath);
        if (attachment.kind === 'image') {
          images.push({
            id: attachment.id,
            source: 'attachment',
            name: attachment.name,
            mime: attachment.mime,
            sizeBytes: attachment.size,
            url: `/api/attachments/${attachment.id}/${encodeURIComponent(attachment.name)}`,
            createdAt: message.createdAt,
            messageId: message.id,
            filePath: resolvedPath,
            previewKind: 'image',
          });
        } else {
          const previewKind = detectPreviewFileKind(attachment.name);
          if (DOC_PREVIEW_KINDS.has(previewKind)) {
            documents.push({
              id: attachment.id,
              source: 'attachment',
              name: attachment.name,
              mime: attachment.mime,
              sizeBytes: attachment.size,
              url: `/api/attachments/${attachment.id}/${encodeURIComponent(attachment.name)}`,
              createdAt: message.createdAt,
              messageId: message.id,
              filePath: resolvedPath,
              previewKind,
            });
          }
        }
      }
    }

    for (const artifact of store.listArtifacts(projectId)) {
      if (!IMAGE_ARTIFACT_KINDS.has(artifact.kind)) continue;
      if (agentId && (!artifact.sourceMessageId || store.getMessage(artifact.sourceMessageId)?.agentId !== agentId)) continue;
      const filePath = path.resolve(config.dataDir, artifact.path);
      images.push({
        id: artifact.id,
        source: 'artifact',
        name: artifact.label,
        mime: artifact.mime,
        sizeBytes: artifact.sizeBytes,
        url: `/api/projects/${encodeURIComponent(scope)}/library/artifacts/${artifact.id}`,
        createdAt: artifact.createdAt,
        ...(artifact.sourceMessageId ? { messageId: artifact.sourceMessageId } : {}),
        filePath,
        previewKind: artifact.kind === 'svg' ? 'svg' : 'image',
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
        const svgDir = path.resolve(config.dataDir, 'artifacts', scope);
        const safeName = sanitizeFileName(block.name.endsWith('.svg') ? block.name : `${block.name}.svg`);
        const svgFilePath = path.join(svgDir, `svg_${sanitizeFileName(message.id)}_${block.index}_${safeName}`);
        try {
          if (!fs.existsSync(svgFilePath)) {
            fs.mkdirSync(svgDir, { recursive: true });
            fs.writeFileSync(svgFilePath, Buffer.from(block.svg, 'utf8'));
          }
        } catch {
          // best effort
        }
        images.push({
          id: `svg_${message.id}_${block.index}`,
          source: 'artifact',
          name: block.name,
          mime: 'image/svg+xml',
          sizeBytes: Buffer.byteLength(block.svg),
          url: `/api/projects/${encodeURIComponent(scope)}/library/svg/${encodeURIComponent(message.id)}/${block.index}`,
          createdAt: message.createdAt,
          messageId: message.id,
          filePath: svgFilePath,
          previewKind: 'svg',
        });
      }
    }

    // Workspace documents (Markdown, PDF, Word, Excel) in the project or agent workspace
    try {
      const wsFiles = listWorkspacePreviewFiles(projectId, agentId, store, config, 60);
      for (const wf of wsFiles) {
        if (DOC_PREVIEW_KINDS.has(wf.kind)) {
          documents.push({
            id: `ws_${createHash('sha1').update(wf.filePath).digest('hex').slice(0, 12)}`,
            source: 'workspace',
            name: wf.relativePath,
            mime: 'application/octet-stream',
            sizeBytes: wf.sizeBytes,
            url: `/api/files/raw?path=${encodeURIComponent(wf.filePath)}&download=1`,
            createdAt: wf.updatedAt,
            filePath: wf.filePath,
            previewKind: wf.kind,
          });
        }
      }
    } catch {
      // best effort
    }

    images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json({ images, documents });
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
