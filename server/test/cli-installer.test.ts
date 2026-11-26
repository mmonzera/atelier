import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { CliInstallProgressEvent } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CliInstaller } from '../src/agents/cli-installer.js';
import { ProviderAuthManager } from '../src/agents/provider-auth.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const openDbs: AtelierDb[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CliInstaller (1-click in-app CLI installation)', () => {
  it('downloads, extracts, verifies opencode CLI tarball and saves cliPaths.opencode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-cli-inst-'));
    tempDirs.push(dir);
    const pkgParent = path.join(dir, 'tar-src');
    const pkgBinDir = path.join(pkgParent, 'package', 'bin');
    fs.mkdirSync(pkgBinDir, { recursive: true });

    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(pkgBinDir, 'opencode.cmd'),
        '@echo off\r\nif "%1"=="--version" echo 2.4.2\r\n',
        'utf8',
      );
    } else {
      const shPath = path.join(pkgBinDir, 'opencode');
      fs.writeFileSync(shPath, '#!/usr/bin/env sh\necho 2.4.2\n', { mode: 0o755 });
    }

    const tgzPath = path.join(dir, 'opencode-cli.tgz');
    execFileSync('tar', ['-czf', 'opencode-cli.tgz', '-C', pkgParent, 'package'], { cwd: dir });
    const tgzBytes = fs.readFileSync(tgzPath);

    const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
    const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const platPkg = `@opencode/cli-${plat}-${arch}`;

    const server = http.createServer((req, res) => {
      if (req.url === '/@opencode%2Fcli/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ optionalDependencies: { [platPkg]: '2.4.2' } }));
        return;
      }
      if (req.url === `/${platPkg.replace('/', '%2F').replace('@', '@')}/2.4.2` || req.url?.includes('/2.4.2')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dist: { tarball: `${baseUrl}/tarballs/opencode.tgz` } }));
        return;
      }
      if (req.url === '/tarballs/opencode.tgz') {
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': String(tgzBytes.length),
        });
        res.end(tgzBytes);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'workspaces'),
      dbPath,
    });
    const db = new AtelierDb(dbPath);
    openDbs.push(db);
    const store = new AtelierStore(db, config);
    const authManager = new ProviderAuthManager();

    const events: CliInstallProgressEvent[] = [];
    const installer = new CliInstaller({
      dataDir: config.dataDir,
      store,
      authManager,
      registryBaseUrl: baseUrl,
      onProgress: (ev) => events.push(ev),
    });

    const initial = installer.startInstall('opencode');
    expect(initial.status).toBe('downloading');

    await viWaitFor(() => events.some((e) => e.status === 'done' || e.status === 'error'));
    const final = events[events.length - 1]!;
    expect(final.status).toBe('done');
    expect(final.cliPath).toBeTruthy();
    expect(fs.existsSync(final.cliPath!)).toBe(true);
    expect(store.getSettings().cliPaths.opencode).toBe(final.cliPath);
    authManager.shutdown();
  });

  it('rejects API-key providers and concurrent duplicate installs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-cli-err-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces'), dbPath });
    const db = new AtelierDb(dbPath);
    openDbs.push(db);
    const store = new AtelierStore(db, config);
    const authManager = new ProviderAuthManager();
    let releaseRunner!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRunner = r;
    });
    const fakeBin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(fakeBin, '@echo 1.0.0\r\n', 'utf8');

    const events: CliInstallProgressEvent[] = [];
    const installer = new CliInstaller({
      dataDir: config.dataDir,
      store,
      authManager,
      onProgress: (ev) => events.push(ev),
      scriptRunner: async () => {
        await gate;
        return fakeBin;
      },
    });

    expect(() => installer.startInstall('deepseek')).toThrow(/API key/);
    installer.startInstall('claude');
    expect(() => installer.startInstall('claude')).toThrow(/Already installing/);
    releaseRunner();
    await viWaitFor(() => events.some((e) => e.status === 'done' || e.status === 'error'));
    expect(events[events.length - 1]!.status).toBe('done');
    expect(store.getSettings().cliPaths.claude).toBe(fakeBin);
    authManager.shutdown();
  });
});

async function viWaitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for installer completion');
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}
