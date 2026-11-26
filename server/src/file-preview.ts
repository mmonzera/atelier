import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  extractSvgBlocks,
  type ExcelPreviewSheet,
  type FilePreviewData,
  type PreviewFileKind,
  type WordPreviewBlock,
  type WordPreviewRun,
  type WorkspaceFileEntry,
} from '@atelier/contracts';
import { AttachmentStore, INLINE_IMAGE_MIMES, isAttachmentId, sanitizeFileName, sniffImage } from './attachments.js';
import type { AppConfig } from './config.js';
import { getAgentWorkspacePath, getDirectAgentWorkspacePath, getProjectRepoPath } from './github.js';
import type { AtelierStore } from './store.js';

const MAX_PREVIEW_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_EXCEL_ROWS = 200;
const MAX_EXCEL_COLS = 40;

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const WORD_EXT = new Set(['docx']);
const EXCEL_EXT = new Set(['xlsx', 'csv', 'tsv']);
const TEXT_EXT = new Set([
  'txt', 'json', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'vue', 'svelte',
  'graphql', 'proto', 'tex', 'log',
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

export function detectPreviewFileKind(fileName: string, bytes?: Buffer): PreviewFileKind {
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (ext === 'svg') return 'svg';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (bytes) {
    const imgMime = sniffImage(bytes);
    if (imgMime && INLINE_IMAGE_MIMES.has(imgMime)) return 'image';
  }
  if (ext === 'pdf' || (bytes && bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-')) {
    return 'pdf';
  }
  if (WORD_EXT.has(ext)) return 'word';
  if (EXCEL_EXT.has(ext)) return 'excel';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'file';
}

export function mimeForKindAndExt(fileName: string, kind: PreviewFileKind, bytes?: Buffer): string {
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  if (kind === 'image') {
    const sniffed = bytes ? sniffImage(bytes) : null;
    if (sniffed) return sniffed;
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return 'image/png';
  }
  if (kind === 'svg') return 'image/svg+xml';
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'markdown') return 'text/markdown; charset=utf-8';
  if (kind === 'word') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'excel') {
    if (ext === 'csv') return 'text/csv; charset=utf-8';
    if (ext === 'tsv') return 'text/tab-separated-values; charset=utf-8';
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (kind === 'text') return ext === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function isInsideRoot(childReal: string, parentReal: string): boolean {
  const rel = path.relative(parentReal, childReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function getAllowedFileRoots(store: AtelierStore, config: AppConfig): string[] {
  const roots = [
    config.dataDir,
    config.workspacesDir,
    ...store.listProjects().flatMap((p) => (p.repo?.localPath ? [p.repo.localPath] : [])),
  ];
  const resolved: string[] = [];
  for (const r of roots) {
    try {
      if (fs.existsSync(r)) {
        resolved.push(fs.realpathSync(r));
      } else {
        resolved.push(path.resolve(r));
      }
    } catch {
      // ignore inaccessible root
    }
  }
  return resolved;
}

export function isAllowedLocalFilePath(candidatePath: string, store: AtelierStore, config: AppConfig): string | null {
  try {
    const resolved = path.resolve(candidatePath);
    if (!fs.existsSync(resolved)) return null;
    const real = fs.realpathSync(resolved);
    const allowedRoots = getAllowedFileRoots(store, config);
    if (!allowedRoots.some((root) => isInsideRoot(real, root))) return null;
    return real;
  } catch {
    return null;
  }
}

export interface ResolvedPreviewTarget {
  name: string;
  filePath: string;
  sizeBytes: number;
  mime: string;
  kind: PreviewFileKind;
  updatedAt?: string;
  queryParams: string;
}

export function resolvePreviewTarget(
  params: {
    path?: string;
    attachmentId?: string;
    artifactId?: string;
    svgMessageId?: string;
    svgIndex?: string | number;
    scope?: string;
    agentId?: string;
  },
  store: AtelierStore,
  config: AppConfig,
): ResolvedPreviewTarget | null {
  const attachmentStore = new AttachmentStore(config.dataDir);

  if (params.attachmentId && isAttachmentId(params.attachmentId)) {
    const found = attachmentStore.get(params.attachmentId);
    if (!found) return null;
    const stat = fs.statSync(found.filePath);
    const headerBytes = readHeaderBytes(found.filePath, 64);
    const kind = detectPreviewFileKind(found.meta.name, headerBytes);
    const mime = mimeForKindAndExt(found.meta.name, kind, headerBytes);
    const qs = new URLSearchParams({ attachmentId: params.attachmentId }).toString();
    return {
      name: found.meta.name,
      filePath: path.resolve(found.filePath),
      sizeBytes: stat.size,
      mime,
      kind,
      updatedAt: stat.mtime.toISOString(),
      queryParams: qs,
    };
  }

  if (params.artifactId) {
    const artifact = store.getArtifact(params.artifactId);
    if (!artifact) return null;
    let filePath: string;
    try {
      filePath = store.materializeArtifact(artifact);
    } catch {
      filePath = path.resolve(config.dataDir, artifact.path);
    }
    const bytes = store.readArtifact(artifact);
    const kind =
      artifact.kind === 'svg'
        ? 'svg'
        : artifact.kind === 'image'
          ? 'image'
          : detectPreviewFileKind(artifact.label, bytes);
    const mime = mimeForKindAndExt(artifact.label, kind, bytes);
    const qs = new URLSearchParams({ artifactId: artifact.id }).toString();
    return {
      name: artifact.label,
      filePath,
      sizeBytes: artifact.sizeBytes,
      mime,
      kind,
      updatedAt: artifact.createdAt,
      queryParams: qs,
    };
  }

  if (params.svgMessageId && params.svgIndex !== undefined) {
    const message = store.getMessage(params.svgMessageId);
    const idx = Number(params.svgIndex);
    if (!message || !Number.isFinite(idx)) return null;
    const block = extractSvgBlocks(message.text).find((b) => b.index === idx);
    if (!block) return null;
    const scope = message.projectId ?? 'direct';
    const dir = path.resolve(config.dataDir, 'artifacts', scope);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = sanitizeFileName(block.name.endsWith('.svg') ? block.name : `${block.name}.svg`);
    const filePath = path.join(dir, `svg_${sanitizeFileName(message.id)}_${idx}_${safeName}`);
    const bytes = Buffer.from(block.svg, 'utf8');
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, bytes);
    }
    const qs = new URLSearchParams({
      svgMessageId: message.id,
      svgIndex: String(idx),
    }).toString();
    return {
      name: block.name,
      filePath,
      sizeBytes: bytes.length,
      mime: 'image/svg+xml',
      kind: 'svg',
      updatedAt: message.createdAt,
      queryParams: qs,
    };
  }

  if (params.path) {
    const rawPath = params.path.trim();
    if (!rawPath || rawPath.length > 1024) return null;
    let candidate = rawPath;

    if (!path.isAbsolute(candidate)) {
      const candidateBases: string[] = [];
      const scope = params.scope && params.scope !== 'direct' ? params.scope : null;
      if (scope) {
        const proj = store.getProject(scope);
        if (proj?.repo?.localPath) candidateBases.push(proj.repo.localPath);
        candidateBases.push(getProjectRepoPath(config.workspacesDir, scope));
        if (params.agentId) {
          candidateBases.push(getAgentWorkspacePath(config.workspacesDir, scope, params.agentId));
        }
      } else if (params.agentId) {
        candidateBases.push(getDirectAgentWorkspacePath(config.workspacesDir, params.agentId));
      }
      for (const proj of store.listProjects()) {
        if (proj.repo?.localPath) candidateBases.push(proj.repo.localPath);
        candidateBases.push(getProjectRepoPath(config.workspacesDir, proj.id));
      }
      candidateBases.push(config.workspacesDir);

      for (const base of candidateBases) {
        const joined = path.resolve(base, candidate);
        if (fs.existsSync(joined)) {
          candidate = joined;
          break;
        }
      }
    }

    const allowedReal = isAllowedLocalFilePath(candidate, store, config);
    if (!allowedReal) return null;
    const stat = fs.statSync(allowedReal);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_FILE_BYTES) return null;
    const name = path.basename(allowedReal);
    const headerBytes = readHeaderBytes(allowedReal, 64);
    const kind = detectPreviewFileKind(name, headerBytes);
    const mime = mimeForKindAndExt(name, kind, headerBytes);
    const qs = new URLSearchParams({ path: allowedReal }).toString();
    return {
      name,
      filePath: allowedReal,
      sizeBytes: stat.size,
      mime,
      kind,
      updatedAt: stat.mtime.toISOString(),
      queryParams: qs,
    };
  }

  return null;
}

function readHeaderBytes(filePath: string, length: number): Buffer {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(length, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

export function buildFilePreviewData(target: ResolvedPreviewTarget): FilePreviewData {
  const rawUrl = `/api/files/raw?${target.queryParams}`;
  const downloadUrl = `/api/files/raw?${target.queryParams}&download=1`;
  const base: FilePreviewData = {
    name: target.name,
    filePath: target.filePath,
    sizeBytes: target.sizeBytes,
    mime: target.mime,
    kind: target.kind,
    rawUrl,
    downloadUrl,
    updatedAt: target.updatedAt,
  };

  if (target.kind === 'markdown') {
    const bytes = readUpToBytes(target.filePath, MAX_TEXT_PREVIEW_BYTES);
    base.markdown = bytes.toString('utf8');
    base.text = base.markdown;
    base.lang = 'markdown';
    return base;
  }

  if (target.kind === 'svg') {
    const bytes = readUpToBytes(target.filePath, MAX_TEXT_PREVIEW_BYTES);
    base.text = bytes.toString('utf8');
    base.lang = 'svg';
    return base;
  }

  if (target.kind === 'text') {
    const bytes = readUpToBytes(target.filePath, MAX_TEXT_PREVIEW_BYTES);
    base.text = bytes.toString('utf8');
    base.lang = path.extname(target.name).replace(/^\./, '').toLowerCase() || 'text';
    return base;
  }

  if (target.kind === 'word') {
    const bytes = fs.readFileSync(target.filePath);
    base.word = parseDocxPreview(bytes);
    return base;
  }

  if (target.kind === 'excel') {
    const bytes = fs.readFileSync(target.filePath);
    const ext = path.extname(target.name).replace(/^\./, '').toLowerCase();
    base.excel = parseExcelPreview(bytes, ext);
    return base;
  }

  return base;
}

function readUpToBytes(filePath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/* -------------------------------------------------------------------------- */
/* Zero-dependency ZIP reader using Node's built-in zlib.inflateRawSync       */
/* -------------------------------------------------------------------------- */

export function readZipEntries(zipBuffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  // Locate End of Central Directory (EOCD) signature 0x06054b50
  const minEocdOffset = Math.max(0, zipBuffer.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= minEocdOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: End of Central Directory not found.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let ptr = centralDirOffset;
  const centralDirEnd = Math.min(zipBuffer.length, centralDirOffset + centralDirSize);
  for (let idx = 0; idx < totalEntries && ptr + 46 <= centralDirEnd; idx++) {
    const sig = zipBuffer.readUInt32LE(ptr);
    if (sig !== 0x02014b50) break;
    const compressionMethod = zipBuffer.readUInt16LE(ptr + 10);
    const compressedSize = zipBuffer.readUInt32LE(ptr + 20);
    const fileNameLen = zipBuffer.readUInt16LE(ptr + 28);
    const extraLen = zipBuffer.readUInt16LE(ptr + 30);
    const commentLen = zipBuffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42);

    const fileName = zipBuffer
      .subarray(ptr + 46, ptr + 46 + fileNameLen)
      .toString('utf8')
      .replace(/\\/g, '/');

    ptr += 46 + fileNameLen + extraLen + commentLen;

    if (fileName.endsWith('/') || localHeaderOffset + 30 > zipBuffer.length) continue;
    if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) continue;

    const compressed = zipBuffer.subarray(dataStart, dataEnd);
    try {
      if (compressionMethod === 0) {
        entries.set(fileName, Buffer.from(compressed));
      } else if (compressionMethod === 8) {
        entries.set(fileName, zlib.inflateRawSync(compressed));
      }
    } catch {
      // skip corrupted entry
    }
  }

  return entries;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* -------------------------------------------------------------------------- */
/* Word (.docx) Parser                                                        */
/* -------------------------------------------------------------------------- */

export function parseDocxPreview(buffer: Buffer): { blocks: WordPreviewBlock[] } {
  const zip = readZipEntries(buffer);
  const docXml = zip.get('word/document.xml')?.toString('utf8');
  if (!docXml) {
    throw new Error('Invalid .docx file: word/document.xml not found.');
  }

  // Parse relationships (hyperlinks & embedded media images)
  const relsXml = zip.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '';
  const relTargets = new Map<string, { target: string; external: boolean }>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attrs = match[1] ?? '';
    const id = /\bId\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const mode = /\bTargetMode\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (id && target) {
      relTargets.set(id, {
        target: decodeXmlEntities(target),
        external: mode?.toLowerCase() === 'external',
      });
    }
  }

  const resolveMediaDataUri = (rId: string): string | null => {
    const rel = relTargets.get(rId);
    if (!rel || rel.external) return null;
    const cleanTarget = rel.target.replace(/^\/+/, '');
    const zipKey = cleanTarget.startsWith('word/') ? cleanTarget : `word/${cleanTarget}`;
    const mediaBytes = zip.get(zipKey);
    if (!mediaBytes || mediaBytes.length > 4 * 1024 * 1024) return null;
    const mime = sniffImage(mediaBytes);
    if (!mime) return null;
    return `data:${mime};base64,${mediaBytes.toString('base64')}`;
  };

  const blocks: WordPreviewBlock[] = [];
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i.exec(docXml);
  const bodyXml = bodyMatch ? bodyMatch[1]! : docXml;

  // Match top-level tables and paragraphs in document order
  const tokenRe = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/gi;
  for (const match of bodyXml.matchAll(tokenRe)) {
    const chunk = match[0];
    if (/^<w:tbl\b/i.test(chunk)) {
      const rows: WordPreviewRun[][][] = [];
      for (const trMatch of chunk.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi)) {
        const rowCells: WordPreviewRun[][] = [];
        for (const tcMatch of trMatch[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi)) {
          const cellRuns: WordPreviewRun[] = [];
          for (const pMatch of tcMatch[1]!.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
            const parsed = parseDocxParagraphRuns(pMatch[1]!, relTargets);
            if (cellRuns.length > 0 && parsed.runs.length > 0) {
              cellRuns.push({ text: '\n' });
            }
            cellRuns.push(...parsed.runs);
          }
          rowCells.push(cellRuns.length > 0 ? cellRuns : [{ text: '' }]);
        }
        if (rowCells.length > 0) rows.push(rowCells);
      }
      if (rows.length > 0) blocks.push({ type: 'table', rows });
      continue;
    }

    // Paragraph
    const pInner = /^<w:p\b[^>]*>([\s\S]*?)<\/w:p>$/i.exec(chunk)?.[1] ?? '';
    if (!pInner) continue;

    // Check for embedded images inside paragraph
    for (const blip of pInner.matchAll(/\br:(?:embed|id)\s*=\s*"([^"]+)"/gi)) {
      const dataUri = resolveMediaDataUri(blip[1]!);
      if (dataUri) {
        blocks.push({ type: 'image', src: dataUri });
      }
    }

    const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i.exec(pInner)?.[1] ?? '';
    const styleVal = /<w:pStyle\b[^>]*\bw:val\s*=\s*"([^"]+)"/i.exec(pPr)?.[1] ?? '';
    const headingMatch = /^(?:Heading|heading\s*|Judul\s*)([1-6])$/i.exec(styleVal);
    const isTitle = /^Title$/i.test(styleVal);
    const isSubtitle = /^Subtitle$/i.test(styleVal);

    const numPr = /<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/i.exec(pPr)?.[1];
    const ilvl = numPr ? Number.parseInt(/<w:ilvl\b[^>]*\bw:val\s*=\s*"(\d+)"/i.exec(numPr)?.[1] ?? '0', 10) : 0;
    const numId = numPr ? /<w:numId\b[^>]*\bw:val\s*=\s*"(\d+)"/i.exec(numPr)?.[1] : null;

    const { runs } = parseDocxParagraphRuns(pInner, relTargets);
    const hasText = runs.some((r) => r.text.trim().length > 0);
    if (!hasText) continue;

    if (isTitle) {
      blocks.push({ type: 'heading', level: 1, runs });
    } else if (isSubtitle) {
      blocks.push({ type: 'heading', level: 2, runs });
    } else if (headingMatch) {
      blocks.push({ type: 'heading', level: Number(headingMatch[1]), runs });
    } else if (numId && numId !== '0') {
      blocks.push({
        type: 'list-item',
        ordered: Number(numId) % 2 === 0,
        level: Math.min(3, Math.max(0, ilvl)),
        runs,
      });
    } else {
      blocks.push({ type: 'paragraph', runs });
    }
  }

  return { blocks };
}

function parseDocxParagraphRuns(
  pInner: string,
  relTargets: Map<string, { target: string; external: boolean }>,
): { runs: WordPreviewRun[] } {
  const runs: WordPreviewRun[] = [];
  const tokenRe = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi;

  const pushRun = (run: WordPreviewRun) => {
    if (!run.text) return;
    const prev = runs[runs.length - 1];
    if (
      prev &&
      prev.bold === run.bold &&
      prev.italic === run.italic &&
      prev.underline === run.underline &&
      prev.strike === run.strike &&
      prev.code === run.code &&
      prev.href === run.href
    ) {
      prev.text += run.text;
    } else {
      runs.push(run);
    }
  };

  for (const m of pInner.matchAll(tokenRe)) {
    if (m[1] !== undefined && m[2] !== undefined) {
      const rId = /\br:id\s*=\s*"([^"]+)"/i.exec(m[1])?.[1];
      const rel = rId ? relTargets.get(rId) : undefined;
      const href = rel?.external && /^https?:\/\/|^mailto:/i.test(rel.target) ? rel.target : undefined;
      for (const rm of m[2].matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi)) {
        const parsed = parseSingleDocxRun(rm[1]!, href);
        if (parsed) pushRun(parsed);
      }
    } else if (m[3] !== undefined) {
      const parsed = parseSingleDocxRun(m[3]);
      if (parsed) pushRun(parsed);
    }
  }

  return { runs };
}

function parseSingleDocxRun(rInner: string, href?: string): WordPreviewRun | null {
  const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i.exec(rInner)?.[1] ?? '';
  const isTagOn = (tag: string) => {
    const m = new RegExp(`<w:${tag}\\b([^>]*?)\\/?\\s*>`, 'i').exec(rPr);
    if (!m) return false;
    const val = /\bw:val\s*=\s*"([^"]+)"/i.exec(m[1] ?? '')?.[1]?.toLowerCase();
    return val !== 'false' && val !== '0' && val !== 'none';
  };
  const bold = isTagOn('b');
  const italic = isTagOn('i');
  const underline = isTagOn('u');
  const strike = isTagOn('strike') || isTagOn('dstrike');
  const font = /<w:rFonts\b[^>]*\bw:ascii\s*=\s*"([^"]+)"/i.exec(rPr)?.[1] ?? '';
  const code = /mono|consolas|courier|menlo|fira/i.test(font);

  let text = '';
  const itemRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gi;
  for (const tm of rInner.matchAll(itemRe)) {
    if (tm[1] !== undefined) {
      text += decodeXmlEntities(tm[1]);
    } else if (/^<w:tab\b/i.test(tm[0])) {
      text += '\t';
    } else if (/^<w:br\b/i.test(tm[0])) {
      text += '\n';
    }
  }
  if (!text) return null;
  return {
    text,
    ...(bold ? { bold: true } : {}),
    ...(italic ? { italic: true } : {}),
    ...(underline ? { underline: true } : {}),
    ...(strike ? { strike: true } : {}),
    ...(code ? { code: true } : {}),
    ...(href ? { href } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Excel (.xlsx / .csv / .tsv) Parser                                         */
/* -------------------------------------------------------------------------- */

export function parseExcelPreview(buffer: Buffer, ext: string): { sheets: ExcelPreviewSheet[] } {
  if (ext === 'csv' || ext === 'tsv') {
    const delimiter = ext === 'tsv' ? '\t' : ',';
    const text = buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString('utf8');
    const allRows = parseDelimitedTable(text, delimiter);
    const totalRows = allRows.length;
    const totalCols = allRows.reduce((max, r) => Math.max(max, r.length), 0);
    const rows = allRows.slice(0, MAX_EXCEL_ROWS).map((r) => r.slice(0, MAX_EXCEL_COLS));
    return {
      sheets: [
        {
          name: ext.toUpperCase(),
          rows,
          totalRows,
          totalCols,
        },
      ],
    };
  }

  const zip = readZipEntries(buffer);
  const sharedStrings: string[] = [];
  const sstXml = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sstXml) {
    for (const siMatch of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      let cellText = '';
      for (const tMatch of siMatch[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
        cellText += decodeXmlEntities(tMatch[1]!);
      }
      sharedStrings.push(cellText);
    }
  }

  // Map workbook sheet names to worksheet files
  const workbookXml = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const workbookRelsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map<string, string>();
  for (const rm of workbookRelsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attrs = rm[1] ?? '';
    const id = /\bId\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (id && target) {
      const clean = target.replace(/^\/+/, '');
      relMap.set(id, clean.startsWith('xl/') ? clean : `xl/${clean}`);
    }
  }

  const sheetSpecs: Array<{ name: string; path: string }> = [];
  for (const sm of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/gi)) {
    const attrs = sm[1] ?? '';
    const name = /\bname\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const rId = /\br:id\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const targetPath = rId ? relMap.get(rId) : undefined;
    if (name && targetPath && zip.has(targetPath)) {
      sheetSpecs.push({ name: decodeXmlEntities(name), path: targetPath });
    }
  }

  if (sheetSpecs.length === 0) {
    const fallbackPaths = [...zip.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort();
    fallbackPaths.forEach((p, idx) => {
      sheetSpecs.push({ name: `Sheet ${idx + 1}`, path: p });
    });
  }

  const sheets: ExcelPreviewSheet[] = [];
  for (const spec of sheetSpecs) {
    const xml = zip.get(spec.path)?.toString('utf8');
    if (!xml) continue;
    sheets.push(parseWorksheetXml(spec.name, xml, sharedStrings));
  }

  return { sheets };
}

function colLettersToIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0]?.toUpperCase() ?? '';
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function parseWorksheetXml(name: string, xml: string, sharedStrings: string[]): ExcelPreviewSheet {
  const rows: string[][] = [];
  let totalRows = 0;
  let totalCols = 0;

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    totalRows++;
    const rowCells: string[] = [];
    let nextCol = 0;

    for (const cMatch of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/gi)) {
      const attrs = cMatch[1] ?? '';
      const inner = cMatch[2] ?? '';
      const ref = /\br\s*=\s*"([A-Za-z]+\d+)"/i.exec(attrs)?.[1];
      const cellType = /\bt\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
      const colIdx = ref ? colLettersToIndex(ref) : nextCol;
      nextCol = colIdx + 1;
      if (nextCol > totalCols) totalCols = nextCol;

      if (totalRows > MAX_EXCEL_ROWS || colIdx >= MAX_EXCEL_COLS) continue;

      let value = '';
      if (cellType === 'inlineStr') {
        for (const tm of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
          value += decodeXmlEntities(tm[1]!);
        }
      } else {
        const rawV = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)?.[1];
        if (rawV !== undefined) {
          if (cellType === 's') {
            const sstIdx = Number.parseInt(rawV, 10);
            value = sharedStrings[sstIdx] ?? rawV;
          } else if (cellType === 'b') {
            value = rawV === '1' ? 'TRUE' : 'FALSE';
          } else if (cellType === 'str' || cellType === 'e') {
            value = decodeXmlEntities(rawV);
          } else {
            const num = Number(rawV);
            value =
              Number.isFinite(num) && rawV.includes('.') && rawV.length > 12
                ? String(Math.round(num * 1e6) / 1e6)
                : decodeXmlEntities(rawV);
          }
        }
      }

      while (rowCells.length < colIdx) rowCells.push('');
      rowCells[colIdx] = value;
    }

    if (totalRows <= MAX_EXCEL_ROWS) {
      rows.push(rowCells);
    }
  }

  // Normalize row lengths up to displayCols
  const displayCols = Math.min(totalCols, MAX_EXCEL_COLS);
  for (const r of rows) {
    while (r.length < displayCols) r.push('');
  }

  return {
    name,
    rows,
    totalRows,
    totalCols,
  };
}

export function parseDelimitedTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Workspace Previewable File Scanner                                         */
/* -------------------------------------------------------------------------- */

const PREVIEWABLE_SCAN_KINDS = new Set<PreviewFileKind>([
  'markdown',
  'pdf',
  'word',
  'excel',
  'image',
  'svg',
]);

export function listWorkspacePreviewFiles(
  scope: string | null,
  agentId: string | undefined,
  store: AtelierStore,
  config: AppConfig,
  limit = 120,
): WorkspaceFileEntry[] {
  const roots: Array<{ dir: string; prefix: string }> = [];
  if (scope && scope !== 'direct') {
    const project = store.getProject(scope);
    if (project?.repo?.localPath && fs.existsSync(project.repo.localPath)) {
      roots.push({ dir: project.repo.localPath, prefix: '' });
    }
    const managed = getProjectRepoPath(config.workspacesDir, scope);
    if (fs.existsSync(managed) && managed !== project?.repo?.localPath) {
      roots.push({ dir: managed, prefix: '' });
    }
    if (agentId) {
      const agentDir = getAgentWorkspacePath(config.workspacesDir, scope, agentId);
      if (fs.existsSync(agentDir)) {
        roots.push({ dir: agentDir, prefix: '' });
      }
    }
  } else if (agentId) {
    const directDir = getDirectAgentWorkspacePath(config.workspacesDir, agentId);
    if (fs.existsSync(directDir)) {
      roots.push({ dir: directDir, prefix: '' });
    }
  }

  const seenPaths = new Set<string>();
  const results: WorkspaceFileEntry[] = [];

  const walk = (baseDir: string, currentDir: string, depth: number) => {
    if (depth > 4 || results.length >= limit * 2) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') && d.name !== '.env.example') continue;
      const fullPath = path.join(currentDir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) {
          walk(baseDir, fullPath, depth + 1);
        }
        continue;
      }
      if (!d.isFile()) continue;
      const kind = detectPreviewFileKind(d.name);
      if (!PREVIEWABLE_SCAN_KINDS.has(kind)) continue;
      let real: string;
      let stat: fs.Stats;
      try {
        real = fs.realpathSync(fullPath);
        if (seenPaths.has(real)) continue;
        stat = fs.statSync(real);
        if (stat.size === 0 || stat.size > MAX_PREVIEW_FILE_BYTES) continue;
      } catch {
        continue;
      }
      seenPaths.add(real);
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push({
        name: d.name,
        relativePath: rel || d.name,
        filePath: real,
        sizeBytes: stat.size,
        kind,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  };

  for (const r of roots) {
    walk(r.dir, r.dir, 0);
  }

  const kindPriority: Record<PreviewFileKind, number> = {
    markdown: 0,
    pdf: 1,
    word: 2,
    excel: 3,
    image: 4,
    svg: 5,
    text: 6,
    file: 7,
  };

  results.sort((a, b) => {
    const timeDiff = b.updatedAt.localeCompare(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return kindPriority[a.kind] - kindPriority[b.kind];
  });

  return results.slice(0, limit);
}
