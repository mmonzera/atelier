import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliPermissionRequest, McpServerConfig, ServerEvent, Settings } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  buildAntigravityAllowedRules,
  buildClaudeExtraAllowedTools,
  buildCodexPermissionArgs,
  buildEffectiveTurnGrants,
  detectAllPermissionDenials,
  detectPermissionDenial,
  discoverGlobalClaudeMcpNames,
  discoverGlobalCodexMcpNames,
  isPermissionAlreadyGranted,
  makePermissionGrant,
  mergePermissionGrants,
  normalizeMcpTarget,
  parseClaudeToolDenial,
  parseCodexItemDenial,
  parseOpenCodeEventDenial,
} from '../src/agents/permissions.js';
import { composeCliPrompt } from '../src/agents/cli-runners.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { startAtelierServer, type AtelierServerHandle } from '../src/index.js';
import { buildCodexMcpArgs, buildOpenCodeMcpConfig } from '../src/mcp/config.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];
const openDbs: AtelierDb[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createFakeCli(dir: string, binName: string, jsBody: string): string {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, `${binName}.js`);
  fs.writeFileSync(scriptPath, jsBody, 'utf8');

  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, `${binName}.cmd`);
    fs.writeFileSync(
      cmdPath,
      `@ECHO off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
    return cmdPath;
  }

  const shPath = path.join(binDir, binName);
  fs.writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
    mode: 0o755,
  });
  return shPath;
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out waiting for condition');
}

describe('Unified CLI permission helpers', () => {
  it('normalizes MCP identifiers across all 4 CLI formats and merges grants cleanly', () => {
    expect(normalizeMcpTarget('mcp(figelo/ping)')).toEqual({ server: 'figelo', mcpTool: 'ping' });
    expect(normalizeMcpTarget('figelo/list_figma_documents')).toEqual({
      server: 'figelo',
      mcpTool: 'list_figma_documents',
    });
    expect(normalizeMcpTarget('mcp__figelo__ping')).toEqual({ server: 'figelo', mcpTool: 'ping' });
    expect(normalizeMcpTarget('mcp__figelo')).toEqual({ server: 'figelo' });
    expect(normalizeMcpTarget('*')).toEqual({ server: '*' });

    const g1 = makePermissionGrant('mcp', 'figelo', ['ping'], '2026-01-01T00:00:00.000Z');
    const g2 = makePermissionGrant('mcp', 'figelo', ['list_figma_documents'], '2026-01-02T00:00:00.000Z');
    const merged = mergePermissionGrants([g1], g2);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.mcpTools).toEqual(['ping', 'list_figma_documents']);
    expect(merged[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');

    expect(isPermissionAlreadyGranted(merged, { kind: 'mcp', target: 'figelo' })).toBe(true);
    expect(isPermissionAlreadyGranted(merged, { kind: 'mcp', target: 'other' })).toBe(false);
    expect(
      isPermissionAlreadyGranted([makePermissionGrant('mcp', '*')], {
        kind: 'mcp',
        target: 'any-server',
      }),
    ).toBe(true);
  });

  it('builds per-CLI allow rules for Antigravity, Claude, Codex, and OpenCode', () => {
    const attached: McpServerConfig = {
      id: 'mcp_1',
      name: 'figcraft',
      transport: 'http',
      url: 'http://127.0.0.1:3055/mcp',
      enabled: true,
    };
    const grants = buildEffectiveTurnGrants({
      attachedMcp: [attached],
      settingsGrants: [
        makePermissionGrant('mcp', 'figelo', ['ping', 'list_figma_documents']),
        makePermissionGrant('tool', 'WebFetch'),
        makePermissionGrant('tool', 'read_file'),
        makePermissionGrant('command', 'npm test'),
      ],
    });

    const agyNoShell = buildAntigravityAllowedRules(grants, false);
    expect(agyNoShell).toContain('mcp(figcraft/*)');
    expect(agyNoShell).toContain('mcp(figelo/*)');
    expect(agyNoShell).toContain('mcp(figelo/ping)');
    expect(agyNoShell).toContain('read_file(*)');
    // Bare mcp(<server>) and foreign tool names like WebFetch must never be emitted to agy
    expect(agyNoShell).not.toContain('mcp(figelo)');
    expect(agyNoShell).not.toContain('WebFetch(*)');
    expect(agyNoShell).not.toContain('command(npm test)');

    const agyWithShell = buildAntigravityAllowedRules(grants, true);
    expect(agyWithShell).toContain('command(npm test)');

    const claudeTools = buildClaudeExtraAllowedTools(grants, false);
    expect(claudeTools).toContain('mcp__figcraft');
    expect(claudeTools).toContain('mcp__figcraft__*');
    expect(claudeTools).toContain('mcp__figelo');
    expect(claudeTools).toContain('mcp__figelo__*');
    expect(claudeTools).toContain('mcp__figelo__ping');
    expect(claudeTools).not.toContain('Bash(npm test)');

    // Wildcard MCP grant expands to concrete per-server rules for Claude CLI
    const claudeWildcardTools = buildClaudeExtraAllowedTools(
      [makePermissionGrant('mcp', '*')],
      false,
      ['figelo', 'figma-remote'],
    );
    expect(claudeWildcardTools).toContain('mcp__*');
    expect(claudeWildcardTools).toContain('mcp__figelo');
    expect(claudeWildcardTools).toContain('mcp__figelo__*');
    expect(claudeWildcardTools).toContain('mcp__figma-remote');
    expect(claudeWildcardTools).toContain('mcp__figma-remote__*');

    // discoverGlobalClaudeMcpNames reads ~/.claude.json, project-scoped entries, ~/.claude/settings.json, and <cwd>/.mcp.json
    const tmpClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-claude-home-'));
    tempDirs.push(tmpClaudeHome);
    const tmpProject = path.join(tmpClaudeHome, 'proj', 'sub');
    const tmpOtherProject = path.join(tmpClaudeHome, 'other-proj');
    fs.mkdirSync(path.join(tmpClaudeHome, '.claude'), { recursive: true });
    fs.mkdirSync(tmpProject, { recursive: true });
    fs.mkdirSync(tmpOtherProject, { recursive: true });
    fs.writeFileSync(
      path.join(tmpClaudeHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { figelo: { command: 'node' } },
        projects: {
          [path.join(tmpClaudeHome, 'proj')]: {
            mcpServers: { 'proj-mcp': { url: 'http://127.0.0.1:4000' } },
          },
          [tmpOtherProject]: {
            mcpServers: { 'unrelated-mcp': { url: 'http://127.0.0.1:5000' } },
          },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpClaudeHome, '.claude', 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['settings-mcp'] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpProject, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'cwd-mcp': { command: 'npx' } } }),
      'utf8',
    );
    const claudeDiscovered = discoverGlobalClaudeMcpNames({
      homeDir: tmpClaudeHome,
      claudeConfigDir: path.join(tmpClaudeHome, '.claude'),
      cwd: tmpProject,
    });
    expect(claudeDiscovered.has('figelo')).toBe(true);
    expect(claudeDiscovered.has('proj-mcp')).toBe(true);
    expect(claudeDiscovered.has('settings-mcp')).toBe(true);
    expect(claudeDiscovered.has('cwd-mcp')).toBe(true);
    expect(claudeDiscovered.has('unrelated-mcp')).toBe(false);

    // buildCodexMcpArgs always sets default_tools_approval_mode="approve" for attached servers
    const attachedCodexArgs = buildCodexMcpArgs([
      {
        id: 'mcp_figelo',
        name: 'figelo-mcp',
        transport: 'http',
        url: 'http://127.0.0.1:4444/mcp',
        enabled: true,
      },
    ]);
    expect(attachedCodexArgs).toContain(
      'mcp_servers.figelo-mcp.default_tools_approval_mode="approve"',
    );

    // buildCodexPermissionArgs emits default_tools_approval_mode ONLY for known servers (never unknown/foreign ones)
    const codexArgs = buildCodexPermissionArgs(grants, {
      allowShell: false,
      memoryOnly: false,
      extraDirs: ['D:\\data\\attachments'],
      knownMcpServers: ['figcraft', 'figelo'],
    });
    expect(codexArgs[0]).toBe('--trust');
    expect(codexArgs).toContain('approval_policy="never"');
    expect(codexArgs).toContain('--add-dir=D:\\data\\attachments');
    expect(codexArgs).toContain('mcp_servers.figelo.default_tools_approval_mode="approve"');
    expect(codexArgs).toContain('mcp_servers.figelo.tools.ping.approval_mode="approve"');
    expect(codexArgs).toContain(
      'mcp_servers.figelo.tools.list_figma_documents.approval_mode="approve"',
    );

    const codexUnknownOnly = buildCodexPermissionArgs(
      [makePermissionGrant('mcp', 'not-configured-in-codex')],
      { allowShell: false, memoryOnly: false, knownMcpServers: ['figcraft'] },
    );
    expect(codexUnknownOnly.some((a) => a.includes('not-configured-in-codex'))).toBe(false);

    // discoverGlobalCodexMcpNames reads [mcp_servers.*] tables with transport and ignores stub sections
    const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-codex-home-'));
    tempDirs.push(tmpCodexHome);
    fs.writeFileSync(
      path.join(tmpCodexHome, 'config.toml'),
      [
        '[mcp_servers.brilliant]',
        'url = "http://127.0.0.1:3333/mcp"',
        '[mcp_servers.figcraft.env]',
        'FIGCRAFT_ACCESS = "edit"',
        '[mcp_servers.stub_no_transport]',
        '[mcp_servers."figelo-mcp"]',
        'command = "node"',
      ].join('\n'),
      'utf8',
    );
    const discovered = discoverGlobalCodexMcpNames(tmpCodexHome);
    expect(discovered.has('brilliant')).toBe(true);
    expect(discovered.has('figelo-mcp')).toBe(true);
    expect(discovered.has('stub_no_transport')).toBe(false);
    expect(discovered.has('figcraft')).toBe(false);

    // composeCliPrompt injects newly attached MCP Action Bridge guide on resumed turns
    const resumedPrompt = composeCliPrompt(
      { canonChanged: false },
      'SYS',
      'User asks about figelo',
      true,
      'MCP Action Bridge (live tools for this turn):\n[figelo-mcp] ping()',
    );
    expect(resumedPrompt).toContain('MCP Action Bridge (live tools for this turn):');
    expect(resumedPrompt).toContain('User asks about figelo');

    const ocCfg = buildOpenCodeMcpConfig([], 2, 'win32', {
      disabledGlobalNames: ['figelo', 'other-mcp'],
      allowShell: false,
      allowedMcpNames: ['figelo'],
    }) as {
      mcp?: { servers?: Record<string, { disabled?: boolean }> };
      policies?: Array<{ action: string; resource: string; effect: string }>;
    };
    expect(ocCfg.mcp?.servers?.figelo).toBeUndefined();
    expect(ocCfg.mcp?.servers?.['other-mcp']?.disabled).toBe(true);
    expect(ocCfg.policies).toContainEqual({ action: 'mcp.use', resource: 'figelo', effect: 'allow' });
    expect(ocCfg.policies).toContainEqual({ action: 'tool.use', resource: 'bash', effect: 'deny' });
    expect(ocCfg.policies).not.toContainEqual({ action: 'mcp.use', resource: '*', effect: 'deny' });
  });

  it('detects permission denials across Antigravity, Claude, Codex, and OpenCode formats', () => {
    const agyText = [
      'Error:',
      'permission check failed for mcp "figelo/ping": user denied permission for mcp(figelo/ping)',
      'permission check failed for mcp "figelo/list_figma_documents": user denied permission for mcp(figelo/list_figma_documents)',
    ].join('\n');
    const agyDenials = detectAllPermissionDenials(agyText, { strictCliOnly: true });
    expect(agyDenials).toHaveLength(2);
    expect(agyDenials[0]).toMatchObject({ kind: 'mcp', target: 'figelo', mcpTool: 'ping' });
    expect(agyDenials[1]).toMatchObject({
      kind: 'mcp',
      target: 'figelo',
      mcpTool: 'list_figma_documents',
    });

    expect(
      parseClaudeToolDenial('mcp__figelo__ping', {}, 'Permission denied'),
    ).toMatchObject({ kind: 'mcp', target: 'figelo', mcpTool: 'ping' });

    expect(
      parseCodexItemDenial({
        type: 'mcp_tool_call',
        server: 'figelo',
        tool: 'ping',
        status: 'failed',
        error: 'MCP tool call rejected: user approval required',
      }),
    ).toMatchObject({ kind: 'mcp', target: 'figelo', mcpTool: 'ping' });

    expect(
      parseOpenCodeEventDenial({
        type: 'tool_use',
        part: {
          tool: 'mcp__figelo__ping',
          state: { status: 'error', error: 'Policy denied for mcp.use(figelo)' },
        },
      }),
    ).toMatchObject({ kind: 'mcp', target: 'figelo' });

    expect(
      detectPermissionDenial('Claude requested permissions to use mcp__figelo__ping'),
    ).toMatchObject({ kind: 'mcp', target: 'figelo', mcpTool: 'ping' });

    expect(
      detectPermissionDenial('MCP tool call requires approval, but approval policy is never'),
    ).toMatchObject({ kind: 'mcp', target: '*' });
  });
});

describe('End-to-end 4-CLI permission escalation & persistent auto-grant', () => {
  it('escalates blocked MCP via popup, persists Always Allow across all 4 CLIs, and auto-retries without asking again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-perm-e2e-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const argLog = path.join(dir, 'cli-invocations.jsonl');

    const fakeAgy = createFakeCli(
      dir,
      'agy',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ provider: 'antigravity', args }) + '\\n');
      const settingsArg = args.find((a) => a.startsWith('--settings=')) || '';
      const settingsObj = settingsArg ? JSON.parse(settingsArg.slice('--settings='.length)) : {};
      const allowed = (settingsObj.permissions && settingsObj.permissions.allow) || [];
      const hasFigelo = allowed.includes('mcp(figelo/*)') || allowed.includes('mcp(*)');
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (!hasFigelo) {
          const msg = 'permission check failed for mcp "figelo/ping": user denied permission for mcp(figelo/ping)';
          console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-1', step_type: 'agent_response', text_delta: msg } }));
          console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-1', usage: { input_tokens: 5, output_tokens: 5 } } }));
          return;
        }
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-2', step_type: 'agent_response', text_delta: 'AGY_FIGELO_OK' } }));
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-2', usage: { input_tokens: 5, output_tokens: 5 } } }));
      });
      `,
    );

    const fakeCodex = createFakeCli(
      dir,
      'codex',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ provider: 'openai', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        const ok = args.includes('--trust') && args.includes('approval_policy="never"');
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cx-perm-1' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ok ? 'CODEX_FIGELO_OK' : 'CODEX_BLOCKED' } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }));
      });
      `,
    );

    const fakeClaude = createFakeCli(
      dir,
      'claude',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ provider: 'claude', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        const allowedArg = args.find((a) => a.startsWith('--allowedTools=')) || '';
        const ok = allowedArg.includes('mcp__figelo');
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'cl-perm-1', result: ok ? 'CLAUDE_FIGELO_OK' : 'CLAUDE_BLOCKED' }));
      });
      `,
    );

    const fakeOpenCode = createFakeCli(
      dir,
      'opencode',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const clean = args.filter((a) => a !== '--standalone');
      if (clean[0] === '--version') { console.log('2.4.1'); process.exit(0); }
      if (clean[0] === 'debug' && clean[1] === 'config') { console.log('[]'); process.exit(0); }
      const cfg = process.env.OPENCODE_CONFIG ? JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8')) : {};
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ provider: 'opencode', args, cfg }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        const hasPolicy = Array.isArray(cfg.policies) && cfg.policies.some((p) => p.action === 'mcp.use' && p.resource === 'figelo' && p.effect === 'allow');
        const ok = args.includes('--auto') && hasPolicy;
        console.log(JSON.stringify({ type: 'text', sessionID: 'oc-perm-1', part: { text: ok ? 'OPENCODE_FIGELO_OK' : 'OPENCODE_BLOCKED' } }));
      });
      `,
    );

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'workspaces'),
        dbPath,
      },
    });
    handles.push(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    const wsEvents: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
      ws.on('message', (raw) => {
        wsEvents.push(JSON.parse(String(raw)) as ServerEvent);
      });
    });

    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'antigravity',
          model: 'gemini-3.8-flash-high',
          cliPaths: {
            antigravity: fakeAgy,
            openai: fakeCodex,
            claude: fakeClaude,
            opencode: fakeOpenCode,
          },
        }),
      });

      // Create Direct agent (no project, allowShell: false — exact user scenario!)
      const agtRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Suggoi',
          role: 'UX Reviewer',
          allowShell: false,
          providerOverride: 'antigravity',
          modelOverride: 'gemini-3.8-flash-high',
        }),
      });
      const { agent } = (await agtRes.json()) as { agent: { id: string } };

      // 1. Send message -> agy denies figelo -> server escalates cli-approval event!
      await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test figelo' }),
      });

      const approvalEv = await waitFor(() =>
        wsEvents.find((e) => e.type === 'cli-approval') as
          | { type: 'cli-approval'; payload: CliPermissionRequest }
          | undefined,
      );
      expect(approvalEv.payload.kind).toBe('mcp');
      expect(approvalEv.payload.target).toBe('figelo');
      expect(approvalEv.payload.mcpTools).toContain('ping');

      // 2. Click "Always allow figelo" -> persists grant & auto-retries agy turn!
      const resolveRes = await fetch(
        `${baseUrl}/api/permissions/approvals/${approvalEv.payload.id}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'allow_always' }),
        },
      );
      expect(resolveRes.status).toBe(200);

      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/api/state`);
        const st = (await res.json()) as { messages: Array<{ agentId: string; text: string; streaming: boolean }> };
        return st.messages.some((m) => m.agentId === agent.id && !m.streaming && m.text.includes('AGY_FIGELO_OK'));
      });

      // 3. Switch same agent across ChatGPT/Codex, Claude, and OpenCode -> zero prompts, all receive figelo permission!
      for (const [prov, mod, expectedText] of [
        ['openai', 'gpt-6.2-sol', 'CODEX_FIGELO_OK'],
        ['claude', 'sonnet', 'CLAUDE_FIGELO_OK'],
        ['opencode', 'opencode/big-pickle', 'OPENCODE_FIGELO_OK'],
      ] as const) {
        await fetch(`${baseUrl}/api/agents/${agent.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerOverride: prov, modelOverride: mod }),
        });
        await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `check figelo on ${prov}` }),
        });
        await waitFor(async () => {
          const res = await fetch(`${baseUrl}/api/state`);
          const st = (await res.json()) as {
            messages: Array<{ agentId: string; text: string; streaming: boolean }>;
          };
          return st.messages.some(
            (m) => m.agentId === agent.id && !m.streaming && m.text.includes(expectedText),
          );
        });
      }

      // Only 1 cli-approval should ever have been emitted across all 4 CLIs!
      expect(wsEvents.filter((e) => e.type === 'cli-approval')).toHaveLength(1);

      // Verify Antigravity preserved deny: ["command(*)"] alongside allow: ["mcp(figelo/*)", ...]
      const invocations = fs
        .readFileSync(argLog, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l) as { provider: string; args: string[] });
      const agyRetry = invocations.filter((i) => i.provider === 'antigravity')[1]!;
      const retrySettings = JSON.parse(
        agyRetry.args.find((a) => a.startsWith('--settings='))!.slice('--settings='.length),
      ) as { permissions: { deny: string[]; allow: string[] } };
      expect(retrySettings.permissions.deny).toEqual(['command(*)']);
      expect(retrySettings.permissions.allow).toContain('mcp(figelo/*)');

      // Verify persistence in DB + revoke endpoint
      const settingsRes = await fetch(`${baseUrl}/api/settings`);
      const { settings: savedSettings } = (await settingsRes.json()) as { settings: Settings };
      expect(savedSettings.approvedPermissions?.some((g) => g.key === 'mcp:figelo')).toBe(true);

      const delRes = await fetch(`${baseUrl}/api/permissions/grants/${encodeURIComponent('mcp:figelo')}`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);
      const afterDel = (await delRes.json()) as { settings: Settings };
      expect(afterDel.settings.approvedPermissions ?? []).toEqual([]);

      // 4. Even for an attached MCP server, if Codex ever returns "MCP tool call requires approval, but approval policy is never",
      //    runtime still surfaces the popup instead of swallowing it!
      const attachedSrvRes = await fetch(`${baseUrl}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'figelo-mcp',
          transport: 'http',
          url: 'http://127.0.0.1:4444/mcp',
          enabled: true,
        }),
      });
      const { server: figeloSrv } = (await attachedSrvRes.json()) as { server: { id: string } };
      await fetch(`${baseUrl}/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mcpServerIds: [figeloSrv.id],
          providerOverride: 'openai',
          modelOverride: 'gpt-6.1-terra',
        }),
      });
      const fakeCodexAttached = createFakeCli(
        dir,
        'codex-attached',
        `
        const args = process.argv.slice(2);
        const hasDefaultApprove = args.includes('mcp_servers.figelo-mcp.default_tools_approval_mode="approve"');
        process.stdin.resume();
        process.stdin.on('end', () => {
          console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cx-att-1' }));
          if (!hasDefaultApprove) {
            console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'MCP tool call requires approval, but approval policy is never' } }));
          } else {
            console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'CODEX_ATTACHED_OK' } }));
          }
          console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }));
        });
        `,
      );
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliPaths: { openai: fakeCodexAttached } }),
      });
      await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '@figelo-mcp check open file' }),
      });
      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/api/state`);
        const st = (await res.json()) as {
          messages: Array<{ agentId: string; text: string; streaming: boolean }>;
        };
        return st.messages.some(
          (m) => m.agentId === agent.id && !m.streaming && m.text.includes('CODEX_ATTACHED_OK'),
        );
      });
    } finally {
      ws.close();
    }

    // Reopen DB directly to verify clean persistence schema
    const db2 = new AtelierDb(dbPath);
    openDbs.push(db2);
    const store2 = new AtelierStore(
      db2,
      loadConfig({
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'workspaces'),
        dbPath,
      }),
    );
    expect(Array.isArray(store2.getSettings().approvedPermissions)).toBe(true);
  });
});
