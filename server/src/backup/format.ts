import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * `.atelier-backup` container
 *
 *   [8]  magic "ATLBKP01"
 *   [4]  header length (uint32 BE)
 *   [n]  header JSON (public: version, createdAt, encryption params — never project data)
 *   [..] body
 *
 * body (plain)     = gzip( [4 manifest len][manifest JSON][SQLite snapshot bytes] )
 * body (encrypted) = AES-256-GCM( plain body ) || 16-byte auth tag
 *                    key = scrypt(passphrase, salt), AAD = magic + header bytes
 *
 * The header is authenticated as AAD, so flipping `encrypted` or the KDF params is detected.
 */

export const BACKUP_MAGIC = Buffer.from('ATLBKP01', 'ascii');
export const BACKUP_EXTENSION = '.atelier-backup';
export const MIN_PASSPHRASE_LENGTH = 8;

const KDF = { N: 1 << 15, r: 8, p: 1 } as const;
const KDF_MAXMEM = 128 * 1024 * 1024;

export interface BackupHeader {
  format: 'atelier-backup';
  version: 1;
  createdAt: string;
  encrypted: boolean;
  kdf?: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher?: { name: 'aes-256-gcm'; iv: string };
}

export interface BackupManifest {
  app: 'atelier';
  appVersion: string;
  createdAt: string;
  sourceHostname: string;
  includesSecrets: boolean;
  dbSha256: string;
  dbBytes: number;
  projects: Array<{ id: string; name: string; repoFullName: string | null; repoLocalPath: string | null }>;
}

export class BackupFormatError extends Error {
  constructor(
    public readonly code:
      | 'not_a_backup'
      | 'unsupported_version'
      | 'passphrase_required'
      | 'bad_passphrase'
      | 'corrupt_backup',
    message: string,
  ) {
    super(message);
  }
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: KDF_MAXMEM,
  });
}

export function encodeBackup(input: {
  manifest: BackupManifest;
  dbBytes: Buffer;
  passphrase: string | null;
}): Buffer {
  const manifestBuf = Buffer.from(JSON.stringify(input.manifest), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(manifestBuf.length, 0);
  const plain = zlib.gzipSync(Buffer.concat([lenBuf, manifestBuf, input.dbBytes]), { level: 6 });

  const header: BackupHeader = {
    format: 'atelier-backup',
    version: 1,
    createdAt: input.manifest.createdAt,
    encrypted: Boolean(input.passphrase),
  };

  let body = plain;
  let key: Buffer | null = null;
  let iv: Buffer | null = null;
  if (input.passphrase) {
    const salt = crypto.randomBytes(16);
    iv = crypto.randomBytes(12);
    key = deriveKey(input.passphrase, salt, KDF);
    header.kdf = { name: 'scrypt', ...KDF, salt: salt.toString('base64') };
    header.cipher = { name: 'aes-256-gcm', iv: iv.toString('base64') };
  }

  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerBuf.length, 0);
  const prefix = Buffer.concat([BACKUP_MAGIC, headerLen, headerBuf]);

  if (key && iv) {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(prefix);
    body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  return Buffer.concat([prefix, body]);
}

export function readBackupHeader(file: Buffer): { header: BackupHeader; prefix: Buffer; body: Buffer } {
  if (file.length < 12 || !file.subarray(0, 8).equals(BACKUP_MAGIC)) {
    throw new BackupFormatError('not_a_backup', 'File ini bukan backup Atelier (.atelier-backup).');
  }
  const headerLen = file.readUInt32BE(8);
  if (headerLen <= 0 || headerLen > 64 * 1024 || 12 + headerLen > file.length) {
    throw new BackupFormatError('corrupt_backup', 'Header backup rusak.');
  }
  let header: BackupHeader;
  try {
    header = JSON.parse(file.subarray(12, 12 + headerLen).toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupFormatError('corrupt_backup', 'Header backup rusak.');
  }
  if (header.format !== 'atelier-backup') {
    throw new BackupFormatError('not_a_backup', 'File ini bukan backup Atelier.');
  }
  if (header.version !== 1) {
    throw new BackupFormatError(
      'unsupported_version',
      `Versi backup ${String(header.version)} belum didukung oleh Atelier ini. Update Atelier dulu.`,
    );
  }
  return { header, prefix: file.subarray(0, 12 + headerLen), body: file.subarray(12 + headerLen) };
}

export function decodeBackup(
  file: Buffer,
  passphrase: string | null,
): { header: BackupHeader; manifest: BackupManifest; dbBytes: Buffer } {
  const { header, prefix, body } = readBackupHeader(file);
  let plain = body;

  if (header.encrypted) {
    if (!passphrase) {
      throw new BackupFormatError('passphrase_required', 'Backup ini terenkripsi. Masukkan passphrase.');
    }
    if (!header.kdf || !header.cipher || body.length < 17) {
      throw new BackupFormatError('corrupt_backup', 'Parameter enkripsi backup tidak lengkap.');
    }
    const key = deriveKey(passphrase, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'));
    decipher.setAAD(prefix);
    decipher.setAuthTag(body.subarray(body.length - 16));
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    } catch {
      throw new BackupFormatError(
        'bad_passphrase',
        'Passphrase salah, atau file backup sudah berubah/rusak.',
      );
    }
  }

  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(plain);
  } catch {
    throw new BackupFormatError('corrupt_backup', 'Isi backup rusak (gagal dekompresi).');
  }
  if (raw.length < 4) throw new BackupFormatError('corrupt_backup', 'Isi backup kosong.');
  const manifestLen = raw.readUInt32BE(0);
  if (4 + manifestLen > raw.length) throw new BackupFormatError('corrupt_backup', 'Manifest backup rusak.');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(raw.subarray(4, 4 + manifestLen).toString('utf8')) as BackupManifest;
  } catch {
    throw new BackupFormatError('corrupt_backup', 'Manifest backup rusak.');
  }
  const dbBytes = raw.subarray(4 + manifestLen);
  const sha = crypto.createHash('sha256').update(dbBytes).digest('hex');
  if (sha !== manifest.dbSha256) {
    throw new BackupFormatError('corrupt_backup', 'Checksum database di backup tidak cocok.');
  }
  return { header, manifest, dbBytes };
}
