import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MACHINE_KEY_FILENAME = '.atelier-machine.key';

/**
 * Loads or initializes the 32-byte AES-256-GCM machine key in `<dataDir>/.atelier-machine.key`.
 * Used for encrypting machine-local secrets (auto-backup passphrases and site login passwords).
 */
export function getMachineKey(dataDir: string): Buffer {
  const keyPath = path.join(dataDir, MACHINE_KEY_FILENAME);
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  return key;
}

/**
 * Encrypts `plain` using AES-256-GCM with `key`.
 * Layout: `iv(12) | authTag(16) | ciphertext`.
 */
export function encryptWithKey(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/**
 * Decrypts a buffer produced by `encryptWithKey`. Returns `null` on invalid format or auth failure.
 */
export function decryptWithKey(key: Buffer, sealed: Buffer): Buffer | null {
  if (!sealed || sealed.length < 28) return null;
  try {
    const iv = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const ct = sealed.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

export function sealBuffer(dataDir: string, plain: Buffer): Buffer {
  return encryptWithKey(getMachineKey(dataDir), plain);
}

export function openBuffer(dataDir: string, sealed: Buffer): Buffer | null {
  return decryptWithKey(getMachineKey(dataDir), sealed);
}

export function sealString(dataDir: string, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMachineKey(dataDir), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function openString(dataDir: string, sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
    if (!iv || !tag || !ct) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMachineKey(dataDir), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
