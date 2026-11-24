import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { INLINE_IMAGE_MIMES, sniffImage } from './attachments.js';

export const CANON_KEY = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SECRET = /(?:\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]{8,}|\bBearer\s+\S+)/i;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export function validateMemoryPath(value: string): string {
  if (!value || value.length > 240 || /[\\:\x00-\x1f<>|"*?]/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..' ||
        /[. ]$/.test(part) || /^\.(?:git|ssh|aws|env)(?:\.|$)/i.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Use a workspace-relative path without traversal or drive prefixes.');
  }
  return value;
}

export const CanonInputFields = z.object({
  kind: z.enum(['decision', 'asset', 'rule']),
  key: z.string().regex(CANON_KEY),
  title: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(300),
  path: z.string().optional(),
});

export const CanonInputSchema = CanonInputFields.superRefine((input, ctx) => {
  if ([input.title, input.value, input.path ?? ''].some((value) => SECRET.test(value))) {
    ctx.addIssue({ code: 'custom', message: 'Keep credentials out of Canon.' });
  }
  if (input.path !== undefined) {
    try {
      validateMemoryPath(input.path);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'Invalid workspace-relative path.' });
    }
  }
});

/** Reject links at every level, including a pre-existing destination file. */
export function memoryFilePath(root: string, relative: string): string {
  const parts = validateMemoryPath(relative).split('/');
  let current = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Memory files cannot use symbolic links.');
  }
  return current;
}

export function readDesignImage(src: string, roots: string[]): { bytes: Buffer; mime: string } {
  let bytes: Buffer;
  const inline = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/=]+)$/i.exec(src);
  if (inline) {
    if (inline[1].length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) throw new Error('Design image is too large.');
    bytes = Buffer.from(inline[1], 'base64');
  } else {
    if (!path.isAbsolute(src)) throw new Error('Design image must be in the current workspace.');
    const real = fs.realpathSync(src);
    const allowed = roots.some((root) => {
      if (!fs.existsSync(root)) return false;
      const relative = path.relative(fs.realpathSync(root), real);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!allowed) throw new Error('Design image must be in the current workspace.');
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error('Invalid design image size.');
    bytes = fs.readFileSync(real);
  }
  const mime = sniffImage(bytes);
  if (!mime || !INLINE_IMAGE_MIMES.has(mime)) throw new Error('Unsupported design image.');
  return { bytes, mime };
}

export function writeMemoryFile(root: string, relative: string, bytes: Buffer, replace?: Buffer): boolean {
  const target = memoryFilePath(root, relative);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error('Invalid existing memory file.');
    const existing = fs.readFileSync(target);
    if (bytes.equals(existing)) return false;
    if (!replace?.equals(existing)) throw new Error('An existing workspace file uses this path.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!replace) {
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    return true;
  }
  const temp = target + '.atelier-' + globalThis.crypto.randomUUID();
  fs.writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}

export function validateArtifactSize(bytes: Buffer): void {
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Invalid artifact size.');
}
