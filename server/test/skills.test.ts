import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSkill } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { INLINE_SKILL_MAX_CHARS, buildAgentSystemPrompt } from '../src/agents/prompts.js';
import type { AgentRunner, Turn } from '../src/agents/runner.js';
import { applyAtelierActions } from '../src/agents/cli-runners.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

const handles: AtelierServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const short: AgentSkill = { id: 'skill_short', name: 'Short Rules', description: 'Tiny', content: 'Always be brief.', enabled: true };
const longBody = `# Brand Voice\n${'Write warmly and plainly. '.repeat(60)}SECRET-LONG-MARKER`;
const long: AgentSkill = { id: 'skill_long', name: 'Brand Voice', description: 'Tone guidelines', content: longBody, enabled: true };
const off: AgentSkill = { id: 'skill_off', name: 'Disabled One', description: 'Off', content: `${longBody} OFF`, enabled: false };

async function boot(runner?: AgentRunner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-skills-'));
  dirs.push(dir);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
    },
    customRunner: runner,
  });
  handles.push(handle);
  const { project, agents } = handle.store.createProject({ name: 'Skills', starterAgents: [{ name: 'Bot', role: 'Writer' }] });
  const agent = handle.store.updateAgentConfig(agents[0]!.id, { skills: [short, long, off] })!;
  return { handle, base: `http://127.0.0.1:${handle.port}`, project, agent };
}

describe('skills: load on demand', () => {
  it('inlines short skills and lists long ones by name instead of embedding them', async () => {
    const { project, agent } = await boot();
    expect(long.content.length).toBeGreaterThan(INLINE_SKILL_MAX_CHARS);
    const prompt = buildAgentSystemPrompt(agent, project, [agent], [], []);
    expect(prompt).toContain('Always be brief.'); // short: inline
    expect(prompt).not.toContain('SECRET-LONG-MARKER'); // long: not embedded
    expect(prompt).toMatch(/- skill_long — Brand Voice: Tone guidelines/);
    expect(prompt).toContain('get_skill');
    expect(prompt).not.toContain('Disabled One'); // disabled skills are not offered
  });

  it('get_skill returns the full text of an enabled skill and nothing else', async () => {
    const { handle, project, agent } = await boot();
    const tools = createStudioTools({ store: handle.store, projectId: project.id, actingAgentId: agent.id, enqueue: () => undefined });
    expect(tools.memoryAction('get_skill', { id: 'skill_long' })).toMatchObject({ found: true, name: 'Brand Voice' });
    expect((tools.memoryAction('get_skill', { id: 'skill_long' }) as { content: string }).content).toContain('SECRET-LONG-MARKER');
    expect(tools.memoryAction('get_skill', { id: 'Brand Voice' })).toMatchObject({ found: true, id: 'skill_long' }); // by name
    expect(tools.memoryAction('get_skill', { id: 'skill_off' })).toEqual({ found: false });
    expect(tools.memoryAction('get_skill', { id: 'nope' })).toEqual({ found: false });

    // CLI runners reach it through an atelier-action and feed the result back as a recall round.
    const calls: string[] = [];
    const result = applyAtelierActions(
      'Reading it. <atelier-action>{"tool":"get_skill","id":"skill_long"}</atelier-action>',
      tools,
      { onTool: (name) => calls.push(name) },
    );
    expect(calls).toEqual(['atelier.get_skill']);
    expect(result.cleanText).toBe('Reading it.');
    expect(result.recall).toHaveLength(1);
    expect(JSON.stringify(result.recall[0]!.result)).toContain('SECRET-LONG-MARKER');
  });
});

describe('skills: invoked with /skill', () => {
  it('puts the chosen skill in that turn only, keeps the bubble text plain, and rejects unknown skills', async () => {
    const turns: Turn[] = [];
    const runner: AgentRunner = {
      async run(turn, cb) {
        turns.push(turn);
        cb.onText('ok');
        return { finalText: 'ok' };
      },
    };
    const { handle, base, project, agent } = await boot(runner);
    const send = (body: unknown) =>
      fetch(`${base}/api/agents/${agent.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const waitFor = async (count: number) => {
      const started = Date.now();
      while (turns.length < count && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 40));
    };

    expect((await send({ text: 'tulis tagline', projectId: project.id, skillIds: ['skill_nope'] })).status).toBe(404);

    // a disabled skill can still be invoked by hand
    expect((await send({ text: 'tulis tagline', projectId: project.id, skillIds: ['skill_long', 'skill_off'] })).status).toBe(202);
    await waitFor(1);
    expect(turns[0]!.prompt).toContain('SECRET-LONG-MARKER');
    expect(turns[0]!.prompt).toContain('## Skill: Disabled One');
    expect(turns[0]!.prompt).toContain('User message:\ntulis tagline');

    const user = handle.store.listAgentMessages(agent.id, project.id).find((m) => m.author === 'user')!;
    expect(user.text).toBe('tulis tagline'); // bubble shows only what the user typed
    expect(user.metadata?.skills).toEqual([{ id: 'skill_long', name: 'Brand Voice' }, { id: 'skill_off', name: 'Disabled One' }]);

    // the next message without /skill does not carry it
    await new Promise((r) => setTimeout(r, 250));
    expect((await send({ text: 'lanjut', projectId: project.id })).status).toBe(202);
    await waitFor(2);
    expect(turns[1]!.prompt).not.toContain('SECRET-LONG-MARKER');
  });
});
