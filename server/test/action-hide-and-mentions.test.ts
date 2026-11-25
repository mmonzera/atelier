import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMessageSegments, stripAtelierActions } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionTagStreamFilter } from '../src/agents/action-stream-filter.js';
import { startAtelierServer } from '../src/index.js';

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
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Hiding <atelier-action> blocks from UI and streaming', () => {
  it('strips complete and unclosed <atelier-action> blocks while preserving text and design blocks', () => {
    const raw = [
      'Sudah saya delegasikan ke tim.',
      '<atelier-action>{"tool":"message_agent","targetAgentId":"agt_1","message":"Audit file"}</atelier-action>',
      '<atelier-action>{"tool":"message_agent","targetAgentId":"agt_2","message":"Kerjakan AT-14"}</atelier-action>',
      'Silakan cek hasilnya nanti.',
    ].join('\n');

    expect(stripAtelierActions(raw)).toBe(
      'Sudah saya delegasikan ke tim.\n\nSilakan cek hasilnya nanti.',
    );

    const streamingRaw =
      'Sebentar ya.\n<atelier-action>{"tool":"message_agent","targetAgentId":"agt_1"';
    expect(stripAtelierActions(streamingRaw, { streaming: true })).toBe('Sebentar ya.');
    expect(parseMessageSegments(streamingRaw)).toEqual([{ type: 'text', text: 'Sebentar ya.' }]);
  });

  it('buffers and drops <atelier-action> across arbitrary streaming chunks', () => {
    const chunks: string[] = [];
    const filter = createActionTagStreamFilter((delta) => chunks.push(delta));

    const input =
      'Checking <div>tag</div> first.\n<atelier-action>{"tool":"message_agent","message":"hi"}</atelier-action>\nAll done!';
    for (let i = 0; i < input.length; i += 3) {
      filter.push(input.slice(i, i + 3));
    }
    filter.flush();

    expect(chunks.join('')).toBe('Checking <div>tag</div> first.\n\nAll done!');
  });

  it('never leaks <atelier-action> into live or finalized chat messages in AgentRuntime', async () => {
    const dir = makeTempDir('atelier-hide-action-');
    const observedStreamTexts: string[] = [];
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: () => ({
        async run(_turn, cb) {
          cb.onText('Oke, ');
          cb.onText('<at');
          cb.onText('elier-action>{"tool":"message_agent","targetAgentId":"agt_x","message":"secret"}</atelier-');
          cb.onText('action>');
          cb.onText('sudah saya teruskan.');
          return {
            finalText:
              'Oke, <atelier-action>{"tool":"message_agent","targetAgentId":"agt_x","message":"secret"}</atelier-action>sudah saya teruskan.',
          };
        },
      }),
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Hide Action Project',
          starterAgents: [{ name: 'Lead', role: 'Coordinator' }],
        }),
      });
      const { project, agents } = (await projRes.json()) as {
        project: { id: string };
        agents: Array<{ id: string }>;
      };

      const unsub = handle.bus.onEvent((ev) => {
        if (ev.type === 'message-delta') {
          observedStreamTexts.push(ev.payload.delta);
        }
      });

      const sendRes = await fetch(`${baseUrl}/api/agents/${agents[0]!.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Tolong koordinasi', projectId: project.id }),
      });
      expect(sendRes.status).toBe(202);

      const reply = await waitFor(() => {
        const msgs = handle.store.listAgentMessages(agents[0]!.id, project.id);
        return msgs.find((m) => m.author === 'agent' && !m.streaming);
      });

      unsub();
      expect(observedStreamTexts.join('')).not.toContain('atelier-action');
      expect(observedStreamTexts.join('')).not.toContain('message_agent');
      expect(reply.text).toBe('Oke, sudah saya teruskan.');
    } finally {
      await handle.close();
    }
  });
});

describe('Project chat @agent mentions', () => {
  it('dispatches a message to single or multiple mentioned project agents and validates membership', async () => {
    const dir = makeTempDir('atelier-mentions-');
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: dir,
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
      customRunnerFactory: () => ({
        async run(turn, cb) {
          const text = `${turn.agent.name} got: ${turn.prompt}`;
          cb.onText(text);
          return { finalText: text };
        },
      }),
    });

    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };

    try {
      const projRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Mention Project',
          starterAgents: [
            { name: 'Lead', role: 'PM' },
            { name: 'Writer', role: 'Copywriting' },
            { name: 'Frontend', role: 'UI' },
          ],
        }),
      });
      const { project, agents } = (await projRes.json()) as {
        project: { id: string };
        agents: Array<{ id: string; name: string }>;
      };
      const lead = agents.find((a) => a.name === 'Lead')!;
      const writer = agents.find((a) => a.name === 'Writer')!;
      const frontend = agents.find((a) => a.name === 'Frontend')!;

      const outsiderRes = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Outsider', role: 'Other', color: 'amber' }),
      });
      const { agent: outsider } = (await outsiderRes.json()) as { agent: { id: string } };

      // 1. Unknown agent ID -> 404
      const missingRes = await fetch(`${baseUrl}/api/agents/${lead.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: '@Ghost hello',
          projectId: project.id,
          mentionAgentIds: ['agt_does_not_exist'],
        }),
      });
      expect(missingRes.status).toBe(404);

      // 2. Agent outside project -> 400
      const outsiderSend = await fetch(`${baseUrl}/api/agents/${lead.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: '@Outsider hello',
          projectId: project.id,
          mentionAgentIds: [outsider.id],
        }),
      });
      expect(outsiderSend.status).toBe(400);

      // 3. Multi-agent @mention in project chat dispatches to both Writer and Frontend
      const multiRes = await fetch(`${baseUrl}/api/agents/${lead.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: '@Writer @Frontend audit AT-12 and AT-14',
          projectId: project.id,
          mentionAgentIds: [writer.id, frontend.id],
        }),
      });
      expect(multiRes.status).toBe(202);
      const multiBody = (await multiRes.json()) as {
        ok: boolean;
        agentId: string;
        dispatchedAgentIds?: string[];
      };
      expect(multiBody.ok).toBe(true);
      expect(multiBody.dispatchedAgentIds).toEqual([writer.id, frontend.id]);

      await waitFor(() => {
        const wMsgs = handle.store.listAgentMessages(writer.id, project.id);
        const fMsgs = handle.store.listAgentMessages(frontend.id, project.id);
        const wDone = wMsgs.some((m) => m.author === 'agent' && !m.streaming && m.text.includes('Writer got:'));
        const fDone = fMsgs.some((m) => m.author === 'agent' && !m.streaming && m.text.includes('Frontend got:'));
        return wDone && fDone;
      });

      // Lead should NOT have received the message because only Writer and Frontend were mentioned.
      const leadMsgs = handle.store.listAgentMessages(lead.id, project.id);
      expect(leadMsgs).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
