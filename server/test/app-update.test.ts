import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppUpdateStatus } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AppUpdateBridge } from '../src/app-update.js';
import { startAtelierServer, type AtelierServerHandle } from '../src/index.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AppUpdateBridge & desktop updater HTTP/WS API', () => {
  it('tracks update lifecycle, triggers shell actions, and broadcasts status changes', () => {
    const actions: string[] = [];
    const seen: AppUpdateStatus[] = [];
    const bridge = new AppUpdateBridge({
      supported: true,
      currentVersion: '0.1.0',
      onRequestAction: (a) => actions.push(a),
      onBroadcast: (s) => seen.push(s),
    });

    expect(bridge.getStatus()).toMatchObject({
      supported: true,
      currentVersion: '0.1.0',
      state: 'idle',
    });

    expect(bridge.requestCheck().state).toBe('checking');
    expect(actions).toEqual(['check']);

    const available = bridge.applyShellStatus({
      state: 'available',
      availableVersion: '0.1.1',
      notes: 'Bug fixes',
    });
    expect(available).toMatchObject({
      state: 'available',
      availableVersion: '0.1.1',
      notes: 'Bug fixes',
    });

    expect(bridge.requestInstall()).toMatchObject({
      state: 'downloading',
      progressPercent: 0,
    });
    expect(actions).toEqual(['check', 'install']);
    expect(seen.map((s) => s.state)).toEqual(['checking', 'available', 'downloading']);
  });

  it('serves /api/app-update endpoints and embeds initial appUpdate in snapshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-update-test-'));
    tempDirs.push(dir);
    const actions: string[] = [];
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'workspaces'),
      },
      updateOptions: {
        onAction: (action) => actions.push(action),
      },
    });
    handles.push(handle);

    const base = `http://127.0.0.1:${handle.port}`;
    const snapRes = await fetch(`${base}/api/state`);
    const snap = (await snapRes.json()) as { appUpdate?: AppUpdateStatus };
    expect(snap.appUpdate).toBeDefined();
    expect(snap.appUpdate?.state).toBe('idle');

    handle.appUpdate.applyShellStatus({ state: 'available', availableVersion: '0.1.1' });
    const getRes = await fetch(`${base}/api/app-update`);
    const getJson = (await getRes.json()) as { update: AppUpdateStatus };
    expect(getJson.update.state).toBe('available');
    expect(getJson.update.availableVersion).toBe('0.1.1');

    // Non-embedded test server returns supported=false so install/check safely no-ops
    const checkRes = await fetch(`${base}/api/app-update/check`, { method: 'POST' });
    expect(checkRes.status).toBe(200);
    expect(actions).toEqual([]);
  });
});
