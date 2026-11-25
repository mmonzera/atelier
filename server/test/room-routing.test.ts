import type { Agent, Channel, Task } from '@atelier/contracts';
import { describe, expect, it } from 'vitest';
import { routeRoomMessage } from '../src/channels/router.js';

const channel: Channel = {
  id: 'chn_room',
  projectId: 'prj_1',
  kind: 'room',
  agentId: null,
  name: 'Landing',
  defaultResponderAgentId: 'agt_cos',
  currentSessionId: 'ses_1',
  createdAt: '2026-11-25T00:00:00.000Z',
};

const makeAgent = (id: string, name: string, role: string): Agent => ({
  id,
  projectId: 'prj_1',
  name,
  role,
  color: 'blue',
  systemInstructions: '',
  skills: [],
  allowShell: false,
  status: 'idle',
  currentTask: null,
  sessionId: null,
  queueLength: 0,
  lastError: null,
  tokenUsage: { input: 0, output: 0 },
  createdAt: '2026-11-25T00:00:00.000Z',
  updatedAt: '2026-11-25T00:00:00.000Z',
});

const agents: Agent[] = [
  makeAgent('agt_cos', 'Chief of Staff', 'Chief of Staff'),
  makeAgent('agt_b', 'Builder', 'Frontend'),
  makeAgent('agt_q', 'QA', 'Quality'),
  makeAgent('agt_w', 'Writer', 'Copywriting'),
  makeAgent('agt_s', 'SEO', 'Marketing'),
];

const tasks: Task[] = [
  {
    id: 'tsk_1',
    identifier: 'AT-11',
    projectId: 'prj_1',
    title: 'Build hero',
    description: '',
    status: 'todo',
    priority: 'high',
    assigneeAgentId: 'agt_b',
    branch: null,
    prUrl: null,
    deliverableSummary: null,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
  },
];

describe('RoomRouter deterministic rules (§4.3 + §10.5)', () => {
  it('1. routes explicit @Agent mentions (up to 5) and ignores non-project / self-mentions', () => {
    const res = routeRoomMessage(
      { author: 'user', agentId: null, text: '@Builder @QA check this' },
      {
        channel,
        projectAgents: agents,
        tasks,
        explicitMentionAgentIds: ['agt_b', 'agt_q', 'agt_outsider'],
      },
    );
    expect(res.targetAgentIds).toEqual(['agt_b', 'agt_q']);
    expect(res.reason).toBe('explicit-mention');

    // Agent self-mention is ignored
    const selfRes = routeRoomMessage(
      { author: 'agent', agentId: 'agt_b', text: '@Builder note to self' },
      { channel, projectAgents: agents, tasks },
    );
    expect(selfRes.targetAgentIds).toEqual([]);
  });

  it('2. routes @all / @semua for user messages capped at maxFanout, ignored for agents', () => {
    const userAll = routeRoomMessage(
      { author: 'user', agentId: null, text: '@all status check please' },
      { channel, projectAgents: agents, tasks, maxFanout: 4 },
    );
    expect(userAll.targetAgentIds).toHaveLength(4);
    expect(userAll.reason).toBe('all-mention');

    const agentAll = routeRoomMessage(
      { author: 'agent', agentId: 'agt_b', text: '@all stop everything' },
      { channel, projectAgents: agents, tasks },
    );
    expect(agentAll.targetAgentIds).toEqual([]);
    expect(agentAll.reason).toBe('agent-fyi-none');
  });

  it('3. routes replyToMessage pointing to an agent back to that agent', () => {
    const res = routeRoomMessage(
      { author: 'user', agentId: null, text: 'Looks good, ship it' },
      {
        channel,
        projectAgents: agents,
        tasks,
        replyToMessage: {
          id: 'msg_1',
          projectId: 'prj_1',
          agentId: 'agt_w',
          author: 'agent',
          text: 'Draft ready',
          streaming: false,
          durationMs: 100,
          createdAt: '2026-11-25T00:00:00.000Z',
        },
      },
    );
    expect(res.targetAgentIds).toEqual(['agt_w']);
    expect(res.reason).toBe('reply-to-agent');
  });

  it('4. treats agent messages without mention as FYI only (no triggers)', () => {
    const res = routeRoomMessage(
      { author: 'agent', agentId: 'agt_b', text: 'Finished AT-11, build passed.' },
      { channel, projectAgents: agents, tasks },
    );
    expect(res.targetAgentIds).toEqual([]);
    expect(res.reason).toBe('agent-fyi-none');
  });

  it('5. fast-routes user message mentioning task identifier AT-11 to its assignee', () => {
    const res = routeRoomMessage(
      { author: 'user', agentId: null, text: 'Can you update AT-11 status?' },
      { channel, projectAgents: agents, tasks },
    );
    expect(res.targetAgentIds).toEqual(['agt_b']);
    expect(res.reason).toBe('task-identifier');
  });

  it('6. fast-routes user message containing exact agent name without @', () => {
    const res = routeRoomMessage(
      { author: 'user', agentId: null, text: 'Writer please polish the hero copy' },
      { channel, projectAgents: agents, tasks },
    );
    expect(res.targetAgentIds).toEqual(['agt_w']);
    expect(res.reason).toBe('name-match');
  });

  it('7. falls back to defaultResponderAgentId (Chief of Staff) in dispatch mode', () => {
    const res = routeRoomMessage(
      { author: 'user', agentId: null, text: 'What should we focus on next?' },
      { channel, projectAgents: agents, tasks },
    );
    expect(res.targetAgentIds).toEqual(['agt_cos']);
    expect(res.reason).toBe('default-responder');
    expect(res.turnPurpose).toBe('dispatch');
  });
});
