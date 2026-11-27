import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, McpServerConfig } from '@atelier/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAtelierActions, applyVisualAtelierActions } from '../src/agents/atelier-actions.js';
import { resolveMaxToolCallsPerTurn } from '../src/agents/cli-runners.js';
import { buildAgentSystemPrompt } from '../src/agents/prompts.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { optimizeSvgContent } from '../src/agents/visual-tools.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { buildOpenCodeMcpConfig } from '../src/mcp/config.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const openDbs: AtelierDb[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-opt-test-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'atelier.db');
  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const config = loadConfig({
    dataDir: path.join(dir, 'data'),
    workspacesDir: path.join(dir, 'workspaces'),
    dbPath,
  });
  const db = new AtelierDb(dbPath);
  openDbs.push(db);
  const store = new AtelierStore(db, config);
  const { project, agents } = store.createProject({
    name: 'Visual Studio',
    starterAgents: [{ name: 'Designer', role: 'Brand Designer', allowShell: true }],
  });
  return { dir, cwd, config, store, project, agent: agents[0]! };
}

describe('Harness speed & token-economy optimizations', () => {
  it('isolates global OpenCode MCP servers and denies bash when allowShell is false', () => {
    const cfg = buildOpenCodeMcpConfig([], 2, 'win32', {
      disabledGlobalNames: ['local-mcp', 'figcraft', 'pencil'],
      allowShell: false,
    }) as {
      mcp?: { servers?: Record<string, { disabled?: boolean }> };
      policies?: Array<{ action: string; resource: string; effect: string }>;
    };

    expect(cfg.mcp?.servers?.['local-mcp']?.disabled).toBe(true);
    expect(cfg.mcp?.servers?.figcraft?.disabled).toBe(true);
    expect(cfg.mcp?.servers?.pencil?.disabled).toBe(true);
    expect(cfg.policies).toContainEqual({ action: 'mcp.use', resource: '*', effect: 'deny' });
    expect(cfg.policies).toContainEqual({ action: 'tool.use', resource: 'bash', effect: 'deny' });

    const attached: McpServerConfig = {
      id: 'mcp_1',
      name: 'figcraft',
      transport: 'http',
      url: 'http://127.0.0.1:3055/mcp',
      enabled: true,
    };
    const cfgWithAttached = buildOpenCodeMcpConfig([attached], 2, 'win32', {
      disabledGlobalNames: ['local-mcp', 'figcraft'],
      allowShell: true,
    }) as {
      mcp?: { servers?: Record<string, { disabled?: boolean }> };
      policies?: Array<{ action: string; resource: string; effect: string }>;
    };
    expect(cfgWithAttached.mcp?.servers?.figcraft?.disabled).toBe(false);
    expect(cfgWithAttached.mcp?.servers?.['local-mcp']?.disabled).toBe(true);
    expect(cfgWithAttached.policies).toBeUndefined();
  });

  it('optimizes SVG in-process, writes workspace output, creates artifact, and rejects traversal', () => {
    const { cwd, config, store, project, agent } = makeFixture();
    const tools = createStudioTools({
      store,
      projectId: project.id,
      actingAgentId: agent.id,
      enqueue: () => {},
      dataDir: config.dataDir,
      cwd,
      config,
    });

    const raw = `<?xml version="1.0"?>
      <!-- exported from inkscape -->
      <svg width="120" height="80" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3">
        <metadata><rdf>junk</rdf></metadata>
        <defs>   </defs>
        <rect x="0" y="0" width="120" height="80" fill="#ff6600" />
      </svg>`;
    const inlineOpt = optimizeSvgContent(raw);
    expect(inlineOpt.viewBox).toBe('0 0 120 80');
    expect(inlineOpt.svg).not.toContain('inkscape');
    expect(inlineOpt.svg).not.toContain('<metadata>');
    expect(inlineOpt.optimizedBytes).toBeLessThan(inlineOpt.originalBytes);

    fs.writeFileSync(path.join(cwd, 'draft.svg'), raw, 'utf8');
    const actionRes = applyAtelierActions(
      `Done.\n<atelier-action>{"tool":"optimize_svg","inputPath":"draft.svg","outputPath":"dist/logo.min.svg","label":"Logo"}</atelier-action>`,
      tools,
      { onText() {}, onTool() {}, onSession() {} },
    );
    expect(actionRes.actionsExecuted).toBe(1);
    expect(actionRes.recall).toHaveLength(1);
    const outPayload = actionRes.recall[0]!.result as {
      ok: boolean;
      artifactId?: string;
      workspacePath?: string;
      viewBox?: string;
    };
    expect(outPayload.ok).toBe(true);
    expect(outPayload.viewBox).toBe('0 0 120 80');
    expect(fs.existsSync(path.join(cwd, 'dist', 'logo.min.svg'))).toBe(true);
    expect(store.getArtifact(outPayload.artifactId!)?.kind).toBe('svg');

    const traversal = tools.optimize_svg({
      svg: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
      outputPath: '../outside.svg',
    });
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toMatch(/Path must stay inside workspace/i);
  });

  it('fast-fails generate_image without API keys and saves artifact via OpenRouter when configured', async () => {
    const { cwd, config, store, project, agent } = makeFixture();
    const tools = createStudioTools({
      store,
      projectId: project.id,
      actingAgentId: agent.id,
      enqueue: () => {},
      dataDir: config.dataDir,
      cwd,
      config,
    });

    const missing = await tools.generate_image({ prompt: 'minimalist golden garuda emblem' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('no_image_api_key');

    const fakePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    store.setProviderSecret('openrouter', 'or-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url: `data:image/png;base64,${fakePng.toString('base64')}`,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const visualRes = await applyVisualAtelierActions(
      '<atelier-action>{"tool":"generate_image","prompt":"garuda moodboard","outputPath":"assets/mood.png","aspectRatio":"1:1"}</atelier-action>',
      tools,
      { onText() {}, onTool() {}, onSession() {} },
    );
    expect(visualRes.cleanText).toBe('');
    expect(visualRes.results).toHaveLength(1);
    const imgOut = visualRes.results[0]!.result as {
      ok: boolean;
      artifactId?: string;
      workspacePath?: string;
      providerUsed?: string;
    };
    expect(imgOut.ok).toBe(true);
    expect(imgOut.providerUsed).toBe('openrouter');
    expect(fs.existsSync(path.join(cwd, 'assets', 'mood.png'))).toBe(true);
    expect(store.getArtifact(imgOut.artifactId!)?.kind).toBe('image');
  });

  it('caps tool calls per turn by task intent and includes fast-draft rules in system prompt', () => {
    const { project, agent } = makeFixture();
    const logoAgent = { ...agent, allowShell: true } as Agent;
    expect(
      resolveMaxToolCallsPerTurn({
        agent: logoAgent,
        prompt: 'Coba bikin logo baru buat Brand Garuda Data Teknologi',
      }),
    ).toBe(12);
    expect(
      resolveMaxToolCallsPerTurn({
        agent: logoAgent,
        prompt: 'Tolong slice halaman landing page ke komponen React',
      }),
    ).toBe(28);
    expect(
      resolveMaxToolCallsPerTurn({
        agent: { ...agent, allowShell: false } as Agent,
        prompt: 'Design review',
      }),
    ).toBe(10);
    expect(
      resolveMaxToolCallsPerTurn({
        agent: { ...agent, allowShell: false, mcpServerIds: ['figelo'] } as Agent,
        prompt: 'Tolong relayout modal settings di Figma',
      }),
    ).toBe(28);
    expect(
      resolveMaxToolCallsPerTurn({
        agent: logoAgent,
        prompt: 'Route request',
        turnPurpose: 'dispatch',
      }),
    ).toBe(6);

    const sys = buildAgentSystemPrompt(logoAgent, project, [logoAgent], []);
    expect(sys).toContain('Execution Speed & Token-Economy Rules');
    expect(sys).toContain('optimize_svg');
    expect(sys).toContain('generate_image');
    expect(sys).toContain('Fast Single-Pass Page Slicing');
  });
});
