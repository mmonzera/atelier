import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type MessageAttachment,
} from '@atelier/contracts';

/**
 * Chat attachments live in <dataDir>/attachments/<id>/{meta.json,<safe file name>}.
 *
 * - Images are identified by magic bytes (never by the browser-supplied MIME or extension).
 * - Only png/jpeg/gif/webp are ever served inline; everything else is a forced download.
 * - Agents get the absolute path in their prompt (and small text files are inlined for providers
 *   that cannot read files), see `describeAttachments` / `attachmentExcerpts`.
 */

const ID_RE = /^att_[a-f0-9]{12}$/;
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'htm',
  'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'svg', 'vue', 'svelte', 'graphql', 'proto', 'tex',
]);
const INLINE_EXCERPT_FILE_BYTES = 24 * 1024;
const INLINE_EXCERPT_TOTAL_BYTES = 60 * 1024;
const MAX_TEXT_SNIFF_BYTES = 2 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
  }
}

export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // a multi-byte char can be cut at the sample boundary; tolerate a short tail
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
      return true;
    } catch {
      return false;
    }
  }
}

export function sanitizeFileName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  name = name.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  if (!name) name = 'file';
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export class AttachmentStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'attachments');
  }

  /** Directory that agents may read (added to the Claude CLI/SDK allow-list). */
  public get directory(): string {
    return this.root;
  }

  public save(input: { name: string; bytes: Buffer }): MessageAttachment {
    if (input.bytes.length === 0) throw new AttachmentError('empty_file', `"${input.name}" kosong.`);
    if (input.bytes.length > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new AttachmentError(
        'file_too_large',
        `"${input.name}" lebih dari ${ATTACHMENT_LIMITS.maxFileBytes / 1048576} MB.`,
        413,
      );
    }
    const name = sanitizeFileName(input.name);
    const imageMime = sniffImage(input.bytes);
    const ext = path.extname(name).slice(1).toLowerCase();
    let kind: AttachmentKind = 'file';
    let mime = 'application/octet-stream';
    if (imageMime) {
      kind = 'image';
      mime = imageMime;
    } else if (TEXT_EXT.has(ext) && input.bytes.length <= MAX_TEXT_SNIFF_BYTES && looksLikeText(input.bytes)) {
      kind = 'text';
      mime = ext === 'json' ? 'application/json' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
    } else if (ext === 'pdf' && input.bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
      mime = 'application/pdf';
    }

    const id = `att_${crypto.randomBytes(6).toString('hex')}`;
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), input.bytes);
    const meta: MessageAttachment = { id, name, mime, size: input.bytes.length, kind };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return meta;
  }

  public get(id: string): { meta: MessageAttachment; filePath: string } | null {
    if (!isAttachmentId(id)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.root, id, 'meta.json'), 'utf8')) as MessageAttachment;
      const filePath = path.join(this.root, id, sanitizeFileName(meta.name));
      return fs.existsSync(filePath) ? { meta, filePath } : null;
    } catch {
      return null;
    }
  }

  public remove(id: string): boolean {
    if (!isAttachmentId(id)) return false;
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    return true;
  }

  /** Resolves ids from the client to trusted metadata; unknown ids are an error. */
  public resolve(ids: string[]): MessageAttachment[] {
    const out: MessageAttachment[] = [];
    let total = 0;
    for (const id of [...new Set(ids)]) {
      const found = this.get(id);
      if (!found) throw new AttachmentError('attachment_not_found', `Lampiran ${id} tidak ditemukan.`, 404);
      total += found.meta.size;
      out.push(found.meta);
    }
    if (out.length > ATTACHMENT_LIMITS.maxFiles) {
      throw new AttachmentError('too_many_files', `Maksimal ${ATTACHMENT_LIMITS.maxFiles} lampiran per pesan.`);
    }
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new AttachmentError('too_large', 'Total lampiran terlalu besar.', 413);
    }
    return out;
  }

  public absolutePath(att: MessageAttachment): string {
    return path.join(this.root, att.id, sanitizeFileName(att.name));
  }

  /** File list that goes into the prompt (and into later turns' history). */
  public describe(attachments: MessageAttachment[] | undefined): string {
    if (!attachments?.length) return '';
    const lines = attachments.map(
      (a) => `- ${a.name} (${a.kind === 'image' ? 'image' : a.mime}, ${formatBytes(a.size)}): ${this.absolutePath(a)}`,
    );
    return [
      '',
      '[Attached files — saved on this computer. Open them with your file-reading tool; images can be viewed that way.]',
      ...lines,
    ].join('\n');
  }

  /** Inline text contents for providers that cannot open files themselves (e.g. HTTP APIs). */
  public excerpts(attachments: MessageAttachment[] | undefined): string {
    if (!attachments?.length) return '';
    let budget = INLINE_EXCERPT_TOTAL_BYTES;
    const parts: string[] = [];
    for (const a of attachments) {
      if (a.kind !== 'text' || budget <= 0) continue;
      try {
        const take = Math.min(INLINE_EXCERPT_FILE_BYTES, budget);
        const fd = fs.openSync(this.absolutePath(a), 'r');
        const buf = Buffer.alloc(Math.min(take, a.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        budget -= buf.length;
        parts.push(
          `--- ${a.name}${a.size > buf.length ? ` (first ${formatBytes(buf.length)} of ${formatBytes(a.size)})` : ''} ---\n${buf.toString('utf8')}\n--- end of ${a.name} ---`,
        );
      } catch {
        // unreadable file: the path line is still in the prompt
      }
    }
    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
  }

  public imagePaths(attachments: MessageAttachment[] | undefined): string[] {
    return (attachments ?? []).filter((a) => a.kind === 'image').map((a) => this.absolutePath(a));
  }

  /** Deletes uploads that were never sent with a message (abandoned composer drafts). */
  public sweepOrphans(isReferenced: (id: string) => boolean, maxAgeMs = 24 * 3600 * 1000): number {
    let removed = 0;
    if (!fs.existsSync(this.root)) return 0;
    for (const id of fs.readdirSync(this.root)) {
      if (!isAttachmentId(id)) continue;
      try {
        const age = Date.now() - fs.statSync(path.join(this.root, id)).mtimeMs;
        if (age > maxAgeMs && !isReferenced(id)) {
          fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // ignore races
      }
    }
    return removed;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Only these ever render inline in the browser; everything else downloads. */
export const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
