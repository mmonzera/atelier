import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CliAgentRunner } from '../src/agents/cli-runners.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { McpTurnBridge, applyMcpAtelierActions } from '../src/mcp/client.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const openDbs: AtelierDb[] = [];
const servers: http.Server[] = [];
const bridges: McpTurnBridge[] = [];

afterEach(async () => {
  while (bridges.length > 0) {
    await bridges.pop()!.close().catch(() => undefined);
  }
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

function createFakeStdioMcpScript(dir: string): string {
  const scriptPath = path.join(dir, 'fake-figcraft-mcp.js');
  fs.writeFileSync(
    scriptPath,
    `
    let joinedChannel = null;
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\\r?\\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'figcraft', version: '1.0.0' },
            },
          }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'join_channel',
                  description: 'Join a Figma channel session',
                  inputSchema: {
                    type: 'object',
                    properties: { channel: { type: 'string' } },
                    required: ['channel'],
                  },
                },
                {
                  name: 'get_state',
                  description: 'Get current joined channel state',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'ping',
                  description: 'Ping Figma bridge',
                  inputSchema: {
                    type: 'object',
                    properties: { msg: { type: 'string' } },
                    required: ['msg'],
                  },
                },
              ],
            },
          }) + '\\n');
        } else if (msg.method === 'tools/call') {
          const name = msg.params && msg.params.name;
          const args = (msg.params && msg.params.arguments) || {};
          if (name === 'join_channel') {
            joinedChannel = args.channel || null;
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'joined:' + joinedChannel }] },
            }) + '\\n');
          } else if (name === 'get_state') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'channel:' + (joinedChannel || 'none') }] },
            }) + '\\n');
          } else if (name === 'ping') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'pong:' + (args.msg || '') }] },
            }) + '\\n');
          }
        }
      }
    });
    `,
    'utf8',
  );
  return scriptPath;
}

function createFakeAgyCli(dir: string, logPath: string): string {
  const binDir = path.join(dir, 'agy-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'agy.js');
  fs.writeFileSync(
    scriptPath,
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { stdin += c; });
    process.stdin.on('end', () => {
      const parsed = JSON.parse(stdin.trim());
      const prompt = parsed.message.content;
      fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, prompt }) + '\\n');

      if (!prompt.includes('MCP tool results follow')) {
        const actionReply = 'Checking Figma...\\n<atelier-action>{"tool":"mcp_call","server":"figcraft","name":"ping","arguments":{"msg":"hi"}}</atelier-action>';
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-mcp-1', step_type: 'agent_response', text_delta: actionReply } }));
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-mcp-1', usage: { input_tokens: 10, output_tokens: 5 } } }));
      } else {
        const hasPong = prompt.includes('pong:hi');
        const finalReply = hasPong ? 'Figma ping OK (pong:hi)' : 'Missing pong';
        console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-mcp-1', step_type: 'agent_response', text_delta: finalReply } }));
        console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-mcp-1', usage: { input_tokens: 12, output_tokens: 6 } } }));
      }
    });
    `,
    'utf8',
  );

  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, 'agy.cmd');
    fs.writeFileSync(
      cmdPath,
      `@ECHO off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
    return cmdPath;
  }

  const shPath = path.join(binDir, 'agy');
  fs.writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
    mode: 0o755,
  });
  return shPath;
}

describe('McpTurnBridge (stdio & http stateful MCP action bridge)', () => {
  it('keeps stdio MCP server state across tool calls in one turn and cleans up on close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-mcp-stdio-'));
    tempDirs.push(dir);
    const scriptPath = createFakeStdioMcpScript(dir);

    const cfg: McpServerConfig = {
      id: 'mcp_figcraft',
      name: 'figcraft',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      enabled: true,
    };

    const bridge = new McpTurnBridge();
    bridges.push(bridge);
    await bridge.connectAll([cfg]);

    expect(bridge.errors).toEqual([]);
    expect(bridge.hasConnectedTools).toBe(true);
    expect(bridge.tools.map((t) => t.name)).toEqual(['join_channel', 'get_state', 'ping']);

    const catalog = bridge.formatPromptCatalog();
    expect(catalog).toContain('[figcraft]');
    expect(catalog).toContain('join_channel(channel*)');

    const desc = JSON.parse(bridge.describeTool('figcraft', 'join_channel'));
    expect(desc.name).toBe('join_channel');
    expect(desc.inputSchema.required).toEqual(['channel']);

    const joinRes = await bridge.callTool('figcraft', 'join_channel', { channel: 'room-42' });
    expect(joinRes.isError).toBeUndefined();
    expect(joinRes.text).toBe('joined:room-42');

    // Stateful check: the same live stdio process still holds joinedChannel === 'room-42'
    const stateRes = await bridge.callTool('figcraft', 'get_state', {});
    expect(stateRes.text).toBe('channel:room-42');

    // Also test applyMcpAtelierActions shorthand & explicit forms
    const toolEvents: string[] = [];
    const applied = await applyMcpAtelierActions(
      'Running\n<atelier-action>{"tool":"mcp__figcraft__ping","msg":"shorthand"}</atelier-action>',
      bridge,
      { onTool: (name) => toolEvents.push(name) },
    );
    expect(applied.cleanText).toBe('Running');
    expect(applied.results).toEqual([{ tool: 'mcp__figcraft__ping', result: 'pong:shorthand' }]);
    expect(toolEvents).toEqual(['mcp__figcraft__ping']);

    await bridge.close();
  });

  it('preserves Mcp-Session-Id across initialize, tools/list, and tools/call for HTTP MCP (JSON & SSE)', async () => {
    let seenSessionHeaders: Array<string | undefined> = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c.toString();
      });
      req.on('end', () => {
        const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { msg?: string } } };
        seenSessionHeaders.push(req.headers['mcp-session-id'] as string | undefined);

        if (rpc.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'sess-999',
          });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { capabilities: {} } }));
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (rpc.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                tools: [
                  {
                    name: 'echo',
                    description: 'Echo over HTTP',
                    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
                  },
                ],
              },
            })}\n\n`,
          );
          return;
        }
        if (rpc.method === 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text: `http:${rpc.params?.arguments?.msg}` }] },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    servers.push(srv);
    const port = (srv.address() as AddressInfo).port;

    const bridge = new McpTurnBridge();
    bridges.push(bridge);
    await bridge.connectAll([
      {
        id: 'mcp_http',
        name: 'remote-figma',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        enabled: true,
      },
    ]);

    expect(bridge.errors).toEqual([]);
    const callRes = await bridge.callTool('remote-figma', 'echo', { msg: 'hello' });
    expect(callRes.text).toBe('http:hello');
    // initialize had undefined session header; subsequent requests preserved 'sess-999'
    expect(seenSessionHeaders[0]).toBeUndefined();
    expect(seenSessionHeaders.slice(1).every((h) => h === 'sess-999')).toBe(true);
  });

  it('bridges stdio MCP tools end-to-end for Antigravity CLI without emitting atelier.mcp_skipped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-agy-mcp-'));
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

    const mcpScript = createFakeStdioMcpScript(dir);
    const figcraft = store.addMcpServer({
      name: 'figcraft',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpScript],
      enabled: true,
    });

    const { project, agents } = store.createProject({
      name: 'Figma Bridge Test',
      starterAgents: [
        {
          name: 'UX Reviewer',
          role: 'UX Review',
          providerOverride: 'antigravity',
          modelOverride: 'gemini-3.8-flash-high',
          mcpServerIds: [figcraft.id],
        },
      ],
    });
    const uxAgent = agents[0]!;
    const agyLog = path.join(dir, 'agy-calls.jsonl');
    const fakeAgy = createFakeAgyCli(dir, agyLog);
    store.updateSettings({ cliPaths: { antigravity: fakeAgy } });

    const runner = new CliAgentRunner(store, config, () => () => {});
    const toolEvents: Array<{ name: string; input: unknown }> = [];
    const { finalText } = await runner.run(
      {
        agent: uxAgent,
        project,
        prompt: 'Check figma via figcraft',
        resumeSessionId: null,
        signal: new AbortController().signal,
      },
      {
        onText() {},
        onTool(name, input) {
          toolEvents.push({ name, input });
        },
        onSession() {},
      },
    );

    expect(finalText).toBe('Figma ping OK (pong:hi)');
    expect(toolEvents.some((e) => e.name === 'atelier.mcp_skipped')).toBe(false);
    expect(toolEvents.some((e) => e.name === 'mcp__figcraft__ping')).toBe(true);

    const loggedTurns = fs
      .readFileSync(agyLog, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string });
    expect(loggedTurns).toHaveLength(2);
    expect(loggedTurns[0]!.prompt).toContain('MCP Action Bridge (live tools for this turn):');
    expect(loggedTurns[0]!.prompt).toContain('ping(msg*)');
    expect(loggedTurns[1]!.prompt).toContain('pong:hi');
  });

  it('surfaces failed MCP servers in errors and formatPromptCatalog without blocking healthy servers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-mcp-err-'));
    tempDirs.push(dir);
    const scriptPath = createFakeStdioMcpScript(dir);

    const bridge = new McpTurnBridge();
    bridges.push(bridge);
    await bridge.connectAll([
      {
        id: 'mcp_ok',
        name: 'figcraft',
        transport: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        enabled: true,
      },
      {
        id: 'mcp_sse',
        name: 'legacy-sse',
        transport: 'sse',
        url: 'http://127.0.0.1:9/sse',
        enabled: true,
      },
    ]);

    expect(bridge.hasConnectedTools).toBe(true);
    expect(bridge.errors).toHaveLength(1);
    expect(bridge.errors[0]!.server).toBe('legacy-sse');

    const catalog = bridge.formatPromptCatalog();
    expect(catalog).toContain('[figcraft]');
    expect(catalog).toContain('Unavailable MCP servers (failed to connect this turn):');
    expect(catalog).toContain('legacy-sse');
  });
});
