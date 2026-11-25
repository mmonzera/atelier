import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const dbs: AtelierDb[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-agent-sessions-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'atelier.db');
  const db = new AtelierDb(dbPath);
  dbs.push(db);
  const store = new AtelierStore(db, loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath }));
  const { agents } = store.createProject({ name: 'P', starterAgents: [{ name: 'Solo', role: 'Dev' }] });
  return { store, agent: agents[0]! };
}

const say = (store: AtelierStore, agentId: string, text: string) =>
  store.createMessage({ projectId: null, agentId, author: 'user', text });

describe('Personal agent chat sessions', () => {
  it('adopts existing history as session 1, then keeps each named session apart', () => {
    const { store, agent } = makeStore();
    const dm = store.channels.getDmByAgent(agent.id)!;

    // History that predates sessions has no session id.
    const legacy = say(store, agent.id, 'old topic: pricing');
    expect(legacy.sessionId ?? null).toBeNull();
    expect(store.listAgentMessages(agent.id, null).map((m) => m.text)).toEqual(['old topic: pricing']);

    const started = store.channels.startNewDmSession(dm.id, { name: '  Landing copy  ' })!;
    expect(started.session).toMatchObject({ seq: 2, name: 'Landing copy', startedBy: 'user' });
    expect(started.channel.currentSessionId).toBe(started.session.id);

    const sessions = store.channels.listRoomSessions(dm.id);
    expect(sessions.map((s) => s.seq)).toEqual([1, 2]);
    expect(sessions[0]!.name).toBeUndefined();
    // The legacy message was adopted by session 1 (column and JSON).
    expect(store.getMessage(legacy.id)?.sessionId).toBe(sessions[0]!.id);

    const fresh = say(store, agent.id, 'new topic: hero headline');
    expect(fresh.sessionId).toBe(started.session.id);
    // Context only sees the active session.
    expect(store.listAgentMessages(agent.id, null).map((m) => m.text)).toEqual(['new topic: hero headline']);

    // Reopening session 1 swaps what the agent sees; nothing was lost.
    store.channels.activateDmSession(dm.id, sessions[0]!.id);
    expect(store.listAgentMessages(agent.id, null).map((m) => m.text)).toEqual(['old topic: pricing']);
    const afterSwitch = say(store, agent.id, 'back on pricing');
    expect(afterSwitch.sessionId).toBe(sessions[0]!.id);
  });

  it('renames sessions, clears names, and refuses sessions of another channel', () => {
    const { store, agent } = makeStore();
    const dm = store.channels.getDmByAgent(agent.id)!;
    const { session } = store.channels.startNewDmSession(dm.id, {})!;
    expect(session.name).toBeUndefined();

    expect(store.channels.renameSession(session.id, 'Brand voice')?.name).toBe('Brand voice');
    expect(store.channels.listRoomSessions(dm.id).at(-1)?.name).toBe('Brand voice');
    expect(store.channels.renameSession(session.id, '   ')?.name).toBeUndefined();

    const room = store.channels.listChannels().find((c) => c.kind === 'room')!;
    expect(store.channels.activateDmSession(room.id, session.id)).toBeNull();
    expect(store.channels.startNewDmSession(room.id, {})).toBeNull();
  });

  it('leaves project-scoped agent history untouched', () => {
    const { store, agent } = makeStore();
    const dm = store.channels.getDmByAgent(agent.id)!;
    const inProject = store.createProject({ name: 'Q', starterAgents: [{ name: 'Other', role: 'Dev' }] });
    const other = inProject.agents[0]!;
    store.createMessage({ projectId: inProject.project.id, agentId: other.id, author: 'agent', text: 'project reply' });
    store.channels.startNewDmSession(store.channels.getDmByAgent(other.id)!.id, { name: 'x' });
    expect(store.listAgentMessages(other.id, inProject.project.id).map((m) => m.text)).toEqual(['project reply']);
    expect(dm.currentSessionId).toBeNull();
  });
});
