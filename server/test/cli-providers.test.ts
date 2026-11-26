import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Project } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliAgentRunner,
  buildAntigravityCliInvocation,
  normalizeAntigravityModel,
  parseAntigravityStreamLine,
} from '../src/agents/cli-runners.js';
import {
  buildWindowsCmdCommand,
  execCliCapture,
  quoteCmdArg,
  unwrapWindowsCmdShim,
} from '../src/agents/cli-spawn.js';
import { classifyTurnError } from '../src/agents/fallback.js';
import {
  extractOpenCodeCustomProviders,
  extractOpenCodeDisabledProviders,
  formatOpenCodeModelLabel,
  getModelCatalog,
  discoverOpenCodeLiveModels,
} from '../src/agents/model-catalog.js';
import {
  ProviderAuthManager,
  parseOpenCodeAuthList,
  syncLegacyOpenCodeGoKey,
} from '../src/agents/provider-auth.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const openDbs: AtelierDb[] = [];
const mockServers: http.Server[] = [];

afterEach(async () => {
  while (mockServers.length > 0) {
    await new Promise<void>((resolve) => mockServers.pop()!.close(() => resolve()));
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier cli test '));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'atelier.db');
  const config = loadConfig({
    dataDir: path.join(dir, 'data'),
    workspacesDir: path.join(dir, 'workspaces'),
    dbPath,
  });
  const db = new AtelierDb(dbPath);
  openDbs.push(db);
  const store = new AtelierStore(db, config);
  const { project, agents } = store.createProject({
    name: 'CLI Provider Suite',
    starterAgents: [{ name: 'Tester', role: 'Engineer', allowShell: true }],
  });
  return { dir, config, store, project, agent: agents[0]! };
}

/** Creates a fake CLI binary in a directory containing spaces using npm's shim layout. */
function createFakeCli(dir: string, binName: string, jsBody: string): { binPath: string; scriptPath: string } {
  const binDir = path.join(dir, 'bin with spaces');
  const pkgDir = path.join(binDir, 'node_modules', `fake-${binName}`);
  fs.mkdirSync(pkgDir, { recursive: true });
  const scriptPath = path.join(pkgDir, 'cli.js');
  fs.writeFileSync(scriptPath, jsBody, 'utf8');

  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, `${binName}.cmd`);
    const cmdBody = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      `SET "_prog=${process.execPath}"`,
      `"%_prog%"  "%dp0%\\node_modules\\fake-${binName}\\cli.js" %*`,
      '',
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmdBody, 'utf8');
    return { binPath: cmdPath, scriptPath };
  }

  const shPath = path.join(binDir, binName);
  fs.writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
    mode: 0o755,
  });
  return { binPath: shPath, scriptPath };
}

describe('Windows .cmd shim unwrapping and quoting', () => {
  it('unwraps both Node JS and native .exe npm shims and safely quotes batch commands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier shim test '));
    tempDirs.push(dir);

    const jsTarget = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(jsTarget), { recursive: true });
    fs.writeFileSync(jsTarget, 'console.log("ok");', 'utf8');
    const jsCmd = path.join(dir, 'codex.cmd');
    fs.writeFileSync(
      jsCmd,
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      'utf8',
    );

    const exeTarget = path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    fs.mkdirSync(path.dirname(exeTarget), { recursive: true });
    fs.writeFileSync(exeTarget, 'stub-exe', 'utf8');
    const exeCmd = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(
      exeCmd,
      '@ECHO off\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n',
      'utf8',
    );

    if (process.platform === 'win32') {
      expect(unwrapWindowsCmdShim(jsCmd)).toEqual({
        command: process.execPath,
        prefixArgs: [jsTarget],
      });
      expect(unwrapWindowsCmdShim(exeCmd)).toEqual({
        command: exeTarget,
        prefixArgs: [],
      });

      const batDumpJs = path.join(dir, 'dump args.js');
      fs.writeFileSync(batDumpJs, 'console.log(JSON.stringify(process.argv.slice(2)));', 'utf8');
      const batPath = path.join(dir, 'custom wrapper.bat');
      fs.writeFileSync(batPath, `@echo off\r\n"${process.execPath}" "${batDumpJs}" %*\r\n`, 'utf8');

      const out = await execCliCapture(batPath, [
        '-C',
        'D:\\Mark Zuckenberg\\CanvasBot',
        '-c',
        'mcp_servers.fs.args=["/c","D:\\Mark Zuckenberg\\CanvasBot"]',
      ]);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout.trim())).toEqual([
        '-C',
        'D:\\Mark Zuckenberg\\CanvasBot',
        '-c',
        'mcp_servers.fs.args=["/c","D:\\Mark Zuckenberg\\CanvasBot"]',
      ]);
    }

    expect(quoteCmdArg('')).toBe('""');
    expect(buildWindowsCmdCommand('C:\\Program Files\\cli.bat', ['hello world'])).toBe(
      '""C:\\Program Files\\cli.bat" "hello world""',
    );
  });
});

describe('buildAntigravityCliInvocation & normalizeAntigravityModel', () => {
  it('never emits -p, forces modelProvider="" in settings, and maps legacy ids', () => {
    expect(normalizeAntigravityModel('gemini-3.5-flash', 'high')).toBe('gemini-3.8-flash-high');
    expect(normalizeAntigravityModel('gemini-3.5-flash-lite', 'high')).toBe('gemini-3.8-flash-low');
    expect(normalizeAntigravityModel('gemini-4-hydrogen', 'medium')).toBe('gemini-4-hydrogen-medium');
    expect(normalizeAntigravityModel('gemini-4-neon-high', 'low')).toBe('gemini-4-neon-high');

    const inv = buildAntigravityCliInvocation({
      model: 'gemini-3.5-flash',
      effort: 'high',
      allowShell: true,
      allowFullPermissions: false,
      memoryOnly: false,
      attachmentDir: 'D:\\Mark Zuckenberg\\CanvasBot\\attachments',
      artifactDir: 'D:\\Mark Zuckenberg\\CanvasBot\\artifacts',
      resumeConversationId: null,
      fullPrompt: 'System prompt\n\n---\n\nHalo dunia',
    });

    expect(inv.args).not.toContain('-p');
    expect(inv.args).not.toContain('--print');
    expect(inv.args).not.toContain('--prompt');
    expect(inv.args).toContain('--input-format=stream-json');
    expect(inv.args).toContain('--output-format=stream-json');
    expect(inv.args).toContain('--disable-slash-commands');
    expect(inv.args).toContain('--model=gemini-3.8-flash-high');
    expect(inv.args.some((a) => a.startsWith('--effort='))).toBe(false);
    expect(inv.args).toContain('--mode=auto');
    expect(inv.args).toContain('--settings={"modelProvider":""}');
    expect(inv.args).toContain('--add-dir=D:\\Mark Zuckenberg\\CanvasBot\\attachments');
    expect(inv.args).toContain('--add-dir=D:\\Mark Zuckenberg\\CanvasBot\\artifacts');
    expect(inv.args).not.toContain('--dangerously-skip-permissions');

    const parsedStdin = JSON.parse(inv.stdinPayload.trim());
    expect(parsedStdin).toEqual({
      event: 'user',
      message: { content: 'System prompt\n\n---\n\nHalo dunia' },
    });
  });

  it('parses Antigravity stream-json lines for text, tools, session, usage, and errors', () => {
    const events: string[] = [];
    let session = '';
    let usage: [number, number] | null = null;
    const cb = {
      onText: (t: string) => events.push(`text:${t}`),
      onTool: (n: string) => events.push(`tool:${n}`),
      onSession: (s: string) => {
        session = s;
      },
      onUsage: (i: number, o: number) => {
        usage = [i, o];
      },
    };

    let acc = '';
    acc = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'c-1', step_type: 'agent_response', text_delta: 'Hel' },
      }),
      acc,
      cb,
    ).acc;
    acc = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: {} } },
      }),
      acc,
      cb,
    ).acc;
    const final = parseAntigravityStreamLine(
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', conversation_id: 'c-1', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
      acc,
      cb,
    );
    expect(final.error).toBeUndefined();
    expect(final.acc).toBe('Hel');
    expect(session).toBe('antigravity:c-1');
    expect(usage).toEqual([10, 5]);
    expect(events).toEqual(['text:Hel', 'tool:run_command']);

    const errRes = parseAntigravityStreamLine(
      JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'not logged in' } }),
      '',
      cb,
    );
    expect(errRes.error).toBe('not logged in');
  });
});

describe('CliAgentRunner end-to-end provider invocations & error surfacing', () => {
  it('runs Antigravity via agy CLI (stream-json, resume, and auth errors) and manages CLI login/logout', async () => {
    const { dir, config, store, project, agent } = makeFixture();
    const stateFile = path.join(dir, 'agy-auth-state.json');
    const argLog = path.join(dir, 'agy-args.jsonl');
    fs.writeFileSync(stateFile, JSON.stringify({ loggedIn: true }), 'utf8');

    const fakeAgy = createFakeCli(
      dir,
      'agy',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const stateFile = ${JSON.stringify(stateFile)};
      const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s), 'utf8');

      if (args[0] === '--version') {
        console.log('1.5.16');
        process.exit(0);
      }
      if (args[0] === 'models') {
        if (!readState().loggedIn) {
          console.error('Error: not logged in');
          process.exit(1);
        }
        console.log('Fetching available models...');
        console.log('gemini-4-neon-high\\tGemini 4 Neon (High)');
        console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');
        process.exit(0);
      }
      if (args.includes('--prompt-interactive=/logout')) {
        fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ mode: 'logout', args }) + '\\n');
        writeState({ loggedIn: false });
        process.exit(0);
      }
      if (!args.includes('--input-format=stream-json')) {
        fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ mode: 'login', args }) + '\\n');
        writeState({ loggedIn: true });
        process.exit(0);
      }

      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ mode: 'run', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (args.includes('--model=fail-auth')) {
          console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'not logged in' } }));
          process.exit(1);
        }
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-conv-1', step_type: 'agent_response', text_delta: 'OK-AGY' } }));
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-conv-1', usage: { input_tokens: 12, output_tokens: 4 } } }));
      });
      `,
    );

    store.updateSettings({ cliPaths: { antigravity: fakeAgy.binPath } });

    const authManager = new ProviderAuthManager();
    const initialStatus = await authManager.getStatus('antigravity', store.getSettings(), store);
    expect(initialStatus.authMode).toBe('cli');
    expect(initialStatus.cliInstalled).toBe(true);
    expect(initialStatus.authenticated).toBe(true);
    expect(initialStatus.accountLabel).toContain('agy 1.5.16');
    expect(authManager.getDiscoveredAntigravityModels().map((m) => m.id)).toEqual([
      'gemini-4-neon-high',
      'gemini-3.8-flash-high',
    ]);

    const catalog = await getModelCatalog('antigravity', config, store.getSettings(), true);
    expect(catalog.source).toBe('live');
    expect(catalog.models.some((m) => m.id === 'gemini-4-neon-high')).toBe(true);

    const runner = new CliAgentRunner(store, config, () => () => {});
    let sessionSeen = '';
    let usage: [number, number] | null = null;
    const first = await runner.run(
      {
        agent: { ...agent, providerOverride: 'antigravity', modelOverride: 'gemini-3.8-flash-high' },
        project,
        prompt: 'Reply OK',
        resumeSessionId: null,
        signal: new AbortController().signal,
      },
      {
        onText() {},
        onTool() {},
        onSession(s) {
          sessionSeen = s;
        },
        onUsage: (i, o) => {
          usage = [i, o];
        },
      },
    );
    expect(first.finalText).toBe('OK-AGY');
    expect(sessionSeen).toBe('antigravity:agy-conv-1');
    expect(usage).toEqual([12, 4]);

    await runner.run(
      {
        agent: { ...agent, providerOverride: 'antigravity', modelOverride: 'gemini-3.8-flash-high' },
        project,
        prompt: 'Follow-up',
        resumeSessionId: 'antigravity:agy-conv-1',
        signal: new AbortController().signal,
      },
      { onText() {}, onTool() {}, onSession() {} },
    );

    await expect(
      runner.run(
        {
          agent: { ...agent, providerOverride: 'antigravity', modelOverride: 'fail-auth' },
          project,
          prompt: 'Fail',
          resumeSessionId: null,
          signal: new AbortController().signal,
        },
        { onText() {}, onTool() {}, onSession() {} },
      ),
    ).rejects.toThrow(/Sign in on Antigravity/);

    const loggedOut = await authManager.logout('antigravity', store.getSettings(), store);
    expect(loggedOut.authenticated).toBe(false);
    expect(loggedOut.loginInProgress).toBe(false);
    expect(loggedOut.accountLabel).toBeNull();

    const loggedIn = await authManager.startLogin('antigravity', store.getSettings(), store);
    expect(loggedIn.authenticated).toBe(true);
    expect(loggedIn.loginInProgress).toBe(false);

    const runs = fs
      .readFileSync(argLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { mode: string; args: string[] });
    expect(runs.some((r) => r.mode === 'run' && r.args.includes('--conversation=agy-conv-1'))).toBe(true);
    expect(runs.some((r) => r.mode === 'logout' && r.args.includes('--prompt-interactive=/logout'))).toBe(true);
    expect(runs.some((r) => r.mode === 'login')).toBe(true);
    authManager.shutdown();
  });

  it('surfaces structured JSON errors across claude, openai (codex), and opencode and avoids flag swallowing', async () => {
    const { dir, config, store, project, agent } = makeFixture();
    const argLog = path.join(dir, 'provider-args.jsonl');

    const fakeClaude = createFakeCli(
      dir,
      'claude',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ p: 'claude', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (args.includes('--model=fail-quota')) {
          console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' }));
          process.exit(1);
        }
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'cl-1', result: 'OK-CLAUDE' }));
      });
      `,
    );

    const fakeCodex = createFakeCli(
      dir,
      'codex',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ p: 'codex', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (args.includes('fail-429')) {
          console.log(JSON.stringify({ type: 'turn.failed', error: { message: '429 Too Many Requests' } }));
          process.exit(1);
        }
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 'cx-1' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK-CODEX' } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }));
      });
      `,
    );

    const fakeOpenCode = createFakeCli(
      dir,
      'opencode',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        console.log('2.4.1');
        process.exit(0);
      }
      fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify({ p: 'opencode', args }) + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (args.includes('--model=fail-auth')) {
          console.log(JSON.stringify({ type: 'error', error: { message: '401 Unauthorized API key' } }));
          process.exit(1);
        }
        console.log(JSON.stringify({ type: 'text', sessionID: 'oc-1', part: { text: 'OK-OPENCODE' } }));
      });
      `,
    );

    store.updateSettings({
      cliPaths: {
        claude: fakeClaude.binPath,
        openai: fakeCodex.binPath,
        opencode: fakeOpenCode.binPath,
      },
    });

    const runner = new CliAgentRunner(store, config, () => () => {});
    const mkTurn = (provider: Agent['providerOverride'], model: string, projectObj: Project | null = project) => ({
      agent: { ...agent, providerOverride: provider, modelOverride: model },
      project: projectObj,
      prompt: 'hi',
      resumeSessionId: null,
      signal: new AbortController().signal,
    });

    expect((await runner.run(mkTurn('claude', 'sonnet'), { onText() {}, onTool() {}, onSession() {} })).finalText).toBe('OK-CLAUDE');
    expect((await runner.run(mkTurn('openai', 'gpt-6.2-sol'), { onText() {}, onTool() {}, onSession() {} })).finalText).toBe('OK-CODEX');
    expect((await runner.run(mkTurn('opencode', 'opencode/big-pickle'), { onText() {}, onTool() {}, onSession() {} })).finalText).toBe('OK-OPENCODE');

    await expect(
      runner.run(mkTurn('claude', 'fail-quota'), { onText() {}, onTool() {}, onSession() {} }),
    ).rejects.toThrow('Credit balance is too low');
    expect(classifyTurnError('Credit balance is too low').kind).toBe('quota');

    await expect(
      runner.run(mkTurn('openai', 'fail-429'), { onText() {}, onTool() {}, onSession() {} }),
    ).rejects.toThrow('429 Too Many Requests');
    expect(classifyTurnError('429 Too Many Requests').kind).toBe('rate_limit');

    await expect(
      runner.run(mkTurn('opencode', 'fail-auth'), { onText() {}, onTool() {}, onSession() {} }),
    ).rejects.toThrow('401 Unauthorized API key');
    expect(classifyTurnError('401 Unauthorized API key').kind).toBe('auth');

    const logged = fs
      .readFileSync(argLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { p: string; args: string[] });
    const claudeOk = logged.find((x) => x.p === 'claude' && x.args.includes('--model=sonnet'))!;
    expect(claudeOk.args).toContain('--output-format=stream-json');
    expect(claudeOk.args.some((a) => a.startsWith('--allowedTools='))).toBe(true);
    const openCodeOk = logged.find((x) => x.p === 'opencode' && x.args.includes('--model=opencode/big-pickle'))!;
    expect(openCodeOk.args).toContain('--format=json');
  });
});

describe('OpenCode custom provider discovery and auth parsing', () => {
  it('extracts custom baseURL providers from v2/v1 debug config and auth export without leaking secrets', async () => {
    const debugConfig = JSON.stringify([
      {
        type: 'document',
        path: 'opencode.jsonc',
        info: {
          providers: {
            vikey: {
              name: 'Vikey AI',
              settings: { baseURL: 'https://api.vikey.ai/v1/' },
            },
            ignoredNoBaseUrl: { name: 'Ignored' },
          },
        },
      },
    ]);
    const authExport = JSON.stringify([
      {
        id: 'cred_1',
        integrationID: 'vikey',
        active: true,
        value: { type: 'api', key: 'vk-secret-should-not-leak' },
      },
    ]);

    expect(extractOpenCodeCustomProviders(debugConfig, authExport)).toEqual([
      {
        id: 'vikey',
        name: 'Vikey AI',
        baseUrl: 'https://api.vikey.ai/v1/',
        apiKey: 'vk-secret-should-not-leak',
      },
    ]);
    expect(formatOpenCodeModelLabel('Vikey AI', 'anthropic/claude-sonnet-5.5')).toBe(
      'Vikey AI · anthropic/claude-sonnet-5.5',
    );
    expect(
      formatOpenCodeModelLabel('Vikey AI', 'anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
    ).toBe('Vikey AI · Claude Sonnet 5.5');

    let seenAuth = '';
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        seenAuth = req.headers.authorization ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
              { id: 'x-ai/grok-4.7' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockServers.push(server);
    const port = (server.address() as AddressInfo).port;

    const { dir, config, store, project, agent } = makeFixture();
    const capturedConfigFile = path.join(dir, 'captured-opencode-config.json');
    const { binPath } = createFakeCli(
      dir,
      'opencode',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const cleanArgs = args.filter((a) => a !== '--standalone');
      if (cleanArgs[0] === '--version') {
        console.log('2.4.1');
        process.exit(0);
      }
      if (cleanArgs[0] === 'models') {
        console.log('opencode/big-pickle');
        console.log('opencode-go/kimi-k3');
        console.log('vikey/deepseek/deepseek-v4-flash');
        process.exit(0);
      }
      if (cleanArgs[0] === 'debug' && cleanArgs[1] === 'config') {
        console.log(JSON.stringify([{
          type: 'document',
          info: {
            providers: {
              vikey: {
                name: 'Vikey AI',
                settings: { baseURL: 'http://127.0.0.1:${port}/v1' },
              },
            },
          },
        }]));
        process.exit(0);
      }
      if (cleanArgs[0] === 'auth' && cleanArgs[1] === 'export') {
        console.log(JSON.stringify([{ integrationID: 'vikey', active: true, value: { key: 'vk-test-secret-key' } }]));
        process.exit(0);
      }
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (process.env.OPENCODE_CONFIG) {
          fs.copyFileSync(process.env.OPENCODE_CONFIG, ${JSON.stringify(capturedConfigFile)});
        }
        console.log(JSON.stringify({ type: 'text', sessionID: 'oc-vikey-1', part: { text: 'OK-VIKEY' } }));
      });
      `,
    );

    store.updateSettings({ cliPaths: { opencode: binPath } });
    const catalog = await getModelCatalog('opencode', config, store.getSettings(), true);
    expect(catalog.source).toBe('live');
    expect(seenAuth).toBe('Bearer vk-test-secret-key');
    expect(JSON.stringify(catalog)).not.toContain('vk-test-secret-key');
    expect(catalog.note).toContain('Active in OpenCode:');
    expect(catalog.note).toContain('vikey');

    const sonnet = catalog.models.find((m) => m.id === 'vikey/anthropic/claude-sonnet-5.5');
    const grok = catalog.models.find((m) => m.id === 'vikey/x-ai/grok-4.7');
    const deepseek = catalog.models.find((m) => m.id === 'vikey/deepseek/deepseek-v4-flash');
    const goModel = catalog.models.find((m) => m.id === 'opencode-go/kimi-k3');
    expect(sonnet?.label).toBe('Vikey AI · Claude Sonnet 5.5');
    expect(grok?.label).toBe('Vikey AI · x-ai/grok-4.7');
    expect(deepseek?.id).toBe('vikey/deepseek/deepseek-v4-flash');
    expect(goModel?.label).toBe('OpenCode Go · kimi-k3');

    const runner = new CliAgentRunner(store, config, () => () => {});
    const res = await runner.run(
      {
        agent: { ...agent, providerOverride: 'opencode', modelOverride: 'vikey/anthropic/claude-sonnet-5.5' },
        project,
        prompt: 'hello',
        resumeSessionId: null,
        signal: new AbortController().signal,
      },
      { onText() {}, onTool() {}, onSession() {} },
    );
    expect(res.finalText).toBe('OK-VIKEY');
    const injectedCfg = JSON.parse(fs.readFileSync(capturedConfigFile, 'utf8'));
    expect(injectedCfg.providers?.vikey?.models?.['anthropic/claude-sonnet-5.5']).toEqual({
      name: 'anthropic/claude-sonnet-5.5',
    });
  });

  it('parses OpenCode auth list output with ANSI escape sequences and disabled provider policies', () => {
    expect(
      parseOpenCodeAuthList(
        '\x1b[32mVikey AI\x1b[0m  API key                     stored\nOpenAI    OAuth                       stored\n',
      ),
    ).toEqual(['Vikey AI', 'OpenAI']);
    expect(parseOpenCodeAuthList('No credentials stored.\n')).toEqual([]);
    expect(parseOpenCodeAuthList('No authenticated integrations\n')).toEqual([]);
    expect(
      extractOpenCodeDisabledProviders(
        JSON.stringify([
          {
            type: 'document',
            info: {
              policies: [
                { action: 'provider.use', resource: 'vikey', effect: 'deny' },
                { action: 'tool.use', resource: '*', effect: 'deny' },
              ],
            },
          },
        ]),
      ),
    ).toEqual(['vikey']);
  });

  it('records effective provider and model metadata on each assistant turn across switches', async () => {
    const { config, store, project, agent } = makeFixture();
    const runtime = new AgentRuntime(store, config, {
      async run(turn, cb) {
        cb.onText(`reply:${turn.prompt}`);
        return { finalText: `reply:${turn.prompt}` };
      },
    });

    try {
      store.updateAgentConfig(agent.id, {
        providerOverride: 'antigravity',
        modelOverride: 'gemini-4-hydrogen-high',
      });
      runtime.enqueue({ agentId: agent.id, projectId: project.id, kind: 'user', prompt: 'turn 1' });
      await new Promise((r) => setTimeout(r, 80));
      while (store.getAgent(agent.id)?.status === 'working') {
        await new Promise((r) => setTimeout(r, 20));
      }

      store.updateAgentConfig(agent.id, {
        providerOverride: 'claude',
        modelOverride: 'sonnet',
      });
      runtime.enqueue({ agentId: agent.id, projectId: project.id, kind: 'user', prompt: 'turn 2' });
      await new Promise((r) => setTimeout(r, 80));
      while (store.getAgent(agent.id)?.status === 'working') {
        await new Promise((r) => setTimeout(r, 20));
      }

      const replies = store
        .listAgentMessages(agent.id, project.id)
        .filter((m) => m.author === 'agent');
      expect(replies).toHaveLength(2);
      expect(replies[0]!.metadata?.provider).toBe('antigravity');
      expect(replies[0]!.metadata?.model).toBe('gemini-4-hydrogen-high');
      expect(replies[1]!.metadata?.provider).toBe('claude');
      expect(replies[1]!.metadata?.model).toBe('sonnet');
    } finally {
      await runtime.shutdown();
    }
  });

  it('auto-discovers opencode-go models, imports OpenCode API keys via v2 CLI, and mirrors legacy auth.json', async () => {
    const { dir, config, store } = makeFixture();
    const authJson = path.join(dir, 'legacy-auth.json');
    fs.writeFileSync(authJson, JSON.stringify({ opencode: { type: 'api', key: 'oc-legacy-key' } }), 'utf8');
    syncLegacyOpenCodeGoKey([authJson]);
    const synced = JSON.parse(fs.readFileSync(authJson, 'utf8')) as Record<string, { type: string; key: string }>;
    expect(synced['opencode-go']).toEqual({ type: 'api', key: 'oc-legacy-key' });

    const importedDump = path.join(dir, 'imported-auth.json');
    const { binPath } = createFakeCli(
      dir,
      'opencode',
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2).filter((a) => a !== '--standalone');
      if (args[0] === '--version') {
        console.log('2.4.2');
        process.exit(0);
      }
      if (args[0] === 'auth' && args[1] === 'export') {
        console.log('[]');
        process.exit(0);
      }
      if (args[0] === 'auth' && args[1] === 'import' && args[2]) {
        fs.copyFileSync(args[2], ${JSON.stringify(importedDump)});
        process.exit(0);
      }
      if (args[0] === 'auth' && args[1] === 'list') {
        if (fs.existsSync(${JSON.stringify(importedDump)})) {
          console.log('OpenCode  OpenCode  stored');
        }
        process.exit(0);
      }
      if (args[0] === 'models') {
        console.log('opencode/big-pickle');
        console.log('opencode-go/grok-4.7');
        console.log('opencode-go/glm-5.3-flash');
        process.exit(0);
      }
      if (args[0] === 'debug' && args[1] === 'config') {
        console.log('[]');
        process.exit(0);
      }
      `,
    );

    store.updateSettings({ cliPaths: { opencode: binPath } });
    const v1AuthDump = path.join(dir, 'v1-auth.json');
    const authManager = new ProviderAuthManager();
    const status = await authManager.saveOpenCodeApiKey('oc-go-secret-key', store.getSettings(), store, {
      legacyAuthPath: v1AuthDump,
    });
    expect(status.cliInstalled).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(JSON.parse(fs.readFileSync(v1AuthDump, 'utf8'))).toMatchObject({
      opencode: { type: 'api', key: 'oc-go-secret-key' },
      'opencode-go': { type: 'api', key: 'oc-go-secret-key' },
    });
    const savedPayload = JSON.parse(fs.readFileSync(importedDump, 'utf8')) as Array<{
      integrationID: string;
      value: { type: string; key: string };
    }>;
    expect(savedPayload[0]?.integrationID).toBe('opencode');
    expect(savedPayload[0]?.value).toEqual({ type: 'key', key: 'oc-go-secret-key' });

    const discovered = await discoverOpenCodeLiveModels(config, store.getSettings());
    const grok = discovered.find((m) => m.id === 'opencode-go/grok-4.7');
    const glm = discovered.find((m) => m.id === 'opencode-go/glm-5.3-flash');
    expect(grok?.label).toBe('OpenCode Go · grok-4.7');
    expect(glm?.label).toBe('OpenCode Go · glm-5.3-flash');
    authManager.shutdown();
  });
});
