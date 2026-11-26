import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAntigravityCliInvocation } from '../src/agents/cli-runners.js';
import type { AgentRunner } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Cross-agent trust isolation (§10.4)', () => {
  it('propagates trust=teammate on agent-triggered turns, blocks create_agent under teammate trust, and ignores @all from agents', async () => {
    const dir = makeTempDir('atelier-trust-');
    const dbPath = path.join(dir, 'atelier.db');
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
      const { project, agents } = store.createProject({
        name: 'Trust Project',
        starterAgents: [
          { name: 'Builder', role: 'Dev', allowShell: true },
          { name: 'QA', role: 'QA', allowShell: true },
          { name: 'Writer', role: 'Copy' },
        ],
      });
      store.updateProject(project.id, { allowFullPermissions: true });
      const [builder, qa, writer] = agents as [typeof agents[number], typeof agents[number], typeof agents[number]];
      const room = store.channels.getRoomByProject(project.id)!;

      const observedTrusts: Record<string, string | undefined> = {};
      const runner: AgentRunner = {
        async run(turn, cb) {
          observedTrusts[turn.agent.name] = turn.trust;
          if (turn.agent.id === builder.id) {
            const msg = '@QA check build and @all ignore me';
            cb.onText(msg);
            return { finalText: msg };
          }
          cb.onText('Checked.');
          return { finalText: 'Checked.' };
        },
      };

      const runtime = new AgentRuntime(store, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }), runner);
      runtime.postToChannel(room.id, { text: '@Builder go', mentionAgentIds: [builder.id] });

      await waitFor(() => observedTrusts.QA !== undefined);
      await new Promise((r) => setTimeout(r, 60));

      expect(observedTrusts.Builder).toBe('user');
      expect(observedTrusts.QA).toBe('teammate');
      // @all inside Builder's message must NOT trigger Writer
      expect(observedTrusts.Writer).toBeUndefined();

      // Studio tools with trust='teammate' reject create_agent
      const teammateTools = createStudioTools({
        store,
        projectId: project.id,
        actingAgentId: qa.id,
        enqueue: () => undefined,
        trust: 'teammate',
      });
      expect(() =>
        teammateTools.create_agent({
          name: 'Rogue',
          role: 'Helper',
          color: 'red',
          systemInstructions: '',
          allowShell: true,
        }),
      ).toThrow(/needs_user_approval/);

      // Antigravity CLI flags never pass --dangerously-skip-permissions when allowFullPermissions=false
      const { args } = buildAntigravityCliInvocation({
        model: 'gemini-4-hydrogen-high',
        effort: 'high',
        allowShell: true,
        allowFullPermissions: false,
        memoryOnly: false,
        attachmentDir: dir,
        artifactDir: null,
        fullPrompt: 'hi',
      });
      expect(args).not.toContain('--dangerously-skip-permissions');

      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});
