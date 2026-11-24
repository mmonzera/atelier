import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MeetingSettings,
  SttBenchmarkResult,
  SttDownloadProgressEvent,
  SttLocalStatus,
} from '@atelier/contracts';
import {
  DEFAULT_STT_CATALOG,
  type SttCatalog,
  type WhisperEngineCatalogEntry,
  type WhisperModelCatalogEntry,
  getEngineById,
  getModelById,
  getPlatformKey,
} from './catalog.js';

const execFileAsync = promisify(execFile);

export class SttInstallerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 500 | 507 = 400,
  ) {
    super(message);
  }
}

interface InstalledEngineManifest {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  exeRelPath: string;
  installedAt: string;
}

interface InstalledModelManifest {
  id: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  installedAt: string;
}

interface SttManifest {
  engine: InstalledEngineManifest | null;
  models: Record<string, InstalledModelManifest>;
  benchmarks: SttBenchmarkResult[];
}

function emptyManifest(): SttManifest {
  return { engine: null, models: {}, benchmarks: [] };
}

function dirSizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // ignore transient file
      }
    }
  }
  return total;
}

function findFileRecursive(rootDir: string, filename: string): string | null {
  if (!fs.existsSync(rootDir)) return null;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const hit = findFileRecursive(full, filename);
      if (hit) return hit;
    }
  }
  return null;
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

function checkFreeDiskSpace(targetDir: string, neededBytes: number): void {
  if (neededBytes <= 0 || typeof fs.statfsSync !== 'function') return;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const stats = fs.statfsSync(targetDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const required = Math.ceil(neededBytes * 1.2);
    if (Number.isFinite(freeBytes) && freeBytes > 0 && freeBytes < required) {
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      const reqMb = Math.round(required / (1024 * 1024));
      throw new SttInstallerError(
        'insufficient_disk_space',
        `Not enough disk space (${freeMb} MB free, need at least ${reqMb} MB).`,
        507,
      );
    }
  } catch (err) {
    if (err instanceof SttInstallerError) throw err;
    // Ignore unsupported filesystems where statfsSync fails
  }
}

export class SttInstaller {
  private readonly sttDir: string;
  private readonly enginesDir: string;
  private readonly modelsDir: string;
  private readonly manifestPath: string;
  private catalog: SttCatalog;
  private readonly onProgress?: (event: SttDownloadProgressEvent) => void;
  private activeDownload: {
    event: SttDownloadProgressEvent;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;

  constructor(opts: {
    dataDir: string;
    catalog?: SttCatalog;
    onProgress?: (event: SttDownloadProgressEvent) => void;
  }) {
    this.sttDir = path.join(opts.dataDir, 'stt');
    this.enginesDir = path.join(this.sttDir, 'engine');
    this.modelsDir = path.join(this.sttDir, 'models');
    this.manifestPath = path.join(this.sttDir, 'manifest.json');
    this.catalog = opts.catalog ?? DEFAULT_STT_CATALOG;
    this.onProgress = opts.onProgress;
  }

  public setCatalog(catalog: SttCatalog): void {
    this.catalog = catalog;
  }

  public getCatalog(): SttCatalog {
    return this.catalog;
  }

  private readManifest(): SttManifest {
    try {
      if (!fs.existsSync(this.manifestPath)) return emptyManifest();
      const raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as Partial<SttManifest>;
      return {
        engine: raw.engine ?? null,
        models: raw.models && typeof raw.models === 'object' ? raw.models : {},
        benchmarks: Array.isArray(raw.benchmarks) ? raw.benchmarks : [],
      };
    } catch {
      return emptyManifest();
    }
  }

  private writeManifest(manifest: SttManifest): void {
    fs.mkdirSync(this.sttDir, { recursive: true });
    const tmpPath = `${this.manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.manifestPath);
  }

  public getExePath(): string | null {
    const manifest = this.readManifest();
    if (!manifest.engine) return null;
    const candidate = path.join(
      this.enginesDir,
      manifest.engine.version,
      manifest.engine.exeRelPath,
    );
    return fs.existsSync(candidate) ? candidate : null;
  }

  public getModelPath(modelId: string): string | null {
    const manifest = this.readManifest();
    const installed = manifest.models[modelId];
    if (!installed) return null;
    const filePath = path.join(this.modelsDir, installed.filename);
    return fs.existsSync(filePath) ? filePath : null;
  }

  public getInstalledModelIds(): string[] {
    const manifest = this.readManifest();
    return Object.keys(manifest.models).filter((id) => this.getModelPath(id) !== null);
  }

  public getStatus(meetingSettings: MeetingSettings): SttLocalStatus {
    const manifest = this.readManifest();
    const platform = getPlatformKey();
    const cpuCores = Math.max(1, os.cpus().length);
    const defaultThreads = Math.min(4, Math.max(1, Math.floor(cpuCores / 2)));

    const exePath = this.getExePath();
    const installedEngine =
      manifest.engine && exePath
        ? {
            id: manifest.engine.id,
            version: manifest.engine.version,
            installedAt: manifest.engine.installedAt,
            exePath,
          }
        : null;

    const engines = this.catalog.engines
      .filter((e) => e.platform === platform || e.platform === 'any')
      .map((e) => {
        const isThisInstalled = Boolean(installedEngine && installedEngine.id === e.id);
        return {
          id: e.id,
          version: e.version,
          platform: e.platform,
          url: e.url,
          host: e.host,
          sizeBytes: e.sizeBytes,
          ...(e.gpu ? { gpu: true } : {}),
          installed: isThisInstalled,
          updateAvailable: Boolean(isThisInstalled && installedEngine!.version !== e.version),
        };
      });

    const models = this.catalog.models.map((m) => {
      const installed = this.getModelPath(m.id) !== null;
      return {
        id: m.id,
        label: m.label,
        filename: m.filename,
        url: m.url,
        host: m.host,
        sizeBytes: m.sizeBytes,
        ramMb: m.ramMb,
        quality: m.quality,
        ...(m.recommended ? { recommended: true } : {}),
        installed,
        active: meetingSettings.activeModelId === m.id,
      };
    });

    const engineBytes = dirSizeBytes(this.enginesDir);
    const modelsBytes = dirSizeBytes(this.modelsDir);
    const activeModelInstalled = this.getModelPath(meetingSettings.activeModelId) !== null;

    return {
      ready: Boolean(installedEngine && activeModelInstalled),
      platform,
      cpuCores,
      defaultThreads,
      installedEngine,
      engines,
      models,
      diskUsage: {
        engineBytes,
        modelsBytes,
        totalBytes: engineBytes + modelsBytes,
      },
      activeDownload: this.activeDownload ? { ...this.activeDownload.event } : null,
      benchmarks: manifest.benchmarks,
      settings: meetingSettings,
    };
  }

  private emitProgress(event: SttDownloadProgressEvent): void {
    if (this.activeDownload && this.activeDownload.event.id === event.id && this.activeDownload.event.kind === event.kind) {
      this.activeDownload.event = event;
    }
    this.onProgress?.(event);
  }

  private async downloadAndVerify(opts: {
    kind: 'engine' | 'model';
    id: string;
    url: string;
    expectedSha256: string;
    expectedSizeBytes: number;
    destPath: string;
  }): Promise<void> {
    if (this.activeDownload) {
      throw new SttInstallerError(
        'download_in_progress',
        'Another speech-to-text download is already in progress.',
        409,
      );
    }

    const controller = new AbortController();
    const partPath = `${opts.destPath}.part`;
    fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });

    let existingBytes = 0;
    if (fs.existsSync(partPath)) {
      const stat = fs.statSync(partPath);
      if (stat.isFile()) {
        if (opts.expectedSizeBytes > 0 && stat.size > opts.expectedSizeBytes) {
          fs.rmSync(partPath, { force: true });
        } else {
          existingBytes = stat.size;
        }
      }
    }

    const remainingNeeded = Math.max(0, opts.expectedSizeBytes - existingBytes);
    checkFreeDiskSpace(path.dirname(opts.destPath), remainingNeeded);

    const initialPercent =
      opts.expectedSizeBytes > 0
        ? Math.min(99, Math.round((existingBytes / opts.expectedSizeBytes) * 100))
        : 0;

    const initialEvent: SttDownloadProgressEvent = {
      kind: opts.kind,
      id: opts.id,
      status: 'downloading',
      downloadedBytes: existingBytes,
      totalBytes: opts.expectedSizeBytes,
      percent: initialPercent,
    };

    const run = (async () => {
      try {
        this.emitProgress(initialEvent);

        // If the .part file already reached expectedSizeBytes, verify it directly first.
        const needNetwork =
          existingBytes === 0 ||
          opts.expectedSizeBytes <= 0 ||
          existingBytes < opts.expectedSizeBytes;

        if (needNetwork) {
          const headers: Record<string, string> = {};
          if (existingBytes > 0) {
            headers.Range = `bytes=${existingBytes}-`;
          }
          const res = await fetch(opts.url, {
            headers,
            signal: controller.signal,
            redirect: 'follow',
          });

          if (res.status === 416 && existingBytes > 0) {
            // Server says range starts at or beyond EOF; proceed to verification below.
          } else if (!res.ok && res.status !== 206) {
            throw new SttInstallerError(
              'download_failed',
              `Download failed with HTTP ${res.status}.`,
              500,
            );
          } else {
            const isResume = res.status === 206 && existingBytes > 0;
            if (!isResume) {
              existingBytes = 0;
            }
            const contentLength = Number(res.headers.get('content-length') ?? 0);
            const totalBytes =
              opts.expectedSizeBytes > 0
                ? opts.expectedSizeBytes
                : isResume
                  ? existingBytes + contentLength
                  : contentLength;

            let downloadedBytes = existingBytes;
            let lastEmitAt = 0;

            const writeStream = fs.createWriteStream(partPath, {
              flags: isResume ? 'a' : 'w',
            });

            try {
              if (!res.body) {
                throw new SttInstallerError('download_failed', 'Empty response body.', 500);
              }
              const reader = res.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.byteLength === 0) continue;

                const canContinue = writeStream.write(value);
                if (!canContinue) {
                  await new Promise<void>((resolve, reject) => {
                    writeStream.once('drain', resolve);
                    writeStream.once('error', reject);
                  });
                }
                downloadedBytes += value.byteLength;
                const now = Date.now();
                if (now - lastEmitAt >= 150) {
                  lastEmitAt = now;
                  const percent =
                    totalBytes > 0
                      ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
                      : 0;
                  this.emitProgress({
                    kind: opts.kind,
                    id: opts.id,
                    status: 'downloading',
                    downloadedBytes,
                    totalBytes,
                    percent,
                  });
                }
              }
              await new Promise<void>((resolve, reject) => {
                writeStream.once('error', reject);
                writeStream.end(() => resolve());
              });
            } catch (err) {
              writeStream.destroy();
              throw err;
            }

            this.emitProgress({
              kind: opts.kind,
              id: opts.id,
              status: 'verifying',
              downloadedBytes,
              totalBytes,
              percent: 99,
            });
          }
        } else {
          this.emitProgress({
            kind: opts.kind,
            id: opts.id,
            status: 'verifying',
            downloadedBytes: existingBytes,
            totalBytes: opts.expectedSizeBytes,
            percent: 99,
          });
        }

        const actualHash = await computeSha256(partPath);
        if (actualHash !== opts.expectedSha256.toLowerCase()) {
          fs.rmSync(partPath, { force: true });
          const err = new SttInstallerError(
            'hash_mismatch',
            `SHA-256 verification failed for ${opts.id} (expected ${opts.expectedSha256}, got ${actualHash}).`,
            400,
          );
          this.emitProgress({
            kind: opts.kind,
            id: opts.id,
            status: 'error',
            downloadedBytes: 0,
            totalBytes: opts.expectedSizeBytes,
            percent: 0,
            error: err.message,
          });
          throw err;
        }

        fs.renameSync(partPath, opts.destPath);
      } catch (err) {
        if (controller.signal.aborted) {
          this.emitProgress({
            kind: opts.kind,
            id: opts.id,
            status: 'cancelled',
            downloadedBytes: fs.existsSync(partPath) ? fs.statSync(partPath).size : 0,
            totalBytes: opts.expectedSizeBytes,
            percent: 0,
          });
          throw new SttInstallerError('download_cancelled', 'Download cancelled.', 400);
        }
        if (err instanceof SttInstallerError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : 'Download failed.';
        this.emitProgress({
          kind: opts.kind,
          id: opts.id,
          status: 'error',
          downloadedBytes: 0,
          totalBytes: opts.expectedSizeBytes,
          percent: 0,
          error: message,
        });
        throw new SttInstallerError('download_failed', message, 500);
      }
    })();

    this.activeDownload = { event: initialEvent, controller, promise: run };
    try {
      await run;
    } finally {
      if (this.activeDownload?.controller === controller) {
        this.activeDownload = null;
      }
    }
  }

  public async installEngine(engineId: string): Promise<InstalledEngineManifest> {
    const entry: WhisperEngineCatalogEntry | undefined = getEngineById(engineId, this.catalog);
    if (!entry) {
      throw new SttInstallerError('unknown_engine', `Unknown Whisper engine: ${engineId}`, 404);
    }

    const archivePath = path.join(this.enginesDir, `${entry.id}-${entry.version}.zip`);
    const targetDir = path.join(this.enginesDir, entry.version);
    const stagingDir = path.join(this.enginesDir, `.staging-${entry.version}-${Date.now()}`);

    await this.downloadAndVerify({
      kind: 'engine',
      id: entry.id,
      url: entry.url,
      expectedSha256: entry.sha256,
      expectedSizeBytes: entry.sizeBytes,
      destPath: archivePath,
    });

    this.emitProgress({
      kind: 'engine',
      id: entry.id,
      status: 'extracting',
      downloadedBytes: entry.sizeBytes,
      totalBytes: entry.sizeBytes,
      percent: 99,
    });

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      await execFileAsync('tar', ['-xf', archivePath, '-C', stagingDir], {
        windowsHide: true,
      });

      const directCandidate = path.join(stagingDir, entry.exe);
      let resolvedExe = fs.existsSync(directCandidate) ? directCandidate : null;
      if (!resolvedExe) {
        resolvedExe = findFileRecursive(stagingDir, path.basename(entry.exe));
      }
      if (!resolvedExe) {
        throw new SttInstallerError(
          'extract_failed',
          `Archive did not contain ${entry.exe}.`,
          500,
        );
      }

      const exeRelPath = path.relative(stagingDir, resolvedExe);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(stagingDir, targetDir);
      fs.rmSync(archivePath, { force: true });

      const installed: InstalledEngineManifest = {
        id: entry.id,
        version: entry.version,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        exeRelPath,
        installedAt: new Date().toISOString(),
      };

      const manifest = this.readManifest();
      manifest.engine = installed;
      this.writeManifest(manifest);

      this.emitProgress({
        kind: 'engine',
        id: entry.id,
        status: 'done',
        downloadedBytes: entry.sizeBytes,
        totalBytes: entry.sizeBytes,
        percent: 100,
      });
      return installed;
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(archivePath, { force: true });
      if (err instanceof SttInstallerError) throw err;
      throw new SttInstallerError(
        'extract_failed',
        err instanceof Error ? err.message : 'Failed to extract Whisper engine.',
        500,
      );
    }
  }

  public async downloadModel(modelId: string): Promise<InstalledModelManifest> {
    const entry: WhisperModelCatalogEntry | undefined = getModelById(modelId, this.catalog);
    if (!entry) {
      throw new SttInstallerError('unknown_model', `Unknown Whisper model: ${modelId}`, 404);
    }

    const destPath = path.join(this.modelsDir, entry.filename);
    await this.downloadAndVerify({
      kind: 'model',
      id: entry.id,
      url: entry.url,
      expectedSha256: entry.sha256,
      expectedSizeBytes: entry.sizeBytes,
      destPath,
    });

    const stat = fs.statSync(destPath);
    const installed: InstalledModelManifest = {
      id: entry.id,
      filename: entry.filename,
      sha256: entry.sha256,
      sizeBytes: stat.size,
      installedAt: new Date().toISOString(),
    };

    const manifest = this.readManifest();
    manifest.models[entry.id] = installed;
    this.writeManifest(manifest);

    this.emitProgress({
      kind: 'model',
      id: entry.id,
      status: 'done',
      downloadedBytes: stat.size,
      totalBytes: entry.sizeBytes || stat.size,
      percent: 100,
    });

    return installed;
  }

  public async cancelDownload(): Promise<boolean> {
    if (!this.activeDownload) return false;
    const current = this.activeDownload;
    current.controller.abort();
    await current.promise.catch(() => undefined);
    return true;
  }

  public deleteModel(modelId: string): boolean {
    const manifest = this.readManifest();
    const existing = manifest.models[modelId];
    const catalogEntry = getModelById(modelId, this.catalog);
    const filename = existing?.filename ?? catalogEntry?.filename;
    if (!existing && !filename) return false;

    let deleted = Boolean(existing);
    if (filename) {
      const target = path.join(this.modelsDir, filename);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        deleted = true;
      }
      fs.rmSync(`${target}.part`, { force: true });
    }
    delete manifest.models[modelId];
    this.writeManifest(manifest);
    return deleted;
  }

  public deleteEngine(): boolean {
    const manifest = this.readManifest();
    const had = Boolean(manifest.engine) || fs.existsSync(this.enginesDir);
    fs.rmSync(this.enginesDir, { recursive: true, force: true });
    manifest.engine = null;
    this.writeManifest(manifest);
    return had;
  }

  public async clearAll(): Promise<void> {
    await this.cancelDownload();
    fs.rmSync(this.sttDir, { recursive: true, force: true });
  }

  public saveBenchmark(result: SttBenchmarkResult): void {
    const manifest = this.readManifest();
    const filtered = manifest.benchmarks.filter(
      (b) =>
        !(
          b.engineVersion === result.engineVersion &&
          b.modelId === result.modelId &&
          b.threads === result.threads &&
          b.useGpu === result.useGpu
        ),
    );
    filtered.unshift(result);
    manifest.benchmarks = filtered.slice(0, 20);
    this.writeManifest(manifest);
  }
}
