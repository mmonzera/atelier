import http from 'node:http';
import type { ProviderAuthStatus, ServerEvent } from '@atelier/contracts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CliAgentRunner, applyAtelierActions } from '../src/agents/cli-runners.js';
import { formatUncompactedConversation, getUncompactedMessages } from '../src/agents/compactor.js';
import { classifyTurnError } from '../src/agents/fallback.js';
import { buildAgentSystemPrompt } from '../src/agents/prompts.js';
import type { AgentRunner, Turn, TurnCallbacks } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { installPrePushHook } from '../src/github.js';
import { startAtelierServer } from '../src/index.js';
import { buildClaudeMcpJson, buildCodexMcpArgs } from '../src/mcp/config.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { detectLocalBrowser, resolveQaArtifactPath } from '../src/qa/browser-qa.js';
import { AtelierStore } from '../src/store.js';

// Projects no longer ship with default agents; tests that need bots pass them explicitly.
const TEST_AGENTS = [
  { name: 'Bot A', role: 'Engineer' },
  { name: 'Bot B', role: 'QA' },
];

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out waiting for condition');
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('AtelierStore custom agents, tasks, & startup recovery', () => {
  it('persists flexible agents, skills, tasks with AT-N IDs, and recovers cleanly on restart', () => {
    const dir = makeTempDir('atelier-store-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });

    let db = new AtelierDb(dbPath);
    try {
      let store = new AtelierStore(db, config);

      const { project, agents } = store.createProject({ name: 'Harness Test', starterAgents: TEST_AGENTS });
      expect(agents.length).toBeGreaterThanOrEqual(2);
      const firstAgent = agents[0]!;

      // Create custom agent with instructions, extended color, avatarShape & skill
      const qaAgent = store.createAgent(project.id, {
        name: 'QA Bot',
        role: 'QA Engineer',
        color: 'purple',
        avatarShape: 'triangle',
        systemInstructions: 'Verify edge cases and write crisp test plans.',
        allowShell: true,
        skills: [
          {
            id: 'skill_qa_1',
            name: 'playwright-audit',
            description: 'Audit UI flows thoroughly',
            content: '# Playwright Audit\nCheck empty states and happy paths.',
            enabled: true,
          },
        ],
      });
      expect(qaAgent.name).toBe('QA Bot');
      expect(qaAgent.color).toBe('purple');
      expect(qaAgent.avatarShape).toBe('triangle');
      expect(qaAgent.skills).toHaveLength(1);

      const updatedQa = store.updateAgentConfig(qaAgent.id, {
        role: 'Lead QA',
        color: 'magenta',
        avatarShape: 'cloud',
        providerOverride: 'openai',
        modelOverride: 'gpt-5',
      });
      expect(updatedQa.role).toBe('Lead QA');
      expect(updatedQa.color).toBe('magenta');
      expect(updatedQa.avatarShape).toBe('cloud');
      expect(updatedQa.providerOverride).toBe('openai');

      // Create Linear-style tasks with incrementing AT-N identifiers
      const t1 = store.createTask(project.id, {
        title: 'Write smoke tests',
        priority: 'high',
        status: 'todo',
        assigneeAgentId: qaAgent.id,
      });
      const t2 = store.createTask(project.id, {
        title: 'Polish onboarding copy',
        priority: 'medium',
      });
      expect(t1.identifier).toBe('AT-1');
      expect(t2.identifier).toBe('AT-2');

      // Deleting agent unassigns its tasks instead of deleting tasks
      store.deleteAgent(qaAgent.id);
      expect(store.getAgent(qaAgent.id)).toBeNull();
      expect(store.getTask(t1.id)?.assigneeAgentId).toBeNull();

      // Simulate crash during working turn + queued task
      store.updateAgent(firstAgent.id, { status: 'working', currentTask: 'Running checks' });
      store.createMessage({
        projectId: project.id,
        agentId: firstAgent.id,
        author: 'agent',
        text: 'Partial text',
        streaming: true,
      });
      store.enqueueItem({
        agentId: firstAgent.id,
        projectId: project.id,
        kind: 'user',
        prompt: 'Queued after crash',
        refId: null,
      });
      db.close();

      // Reopen and run startup recovery
      db = new AtelierDb(dbPath);
      store = new AtelierStore(db, config);
      store.recoverOnStartup();

      const persistedCustomBot = store.createAgent(project.id, {
        name: 'Mascot Bot',
        role: 'Mascot Designer',
        color: 'cyan',
        avatarShape: 'diamond',
      });
      expect(persistedCustomBot).not.toBeNull();
      db.close();
      db = new AtelierDb(dbPath);
      store = new AtelierStore(db, config);
      const reloadedMascotBot = store.getAgent(persistedCustomBot!.id);
      expect(reloadedMascotBot?.color).toBe('cyan');
      expect(reloadedMascotBot?.avatarShape).toBe('diamond');

      const recoveredAgent = store.getAgent(firstAgent.id)!;
      expect(recoveredAgent.status).toBe('error');
      expect(recoveredAgent.lastError).toBe('Server restart saat turn berjalan');
      expect(recoveredAgent.queueLength).toBe(1);

      const recoveredMsgs = store.listAgentMessages(firstAgent.id);
      expect(recoveredMsgs[0].streaming).toBe(false);
      expect(recoveredMsgs[0].text).toContain('(terputus)');

      // Queued item remains intact (not auto-drained)
      expect(store.listQueue(firstAgent.id)).toHaveLength(1);
    } finally {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  });
});

describe('StudioTools & AgentRuntime (FIFO, Stop, Retry, dispatchTask, message_agent)', () => {
  it('enforces FIFO order, stop (" (dihentikan)" + clears queue), and retry after recovery', async () => {
    const dir = makeTempDir('atelier-rt-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);

      const seenPrompts: string[] = [];
      let releaseFirstTurn: (() => void) | null = null;

      const controlledRunner: AgentRunner = {
        async run(turn: Turn, cb: TurnCallbacks) {
          seenPrompts.push(turn.prompt);
          cb.onText('Hello ');
          if (turn.prompt === 'First slow') {
            await new Promise<void>((resolve, reject) => {
              releaseFirstTurn = resolve;
              turn.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
          }
          cb.onText('world');
          return { finalText: 'Hello world' };
        },
      };

      const runtime = new AgentRuntime(store, config, controlledRunner);
      const { agents } = store.createProject({ name: 'Runtime Project', starterAgents: TEST_AGENTS });
      const bot = agents[0]!;

      runtime.enqueue({ agentId: bot.id, kind: 'user', prompt: 'First slow' });
      runtime.enqueue({ agentId: bot.id, kind: 'user', prompt: 'Second queued' });

      await waitFor(() => store.getAgent(bot.id)?.status === 'working');
      expect(store.getAgent(bot.id)?.queueLength).toBe(1);

      // Stop active turn -> appends " (dihentikan)", clears queue, sets idle
      const stopRes = await runtime.stop(bot.id);
      expect(stopRes.stopped).toBe(true);
      expect(store.getAgent(bot.id)?.status).toBe('idle');
      expect(store.getAgent(bot.id)?.queueLength).toBe(0);
      expect(seenPrompts).toEqual(['First slow']);

      const agentReply = store
        .listAgentMessages(bot.id)
        .find((m) => m.author === 'agent');
      expect(agentReply?.text).toContain('(dihentikan)');

      // Verify retry drains queued task left after simulated restart
      store.enqueueItem({
        agentId: bot.id,
        projectId: bot.projectId ?? null,
        kind: 'user',
        prompt: 'Recovered task',
        refId: null,
      });
      store.updateAgent(bot.id, { status: 'error', lastError: 'Server restart saat turn berjalan' });

      runtime.retry(bot.id);
      await waitFor(() => seenPrompts.includes('Recovered task'));
      await waitFor(() => store.getAgent(bot.id)?.status === 'idle');
      expect(releaseFirstTurn).not.toBeNull();
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });

  it('auto-moves dispatched task from in_progress to in_review with deliverableSummary and delivers message_agent', async () => {
    const dir = makeTempDir('atelier-tools-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);

      const { project, agents } = store.createProject({ name: 'Tools Project', starterAgents: TEST_AGENTS });
      const botA = agents[0]!;
      const botB = agents[1]!;

      const runner: AgentRunner = {
        async run(turn, cb) {
          const text = `Delivered work for: ${turn.prompt.slice(0, 40)}`;
          cb.onText(text);
          return { finalText: text };
        },
      };

      const runtime = new AgentRuntime(store, config, runner);
      const task = store.createTask(project.id, {
        title: 'Build auth module',
        description: 'Implement OAuth session middleware',
        assigneeAgentId: botA.id,
        status: 'todo',
        priority: 'high',
      });

      const { task: dispatched } = runtime.dispatchTask(task.id);
      expect(dispatched.status).toBe('in_progress');

      await waitFor(() => store.getTask(task.id)?.status === 'in_review');
      const finishedTask = store.getTask(task.id)!;
      expect(finishedTask.deliverableSummary).toContain('Delivered work');

      // message_agent enqueues a teammate turn on botB
      const tools = createStudioTools({
        store,
        projectId: project.id,
        actingAgentId: botA.id,
        enqueue: (inTask) => runtime.enqueue(inTask),
      });
      tools.message_agent({
        targetAgentId: botB.id,
        message: 'Please review auth module.',
      });

      await waitFor(() => store.listAgentMessages(botB.id).some((m) => m.author === 'agent'));
      await runtime.shutdown();
    } finally {
      db.close();
    }
  });
});

describe('Git pre-push guardrail hook', () => {
  it('installs .git/hooks/pre-push blocking pushes to defaultBranch', () => {
    const dir = makeTempDir('atelier-git-');
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const installed = installPrePushHook(dir, 'main');
    expect(installed).toBe(true);
    const hookContent = fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), 'utf8');
    expect(hookContent).toContain('refs/heads/main');
    expect(hookContent).toContain('exit 1');
  });
});

describe('HTTP + WebSocket integration (end-to-end custom agents, skills & Linear tasklist)', () => {
  it('enforces Origin security and supports custom agent CRUD, skill file reading, and task dispatch via WS', async () => {
    const dir = makeTempDir('atelier-int-');
    tempDirs.push(dir);
    const skillFilePath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(
      skillFilePath,
      '---\nname: api-reviewer\ndescription: Checks API contracts and error shapes\n---\n\nAlways verify HTTP status codes and schema types.',
      'utf8',
    );

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: ({ store, enqueue }) => ({
        async run(turn, cb) {
          const tools = createStudioTools({
            store,
            projectId: turn.project?.id ?? null,
            actingAgentId: turn.agent.id,
            enqueue,
          });
          cb.onTool('atelier.project_info', {});
          const info = tools.project_info();
          const scopeLabel = info.project ? info.project.name : 'Direct';
          const summary = `Completed turn in ${scopeLabel} (${info.tasks.length} tasks tracked).`;
          cb.onText(summary);
          return { finalText: summary };
        },
      }),
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const events: ServerEvent[] = [];
    let ws: WebSocket | null = null;

    try {
      // Reject disallowed foreign Origin
      const evilRes = await fetch(`${baseUrl}/api/state`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(evilRes.status).toBe(403);
      const evilBody = (await evilRes.json()) as { error: { code: string } };
      expect(evilBody.error.code).toBe('forbidden_origin');

      // Allowed Origin connects to WebSocket
      ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      ws.on('message', (raw) => {
        events.push(JSON.parse(raw.toString()) as ServerEvent);
      });
      await new Promise((resolve, reject) => {
        ws!.once('open', resolve);
        ws!.once('error', reject);
      });

      const snapshotEv = await waitFor(() => events.find((e) => e.type === 'snapshot'));
      expect(snapshotEv.payload.projects).toEqual([]);

      // Create project
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ name: 'Personal Harness' }),
      });
      expect(projRes.status).toBe(201);
      const { project } = (await projRes.json()) as {
        project: { id: string };
      };

      // Import markdown skill via /api/skills/read-file
      const skillRes = await fetch(`${baseUrl}/api/skills/read-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ filePath: skillFilePath }),
      });
      expect(skillRes.status).toBe(200);
      const { skill } = (await skillRes.json()) as {
        skill: { name: string; description: string; content: string };
      };
      expect(skill.name).toBe('api-reviewer');

      // Install custom bot
      const createAgentRes = await fetch(`${baseUrl}/api/projects/${project.id}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          name: 'API Reviewer',
          role: 'Reviewer',
          color: 'red',
          avatarShape: 'diamond',
          systemInstructions: 'Audit API responses carefully.',
          skills: [
            {
              id: 'sk_1',
              name: skill.name,
              description: skill.description,
              content: skill.content,
              enabled: true,
            },
          ],
        }),
      });
      expect(createAgentRes.status).toBe(201);
      const { agent: reviewer } = (await createAgentRes.json()) as {
        agent: { id: string; color: string; avatarShape?: string };
      };
      expect(reviewer.color).toBe('red');
      expect(reviewer.avatarShape).toBe('diamond');

      // Also verify global /api/agents + PATCH extended color & avatarShape
      const globalCreateRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          name: 'Global Mascot',
          role: 'Companion',
          color: 'purple',
          avatarShape: 'triangle',
        }),
      });
      expect(globalCreateRes.status).toBe(201);
      const { agent: globalMascot } = (await globalCreateRes.json()) as {
        agent: { id: string; color: string; avatarShape?: string };
      };
      expect(globalMascot.color).toBe('purple');
      expect(globalMascot.avatarShape).toBe('triangle');

      const globalPatchRes = await fetch(`${baseUrl}/api/agents/${globalMascot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ color: 'pink', avatarShape: 'cloud' }),
      });
      expect(globalPatchRes.status).toBe(200);
      const { agent: patchedMascot } = (await globalPatchRes.json()) as {
        agent: { id: string; color: string; avatarShape?: string };
      };
      expect(patchedMascot.color).toBe('pink');
      expect(patchedMascot.avatarShape).toBe('cloud');

      await fetch(`${baseUrl}/api/agents/${globalMascot.id}`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });

      // Create Linear-style task & dispatch to custom agent
      const taskRes = await fetch(`${baseUrl}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          title: 'Audit auth endpoints',
          priority: 'urgent',
          assigneeAgentId: reviewer.id,
        }),
      });
      expect(taskRes.status).toBe(201);
      const { task } = (await taskRes.json()) as { task: { id: string; identifier: string } };
      expect(task.identifier).toBe('AT-1');

      const dispatchRes = await fetch(`${baseUrl}/api/tasks/${task.id}/dispatch`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(dispatchRes.status).toBe(202);

      await waitFor(() => events.some((e) => e.type === 'message-delta'));
      const reviewEv = await waitFor(() =>
        events.find(
          (e) =>
            e.type === 'task-upserted' &&
            e.payload.id === task.id &&
            e.payload.status === 'in_review',
        ),
      );
      expect(reviewEv.payload.deliverableSummary).toContain('Completed turn');

      // Delete custom agent broadcasts agent-deleted
      const delRes = await fetch(`${baseUrl}/api/agents/${reviewer.id}`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(delRes.status).toBe(200);
      await waitFor(() => events.some((e) => e.type === 'agent-deleted' && e.payload.id === reviewer.id));

      // Verify provider status endpoint returns all 3 providers + discovered models
      const providersRes = await fetch(`${baseUrl}/api/providers/status`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(providersRes.status).toBe(200);
      const { providers, discoveredModels } = (await providersRes.json()) as {
        providers: ProviderAuthStatus[];
        discoveredModels: unknown[];
      };
      expect(providers.map((p) => p.provider)).toEqual([
        'claude',
        'openai',
        'antigravity',
        'deepseek',
        'opencode',
      ]);
      expect(Array.isArray(discoveredModels)).toBe(true);

      // Verify PUT /api/settings persists provider, customModels, and cliPaths
      const customPutRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5',
          customModels: [
            { id: 'gpt-5-custom', label: 'Custom GPT-5', provider: 'openai' },
          ],
          cliPaths: {
            antigravity: 'C:\\custom\\agy.cmd',
            opencode: 'C:\\custom\\opencode.exe',
          },
        }),
      });
      expect(customPutRes.status).toBe(200);
      const putData = (await customPutRes.json()) as {
        settings: {
          provider: string;
          model: string;
          customModels: Array<{ id: string }>;
          cliPaths: Record<string, string>;
        };
      };
      expect(putData.settings.provider).toBe('openai');
      expect(putData.settings.model).toBe('gpt-5');
      expect(putData.settings.customModels[0].id).toBe('gpt-5-custom');
      expect(putData.settings.cliPaths.antigravity).toBe('C:\\custom\\agy.cmd');
      expect(putData.settings.cliPaths.opencode).toBe('C:\\custom\\opencode.exe');

      // Chief of Staff onboarding creates CoS agent with greeting and completes onboarding
      const cosRes = await fetch(`${baseUrl}/api/onboarding/chief-of-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({}),
      });
      expect(cosRes.status).toBe(201);
      const cosData = (await cosRes.json()) as {
        project: { id: string };
        agent: { id: string; role: string };
      };
      expect(cosData.agent.role).toBe('Chief of Staff');

      // Import MCP JSON -> attach to CoS agent -> DELETE removes it & detaches from agent
      const importRes = await fetch(`${baseUrl}/api/mcp/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          json: JSON.stringify({
            mcpServers: {
              fs: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
              },
            },
          }),
        }),
      });
      expect(importRes.status).toBe(201);
      const importData = (await importRes.json()) as {
        servers: Array<{ id: string; name: string }>;
      };
      expect(importData.servers).toHaveLength(1);
      const fsServerId = importData.servers[0].id;

      const patchAgentRes = await fetch(`${baseUrl}/api/agents/${cosData.agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ mcpServerIds: [fsServerId] }),
      });
      expect(patchAgentRes.status).toBe(200);

      const stateAfterImport = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        agents: Array<{ id: string; mcpServerIds: string[] }>;
        messages: Array<{ agentId: string; author: string }>;
        settings: { onboardingCompleted: boolean; mcpServers: Array<{ id: string }> };
      };
      expect(stateAfterImport.settings.onboardingCompleted).toBe(true);
      expect(stateAfterImport.settings.mcpServers.some((m) => m.id === fsServerId)).toBe(true);
      expect(
        stateAfterImport.messages.filter(
          (m) => m.agentId === cosData.agent.id && m.author === 'agent',
        ),
      ).toHaveLength(1);
      expect(
        stateAfterImport.agents.find((a) => a.id === cosData.agent.id)?.mcpServerIds,
      ).toEqual([fsServerId]);

      const delMcpRes = await fetch(`${baseUrl}/api/mcp/servers/${fsServerId}`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(delMcpRes.status).toBe(200);

      const stateAfterDelete = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        agents: Array<{ id: string; mcpServerIds: string[] }>;
        settings: { mcpServers: Array<{ id: string }> };
      };
      expect(stateAfterDelete.settings.mcpServers).toEqual([]);
      expect(
        stateAfterDelete.agents.find((a) => a.id === cosData.agent.id)?.mcpServerIds,
      ).toEqual([]);
    } finally {
      ws?.close();
      await handle.close();
    }
  });
});

describe('Structured <atelier-action> extraction for external CLI runners', () => {
  it('executes create_task & update_task and strips raw XML tags from display text', () => {
    const dir = makeTempDir('atelier-actions-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      const { project, agents } = store.createProject({ name: 'Action Test', starterAgents: TEST_AGENTS });
      const bot = agents[0]!;

      const enqueued: string[] = [];
      const tools = createStudioTools({
        store,
        projectId: project.id,
        actingAgentId: bot.id,
        enqueue: (task) => enqueued.push(task.prompt),
      });

      const loggedTools: string[] = [];
      const rawReply = [
        'Broke down the milestone and created a tracked task.',
        `<atelier-action>{"tool":"create_task","title":"Build Billing UI","priority":"high","assigneeAgentId":"${bot.id}"}</atelier-action>`,
      ].join('\n');

      const { cleanText, actionsExecuted } = applyAtelierActions(rawReply, tools, {
        onTool: (name) => loggedTools.push(name),
      });

      expect(actionsExecuted).toBe(1);
      expect(cleanText).toBe('Broke down the milestone and created a tracked task.');
      expect(loggedTools).toContain('atelier.create_task');
      const tasks = store.listProjectTasks(project.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].identifier).toBe('AT-1');
    } finally {
      db.close();
    }
  });

  it('executes create_agent with skills & MCP attachment and resolves follow-up create_task by name', () => {
    const dir = makeTempDir('atelier-cos-actions-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      const mcpSrv = store.addMcpServer({
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        enabled: true,
      });

      const { project, agents } = store.createProject({ name: 'CoS Action Test', starterAgents: TEST_AGENTS });
      const cosBot = agents[0]!;
      const tools = createStudioTools({
        store,
        projectId: project.id,
        actingAgentId: cosBot.id,
        enqueue: () => undefined,
      });

      const loggedTools: string[] = [];
      const rawReply = [
        'Tim bot sudah dibuat dan task awal sudah di-assign.',
        '<atelier-action>{"tool":"create_agent","name":"Repo Auditor","role":"Code Auditor","color":"red","systemInstructions":"Audit PRs carefully.","skillIds":["skill_code_review"],"mcpServerNames":["github"]}</atelier-action>',
        '<atelier-action>{"tool":"create_task","title":"Audit latest PRs","priority":"high","assigneeAgentId":"Repo Auditor"}</atelier-action>',
      ].join('\n');

      const { actionsExecuted } = applyAtelierActions(rawReply, tools, {
        onTool: (name) => loggedTools.push(name),
      });

      expect(actionsExecuted).toBe(2);
      expect(loggedTools).toContain('atelier.create_agent');
      expect(loggedTools).toContain('atelier.create_task');

      const auditor = store.listProjectAgents(project.id).find((a) => a.name === 'Repo Auditor');
      expect(auditor).toBeDefined();
      expect(auditor?.skills).toHaveLength(1);
      expect(auditor?.skills[0].id).toBe('skill_code_review');
      expect(auditor?.mcpServerIds).toEqual([mcpSrv.id]);

      const tasks = store.listProjectTasks(project.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].assigneeAgentId).toBe(auditor?.id);
    } finally {
      db.close();
    }
  });
});

describe('MCP config generation & stdio/HTTP probe', () => {
  it('formats Claude JSON and Codex CLI overrides including win32 npx wrapping', () => {
    const servers = [
      {
        id: 'mcp_1',
        name: 'fs',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { FOO: 'bar' },
        enabled: true,
      },
      {
        id: 'mcp_2',
        name: 'linear',
        transport: 'http' as const,
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer tok' },
        enabled: true,
      },
    ];

    const claudeCfg = buildClaudeMcpJson(servers);
    if (process.platform === 'win32') {
      expect(claudeCfg.mcpServers.fs.command).toBe('cmd');
      expect(claudeCfg.mcpServers.fs.args).toEqual([
        '/c',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
      ]);
    } else {
      expect(claudeCfg.mcpServers.fs.command).toBe('npx');
    }
    expect(claudeCfg.mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer tok' },
    });

    const codexArgs = buildCodexMcpArgs(servers);
    expect(codexArgs).toContain('mcp_servers.fs.env={FOO="bar"}');
    expect(codexArgs).toContain('mcp_servers.linear.url="https://mcp.linear.app/mcp"');
    expect(codexArgs).toContain('mcp_servers.linear.http_headers={Authorization="Bearer tok"}');
    if (process.platform === 'win32') {
      expect(codexArgs).toContain('mcp_servers.fs.command="cmd"');
    }
  });

  it('probes a stdio MCP server via initialize + tools/list and cleans up', async () => {
    const dir = makeTempDir('atelier-mcp-probe-');
    tempDirs.push(dir);
    const scriptPath = path.join(dir, 'fake-mcp.mjs');
    fs.writeFileSync(
      scriptPath,
      [
        "import readline from 'node:readline';",
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        "rl.on('line', (line) => {",
        '  if (!line.trim()) return;',
        '  const req = JSON.parse(line);',
        "  if (req.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } }) + '\\n');",
        "  } else if (req.method === 'tools/list') {",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'echo', description: 'Echo tool' }] } }) + '\\n');",
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );

    const res = await probeMcpServer({
      id: 'probe_test',
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      enabled: true,
    });

    expect(res.ok).toBe(true);
    expect(res.tools).toEqual(['echo']);
  });
});

describe('Global multi-project agents, Direct DM, and legacy DB migration', () => {
  it('assigns a global agent across multiple projects, unassigns cleanly, and survives project deletion', async () => {
    const dir = makeTempDir('atelier-multiproj-');
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      const globalRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Shared Architect',
          role: 'Systems Architect',
          color: 'blue',
          systemInstructions: 'Work across repositories.',
        }),
      });
      expect(globalRes.status).toBe(201);
      const { agent } = (await globalRes.json()) as { agent: { id: string } };

      const pARes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Alpha App' }),
      });
      const pBRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Beta App' }),
      });
      const { project: projA } = (await pARes.json()) as { project: { id: string } };
      const { project: projB } = (await pBRes.json()) as { project: { id: string } };

      expect(
        (
          await fetch(`${baseUrl}/api/projects/${projA.id}/agents/${agent.id}`, {
            method: 'POST',
            headers: { Origin: 'http://localhost:5173' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${baseUrl}/api/projects/${projB.id}/agents/${agent.id}`, {
            method: 'POST',
            headers: { Origin: 'http://localhost:5173' },
          })
        ).status,
      ).toBe(200);

      const midState = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        projects: Array<{ id: string; agentIds: string[] }>;
        agents: Array<{ id: string }>;
      };
      expect(midState.projects.find((p) => p.id === projA.id)?.agentIds).toEqual([agent.id]);
      expect(midState.projects.find((p) => p.id === projB.id)?.agentIds).toEqual([agent.id]);

      // Unassign from Project A -> stays in Project B & globally
      const unassignRes = await fetch(`${baseUrl}/api/projects/${projA.id}/agents/${agent.id}`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(unassignRes.status).toBe(200);

      // Delete Project B -> global agent still survives!
      const delBRes = await fetch(`${baseUrl}/api/projects/${projB.id}`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(delBRes.status).toBe(200);

      const finalState = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        projects: Array<{ id: string; agentIds: string[] }>;
        agents: Array<{ id: string; name: string }>;
      };
      expect(finalState.projects.find((p) => p.id === projA.id)?.agentIds).toEqual([]);
      expect(finalState.projects.some((p) => p.id === projB.id)).toBe(false);
      expect(finalState.agents.some((a) => a.id === agent.id)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('supports Direct 1-on-1 DMs (projectId: null) and inter-agent messaging outside projects', async () => {
    const dir = makeTempDir('atelier-direct-dm-');
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: ({ store, enqueue }) => ({
        async run(turn, cb) {
          const tools = createStudioTools({
            store,
            projectId: turn.project?.id ?? null,
            actingAgentId: turn.agent.id,
            enqueue,
          });
          if (turn.agent.name === 'Bot One' && !turn.prompt.startsWith('Bot Two replied:')) {
            tools.message_agent({ targetAgentId: 'Bot Two', message: 'Quick direct sanity check?' });
            cb.onText('Asked Bot Two directly.');
            return { finalText: 'Asked Bot Two directly.' };
          }
          cb.onText('Direct reply from Bot Two.');
          return { finalText: 'Direct reply from Bot Two.' };
        },
      }),
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      const a1 = (
        (await (
          await fetch(`${baseUrl}/api/agents`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Bot One', role: 'Helper', color: 'green' }),
          })
        ).json()) as { agent: { id: string } }
      ).agent;
      const a2 = (
        (await (
          await fetch(`${baseUrl}/api/agents`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Bot Two', role: 'Reviewer', color: 'amber' }),
          })
        ).json()) as { agent: { id: string } }
      ).agent;

      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Isolated Project' }),
      });
      const { project } = (await projRes.json()) as { project: { id: string } };

      const sendRes = await fetch(`${baseUrl}/api/agents/${a1.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Handle this outside any project', projectId: null }),
      });
      expect(sendRes.status).toBe(202);

      const finalState = await waitFor(async () => {
        const s = (await (
          await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
        ).json()) as {
          messages: Array<{ agentId: string; projectId: string | null; author: string; text: string }>;
        };
        const botTwoDone = s.messages.some(
          (m) =>
            m.agentId === a2.id &&
            m.projectId === null &&
            m.author === 'agent' &&
            m.text.includes('Direct reply from Bot Two.'),
        );
        const botOneFollowup = s.messages.some(
          (m) =>
            m.agentId === a1.id &&
            m.projectId === null &&
            m.author === 'teammate' &&
            m.text.includes('Bot Two replied:'),
        );
        return botTwoDone && botOneFollowup ? s : false;
      });

      expect(finalState.messages.some((m) => m.projectId === project.id)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('migrates legacy SQLite schema with NOT NULL project_id and backfills project.agentIds', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = makeTempDir('atelier-legacy-db-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');

    const rawDb = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    rawDb.exec(`
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE activities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE ports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, port INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE agent_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    `);
    rawDb
      .prepare(`INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)`)
      .run(
        'prj_legacy',
        now,
        JSON.stringify({
          id: 'prj_legacy',
          name: 'Legacy Project',
          repo: null,
          previewUrl: null,
          allowFullPermissions: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        }),
      );
    rawDb
      .prepare(`INSERT INTO agents (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`)
      .run(
        'agt_legacy',
        'prj_legacy',
        now,
        JSON.stringify({
          id: 'agt_legacy',
          projectId: 'prj_legacy',
          name: 'Legacy Bot',
          role: 'Builder',
          color: 'green',
          systemInstructions: '',
          skills: [],
          mcpServerIds: [],
          allowShell: true,
          providerOverride: null,
          modelOverride: null,
          status: 'idle',
          queueLength: 0,
          currentTask: null,
          sessionId: null,
          lastError: null,
          tokenUsage: { input: 0, output: 0 },
          updatedAt: now,
        }),
      );
    rawDb.close();

    const db = new AtelierDb(dbPath);
    try {
      const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
      const store = new AtelierStore(db, config);

      const proj = store.getProject('prj_legacy');
      expect(proj?.agentIds).toEqual(['agt_legacy']);
      expect(store.listProjectAgents('prj_legacy').map((a) => a.id)).toEqual(['agt_legacy']);

      // Direct global agent & null projectId messages now work on the migrated DB
      const globalAgt = store.createAgent(null, { name: 'Direct Only', role: 'Helper' });
      expect(globalAgt).not.toBeNull();
      const dm = store.createMessage({
        projectId: null,
        agentId: globalAgt!.id,
        author: 'user',
        text: 'Hello direct!',
      });
      expect(dm.projectId).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('Auto-Compacting Context & Session Rotation', () => {
  it('auto-compacts once uncompacted messages cross threshold, rotates CLI session, and preserves chat history', async () => {
    const dir = makeTempDir('atelier-autocompact-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      store.updateSettings({
        autoCompact: {
          enabled: true,
          maxMessages: 4,
          keepRecentMessages: 2,
          maxContextTokens: 40000,
        },
      });

      const observedTurns: Array<{
        prompt: string;
        resumeSessionId: string | null;
        summaryInCompaction: string | undefined;
        uncompactedTexts: string[];
      }> = [];

      const runner: AgentRunner = {
        async run(turn, cb) {
          const scopeKey = turn.project?.id ?? 'direct';
          const compaction = turn.agent.contextCompactions?.[scopeKey];
          const uncompacted = getUncompactedMessages(
            store.listAgentMessages(turn.agent.id, turn.project?.id ?? null),
            compaction,
          );
          observedTurns.push({
            prompt: turn.prompt,
            resumeSessionId: turn.resumeSessionId,
            summaryInCompaction: compaction?.summary,
            uncompactedTexts: uncompacted.map((m) => m.text),
          });
          cb.onSession(`claude:sess-${observedTurns.length}`);
          cb.onUsage?.(1200, 120);
          const reply = `Reply to: ${turn.prompt}`;
          cb.onText(reply);
          return { finalText: reply };
        },
      };

      const runtime = new AgentRuntime(store, config, runner);
      const { project, agents } = store.createProject({
        name: 'Compaction Project',
        starterAgents: [{ name: 'Compact Bot', role: 'Builder' }],
      });
      const bot = agents[0]!;

      // Turn 1 (messages become 2) -> no compact
      runtime.enqueue({ agentId: bot.id, projectId: project.id, kind: 'user', prompt: 'Turn 1 AT-99 goal' });
      await waitFor(() => observedTurns.length === 1 && store.getAgent(bot.id)?.status === 'idle');
      expect(observedTurns[0]!.resumeSessionId).toBeNull();
      expect(store.getAgent(bot.id)?.sessions?.[project.id]).toBe('claude:sess-1');

      // Turn 2 (messages reach 4 >= maxMessages 4) -> should resume sess-1 during Turn 2, then auto-compact post-turn & rotate session
      runtime.enqueue({ agentId: bot.id, projectId: project.id, kind: 'user', prompt: 'Turn 2 build' });
      await waitFor(() => store.getAgent(bot.id)?.contextCompactions?.[project.id] !== undefined);
      await waitFor(() => store.getAgent(bot.id)?.status === 'idle');

      expect(observedTurns[1]!.resumeSessionId).toBe('claude:sess-1');
      const afterCompact = store.getAgent(bot.id)!;
      expect(afterCompact.sessions?.[project.id]).toBeUndefined();
      const compaction = afterCompact.contextCompactions?.[project.id];
      expect(compaction).toBeDefined();
      expect(compaction!.compactedMessageCount).toBe(2);
      expect(compaction!.summary).toContain('AT-99');

      // Full history in DB must remain intact + include compacted system divider
      const allMsgs = store.listAgentMessages(bot.id, project.id);
      expect(allMsgs.some((m) => m.text === 'Turn 1 AT-99 goal')).toBe(true);
      expect(allMsgs.some((m) => m.author === 'system' && m.metadata?.compacted === true)).toBe(true);

      // System prompt carries the compacted memory block
      const sysPrompt = buildAgentSystemPrompt(bot, project, [bot], [], [], [], [], compaction);
      expect(sysPrompt).toContain('Compacted Conversation Memory');
      expect(sysPrompt).toContain('AT-99');

      // Turn 3 starts a fresh native CLI session (resumeSessionId: null) and skips compacted older messages
      runtime.enqueue({ agentId: bot.id, projectId: project.id, kind: 'user', prompt: 'Turn 3 verify' });
      await waitFor(() => observedTurns.length === 3 && store.getAgent(bot.id)?.status === 'idle');
      expect(observedTurns[2]!.resumeSessionId).toBeNull();
      expect(observedTurns[2]!.summaryInCompaction).toContain('Turn 1 AT-99 goal');
      expect(observedTurns[2]!.uncompactedTexts).not.toContain('Turn 1 AT-99 goal');
      expect(observedTurns[2]!.uncompactedTexts).toContain('Turn 2 build');

      const formatted = formatUncompactedConversation(allMsgs, compaction, 'Turn 3 verify');
      expect(formatted).not.toContain('Turn 1 AT-99 goal');
      expect(formatted).toContain('Turn 2 build');

      await runtime.shutdown();
    } finally {
      db.close();
    }
  });

  it('exposes manual POST /api/agents/:id/compact and isolates Project vs Direct scopes', async () => {
    const dir = makeTempDir('atelier-compact-http-');
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: () => ({
        async run(turn, cb) {
          const scopeTag = turn.project ? turn.project.id : 'direct';
          cb.onSession(`claude:${scopeTag}-live`);
          const text = `Handled (${scopeTag}): ${turn.prompt}`;
          cb.onText(text);
          return { finalText: text };
        },
      }),
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      // Settings update supports autoCompact config
      const settingsRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          autoCompact: { enabled: true, maxMessages: 16, keepRecentMessages: 4, maxContextTokens: 32000 },
        }),
      });
      expect(settingsRes.status).toBe(200);
      const settingsJson = (await settingsRes.json()) as {
        settings: { autoCompact: { maxMessages: number; keepRecentMessages: number; maxContextTokens: number } };
      };
      expect(settingsJson.settings.autoCompact).toEqual({
        enabled: true,
        maxMessages: 16,
        keepRecentMessages: 4,
        maxContextTokens: 32000,
      });

      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Scope Project' }),
      });
      const { project } = (await projRes.json()) as { project: { id: string } };

      const agtRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Multi Scope Bot', role: 'Helper', color: 'blue' }),
      });
      const { agent } = (await agtRes.json()) as { agent: { id: string } };

      await fetch(`${baseUrl}/api/projects/${project.id}/agents/${agent.id}`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173' },
      });

      // 2 turns in Direct scope + 2 turns in Project scope
      for (const prompt of ['DM one', 'DM two']) {
        await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: prompt, projectId: null }),
        });
      }
      for (const prompt of ['Proj one', 'Proj two']) {
        await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: prompt, projectId: project.id }),
        });
      }

      await waitFor(async () => {
        const s = (await (
          await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
        ).json()) as {
          agents: Array<{ id: string; status: string; sessions?: Record<string, string> }>;
          messages: Array<{ agentId: string; projectId: string | null; author: string }>;
        };
        const a = s.agents.find((x) => x.id === agent.id);
        const replyCount = s.messages.filter((m) => m.agentId === agent.id && m.author === 'agent').length;
        return a && a.status === 'idle' && replyCount === 4 ? s : false;
      });

      // Manual compact on Project scope only -> clears project session, leaves direct session intact!
      const compactRes = await fetch(`${baseUrl}/api/agents/${agent.id}/compact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId: project.id }),
      });
      expect(compactRes.status).toBe(200);
      const compactJson = (await compactRes.json()) as {
        ok: boolean;
        compacted: boolean;
        compactedCount: number;
        compaction: { summary: string };
      };
      expect(compactJson.ok).toBe(true);
      expect(compactJson.compacted).toBe(true);
      expect(compactJson.compactedCount).toBe(2);

      const afterState = (await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).json()) as {
        agents: Array<{
          id: string;
          sessions?: Record<string, string>;
          contextCompactions?: Record<string, { summary: string }>;
        }>;
      };
      const updated = afterState.agents.find((x) => x.id === agent.id)!;
      expect(updated.sessions?.[project.id]).toBeUndefined();
      expect(updated.sessions?.direct).toBe('claude:direct-live');
      expect(updated.contextCompactions?.[project.id]?.summary).toContain('Proj one');
      expect(updated.contextCompactions?.direct).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});

describe('DeepSeek & OpenCode providers', () => {
  it('stores DeepSeek API key server-side with masking and persists deepseek/opencode overrides', async () => {
    const dir = makeTempDir('atelier-providers-');
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
    const secret = 'sk-test-secret-key-9876';

    try {
      const saveKeyRes = await fetch(`${baseUrl}/api/providers/deepseek/api-key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: secret }),
      });
      expect(saveKeyRes.status).toBe(200);
      const saveData = (await saveKeyRes.json()) as { status: ProviderAuthStatus };
      expect(saveData.status.provider).toBe('deepseek');
      expect(saveData.status.authMode).toBe('api_key');
      expect(saveData.status.authenticated).toBe(true);
      expect(saveData.status.accountLabel).toBe('sk-…9876');

      // Raw secret must never leak via /api/state
      const rawStateText = await (
        await fetch(`${baseUrl}/api/state`, { headers: { Origin: 'http://localhost:5173' } })
      ).text();
      expect(rawStateText).not.toContain(secret);

      // Agent creation accepts deepseek & opencode overrides
      const dsAgentRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'DeepSeek Analyst',
          role: 'Analyst',
          providerOverride: 'deepseek',
          modelOverride: 'deepseek-reasoner',
        }),
      });
      expect(dsAgentRes.status).toBe(201);
      const ocAgentRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'OpenCode Coder',
          role: 'Builder',
          providerOverride: 'opencode',
          modelOverride: 'opencode/big-pickle',
        }),
      });
      expect(ocAgentRes.status).toBe(201);

      // Clear key removes stored secret
      const clearRes = await fetch(`${baseUrl}/api/providers/deepseek/api-key`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(clearRes.status).toBe(200);
      expect(handle.store.getProviderSecret('deepseek')).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('streams DeepSeek SSE completions, parses usage, and executes atelier-action blocks', async () => {
    const dir = makeTempDir('atelier-deepseek-sse-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');

    let capturedAuth = '';
    let capturedModel = '';
    const mockServer = http.createServer((req, res) => {
      if (req.url === '/chat/completions' && req.method === 'POST') {
        capturedAuth = String(req.headers.authorization ?? '');
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { model: string };
          capturedModel = parsed.model;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'DeepSeek working. ' } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    content:
                      '<atelier-action>{"tool":"create_task","title":"Verify DeepSeek flow","priority":"medium"}</atelier-action>',
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 18 } })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockServer.address();
    const mockPort = typeof addr === 'object' && addr ? addr.port : 0;

    const config = loadConfig({
      dataDir: dir,
      workspacesDir: path.join(dir, 'ws'),
      dbPath,
      deepseekBaseUrl: `http://127.0.0.1:${mockPort}`,
    });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      store.setProviderSecret('deepseek', 'sk-mock-deepseek-1234');
      const { project, agents } = store.createProject({
        name: 'DeepSeek Project',
        starterAgents: [
          {
            name: 'DeepSeek Bot',
            role: 'Planner',
            providerOverride: 'deepseek',
            modelOverride: 'deepseek-chat',
          },
        ],
      });
      const bot = agents[0]!;

      const runtime = new AgentRuntime(
        store,
        config,
        undefined,
        ({ store: s, enqueue }) => new CliAgentRunner(s, config, () => enqueue),
      );

      runtime.enqueue({
        agentId: bot.id,
        projectId: project.id,
        kind: 'user',
        prompt: 'Plan the integration test',
      });

      await waitFor(() => store.listProjectTasks(project.id).length === 1);
      await waitFor(() => store.getAgent(bot.id)?.status === 'idle');

      expect(capturedAuth).toBe('Bearer sk-mock-deepseek-1234');
      expect(capturedModel).toBe('deepseek-chat');
      const updated = store.getAgent(bot.id)!;
      expect(updated.tokenUsage.input).toBe(42);
      expect(updated.tokenUsage.output).toBe(18);
      expect(store.listProjectTasks(project.id)[0]!.title).toBe('Verify DeepSeek flow');

      await runtime.shutdown();
    } finally {
      db.close();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});

describe('AI Usage Analytics & Provider Limits', () => {
  it('tracks per-turn usage logs, computes remaining provider limits, fetches live DeepSeek balance, and resets logs', async () => {
    const dir = makeTempDir('atelier-usage-');
    tempDirs.push(dir);

    const balanceServer = http.createServer((req, res) => {
      if (req.url === '/user/balance' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'USD', total_balance: '4.82' }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => balanceServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = balanceServer.address();
    const balancePort = typeof addr === 'object' && addr ? addr.port : 0;

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
        deepseekBaseUrl: `http://127.0.0.1:${balancePort}`,
      },
      customRunner: {
        async run(turn, cb) {
          cb.onUsage?.(4000, 1000);
          cb.onText(`Done: ${turn.prompt}`);
          return { finalText: `Done: ${turn.prompt}` };
        },
      },
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      // Save DeepSeek API key so /user/balance probe executes
      await fetch(`${baseUrl}/api/providers/deepseek/api-key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: 'sk-balance-probe-9999' }),
      });

      const agtRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'DeepSeek Meter Bot',
          role: 'Analyst',
          providerOverride: 'deepseek',
          modelOverride: 'deepseek-chat',
        }),
      });
      const { agent } = (await agtRes.json()) as { agent: { id: string } };

      // Run 2 turns (total 10,000 tokens: 8,000 in + 2,000 out)
      for (const prompt of ['Check 1', 'Check 2']) {
        await fetch(`${baseUrl}/api/agents/${agent.id}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: prompt, projectId: null }),
        });
      }

      await waitFor(
        () =>
          handle.store.listUsageLogs().length === 2 &&
          handle.store.getAgent(agent.id)?.status === 'idle',
      );

      // Configure monthly tokenLimit = 40,000 & budgetUsd = 10
      const putLimitRes = await fetch(`${baseUrl}/api/usage/limits/deepseek`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ period: 'monthly', tokenLimit: 40000, budgetUsd: 10 }),
      });
      expect(putLimitRes.status).toBe(200);

      const usageRes = await fetch(`${baseUrl}/api/usage?range=30d`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(usageRes.status).toBe(200);
      const dashboard = (await usageRes.json()) as {
        totals: { turns: number; inputTokens: number; outputTokens: number; totalTokens: number };
        providers: Array<{
          provider: string;
          turns: number;
          totalTokens: number;
          supportsRollingWindows: boolean;
          fiveHour: {
            usedTokens: number;
            tokenLimit: number | null;
            remainingTokens: number | null;
            percentUsed: number | null;
            resetsAt: string | null;
          };
          weekly: {
            usedTokens: number;
            tokenLimit: number | null;
            remainingTokens: number | null;
            percentUsed: number | null;
            resetsAt: string | null;
          };
          remainingTokens: number | null;
          remainingBudgetUsd: number | null;
          percentUsed: number | null;
          liveBalance: { available: boolean; currency: string; remaining: number; label: string } | null;
        }>;
        agents: Array<{ agentId: string; totalTokens: number; turns: number }>;
      };

      expect(dashboard.totals.turns).toBe(2);
      expect(dashboard.totals.inputTokens).toBe(8000);
      expect(dashboard.totals.outputTokens).toBe(2000);
      expect(dashboard.totals.totalTokens).toBe(10000);

      const ds = dashboard.providers.find((p) => p.provider === 'deepseek')!;
      expect(ds.turns).toBe(2);
      expect(ds.supportsRollingWindows).toBe(false);
      expect(ds.totalTokens).toBe(10000);
      expect(ds.remainingTokens).toBe(30000);
      expect(ds.percentUsed).toBe(25);
      expect(ds.remainingBudgetUsd).toBeGreaterThan(9.99);
      expect(ds.liveBalance).toEqual({
        available: true,
        currency: 'USD',
        remaining: 4.82,
        label: '$4.82 left',
      });

      const claude = dashboard.providers.find((p) => p.provider === 'claude')!;
      expect(claude.supportsRollingWindows).toBe(true);
      expect(claude.fiveHour.tokenLimit).toBe(10000000);
      expect(claude.weekly.tokenLimit).toBe(100000000);

      // Update custom 5h & weekly token caps on Claude -> reflected accurately in GET /api/usage
      handle.store.recordUsageLog({
        provider: 'claude',
        model: 'sonnet',
        agentId: agent.id,
        projectId: null,
        inputTokens: 20000,
        outputTokens: 5000,
        estimatedCostUsd: 0.135,
      });
      const claudeLimitRes = await fetch(`${baseUrl}/api/usage/limits/claude`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          period: 'weekly',
          tokenLimit: null,
          budgetUsd: null,
          fiveHourTokenLimit: 100000,
          weeklyTokenLimit: 1000000,
        }),
      });
      expect(claudeLimitRes.status).toBe(200);
      const claudeUsageJson = (await (
        await fetch(`${baseUrl}/api/usage?range=7d`, {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).json()) as typeof dashboard;
      const claudeUpdated = claudeUsageJson.providers.find((p) => p.provider === 'claude')!;
      expect(claudeUpdated.fiveHour.usedTokens).toBe(25000);
      expect(claudeUpdated.fiveHour.remainingTokens).toBe(75000);
      expect(claudeUpdated.fiveHour.percentUsed).toBe(25);
      expect(claudeUpdated.fiveHour.resetsAt).not.toBeNull();
      expect(claudeUpdated.weekly.usedTokens).toBe(25000);
      expect(claudeUpdated.weekly.remainingTokens).toBe(975000);
      expect(claudeUpdated.weekly.percentUsed).toBe(2.5);

      expect(dashboard.agents[0]!.agentId).toBe(agent.id);
      expect(dashboard.agents[0]!.totalTokens).toBe(10000);

      // Reset logs -> totals drop back to 0
      const clearRes = await fetch(`${baseUrl}/api/usage/logs`, {
        method: 'DELETE',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(clearRes.status).toBe(200);

      const afterClear = (await (
        await fetch(`${baseUrl}/api/usage?range=30d`, {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).json()) as { totals: { turns: number; totalTokens: number } };
      expect(afterClear.totals.turns).toBe(0);
      expect(afterClear.totals.totalTokens).toBe(0);
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => balanceServer.close(() => resolve()));
    }
  });

  it('syncs local Claude Code & Codex JSONL logs, deduplicates streaming chunks, and applies official Codex rate_limits', async () => {
    const dir = makeTempDir('atelier-local-usage-');
    tempDirs.push(dir);
    const claudeDir = path.join(dir, 'claude-projects', 'sample-proj');
    const codexDir = path.join(dir, 'codex-sessions', '2026', '11', '24');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    const nowMs = Date.now();
    const t1 = new Date(nowMs - 60_000).toISOString();
    const reset5hSec = Math.floor((nowMs + 4 * 3600_000) / 1000);
    const resetWeeklySec = Math.floor((nowMs + 5 * 86400_000) / 1000);

    // Claude Code JSONL with 2 streaming snapshots for the same message.id (keep max -> effectiveInput = 100 + 200 + round(10000*0.1) = 1300, output = 400 -> 1700)
    fs.writeFileSync(
      path.join(claudeDir, 'sess.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: t1,
          message: {
            id: 'msg_dedup_1',
            model: 'claude-sonnet-5-5',
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 10000,
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: t1,
          message: {
            id: 'msg_dedup_1',
            model: 'claude-sonnet-5-5',
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 10000,
              output_tokens: 400,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    // Codex JSONL with duplicate cumulative total_tokens + official 5h (27%) & weekly (12%) rate_limits
    fs.writeFileSync(
      path.join(codexDir, 'rollout.jsonl'),
      [
        JSON.stringify({
          type: 'event_msg',
          timestamp: t1,
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 50000 },
              last_token_usage: {
                input_tokens: 10000,
                cached_input_tokens: 8000,
                output_tokens: 500,
              },
            },
            rate_limits: {
              primary: { used_percent: 27, window_minutes: 300, resets_at: reset5hSec },
              secondary: { used_percent: 12, window_minutes: 10080, resets_at: resetWeeklySec },
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: t1,
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 50000 },
              last_token_usage: {
                input_tokens: 10000,
                cached_input_tokens: 8000,
                output_tokens: 500,
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
        claudeProjectsDir: path.join(dir, 'claude-projects'),
        codexSessionsDir: path.join(dir, 'codex-sessions'),
      },
    });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    try {
      const res = await fetch(`${baseUrl}/api/usage?range=7d&refresh=1`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        providers: Array<{
          provider: string;
          turns: number;
          totalTokens: number;
          sourceLabel?: string;
          fiveHour: {
            usedTokens: number;
            percentUsed: number | null;
            resetsAt: string | null;
            isOfficial?: boolean;
          };
          weekly: {
            usedTokens: number;
            percentUsed: number | null;
            resetsAt: string | null;
            isOfficial?: boolean;
          };
        }>;
        agents: Array<{ agentId: string; agentName: string; turns: number; totalTokens: number }>;
      };

      const claude = data.providers.find((p) => p.provider === 'claude')!;
      expect(claude.sourceLabel).toBe('Local Claude Code logs');
      expect(claude.turns).toBe(1);
      expect(claude.totalTokens).toBe(1700);
      expect(claude.fiveHour.usedTokens).toBe(1700);
      expect(claude.fiveHour.isOfficial).toBe(false);
      expect(claude.weekly.isOfficial).toBe(false);

      const openai = data.providers.find((p) => p.provider === 'openai')!;
      expect(openai.sourceLabel).toBe('Official Codex limits');
      expect(openai.turns).toBe(1);
      // 2000 uncached + round(8000 * 0.1) + 500 output = 3300
      expect(openai.totalTokens).toBe(3300);
      expect(openai.fiveHour.percentUsed).toBe(27);
      expect(openai.fiveHour.isOfficial).toBe(true);
      expect(openai.weekly.percentUsed).toBe(12);
      expect(openai.weekly.isOfficial).toBe(true);
      expect(openai.fiveHour.resetsAt).toBe(new Date(reset5hSec * 1000).toISOString());
      expect(openai.weekly.resetsAt).toBe(new Date(resetWeeklySec * 1000).toISOString());

      // Configure fixed weeklyResetDay on Claude & ChatGPT/Codex -> applies uniform fixed-day reset calculation
      const todayDay = new Date().getDay();
      for (const prov of ['claude', 'openai'] as const) {
        const setResetRes = await fetch(`${baseUrl}/api/usage/limits/${prov}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
          body: JSON.stringify({
            period: 'weekly',
            tokenLimit: null,
            budgetUsd: null,
            weeklyResetDay: todayDay,
          }),
        });
        expect(setResetRes.status).toBe(200);
      }

      const afterResetCfg = (await (
        await fetch(`${baseUrl}/api/usage?range=7d`, {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).json()) as typeof data;
      expect(afterResetCfg.providers.find((p) => p.provider === 'claude')?.weekly.isOfficial).toBe(false);
      expect(afterResetCfg.providers.find((p) => p.provider === 'openai')?.weekly.isOfficial).toBe(false);
      expect(afterResetCfg.providers.find((p) => p.provider === 'openai')?.weekly.usedTokens).toBe(3300);

      expect(data.agents.some((a) => a.agentName === 'Claude Code (Local CLI)')).toBe(true);
      expect(data.agents.some((a) => a.agentName === 'Codex (Local CLI)')).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

describe('Model Fallback Chain (Ask-First & Auto Modes)', () => {
  it('classifies provider limit/network errors accurately', () => {
    expect(classifyTurnError('HTTP 429 Too Many Requests: rate_limit exceeded').kind).toBe('rate_limit');
    expect(classifyTurnError('Error: insufficient_quota for billing period').kind).toBe('quota');
    expect(classifyTurnError('529 Overloaded: please try again').kind).toBe('overloaded');
    expect(classifyTurnError('401 Unauthorized: invalid api key').kind).toBe('auth');
    expect(classifyTurnError('Agent CLI timed out after 15m').kind).toBe('timeout');
    expect(classifyTurnError('connect ECONNREFUSED 127.0.0.1:443').kind).toBe('network');
    const unknown = classifyTurnError('TypeError: invalid JSON input');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.recoverable).toBe(false);
  });

  it('pauses with pendingFallback in ask mode and continues cleanly on chosen backup model', async () => {
    const dir = makeTempDir('atelier-fb-ask-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      store.updateSettings({
        provider: 'claude',
        model: 'sonnet',
        fallbackMode: 'ask',
        fallbackChain: [{ provider: 'openai', model: 'gpt-6.2-astra' }],
      });

      const seenCalls: Array<{ provider?: string; model?: string; resumeSessionId: string | null }> = [];
      const runner: AgentRunner = {
        async run(turn, cb) {
          seenCalls.push({
            provider: turn.providerOverride ?? turn.agent.providerOverride ?? 'claude',
            model: turn.modelOverride ?? turn.agent.modelOverride ?? 'sonnet',
            resumeSessionId: turn.resumeSessionId,
          });
          if (!turn.providerOverride) {
            throw new Error('429 rate_limit reached on Claude');
          }
          cb.onText('Recovered on GPT-6.2 Astra!');
          return { finalText: 'Recovered on GPT-6.2 Astra!' };
        },
      };

      const runtime = new AgentRuntime(store, config, runner);
      const { project, agents } = store.createProject({ name: 'FB Ask', starterAgents: TEST_AGENTS });
      const bot = agents[0]!;
      store.updateAgent(bot.id, {
        sessions: { [`project:${project.id}`]: 'claude:sess-123' },
      });

      runtime.enqueue({
        agentId: bot.id,
        projectId: project.id,
        kind: 'user',
        prompt: 'Build the dashboard',
      });

      await waitFor(() => store.getAgent(bot.id)?.status === 'error');
      const errored = store.getAgent(bot.id)!;
      expect(errored.pendingFallback).not.toBeNull();
      expect(errored.pendingFallback?.errorKind).toBe('rate_limit');
      expect(errored.pendingFallback?.candidates).toEqual([
        { provider: 'openai', model: 'gpt-6.2-astra' },
      ]);
      expect(seenCalls).toHaveLength(1);

      runtime.retry(bot.id, {
        modelOverride: { provider: 'openai', model: 'gpt-6.2-astra' },
      });

      await waitFor(() => {
        const cur = store.getAgent(bot.id);
        return cur?.status === 'idle' && cur.pendingFallback === null;
      });

      expect(seenCalls).toHaveLength(2);
      // Cross-provider failover must reset resumeSessionId so compacted history is injected
      expect(seenCalls[1]).toEqual({
        provider: 'openai',
        model: 'gpt-6.2-astra',
        resumeSessionId: null,
      });

      const msgs = store.listAgentMessages(bot.id, project.id);
      const recoveredMsg = msgs.find((m) => m.text.includes('Recovered on GPT-6.2 Astra!'));
      expect(recoveredMsg?.metadata?.fallbackTo).toEqual({
        provider: 'openai',
        model: 'gpt-6.2-astra',
      });
      expect(recoveredMsg?.metadata?.fallbackFrom).toEqual({
        provider: 'claude',
        model: 'sonnet',
        reason: 'rate_limit',
      });
    } finally {
      db.close();
    }
  });

  it('auto-switches to backup model in auto mode and persists fallbackChain over HTTP', async () => {
    const dir = makeTempDir('atelier-fb-auto-');
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      store.updateSettings({
        provider: 'claude',
        model: 'sonnet',
        fallbackMode: 'auto',
        fallbackChain: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      });

      const seenModels: string[] = [];
      const runner: AgentRunner = {
        async run(turn, cb) {
          seenModels.push(`${turn.providerOverride ?? 'claude'}:${turn.modelOverride ?? 'sonnet'}`);
          if (!turn.providerOverride) {
            throw new Error('HTTP 429 rate limit');
          }
          cb.onText('Done via DeepSeek');
          return { finalText: 'Done via DeepSeek' };
        },
      };

      const runtime = new AgentRuntime(store, config, runner);
      const { project, agents } = store.createProject({ name: 'FB Auto', starterAgents: TEST_AGENTS });
      const bot = agents[0]!;

      runtime.enqueue({
        agentId: bot.id,
        projectId: project.id,
        kind: 'user',
        prompt: 'Analyze logs',
      });

      await waitFor(() =>
        store
          .listAgentMessages(bot.id, project.id)
          .some((m) => m.text.includes('Done via DeepSeek')),
      );

      expect(seenModels).toEqual(['claude:sonnet', 'deepseek:deepseek-chat']);
      const finalBot = store.getAgent(bot.id)!;
      expect(finalBot.status).toBe('idle');
      expect(finalBot.pendingFallback).toBeNull();
      expect(runtime.getCooldowns().some((c) => c.provider === 'claude')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('persists fallback settings and supports HTTP POST /api/agents/:id/retry with model override', async () => {
    const dir = makeTempDir('atelier-fb-http-');
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          fallbackMode: 'ask',
          fallbackChain: [
            { provider: 'openai', model: 'gpt-6.2-astra' },
            { provider: 'deepseek', model: 'deepseek-chat' },
          ],
        }),
      });
      expect(putRes.status).toBe(200);
      const putData = (await putRes.json()) as {
        settings: { fallbackMode: string; fallbackChain: Array<{ provider: string; model: string }> };
      };
      expect(putData.settings.fallbackMode).toBe('ask');
      expect(putData.settings.fallbackChain).toHaveLength(2);

      const createRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          name: 'Backup Tester',
          role: 'QA',
          fallbackChain: [{ provider: 'deepseek', model: 'deepseek-reasoner' }],
        }),
      });
      expect(createRes.status).toBe(201);
      const { agent } = (await createRes.json()) as {
        agent: { id: string; fallbackChain?: Array<{ provider: string; model: string }> };
      };
      expect(agent.fallbackChain).toEqual([{ provider: 'deepseek', model: 'deepseek-reasoner' }]);

      const retryRes = await fetch(`${baseUrl}/api/agents/${agent.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          provider: 'deepseek',
          model: 'deepseek-chat',
          makeDefault: true,
        }),
      });
      expect(retryRes.status).toBe(200);
      const retryData = (await retryRes.json()) as {
        agent: { providerOverride: string | null; modelOverride: string | null };
      };
      expect(retryData.agent.providerOverride).toBe('deepseek');
      expect(retryData.agent.modelOverride).toBe('deepseek-chat');
    } finally {
      await handle.close();
    }
  });
});

describe('Browser E2E QA (Headless + Watch Live + Artifacts)', () => {
  it('blocks path traversal in resolveQaArtifactPath and rejects non-http URLs', async () => {
    const dir = makeTempDir('atelier-qa-sec-');
    tempDirs.push(dir);
    expect(resolveQaArtifactPath(dir, '../escape', 'desktop.png')).toBeNull();
    expect(resolveQaArtifactPath(dir, 'qa_123', '../secret.png')).toBeNull();
    expect(resolveQaArtifactPath(dir, 'qa_123', 'script.js')).toBeNull();
    expect(resolveQaArtifactPath(dir, 'qa_123', 'desktop.png')).toContain('qa_123');

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ name: 'QA Security' }),
      });
      const { project } = (await projRes.json()) as { project: { id: string } };

      const badUrlRes = await fetch(`${baseUrl}/api/projects/${project.id}/qa/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ url: 'file:///C:/Windows/System32/drivers/etc/hosts' }),
      });
      expect(badUrlRes.status).toBe(400);

      const travRes = await fetch(`${baseUrl}/api/qa/artifacts/..%2F..%2Fetc/passwd`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(travRes.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('runs a real headless browser E2E check, captures PNG screenshots, and posts report to chat', async () => {
    const detected = detectLocalBrowser();
    if (!detected) {
      return;
    }

    const dir = makeTempDir('atelier-qa-e2e-');
    tempDirs.push(dir);

    // Local test web app simulating user's coded app
    const appServer = http.createServer((req, res) => {
      if (req.url === '/broken') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><body><h1>Broken App</h1><script>console.error('Boom UI crash');</script></body></html>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1>Todo Demo</h1>
        <button id="btn" onclick="document.getElementById('out').textContent='Clicked!'">Click Me</button>
        <div id="out">Idle</div>
      </body></html>`);
    });
    await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const appPort = (appServer.address() as { port: number }).port;

    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ name: 'QA Demo App', starterAgents: TEST_AGENTS }),
      });
      const { project, agents } = (await projRes.json()) as {
        project: { id: string };
        agents: Array<{ id: string }>;
      };

      const qaRes = await fetch(`${baseUrl}/api/projects/${project.id}/qa/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          url: `http://127.0.0.1:${appPort}/`,
          watchLive: false,
          agentId: agents[0].id,
          postToChat: true,
          steps: [
            { action: 'click', selector: '#btn' },
            { action: 'assertText', selector: '#out', value: 'Clicked!' },
          ],
        }),
      });
      expect(qaRes.status).toBe(200);
      const { run } = (await qaRes.json()) as {
        run: {
          id: string;
          passed: boolean;
          steps: Array<{ ok: boolean }>;
          screenshots: Array<{ url: string; label: string }>;
        };
      };
      expect(run.passed).toBe(true);
      expect(run.steps).toHaveLength(3);
      expect(run.screenshots.length).toBeGreaterThanOrEqual(2);

      // Verify PNG screenshot serves cleanly
      const shotRes = await fetch(`${baseUrl}${run.screenshots[0].url}`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(shotRes.status).toBe(200);
      expect(shotRes.headers.get('content-type')).toBe('image/png');

      // Verify run is listed and chat thread received QaReport metadata
      const listRes = await fetch(`${baseUrl}/api/projects/${project.id}/qa/runs`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as { runs: Array<{ id: string }> };
      expect(listData.runs.some((r) => r.id === run.id)).toBe(true);

      const chatMsgs = handle.store.listAgentMessages(agents[0].id, project.id);
      expect(chatMsgs.some((m) => m.metadata?.qaRun?.id === run.id)).toBe(true);

      // Verify console errors cause passed=false
      const failRes = await fetch(`${baseUrl}/api/projects/${project.id}/qa/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({
          url: `http://127.0.0.1:${appPort}/broken`,
          watchLive: false,
        }),
      });
      const failData = (await failRes.json()) as {
        run: { passed: boolean; consoleErrors: string[] };
      };
      expect(failData.run.passed).toBe(false);
      expect(failData.run.consoleErrors.some((e) => e.includes('Boom UI crash'))).toBe(true);
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
  });
});
