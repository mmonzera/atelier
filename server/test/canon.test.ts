import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonEntry, Message, Task } from '@atelier/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliAgentRunner, composeCliPrompt } from '../src/agents/cli-runners.js';
import { buildDeterministicMemory, compactAgentScope, conversationTail, estimateTokens, formatUncompactedConversation } from '../src/agents/compactor.js';
import { buildAgentSystemPrompt, renderCanon } from '../src/agents/prompts.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { BackupService } from '../src/backup/service.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { getProjectRepoPath } from '../src/github.js';
import { startAtelierServer } from '../src/index.js';
import { AtelierStore } from '../src/store.js';

const folders: string[] = [];
const databases: AtelierDb[] = [];
const oldDefaults = { enabled: true, maxMessages: 20, keepRecentMessages: 6, maxContextTokens: 40000 };
const svgA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="8"/></svg>';
const svgB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0h10v10z" fill="#6D28D9"/></svg>';
const design = `<atelier-design title="Pick a direction">
<atelier-option id="A" label="Orbit" kind="svg">${svgA}</atelier-option>
<atelier-option id="B" label="Mono" kind="svg">${svgB}</atelier-option>
</atelier-design>`;

function tempConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-memory-'));
  folders.push(dataDir);
  return { port: 0, dataDir, dbPath: path.join(dataDir, 'db.sqlite'), workspacesDir: path.join(dataDir, 'ws') };
}

function fixture() {
  const config = loadConfig(tempConfig());
  const db = new AtelierDb(config.dbPath);
  databases.push(db);
  const store = new AtelierStore(db, config);
  const { project, agents: [agent] } = store.createProject({
    name: 'Orbit', starterAgents: [{ name: 'Builder', role: 'Builder' }],
  });
  return { db, store, config, project, agent: agent! };
}

function toolsFor(store: AtelierStore, projectId: string | null, actingAgentId: string) {
  return createStudioTools({ store, projectId, actingAgentId, enqueue() {} });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('Project Canon and design assets', () => {
  it('saves the chosen logo, deduplicates selection retries, and reuses the exact asset through compaction', async () => {
    const configOverrides = tempConfig();
    const seen: Array<{ text: string; changed: boolean }> = [];
    const handle = await startAtelierServer({
      configOverrides,
      customRunner: {
        async run(turn, cb) {
          seen.push({ text: turn.canonText ?? '', changed: Boolean(turn.canonChanged) });
          cb.onSession('claude:memory-session');
          cb.onUsage?.(1000, 50);
          const text = turn.prompt === 'Show me logo options' ? design
            : turn.prompt === 'Add the logo to the header'
              ? (turn.canonText?.includes('brand/logo.svg') ? 'Used brand/logo.svg' : 'Missing logo')
              : 'Acknowledged';
          return { finalText: text };
        },
      },
    });
    try {
      const { store, runtime } = handle;
      store.updateSettings({ autoCompact: { maxMessages: 12, keepRecentMessages: 4 } });
      const { project, agents: [agent] } = store.createProject({
        name: 'Logo', starterAgents: [{ name: 'Designer', role: 'Designer' }],
      });
      const send = async (prompt: string) => {
        runtime.enqueue({ projectId: project.id, agentId: agent!.id, kind: 'user', prompt });
        await vi.waitFor(() => expect(store.getAgent(agent!.id)?.status).toBe('idle'), { interval: 5 });
      };
      await send('Show me logo options');
      const reply = store.listAgentMessages(agent!.id, project.id).find((message) => message.author === 'agent')!;
      expect(reply.text).toBe(design);
      expect(Object.keys(reply.metadata?.designArtifacts ?? {})).toEqual(expect.arrayContaining(['A', 'B']));
      expect(store.listArtifacts(project.id)).toHaveLength(2);

      const base = `http://127.0.0.1:${handle.port}/api/projects/${project.id}`;
      const post = (id: string, optionId: string) => fetch(`${base}/canon/pick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: id, optionId }),
      });
      const res = await post(reply.id, 'B');
      expect(res.status, await res.clone().text()).toBe(200);
      const { entry } = await res.json() as { entry: CanonEntry };
      expect(entry).toMatchObject({ key: 'brand.logo', source: 'user_pick', path: 'brand/logo.svg', kind: 'asset' });
      expect((await post(reply.id, 'B')).status).toBe(200);
      expect(store.listAgentMessages(agent!.id, project.id).filter((message) => message.metadata?.designPick)).toHaveLength(1);
      expect(seen[1]?.changed).toBe(true);
      const logo = path.join(getProjectRepoPath(configOverrides.workspacesDir, project.id), 'brand', 'logo.svg');
      expect(fs.readFileSync(logo, 'utf8')).toBe(svgB);
      const thumbnail = await fetch(`${base}/canon-artifacts/${entry.artifactId}`);
      expect(thumbnail.headers.get('Content-Security-Policy')).toContain('sandbox');
      expect(await thumbnail.text()).toBe(svgB);

      const tools = toolsFor(store, project.id, agent!.id);
      tools.memoryAction('record_decision', { kind: 'decision', key: 'stack.css', title: 'CSS stack', value: 'Use Tailwind' });
      tools.memoryAction('record_decision', { kind: 'decision', key: 'brand.color', title: 'Primary color', value: '#6D28D9' });
      for (let i = 0; i < 32; i++) await send(`Continue step ${i}`);
      await send('Add the logo to the header');

      expect(store.getAgent(agent!.id)?.contextCompactions?.[project.id]?.compactedMessageCount).toBeGreaterThan(30);
      expect(seen.at(-1)?.text).toContain('brand/logo.svg');
      expect(seen.at(-1)?.text).toContain('Use Tailwind');
      expect(seen.at(-1)?.text).toContain('#6D28D9');
      expect(seen.at(-1)?.text).toContain('Inline SVG');
      expect(seen.at(-1)?.changed).toBe(false);
      expect(fs.readFileSync(logo, 'utf8')).toBe(svgB);
      expect(store.listAgentMessages(agent!.id, project.id).at(-1)?.text).toBe('Used brand/logo.svg');
      expect(store.listUsageLogs()[0]?.memoryTokens?.canon).toBeGreaterThan(0);
      expect(tools.memoryAction('search_history', { query: 'Show me logo options' })).toEqual([
        expect.objectContaining({ snippet: 'Show me logo options' }),
      ]);
      const update = await fetch(`${base}/canon/${entry.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Final mark' }),
      });
      expect(update.status).toBe(200);
      const updated = (await update.json() as { entry: CanonEntry }).entry;
      expect(updated).toMatchObject({ source: 'user_edited', title: 'Final mark', artifactId: entry.artifactId });
      expect((await fetch(`${base}/canon/${updated.id}`, { method: 'DELETE' })).status).toBe(200);
      expect(store.listCanon(project.id).map((item) => item.key)).not.toContain('brand.logo');
    } finally {
      await handle.close();
    }
  });

  it('supersedes by key, validates input, and scopes decisions to the project', () => {
    const { db, store, project, agent } = fixture();
    const tools = toolsFor(store, project.id, agent.id);
    const first = tools.memoryAction('record_decision', {
      kind: 'decision', key: 'stack.css', title: 'CSS stack', value: 'CSS modules',
    }) as CanonEntry;
    const next = tools.memoryAction('record_decision', {
      kind: 'decision', key: 'stack.css', title: 'CSS stack', value: 'Tailwind\nCSS',
    }) as CanonEntry;
    expect(store.listCanon(project.id)).toEqual([next]);
    expect(next.value).toBe('Tailwind CSS');
    const historical = db.sqlite.prepare('SELECT data FROM canon WHERE id = ?').get(first.id) as { data: string };
    expect(JSON.parse(historical.data).supersededBy).toBe(next.id);
    expect(store.listCanon('direct')).toEqual([]);
    for (const path of ['../logo.svg', '/brand/logo.svg', 'C:/logo.svg', 'brand\\logo.svg', 'brand/../logo.svg']) {
      expect(() => tools.memoryAction('record_decision', {
        kind: 'asset', key: 'brand.logo', title: 'Logo', value: 'Mark', path,
      })).toThrow();
    }
    expect(() => tools.memoryAction('record_decision', {
      kind: 'rule', key: 'app.secret', title: 'Keep this', value: 'Bearer fake-credential',
    })).toThrow();
    expect(tools.memoryAction('forget_decision', { key: 'stack.css' })).toEqual({ forgotten: true });
    expect(store.listCanon(project.id)).toEqual([]);
  });

  it('does not follow a workspace junction or overwrite a pre-existing logo', () => {
    const { store, config, project, agent } = fixture();
    const root = getProjectRepoPath(config.workspacesDir, project.id);
    const outside = path.join(config.dataDir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside);
    const brand = path.join(root, 'brand');
    fs.symlinkSync(outside, brand, process.platform === 'win32' ? 'junction' : 'dir');
    store.createMessage({ agentId: agent.id, projectId: project.id, text: 'Create a logo', author: 'user' });
    const message = store.createMessage({ agentId: agent.id, projectId: project.id, text: design, author: 'agent' });
    expect(() => store.pickDesign(project.id, message, 'B')).toThrow(/symbolic links/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(brand);
    fs.mkdirSync(brand);
    const logo = path.join(brand, 'logo.svg');
    fs.writeFileSync(logo, '<svg/>');
    expect(() => store.pickDesign(project.id, store.getMessage(message.id)!, 'B')).toThrow(/existing workspace file/);
    expect(fs.readFileSync(logo, 'utf8')).toBe('<svg/>');
    expect(store.listCanon(project.id)).toEqual([]);
  });

  it('keeps the prefix stable across task changes and prioritizes assets under the Canon cap', () => {
    const { store, project, agent } = fixture();
    const canon = Array.from({ length: 50 }, (_, i) => store.upsertCanon(project.id, {
      kind: 'decision', key: `test.choice-${i}`, title: 'Choice', value: 'v'.repeat(300), source: 'agent_recorded',
    }));
    const asset = store.upsertCanon(project.id, {
      kind: 'asset', key: 'brand.logo', title: 'Logo', value: 'Chosen mark', source: 'agent_recorded',
    });
    const small = { ...asset, artifactId: 'art_small' };
    const big = { ...asset, key: 'brand.seal', artifactId: 'art_big' };
    const render = renderCanon([small, big], (id) => id === 'art_small' ? svgB : 'é'.repeat(1100));
    expect(render.text).toContain('Inline SVG "brand.logo"');
    expect(render.text).not.toContain('Inline SVG "brand.seal"');
    const rendered = renderCanon([...canon, small, big]);
    expect(rendered.omitted).toBeGreaterThan(0);
    expect(rendered.text).toContain('brand.logo');
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(1500);
    const task = { id: 'tsk_new', assigneeAgentId: agent.id, status: 'todo', title: 'A new task' } as Task;
    const before = buildAgentSystemPrompt(agent, project, [agent], [], [], [], [], null, [small]);
    const after = buildAgentSystemPrompt(agent, project, [agent], [task], [], [], [], null, [small]);
    expect(after).toContain('A new task');
    expect(before.split('Project Canon')[0]).toBe(after.split('Project Canon')[0]);
  });
});

describe('Token efficiency', () => {
  it('does not resend the system prompt on a resumed CLI session', () => {
    const system = 'Atelier Harness Coordination Protocol ...';
    const first = composeCliPrompt({}, system, 'hello', false);
    expect(first).toContain('Atelier Harness Coordination Protocol');
    expect(composeCliPrompt({}, system, 'hello', true)).toBe('hello');
    const updated = composeCliPrompt({ canonChanged: true, canonText: 'CANON-V2' }, system, 'hello', true);
    expect(updated).toContain('CANON-V2');
    expect(updated).not.toContain('Atelier Harness Coordination Protocol');
  });

  it('keeps the system prompt prefix identical when only dynamic sections change', () => {
    const { project, agent } = fixture();
    const build = (canonText: string, tasks: Task[] = []) =>
      buildAgentSystemPrompt(agent, project, [agent], tasks, [], [], [], null, [], canonText);
    const a = build('Project Canon\n- decision one');
    const b = build('Project Canon\n- decision two');
    const rosterEnd = a.indexOf('Project Canon');
    expect(rosterEnd).toBeGreaterThan(0);
    expect(a.slice(0, rosterEnd)).toBe(b.slice(0, rosterEnd));
  });

  it('only treats explicit phrasing as decisions and caps their count', () => {
    const msg = (id: number, text: string) => ({
      id: `m${id}`, agentId: 'a', projectId: 'p', author: 'user', text, createdAt: new Date().toISOString(),
    }) as unknown as Message;
    const memory = buildDeterministicMemory(null, [
      msg(1, 'tolong pakai tombol biru dan harus cepat'),
      msg(2, 'We decided to ship on Friday'),
      ...Array.from({ length: 60 }, (_, i) => msg(10 + i, `from now on rule ${i}`)),
    ]);
    expect(memory.decisions).not.toContain('tolong pakai tombol biru dan harus cepat');
    expect(memory.open).toContain('tolong pakai tombol biru dan harus cepat');
    expect(memory.decisions.length).toBeLessThanOrEqual(30);
  });
});

describe('Memory budgets and archive', () => {
  it('keeps a 500-message conversation within its memory budgets and carries decisions through repeated compactions', () => {
    const { store, project, agent } = fixture();
    store.updateSettings({ autoCompact: { keepRecentMessages: 14 } });
    for (let i = 0; i < 500; i++) {
      store.createMessage({
        agentId: agent.id, projectId: project.id, author: i === 0 || i % 2 === 0 ? 'user' : 'agent',
        text: i === 0 ? 'We use Tailwind' : `message-${i} ${'Long text '.repeat(400)} END-${i}`,
      });
      if (i > 0 && i % 50 === 0) compactAgentScope(store, agent.id, project.id, { reason: 'auto' });
    }
    const agentAfter = store.getAgent(agent.id)!;
    const summary = agentAfter.contextCompactions?.[project.id]!;
    expect(summary.structured?.decisions).toContain('We use Tailwind');
    expect(summary.summary).toContain('We use Tailwind');
    expect(estimateTokens(summary.summary)).toBeLessThanOrEqual(2000);
    const history = store.listAgentMessages(agent.id, project.id);
    const tail = conversationTail(history, summary, history.at(-1)!.text, 6000, undefined, history.at(-1)!.id);
    const canon = renderCanon(store.listCanon(project.id)).text;
    expect(estimateTokens(tail)).toBeLessThanOrEqual(6000);
    expect(estimateTokens(tail) + estimateTokens(summary.summary) + estimateTokens(canon)).toBeLessThan(10000);
    expect(tail).toContain('trimmed, full text in archive');
    expect(tail).not.toContain('message-499');
    expect(tail.indexOf('message-497')).toBeLessThan(tail.indexOf('message-498'));
    expect(history.filter((message) => !message.metadata?.compacted)).toHaveLength(500);
    expect(store.searchHistory(project.id, 'Tailwind', 5)).toHaveLength(1);
  });

  it('keeps customized settings and reads old unstructured compactions', () => {
    const { db, store, project, agent } = fixture();
    const settings = store.getSettings();
    const raw = (autoCompact: object) => db.sqlite.prepare('UPDATE settings SET data=? WHERE id=1')
      .run(JSON.stringify({ ...settings, autoCompact }));
    raw(oldDefaults);
    expect(store.getSettings().autoCompact).toMatchObject({ maxMessages: 60, keepRecentMessages: 14, maxContextTokens: 24000 });
    raw({ ...oldDefaults, maxMessages: 41 });
    expect(store.getSettings().autoCompact).toMatchObject({ maxMessages: 41, keepRecentMessages: 6, maxContextTokens: 40000 });
    store.updateSettings({ autoCompact: oldDefaults });
    expect(store.getSettings().autoCompact).toMatchObject(oldDefaults);
    const old = { summary: '- [User] Older goal', compactedMessageCount: 1, lastCompactedMessageId: 'old', compactedAt: '2025-01-01' };
    store.updateAgent(agent.id, { contextCompactions: { [project.id]: old } });
    expect(buildAgentSystemPrompt(agent, project, [agent], [], [], [], [], old)).toContain('Older goal');
    expect(store.getAgent(agent.id)?.contextCompactions?.[project.id]).toEqual(old);
  });

  it('rotates a native session above its context limit and leaves another scope active', () => {
    const { store, project, agent } = fixture();
    store.updateAgent(agent.id, {
      sessionId: 'claude:project',
      sessions: { [project.id]: 'claude:project', direct: 'claude:direct' },
      scopeTokens: { [project.id]: 28000 },
    });
    for (const text of ['We use Tailwind', 'First result', 'Next step']) {
      store.createMessage({ agentId: agent.id, projectId: project.id, author: 'user', text });
    }
    const result = compactAgentScope(store, agent.id, project.id, { reason: 'auto' });
    expect(result.compacted).toBe(true);
    expect(result.agent?.sessions).toEqual({ direct: 'claude:direct' });
    expect(result.agent?.sessionId).toBeNull();
  });

  it('leaves the deterministic summary on provider error and timeout, and merges a successful result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { store, config, project, agent } = fixture();
    let outcome: 'error' | 'timeout' | 'success' = 'error';
    const summarizer = vi.fn(async (_provider, _model, _input, signal: AbortSignal) => {
      if (outcome === 'error') throw new Error('Mock provider unavailable');
      if (outcome === 'timeout') await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return JSON.stringify({ goal: 'Model goal', decisions: ['Keep model detail'], done: [], open: [], artifacts: [] });
    });
    const runtime = new AgentRuntime(store, config, {
      async run() { throw new Error('Unexpected foreground turn'); },
      summarize: summarizer,
    });
    const getSummary = () => store.getAgent(agent.id)?.contextCompactions?.[project.id]?.summary;
    const add = () => {
      for (const text of ['We use Tailwind', 'Build src/header.tsx', 'Next step']) {
        store.createMessage({ agentId: agent.id, projectId: project.id, author: 'user', text });
      }
      runtime.compact(agent.id, project.id);
    };
    try {
      add();
      await vi.advanceTimersByTimeAsync(1);
      expect(getSummary()).toContain('We use Tailwind');
      expect(summarizer).toHaveBeenCalledTimes(1);
      outcome = 'timeout';
      add();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getSummary()).not.toContain('Model goal');
      expect(summarizer.mock.calls[1]?.[3].aborted).toBe(true);
      outcome = 'success';
      add();
      await vi.advanceTimersByTimeAsync(1);
      expect(getSummary()).toContain('Model goal');
      expect(getSummary()).toContain('We use Tailwind');
    } finally {
      await runtime.shutdown();
    }
  });

  it('finds scoped history, caps recall output, and keeps the FTS index updated', () => {
    const { store, db, project, agent } = fixture();
    expect(db.hasMessageFts).toBe(true);
    const other = store.createProject({ name: 'Other' }).project;
    const relevant = store.createMessage({ projectId: project.id, agentId: agent.id, author: 'user', text: `Orbit color ${'x'.repeat(7000)}` });
    const foreign = store.createMessage({ projectId: other.id, agentId: agent.id, author: 'user', text: 'Orbit color foreign' });
    store.createMessage({ projectId: null, agentId: agent.id, author: 'user', text: 'Orbit color direct' });
    const streamed = store.createMessage({ projectId: project.id, agentId: agent.id, author: 'agent', text: 'Orbit color pending', streaming: true });
    expect(store.searchHistory(project.id, 'Orbit color', 5).map((row) => row.messageId)).toEqual([relevant.id]);
    store.finalizeMessage(streamed.id, { text: 'Orbit color finalized', streaming: false });
    expect(store.searchHistory(project.id, 'finalized', 5)[0]?.messageId).toBe(streamed.id);
    const tools = toolsFor(store, project.id, agent.id);
    expect(tools.memoryAction('get_message', { id: foreign.id })).toEqual({ found: false });
    expect(tools.memoryAction('get_message', { id: relevant.id })).toMatchObject({ text: relevant.text.slice(0, 6000), truncated: true });
    const asset = store.createArtifact({ projectId: project.id, kind: 'html', label: 'Mockup', mime: 'text/html' }, Buffer.from('x'.repeat(6500)));
    expect(tools.memoryAction('get_artifact', { id: asset.id })).toMatchObject({ content: 'x'.repeat(6000), truncated: true });
    expect(toolsFor(store, other.id, agent.id).memoryAction('get_artifact', { id: asset.id })).toEqual({ found: false });
    expect(store.searchHistory(project.id, 'Orbit color', 5).every((row) => row.snippet.length <= 300)).toBe(true);
    Object.defineProperty(db, 'hasMessageFts', { value: false });
    expect(store.searchHistory(project.id, 'Orbit color', 5).map((row) => row.messageId)).toEqual(
      expect.arrayContaining([relevant.id, streamed.id]),
    );
    expect(store.searchHistory(project.id, 'Orbit color foreign', 5)).toEqual([]);
  });

  it('continues a CLI-style provider turn with the result of an archive action', async () => {
    const { store, config, project, agent } = fixture();
    store.setProviderSecret('deepseek', 'fixture-key');
    const archived = store.createMessage({ projectId: project.id, agentId: agent.id, author: 'user', text: 'The compass engraving is NORTH-721.' });
    store.updateAgent(agent.id, { contextCompactions: { [project.id]: {
      summary: 'An earlier conversation was archived.',
      compactedMessageCount: 1, lastCompactedMessageId: archived.id, compactedAt: new Date().toISOString(),
    } } });
    const responses = [
      '<atelier-action>{"tool":"search_history","query":"compass engraving"}</atelier-action>',
      'The engraving is NORTH-721.',
    ];
    const mockFetch = vi.fn(async (_url, request: RequestInit) => {
      const index = mockFetch.mock.calls.length - 1;
      const { messages } = JSON.parse(String(request.body));
      const prompt = messages.at(-1).content;
      if (index === 0) expect(prompt).not.toContain('NORTH-721');
      if (index === 1) expect(prompt).toContain('NORTH-721');
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: responses[index] } }] })}\n\ndata: [DONE]\n\n`);
    });
    vi.stubGlobal('fetch', mockFetch);
    const result = await new CliAgentRunner(store, config, () => () => {}).run({
      agent: store.getAgent(agent.id)!, project, prompt: 'What did we engrave?',
      resumeSessionId: null, providerOverride: 'deepseek', modelOverride: 'deepseek-chat', signal: new AbortController().signal,
    }, { onText() {}, onTool() {}, onSession() {} });
    expect(result.finalText).toBe(responses[1]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('restores Canon, artifact bytes and searchable history to a fresh data directory', async () => {
    const source = fixture();
    const target = fixture();
    const { project, store, agent } = source;
    store.createMessage({ agentId: agent.id, projectId: project.id, text: 'Show a logo for the compass', author: 'user' });
    const message = store.createMessage({ agentId: agent.id, projectId: project.id, text: design, author: 'agent' });
    const { entry } = store.pickDesign(project.id, message, 'B');
    const bytes = new BackupService(source.db, store, source.config).exportBackup({}).bytes;
    await new BackupService(target.db, target.store, target.config).importBackup(bytes, null);
    const restored = target.store.getArtifact(entry.artifactId!)!;
    expect(target.store.listCanon(project.id)).toEqual([entry]);
    expect(target.store.readArtifact(restored).toString()).toBe(svgB);
    expect(fs.readFileSync(path.join(target.config.dataDir, restored.path), 'utf8')).toBe(svgB);
    expect(fs.readFileSync(path.join(getProjectRepoPath(target.config.workspacesDir, project.id), 'brand', 'logo.svg'), 'utf8')).toBe(svgB);
    expect(target.store.searchHistory(project.id, 'compass', 4)).toHaveLength(1);
  });

  it('opens pre-memory data and imports its backup with a rebuilt archive index', async () => {
    const source = fixture();
    const target = fixture();
    const { db, store, config, agent, project } = source;
    const message = store.createMessage({ projectId: project.id, agentId: agent.id, author: 'user', text: 'Legacy compass note' });
    db.sqlite.exec(`
      DROP TRIGGER messages_fts_insert;
      DROP TRIGGER messages_fts_update;
      DROP TRIGGER messages_fts_delete;
      DROP TABLE messages_fts;
      DROP TABLE canon;
      DROP TABLE artifacts;
    `);
    const backup = new BackupService(db, store, config).exportBackup({}).bytes;
    const reopened = new AtelierDb(config.dbPath);
    databases.push(reopened);
    const upgraded = new AtelierStore(reopened, config);
    await vi.waitFor(() => expect(upgraded.searchHistory(project.id, 'compass', 2)[0]?.messageId).toBe(message.id));
    expect(upgraded.listCanon(project.id)).toEqual([]);
    await new BackupService(target.db, target.store, target.config).importBackup(backup, null);
    expect(target.store.searchHistory(project.id, 'compass', 2)[0]?.messageId).toBe(message.id);
    expect(target.store.listArtifacts(project.id)).toEqual([]);
  });

  it('summarizes design options as artifact references and includes the recorded pick', () => {
    const make = (message: Partial<Message>) => ({ projectId: null, agentId: 'a', author: 'agent',
      streaming: false, durationMs: null, createdAt: '2026-01-01', ...message } as Message);
    const tail = formatUncompactedConversation([
      make({ id: 'design', text: design, metadata: { designArtifacts: { A: 'art_a', B: 'art_b' } } }),
      make({ id: 'pick', author: 'user', text: 'Pick B', metadata: { designPick: { messageId: 'design', optionId: 'B' } } }),
    ], null, 'Next step');
    expect(tail).toContain('B "Mono" (art_b). User picked: B');
    expect(tail).not.toContain(svgB);
  });
});
