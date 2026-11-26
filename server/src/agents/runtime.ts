import { createHash } from 'node:crypto';
import {
  type Agent,
  type AgentSkill,
  type Channel,
  type Message,
  type MessageActivitySummary,
  type MessageAttachment,
  type MessageMetadata,
  type ModelProvider,
  type ModelRef,
  type PendingFallbackOffer,
  type QueueItem,
  type QueueKind,
  type RoomQueueSnapshot,
  type RoomSession,
  type Task,
  stripAtelierActions,
} from '@atelier/contracts';
import { AttachmentStore } from '../attachments.js';
import type { BrowserManager } from '../browser/manager.js';
import { RoomContextBuilder } from '../channels/context.js';
import { LoopGuard } from '../channels/loop-guard.js';
import { routeRoomMessage } from '../channels/router.js';
import { RoomScheduler, type LeaseReleaseReason, type RoomLease } from '../channels/scheduler.js';
import type { AppConfig } from '../config.js';
import type { AtelierStore } from '../store.js';
import { createActionTagStreamFilter } from './action-stream-filter.js';
import { CliAgentRunner } from './cli-runners.js';
import {
  type CompactScopeResult,
  type CompactTrigger,
  autoCompactTrigger,
  buildDeterministicSummary,
  compactAgentScope,
  compactChannelScope,
  estimateActiveContextTokens,
  estimateConversationTokens,
  estimateTokens,
  getScopeKey,
  mergeModelMemory,
  renderStructuredMemory,
} from './compactor.js';
import {
  type CooldownEntry,
  ProviderCooldownTracker,
  classifyTurnError,
  resolveFallbackCandidates,
} from './fallback.js';
import type { AgentRunner } from './runner.js';
import type { EnqueueTaskFn } from './studio-tools.js';
import { estimateTurnCostUsd } from './usage.js';
import { renderCanon, SELECTIVE_MEMORY_PROMPT } from './prompts.js';
import { selectMemory, type SelectResult } from '../memory/selector.js';
import { memoryOwners } from '../memory/owners.js';

const MAX_RESUMED_PROVIDER_CONTEXT_TOKENS =
  Number(process.env.ATELIER_MAX_SESSION_TOKENS) > 0
    ? Number(process.env.ATELIER_MAX_SESSION_TOKENS)
    : 45_000;

export class AgentRuntime {
  private readonly draining = new Set<string>();
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly activeTurns = new Map<string, Promise<void>>();
  private readonly memorySummaries = new Map<string, AbortController>();
  private readonly cooldowns = new ProviderCooldownTracker();
  public readonly scheduler: RoomScheduler;
  public readonly loopGuard: LoopGuard;
  private shuttingDown = false;
  private readonly runner: AgentRunner;
  private readonly attachmentStore: AttachmentStore;
  private readonly browserManager?: BrowserManager;

  constructor(
    private readonly store: AtelierStore,
    config: AppConfig,
    customRunner?: AgentRunner,
    customRunnerFactory?: (deps: { store: AtelierStore; enqueue: EnqueueTaskFn }) => AgentRunner,
    browserManager?: BrowserManager,
    schedulerOpts?: { idleTimeoutMin?: number; maxTurnMin?: number; sweepIntervalMs?: number },
  ) {
    this.browserManager = browserManager;
    this.attachmentStore = new AttachmentStore(config.dataDir);
    this.loopGuard = new LoopGuard(store.sqlite);
    const roomCfg = store.getSettings().room;
    this.scheduler = new RoomScheduler({
      idleTimeoutMin: schedulerOpts?.idleTimeoutMin ?? roomCfg?.idleTimeoutMin ?? 10,
      maxTurnMin: schedulerOpts?.maxTurnMin ?? roomCfg?.maxTurnMin ?? 45,
      sweepIntervalMs: schedulerOpts?.sweepIntervalMs ?? 15_000,
      onTimeout: (lease, reason) => {
        this.handleLeaseTimeout(lease, reason);
      },
    });
    const getEnqueue = () => this.enqueue.bind(this);
    this.runner =
      customRunner ??
      customRunnerFactory?.({ store, enqueue: this.enqueue.bind(this) }) ??
      new CliAgentRunner(store, config, getEnqueue, browserManager);
  }

  private handleLeaseTimeout(lease: RoomLease, reason: 'idle_timeout' | 'hard_timeout'): void {
    const channel = this.store.channels.getChannel(lease.channelId);
    const agent = this.store.getAgent(lease.agentId);
    if (channel && agent) {
      this.store.channels.postMessage({
        channelId: channel.id,
        author: 'system',
        agentId: null,
        text:
          reason === 'idle_timeout'
            ? `${agent.name} timed out after inactivity; lock released.`
            : `${agent.name} reached the maximum turn duration; lock released.`,
        metadata: {
          event: {
            kind: 'turn_skipped',
            agentId: agent.id,
            agentName: agent.name,
            reason,
          },
        },
      });
    }
    this.scheduler.release(lease.channelId, reason, lease.queueItemId);
    this.emitRoomQueue(lease.channelId);
    this.kickNextInChannel(lease.channelId);
  }

  public getRoomQueueSnapshot(channelId: string): RoomQueueSnapshot {
    const channel = this.store.channels.getChannel(channelId);
    const tasks = channel?.projectId ? this.store.listProjectTasks(channel.projectId) : [];
    return this.scheduler.snapshot(channelId, this.store.listAllQueuedItems(channelId), tasks);
  }

  private emitRoomQueue(channelId: string): void {
    this.store.emitEvent({
      type: 'room-queue-updated',
      payload: this.getRoomQueueSnapshot(channelId),
    });
  }

  /** Queued room items whose chain budget still allows them to run (§10.9). */
  private runnableRoomItems(channelId: string): QueueItem[] {
    return this.store.listAllQueuedItems(channelId).filter((q) => {
      if (!q.rootMessageId) return true;
      const chain = this.loopGuard.getChain(q.rootMessageId);
      if (!chain) return true;
      return (
        chain.status === 'active' &&
        chain.turnsUsed < chain.maxTurns &&
        chain.tokensUsed < chain.maxTokens
      );
    });
  }

  private kickNextInChannel(channelId: string): void {
    if (this.shuttingDown) return;
    const channel = this.store.channels.getChannel(channelId);
    if (!channel || channel.kind !== 'room') return;
    if (!channel.settings?.parallel && this.scheduler.getLease(channelId)) return;
    const queued = this.runnableRoomItems(channelId);
    const tasks = channel.projectId ? this.store.listProjectTasks(channel.projectId) : [];
    const next = this.scheduler.pickNext(queued, tasks);
    if (next) {
      void this.drain(next.agentId);
    }
  }

  public postToChannel(
    channelId: string,
    input: {
      text: string;
      mentionAgentIds?: string[];
      attachments?: MessageAttachment[];
      skillsByAgent?: Map<string, Array<Pick<AgentSkill, 'id' | 'name' | 'content'>>>;
      skills?: Array<Pick<AgentSkill, 'id' | 'name' | 'content'>>;
      replyToMessageId?: string;
    },
  ): { message: Message; dispatchedAgentIds: string[]; queueItemId: string | null } {
    const channel = this.store.channels.getChannel(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (channel.kind === 'dm') {
      if (!channel.agentId) {
        throw new Error(`DM channel ${channelId} has no target agent.`);
      }
      const { agent, item } = this.enqueue({
        agentId: channel.agentId,
        projectId: null,
        channelId: channel.id,
        kind: 'user',
        prompt: input.text,
        attachments: input.attachments,
        skills: input.skills,
        metadata: input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : undefined,
      });
      const msg = item.refId ? this.store.getMessage(item.refId) : null;
      return {
        message:
          msg ??
          this.store.channels.postMessage({
            channelId: channel.id,
            author: 'user',
            agentId: null,
            text: input.text,
          }).message,
        dispatchedAgentIds: [agent.id],
        queueItemId: item.id,
      };
    }

    const projectId = channel.projectId!;
    const projectAgents = this.store.listProjectAgents(projectId);
    const tasks = this.store.listProjectTasks(projectId);
    const replyToMessage = input.replyToMessageId
      ? this.store.getMessage(input.replyToMessageId)
      : null;

    const routed = routeRoomMessage(
      { author: 'user', agentId: null, text: input.text },
      {
        channel,
        projectAgents,
        tasks,
        replyToMessage,
        explicitMentionAgentIds: input.mentionAgentIds,
      },
    );

    const { message: posted, rowid } = this.store.channels.postMessage({
      channelId: channel.id,
      author: 'user',
      agentId: null,
      text: input.text,
      metadata: {
        ...(routed.targetAgentIds.length ? { mentions: routed.targetAgentIds, toAgentIds: routed.targetAgentIds } : {}),
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.skills?.length ? { skills: input.skills.map(({ id, name }) => ({ id, name })) } : {}),
      },
    });

    const roomSettings = { ...(this.store.getSettings().room ?? {}), ...(channel.settings ?? {}) };
    this.loopGuard.ensureChain(posted.id, channel.id, {
      maxTurns: roomSettings.maxTurnsPerChain,
      maxTokens: roomSettings.maxTokensPerChain,
    });

    let firstQueueId: string | null = null;
    const dispatchedAgentIds: string[] = [];
    for (let idx = 0; idx < routed.targetAgentIds.length; idx += 1) {
      const targetId = routed.targetAgentIds[idx]!;
      const targetAgent = this.store.getAgent(targetId);
      if (!targetAgent) continue;

      const skills = input.skillsByAgent?.get(targetId) ?? (idx === 0 ? input.skills : undefined);
      const basePrompt = this.promptWithAttachments(input.text, input.attachments);
      const finalPrompt = this.promptWithSkills(basePrompt, skills);

      const { item } = this.store.enqueueItem({
        agentId: targetId,
        projectId,
        channelId: channel.id,
        triggerMessageId: posted.id,
        triggerRowid: rowid,
        mentionIndex: idx,
        trust: 'user',
        priority: 'normal',
        rootMessageId: posted.id,
        hop: 0,
        turnPurpose: routed.turnPurpose,
        kind: 'user',
        prompt: finalPrompt,
        refId: posted.id,
      });
      if (!firstQueueId) firstQueueId = item.id;
      dispatchedAgentIds.push(targetId);

      if (targetAgent.status === 'error') {
        this.store.updateAgent(targetId, { lastError: null });
      }
    }

    this.emitRoomQueue(channel.id);
    this.kickNextInChannel(channel.id);

    return {
      message: posted,
      dispatchedAgentIds,
      queueItemId: firstQueueId,
    };
  }

  public skipRoomTurn(channelId: string): { skipped: boolean; agentId: string | null } {
    const lease = this.scheduler.skip(channelId);
    if (!lease) return { skipped: false, agentId: null };
    const agt = this.store.getAgent(lease.agentId);
    const channel = this.store.channels.getChannel(channelId);
    if (channel && agt) {
      this.store.channels.postMessage({
        channelId,
        author: 'system',
        agentId: null,
        text: `Skipped ${agt.name}'s turn.`,
        metadata: {
          event: {
            kind: 'turn_skipped',
            agentId: agt.id,
            agentName: agt.name,
            reason: 'user_skipped',
          },
        },
      });
    }
    return { skipped: true, agentId: lease.agentId };
  }

  public async stopRoom(channelId: string): Promise<{ stopped: boolean }> {
    const lease = this.scheduler.getLease(channelId);
    this.store.clearChannelQueue(channelId);
    if (lease) {
      await this.stop(lease.agentId);
    }
    this.scheduler.release(channelId, 'stopped');
    this.emitRoomQueue(channelId);
    return { stopped: Boolean(lease) };
  }

  /**
   * "Izinkan sekali": the user approves a sensitive command a teammate-triggered turn was denied.
   * Marks the approval card as approved and posts a user message (trust `user`) that re-runs the
   * request for that agent.
   */
  public approveRoomAction(
    channelId: string,
    approvalMessageId: string,
  ): { ok: boolean; reason?: 'not_found' | 'not_approval' | 'already_approved' | 'agent_missing' } {
    const channel = this.store.channels.getChannel(channelId);
    const msg = this.store.getMessage(approvalMessageId);
    if (!channel || channel.kind !== 'room' || !msg || msg.channelId !== channelId) {
      return { ok: false, reason: 'not_found' };
    }
    const req = msg.metadata?.approvalRequest;
    if (msg.author !== 'system' || !req) return { ok: false, reason: 'not_approval' };
    if (req.approved) return { ok: false, reason: 'already_approved' };
    const agent = req.agentId ? this.store.getAgent(req.agentId) : null;
    if (!agent) return { ok: false, reason: 'agent_missing' };

    this.store.finalizeMessage(msg.id, {
      streaming: false,
      metadata: { ...msg.metadata, approvalRequest: { ...req, approved: true } },
    });
    this.postToChannel(channelId, {
      text: `Approved (one time): you may run \`${req.command}\` now. Continue the work you were doing.`,
      mentionAgentIds: [agent.id],
      replyToMessageId: msg.id,
    });
    return { ok: true };
  }

  public continueRoomChain(channelId: string, rootMessageId: string, extraTurns = 6): boolean {
    const updated = this.loopGuard.continueChain(rootMessageId, extraTurns);
    if (!updated) return false;
    this.kickNextInChannel(channelId);
    return true;
  }

  public startNewRoomSession(
    channelId: string,
    carryover: 'summary' | 'clean' = 'summary',
  ): { session: RoomSession; channel: Channel } | null {
    const channel = this.store.channels.getChannel(channelId);
    if (!channel || channel.kind !== 'room') return null;

    const currentMsgs = this.store.channels
      .listChannelMessagesWithRowids(channelId, { sessionId: channel.currentSessionId })
      .map((r) => r.message)
      .filter((m) => !m.streaming && !m.metadata?.compacted && m.text.trim().length > 0);

    let deterministicSummary: string | null = null;
    if (carryover === 'summary') {
      const parts: string[] = [];
      if (currentMsgs.length > 0) {
        parts.push(buildDeterministicSummary(channel.compaction?.summary, currentMsgs.slice(-60)));
      }
      if (channel.projectId) {
        const openTasks = this.store
          .listProjectTasks(channel.projectId)
          .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
          .slice(0, 8);
        if (openTasks.length > 0) {
          parts.push(
            `Open tasks: ${openTasks.map((t) => `${t.identifier} [${t.status}] ${t.title}`).join('; ')}`,
          );
        }
      }
      deterministicSummary = parts.join('\n\n').slice(0, 1600) || null;
    }

    const res = this.store.channels.startNewSession(channelId, {
      carryover,
      carryoverSummary: deterministicSummary,
      startedBy: 'user',
    });
    if (!res) return null;

    // Clear provider session ids for project agents on this channel
    if (channel.projectId) {
      for (const agt of this.store.listProjectAgents(channel.projectId)) {
        if (agt.sessions?.[channelId]) {
          const nextSessions = { ...agt.sessions };
          delete nextSessions[channelId];
          this.store.updateAgent(agt.id, { sessions: nextSessions });
        }
      }
    }

    // Refine carryover summary in the background with a 20s timeout (§10.12)
    if (carryover === 'summary' && currentMsgs.length >= 2 && this.runner.summarize) {
      const settings = this.store.getSettings();
      const input = JSON.stringify({
        previous: channel.compaction?.summary?.slice(0, 2000),
        messages: currentMsgs.slice(-40).map((m) => ({
          id: m.id,
          author: m.author,
          text: m.text.slice(0, 400),
        })),
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      timer.unref();
      void Promise.resolve()
        .then(async () => {
          const out = await this.runner.summarize!(
            settings.provider,
            settings.autoCompact.summarizerModel,
            input,
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          const trimmed = out.trim().slice(0, 1600);
          if (trimmed) {
            this.store.channels.updateSessionCarryover(res.session.id, trimmed);
          }
        })
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
    }

    return { session: res.session, channel: res.channel };
  }

  /** Drops the agent's provider session, compaction and token state for its personal-chat scope. */
  private resetDirectScope(agentId: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    const without = <T>(map: Record<string, T> | undefined): Record<string, T> => {
      const { direct: _dropped, ...rest } = map ?? {};
      return rest;
    };
    this.store.updateAgent(agentId, {
      sessions: without(agent.sessions),
      sessionCanon: without(agent.sessionCanon),
      sessionMemorySent: without(agent.sessionMemorySent),
      contextCompactions: without(agent.contextCompactions),
      scopeTokens: without(agent.scopeTokens),
    });
  }

  /** Starts a named, clean session in an agent's personal chat. Null when busy-guarded or unknown. */
  public startNewDmSession(
    agentId: string,
    name?: string | null,
  ): { session: RoomSession; channel: Channel } | 'busy' | null {
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    if (agent.status === 'working') return 'busy';
    const dm = this.store.channels.ensureDm(agent.id, agent.name);
    const res = this.store.channels.startNewDmSession(dm.id, { name });
    if (res) this.resetDirectScope(agentId);
    return res;
  }

  /** Reopens an earlier session of an agent's personal chat. */
  public activateDmSession(
    agentId: string,
    sessionId: string,
  ): { channel: Channel } | 'busy' | null {
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    if (agent.status === 'working') return 'busy';
    const dm = this.store.channels.getDmByAgent(agentId);
    if (!dm) return null;
    const channel = this.store.channels.activateDmSession(dm.id, sessionId);
    if (!channel) return null;
    this.resetDirectScope(agentId);
    return { channel };
  }

  public dispatchTask(taskId: string): { task: Task; agent: Agent } {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (!task.assigneeAgentId) {
      throw new Error(`Task ${task.identifier} has no assigned agent.`);
    }
    const agent = this.store.getAgent(task.assigneeAgentId);
    if (!agent) {
      throw new Error(`Assigned agent not found: ${task.assigneeAgentId}`);
    }

    const updatedTask =
      this.store.updateTask(task.id, { status: 'in_progress' }) ?? task;

    this.store.addActivity({
      projectId: task.projectId,
      agentId: agent.id,
      kind: 'task',
      label: `Dispatched ${task.identifier}: ${task.title}`,
    });

    const prompt = [
      `Execute assigned task [${task.identifier}] (${task.id}): ${task.title}`,
      `Priority: ${task.priority}`,
      task.description ? `Details:\n${task.description}` : '',
      `When finished, provide a concise deliverable summary and update task ${task.id} if needed.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const res = this.enqueue({
      agentId: agent.id,
      projectId: task.projectId,
      kind: 'task',
      prompt,
      refId: task.id,
      metadata: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        taskTitle: task.title,
      },
    });

    return { task: updatedTask, agent: res.agent };
  }

  public enqueue(input: {
    agentId: string;
    projectId?: string | null;
    channelId?: string | null;
    triggerMessageId?: string | null;
    triggerRowid?: number | null;
    mentionIndex?: number;
    trust?: 'user' | 'teammate';
    priority?: 'resume' | 'normal';
    rootMessageId?: string | null;
    hop?: number;
    turnPurpose?: 'dispatch' | 'work';
    kind: QueueKind;
    prompt: string;
    refId?: string | null;
    replyToAgentId?: string | null;
    metadata?: MessageMetadata;
    attachments?: MessageAttachment[];
    /** Skills the user invoked by hand for this message. */
    skills?: Array<Pick<AgentSkill, 'id' | 'name' | 'content'>>;
  }): { agent: Agent; item: QueueItem } {
    const agent = this.store.getAgent(input.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${input.agentId}`);
    }

    const projectId = input.projectId ?? null;
    const channelId =
      input.channelId ??
      (projectId
        ? this.store.channels.getRoomByProject(projectId)?.id ?? null
        : this.store.channels.getDmByAgent(agent.id)?.id ?? null);
    const channel = channelId ? this.store.channels.getChannel(channelId) : null;
    const prompt = this.promptWithSkills(this.promptWithAttachments(input.prompt, input.attachments), input.skills);

    if (channel?.kind === 'room' && input.triggerMessageId) {
      const rootId = input.rootMessageId ?? input.triggerMessageId;
      const hop = input.hop ?? 0;
      const roomSettings = { ...(this.store.getSettings().room ?? {}), ...(channel.settings ?? {}) };
      const check = this.loopGuard.canEnqueue({
        rootMessageId: rootId,
        channelId: channel.id,
        hop,
        maxHops: roomSettings.maxHops,
        maxTurns: roomSettings.maxTurnsPerChain,
        maxTokens: roomSettings.maxTokensPerChain,
      });
      if (!check.allowed && check.reason === 'max_hops') {
        this.store.channels.postMessage({
          channelId: channel.id,
          author: 'system',
          agentId: null,
          text: `Agent-to-agent chain stopped at ${check.maxHops ?? 6} steps — reply to continue.`,
          metadata: {
            event: {
              kind: 'loop_stopped',
              rootMessageId: rootId,
              hop,
              maxHops: check.maxHops ?? 6,
            },
          },
        });
        return {
          agent,
          item: {
            id: 'q_skipped',
            agentId: agent.id,
            projectId,
            channelId: channel.id,
            kind: input.kind,
            prompt,
            refId: input.refId ?? null,
            createdAt: new Date().toISOString(),
          },
        };
      }
      // chain_budget_exhausted: the item is still queued but held (see runnableRoomItems) until
      // the user presses "Continue", so nothing is silently dropped.
      if (this.store.hasQueuedRootForAgent(channel.id, agent.id, rootId)) {
        return {
          agent,
          item: this.store.listQueue(agent.id).find((q) => q.channelId === channel.id && q.rootMessageId === rootId) ?? {
            id: 'q_deduped',
            agentId: agent.id,
            projectId,
            channelId: channel.id,
            kind: input.kind,
            prompt,
            refId: input.refId ?? null,
            createdAt: new Date().toISOString(),
          },
        };
      }
      const { item, agent: updatedAgent } = this.store.enqueueItem({
        agentId: agent.id,
        projectId,
        channelId: channel.id,
        triggerMessageId: input.triggerMessageId,
        triggerRowid: input.triggerRowid ?? this.store.channels.getMessageRowid(input.triggerMessageId),
        mentionIndex: input.mentionIndex ?? 0,
        trust: input.trust ?? (input.kind === 'teammate' ? 'teammate' : 'user'),
        priority: input.priority ?? 'normal',
        rootMessageId: rootId,
        hop,
        ...(input.turnPurpose ? { turnPurpose: input.turnPurpose } : {}),
        kind: input.kind,
        prompt,
        refId: input.refId ?? input.triggerMessageId,
        replyToAgentId: input.replyToAgentId ?? null,
      });
      if (agent.status === 'error') {
        this.store.updateAgent(agent.id, { lastError: null });
      }
      this.emitRoomQueue(channel.id);
      this.kickNextInChannel(channel.id);
      return { agent: updatedAgent ?? agent, item };
    }

    const author = input.kind === 'user' ? 'user' : 'teammate';
    const { item, agent: updatedAgent } = this.store.enqueueMessage({
      ...(channelId ? { channelId } : {}),
      projectId,
      agentId: agent.id,
      author,
      text: input.prompt,
      streaming: false,
      metadata: {
        ...input.metadata,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.skills?.length ? { skills: input.skills.map(({ id, name }) => ({ id, name })) } : {}),
        taskId: input.kind === 'task' ? (input.refId ?? undefined) : input.metadata?.taskId,
      },
    }, {
      agentId: agent.id,
      projectId,
      channelId,
      trust: input.trust ?? (input.kind === 'teammate' ? 'teammate' : 'user'),
      priority: input.priority ?? 'normal',
      rootMessageId: input.rootMessageId ?? null,
      hop: input.hop ?? 0,
      kind: input.kind,
      // The chat bubble shows the plain text; the model also gets the file list (+ small text files).
      prompt,
      refId: input.refId ?? null,
      replyToAgentId: input.replyToAgentId ?? null,
    });

    if (agent.status === 'error') {
      this.store.updateAgent(agent.id, { lastError: null });
    }

    if (channel?.kind === 'room') {
      this.emitRoomQueue(channel.id);
      this.kickNextInChannel(channel.id);
    } else {
      void this.drain(agent.id);
    }

    return {
      agent: updatedAgent ?? agent,
      item,
    };
  }

  /** Puts the full text of skills the user invoked by hand in front of their message. */
  private promptWithSkills(prompt: string, skills?: Array<Pick<AgentSkill, 'name' | 'content'>>): string {
    if (!skills?.length) return prompt;
    const blocks = skills.map((s) => `## Skill: ${s.name}\n${s.content.trim().slice(0, 20000)}`);
    return [
      'The user invoked these skills for this message. Follow them for this request.',
      ...blocks,
      '---',
      `User message:\n${prompt}`,
    ].join('\n\n');
  }

  /** Message text + attached-file list (+ inlined small text files) as the model should see it. */
  private promptWithAttachments(text: string, attachments?: MessageAttachment[]): string {
    if (!attachments?.length) return text;
    return `${text}${this.attachmentStore.describe(attachments)}${this.attachmentStore.excerpts(attachments)}`;
  }

  public async stop(agentId: string): Promise<{ stopped: boolean; agent: Agent | null }> {
    const agent = this.store.getAgent(agentId);
    if (!agent) return { stopped: false, agent: null };

    this.store.clearQueue(agentId);

    const controller = this.activeAborts.get(agentId);
    const activeTurn = this.activeTurns.get(agentId);

    if (controller) {
      controller.abort();
      this.activeAborts.delete(agentId);
      if (activeTurn) {
        await activeTurn.catch(() => undefined);
      }
      this.store.addActivity({
        projectId: null,
        agentId: agent.id,
        kind: 'status',
        label: 'Stopped by user',
      });
      return { stopped: true, agent: this.store.getAgent(agentId) };
    }

    const updated =
      agent.status === 'working'
        ? this.store.updateAgent(agentId, { status: 'idle', currentTask: null, queueLength: 0 })
        : agent;

    return { stopped: agent.status === 'working', agent: updated };
  }

  public retry(
    agentId: string,
    opts?: { modelOverride?: ModelRef; makeDefault?: boolean },
  ): { agent: Agent | null } {
    const agent = this.store.getAgent(agentId);
    if (!agent) return { agent: null };

    if (opts?.makeDefault && opts.modelOverride) {
      this.store.updateAgentConfig(agentId, {
        providerOverride: opts.modelOverride.provider,
        modelOverride: opts.modelOverride.model,
      });
    }

    const queue = this.store.listQueue(agentId);
    if (queue.length === 0) {
      const pf = agent.pendingFallback;
      if (pf) {
        this.store.enqueueItem({
          agentId: agent.id,
          projectId: pf.projectId ?? null,
          channelId: pf.projectId ? this.store.channels.getRoomByProject(pf.projectId)?.id ?? null : null,
          priority: 'resume',
          kind: pf.kind,
          prompt: pf.prompt,
          refId: pf.refId,
          replyToAgentId: pf.replyToAgentId ?? null,
          modelOverride: opts?.modelOverride ?? null,
          fallbackAttempt: 0,
          fallbackFrom: opts?.modelOverride
            ? {
                provider: pf.failedProvider,
                model: pf.failedModel,
                reason: pf.errorKind,
              }
            : null,
        });
      } else {
        const msgs = this.store.listAgentMessages(agentId);
        const lastUser = [...msgs].reverse().find((m) => m.author === 'user');
        if (lastUser) {
          this.store.enqueueItem({
            agentId: agent.id,
            projectId: lastUser.projectId ?? null,
            channelId: lastUser.channelId ?? null,
            triggerMessageId: lastUser.id,
            priority: 'resume',
            kind: 'user',
            prompt: this.promptWithSkills(
              this.promptWithAttachments(lastUser.text, lastUser.metadata?.attachments),
              lastUser.metadata?.skills
                ?.map((ref) => agent.skills.find((s) => s.id === ref.id))
                .filter((s): s is AgentSkill => Boolean(s)),
            ),
            refId: lastUser.id,
            modelOverride: opts?.modelOverride ?? null,
          });
        }
      }
    }

    const cleared = this.store.updateAgent(agentId, {
      status: 'idle',
      lastError: null,
      pendingFallback: null,
    });

    void this.drain(agentId);
    return { agent: cleared };
  }

  public dismissFallback(agentId: string): Agent | null {
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    return this.store.updateAgent(agentId, {
      pendingFallback: null,
    });
  }

  public getCooldowns(): CooldownEntry[] {
    return this.cooldowns.listActive();
  }

  public clearCooldown(provider?: ModelProvider, model?: string): void {
    this.cooldowns.clear(provider, model);
  }

  public compact(agentId: string, projectId: string | null): CompactScopeResult {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (agent.status === 'working') {
      throw new Error(
        'Agent is currently running a turn. Wait until it finishes or stop it first.',
      );
    }
    const room = projectId ? this.store.channels.getRoomByProject(projectId) : null;
    if (room) {
      return this.compactChannel(room.id, agent.id, 'manual');
    }
    return this.compactScope(agent, projectId, 'manual');
  }

  private compactChannel(
    channelId: string,
    actingAgentId: string,
    reason: 'manual' | 'auto',
    providerOverride?: ModelProvider,
    trigger?: CompactTrigger,
  ): CompactScopeResult {
    const result = compactChannelScope(this.store, channelId, actingAgentId, {
      force: reason === 'manual',
      reason,
      trigger,
    });
    const { compaction, summarizerInput } = result;
    if (!compaction?.structured || !summarizerInput || !this.runner.summarize) return result;
    const settings = this.store.getSettings();
    const actingAgent = this.store.getAgent(actingAgentId);
    const provider = providerOverride ?? actingAgent?.providerOverride ?? settings.provider;
    const key = `channel:${channelId}`;
    this.memorySummaries.get(key)?.abort();
    const controller = new AbortController();
    this.memorySummaries.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref();
    void Promise.resolve()
      .then(async () => {
        const text = await this.runner.summarize!(
          provider,
          settings.autoCompact.summarizerModel,
          summarizerInput,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const ch = this.store.channels.getChannel(channelId);
        const previous = ch?.compaction;
        if (
          !ch ||
          previous?.lastCompactedMessageId !== compaction.lastCompactedMessageId ||
          previous.compactedAt !== compaction.compactedAt
        ) {
          return;
        }
        const structured = mergeModelMemory(text, compaction.structured!);
        const summary = renderStructuredMemory(structured);
        const updatedCompaction = { ...previous, summary, structured };
        this.store.channels.updateChannel(channelId, {
          compaction: updatedCompaction,
        });
        if (ch.projectId) {
          const curActing = this.store.getAgent(actingAgentId);
          if (curActing) {
            this.store.updateAgent(actingAgentId, {
              contextCompactions: {
                ...(curActing.contextCompactions ?? {}),
                [ch.projectId]: updatedCompaction,
              },
            });
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        if (this.memorySummaries.get(key) === controller) this.memorySummaries.delete(key);
      });
    return result;
  }

  private compactScope(
    agent: Agent,
    projectId: string | null,
    reason: 'manual' | 'auto',
    providerOverride?: ModelProvider,
    trigger?: CompactTrigger,
  ): CompactScopeResult {
    const result = compactAgentScope(this.store, agent.id, projectId, {
      force: reason === 'manual',
      reason,
      trigger,
    });
    const { compaction, summarizerInput } = result;
    if (!compaction?.structured || !summarizerInput || !this.runner.summarize) return result;
    const settings = this.store.getSettings();
    const provider = providerOverride ?? agent.providerOverride ?? settings.provider;
    const scope = getScopeKey(projectId);
    const key = `${agent.id}:${scope}`;
    this.memorySummaries.get(key)?.abort();
    const controller = new AbortController();
    this.memorySummaries.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref();
    void Promise.resolve().then(async () => {
      const text = await this.runner.summarize!(provider, settings.autoCompact.summarizerModel, summarizerInput, controller.signal);
      if (controller.signal.aborted) return;
      const current = this.store.getAgent(agent.id);
      const previous = current?.contextCompactions?.[scope];
      if (!current || previous?.lastCompactedMessageId !== compaction.lastCompactedMessageId ||
          previous.compactedAt !== compaction.compactedAt) return;
      const structured = mergeModelMemory(text, compaction.structured!);
      const summary = renderStructuredMemory(structured);
      this.store.updateAgent(agent.id, {
        contextCompactions: {
          ...current.contextCompactions,
          [scope]: { ...previous, summary, structured },
        },
      });
    }).catch(() => {
      // The deterministic summary is already saved and available to the next turn.
    }).finally(() => {
      clearTimeout(timer);
      if (this.memorySummaries.get(key) === controller) this.memorySummaries.delete(key);
    });
    return result;
  }

  /**
   * One-off text generation with the app's default provider and model, or with `override`
   * (e.g. meeting notes written by a cheaper or local model). `systemPrompt` replaces the
   * built-in summary instructions.
   */
  public async summarizeText(
    input: string,
    signal: AbortSignal,
    override?: { provider?: ModelProvider | null; model?: string | null; systemPrompt?: string },
  ): Promise<string | null> {
    if (!this.runner.summarize) return null;
    const settings = this.store.getSettings();
    const provider = override?.provider ?? settings.provider;
    // A model belongs to its provider: only reuse the default model when the provider is the default.
    const model = override?.provider ? (override.model ?? undefined) : settings.model;
    return this.runner.summarize(provider, model, input, signal, override?.systemPrompt ? { systemPrompt: override.systemPrompt } : undefined);
  }

  /** Stops every running turn (and clears their queues) but keeps the runtime usable. */
  public async stopAll(): Promise<void> {
    for (const controller of this.memorySummaries.values()) controller.abort();
    const ids = [...this.activeAborts.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
    const pending = [...this.activeTurns.values()];
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.scheduler.close();
    for (const controller of this.memorySummaries.values()) controller.abort();
    for (const controller of this.activeAborts.values()) {
      controller.abort();
    }
    this.activeAborts.clear();
    const pending = [...this.activeTurns.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  public async drain(agentId: string): Promise<void> {
    if (this.shuttingDown || this.draining.has(agentId)) return;
    const initial = this.store.getAgent(agentId);
    if (!initial || initial.status === 'working') return;

    this.draining.add(agentId);
    try {
      while (!this.shuttingDown) {
        const current = this.store.getAgent(agentId);
        if (!current || current.status === 'working') break;

        const agentQueue = this.store.listQueue(agentId);
        if (agentQueue.length === 0) break;

        let item: QueueItem | null = null;
        let leaseController: AbortController | undefined;
        let leaseChannelId: string | null = null;
        let retry = false;

        // Walk the agent's own queue in order: a room item that is not this agent's turn (or is
        // held by a paused chain) must not block a runnable DM/direct item behind it.
        for (const cand of agentQueue) {
          const candChannel = cand.channelId ? this.store.channels.getChannel(cand.channelId) : null;
          if (candChannel?.kind !== 'room') {
            item = this.store.shiftQueueItemById(cand.id);
            if (item) break;
            continue;
          }
          const roomSettings = { ...(this.store.getSettings().room ?? {}), ...(candChannel.settings ?? {}) };
          const parallel = Boolean(roomSettings.parallel);
          const projectTasks = candChannel.projectId
            ? this.store.listProjectTasks(candChannel.projectId)
            : [];
          const picked = this.scheduler.pickNext(this.runnableRoomItems(candChannel.id), projectTasks);
          if (!picked || picked.agentId !== agentId) continue;
          const controller = new AbortController();
          const lease = this.scheduler.tryAcquire(candChannel.id, agentId, picked.id, controller, parallel);
          if (!lease) continue;
          const shifted = this.store.shiftQueueItemById(picked.id);
          if (!shifted) {
            this.scheduler.release(candChannel.id, 'done', picked.id);
            retry = true;
            break;
          }
          item = shifted;
          leaseController = controller;
          leaseChannelId = candChannel.id;
          this.emitRoomQueue(candChannel.id);
          break;
        }
        if (retry) continue;

        if (!item) break;

        const turnPromise = this.executeTurn(item, leaseController, leaseChannelId);
        this.activeTurns.set(agentId, turnPromise);
        try {
          await turnPromise;
        } finally {
          if (this.activeTurns.get(agentId) === turnPromise) {
            this.activeTurns.delete(agentId);
          }
        }
      }
    } finally {
      this.draining.delete(agentId);
    }
  }

  private async executeTurn(
    item: QueueItem,
    leaseController?: AbortController,
    leaseChannelId?: string | null,
  ): Promise<void> {
    const project = item.projectId ? this.store.getProject(item.projectId) : null;
    if (item.projectId && !project) {
      if (leaseChannelId) {
        this.scheduler.release(leaseChannelId, 'error', item.id);
        this.emitRoomQueue(leaseChannelId);
      }
      return;
    }
    let agent = this.store.getAgent(item.agentId);
    if (!agent) {
      if (leaseChannelId) {
        this.scheduler.release(leaseChannelId, 'error', item.id);
        this.emitRoomQueue(leaseChannelId);
      }
      return;
    }

    const projectId = project?.id ?? null;
    const resolvedChannelId =
      item.channelId ??
      leaseChannelId ??
      (projectId
        ? this.store.channels.getRoomByProject(projectId)?.id ?? null
        : this.store.channels.getDmByAgent(agent.id)?.id ?? null);
    let channel = resolvedChannelId ? this.store.channels.getChannel(resolvedChannelId) : null;
    const isRoom = channel?.kind === 'room';
    const scopeKey = isRoom && channel ? channel.id : getScopeKey(projectId);
    const settings = this.store.getSettings();
    const preMessages =
      isRoom && channel
        ? this.store.channels
            .listChannelMessagesWithRowids(channel.id, { sessionId: channel.currentSessionId })
            .map((r) => r.message)
        : this.store.listAgentMessages(agent.id, projectId);
    const preCompaction = isRoom && channel ? channel.compaction : agent.contextCompactions?.[scopeKey];
    const preTrigger = autoCompactTrigger(
      preMessages,
      preCompaction,
      agent.scopeTokens?.[scopeKey],
      settings.autoCompact,
    );
    if (preTrigger === 'provider_limit') {
      const compactRes =
        isRoom && channel
          ? this.compactChannel(channel.id, agent.id, 'auto', item.modelOverride?.provider, preTrigger)
          : this.compactScope(agent, projectId, 'auto', item.modelOverride?.provider, preTrigger);
      if (compactRes.agent) {
        agent = compactRes.agent;
      }
      if (isRoom && channel) {
        channel = this.store.channels.getChannel(channel.id);
      }
    }

    const primaryProvider = agent.providerOverride ?? settings.provider;
    const effectiveProvider = item.modelOverride?.provider ?? primaryProvider;
    const effectiveModel = item.modelOverride?.model || agent.modelOverride || settings.model;
    const switchingProvider =
      Boolean(item.modelOverride) && item.modelOverride!.provider !== primaryProvider;
    const priorProviderTokens = agent.scopeTokens?.[scopeKey] ?? 0;
    const sessionBloated =
      preTrigger === 'provider_limit' || priorProviderTokens > MAX_RESUMED_PROVIDER_CONTEXT_TOKENS;
    const roomDeltaStale =
      isRoom && channel
        ? new RoomContextBuilder(this.store.channels).isDeltaStale({
            channel,
            agent,
            allAgents: this.store.listAgents(),
            triggerMessageId: item.triggerMessageId ?? item.refId ?? undefined,
            tailTokens: settings.autoCompact.tailTokens,
          })
        : false;
    const initialResumeId = switchingProvider || roomDeltaStale || sessionBloated
      ? null
      : (agent.sessions?.[scopeKey] ??
        (project &&
        !isRoom &&
        agent.projectId === project.id &&
        !Object.values(agent.sessions ?? {}).includes(agent.sessionId ?? '')
          ? agent.sessionId
          : null));

    const canonScope = getScopeKey(projectId);
    const canon = renderCanon(this.store.listCanon(canonScope), (id) => {
      const artifact = this.store.getArtifact(id);
      if (artifact?.kind === 'svg' && artifact.projectId === projectId && artifact.sizeBytes <= 2048) {
        return this.store.readArtifact(artifact).toString('utf8');
      }
      return undefined;
    });
    this.store.restoreCanonWorkspaceAssets(projectId, agent.id);
    const canonVersion = createHash('sha256').update(canon.text).digest('hex');
    const previousCanon = agent.sessionCanon?.[scopeKey];
    const canonChanged = !!initialResumeId &&
      (previousCanon?.sessionId !== initialResumeId || previousCanon.version !== canonVersion);
    const activeSummaryText = isRoom && channel
      ? (channel.compaction?.summary ?? '')
      : (agent.contextCompactions?.[scopeKey]?.summary ?? '');
    const selective = settings.memory?.mode === 'selective';
    let memorySelection: SelectResult | null = null;
    let memoryCarry: Record<string, string> = {};
    if (selective && settings.memory) {
      const sentRecord = agent.sessionMemorySent?.[scopeKey];
      if (initialResumeId && sentRecord?.sessionId === initialResumeId) memoryCarry = sentRecord.ids;
      const triggerId = item.triggerMessageId ?? item.refId;
      const triggerText = triggerId ? (this.store.getMessage(triggerId)?.text ?? '') : '';
      const taskRef = item.kind === 'task' && item.refId ? this.store.getTask(item.refId) : null;
      const queryText = [item.prompt, triggerText, taskRef ? `${taskRef.title} ${taskRef.description}` : '']
        .join('\n')
        .slice(0, 2500);
      memorySelection = selectMemory({
        index: this.store.memory,
        scopeKey: canonScope,
        owners: memoryOwners(this.store, agent.id, channel?.id),
        queryText,
        settings: settings.memory,
        alreadySent: Object.keys(memoryCarry).length ? memoryCarry : undefined,
      });
    }
    const memoryTokens: {
      canon: number; summary: number; tail: number; stubs?: number; delta?: number;
      relevant?: number; catalog?: number; pinned?: number;
    } = memorySelection
      ? {
          canon: 0,
          summary: 0,
          tail: 0,
          pinned: memorySelection.tokens.pinned,
          relevant: memorySelection.tokens.relevant,
          catalog: memorySelection.tokens.catalog,
        }
      : {
          canon: estimateTokens(canon.text),
          summary: estimateTokens(activeSummaryText.slice(0, 8000)),
          tail: 0,
        };
    if (memorySelection?.pinnedOverflow) {
      this.store.addActivity({
        projectId, agentId: agent.id, kind: 'status', label: 'Pinned memory budget reached',
        detail: `${memorySelection.pinnedOverflow} pinned entries did not fit the pinned budget. Raise the budget or unpin entries.`,
      });
    }
    if (!selective && canon.omitted) {
      this.store.addActivity({
        projectId, agentId: agent.id, kind: 'status', label: 'Canon prompt budget reached',
        detail: `${canon.omitted} entries remain available in the Canon panel.`,
      });
    }

    const startedAt = Date.now();
    const controller = leaseController ?? new AbortController();
    this.activeAborts.set(agent.id, controller);
    let releaseReason: LeaseReleaseReason = 'done';

    if (item.kind === 'task' && item.refId) {
      const existingTask = this.store.getTask(item.refId);
      if (existingTask && (existingTask.status === 'backlog' || existingTask.status === 'todo')) {
        this.store.updateTask(existingTask.id, { status: 'in_progress' });
      }
    }

    const taskLabel = item.prompt.split('\n')[0].slice(0, 64);
    this.store.updateAgent(agent.id, {
      status: 'working',
      currentTask: taskLabel,
      lastError: null,
      pendingFallback: null,
    });
    if (channel) {
      this.store.emitEvent({
        type: 'room-typing',
        payload: { channelId: channel.id, agentId: agent.id, state: 'working' },
      });
    }

    const replyMsg = this.store.createMessage({
      ...(channel ? { channelId: channel.id, sessionId: channel.currentSessionId ?? null } : {}),
      projectId,
      agentId: agent.id,
      author: 'agent',
      text: '',
      streaming: true,
      metadata: {
        provider: effectiveProvider,
        model: effectiveModel,
        ...(item.triggerMessageId || item.refId
          ? { triggerMessageId: item.triggerMessageId ?? item.refId ?? undefined }
          : {}),
        ...(item.rootMessageId ? { rootMessageId: item.rootMessageId } : {}),
        ...(item.hop !== undefined ? { hop: item.hop } : {}),
      },
    });

    const turnActivities: MessageActivitySummary[] = [];
    let sessionId: string | null = initialResumeId;
    let usageIn = 0;
    let usageOut = 0;
    let usageCostUsd: number | null = null;
    let providerContextTokens = 0;

    const streamFilter = createActionTagStreamFilter((delta) => {
      this.store.appendMessageDelta(replyMsg.id, delta);
    });

    this.store.memory.beginTurn(agent.id);
    try {
      const refMessageId = item.triggerMessageId ?? item.refId;
      const { finalText: rawFinalText } = await this.runner.run(
        {
          agent,
          project,
          channelId: channel?.id ?? null,
          trust: item.trust ?? 'user',
          turnPurpose: item.turnPurpose ?? 'work',
          rootMessageId: item.rootMessageId ?? refMessageId ?? null,
          prompt: item.prompt,
          attachments: refMessageId ? this.store.getMessage(refMessageId)?.metadata?.attachments : undefined,
          resumeSessionId: initialResumeId,
          currentMessageId: item.kind === 'user' ? refMessageId : null,
          replyMessageId: replyMsg.id,
          canonText: selective ? SELECTIVE_MEMORY_PROMPT : canon.text,
          canonChanged: selective ? false : canonChanged,
          ...(selective ? { memoryBlock: memorySelection?.text ?? '', omitCompaction: true } : {}),
          providerOverride: item.modelOverride?.provider,
          modelOverride: item.modelOverride?.model,
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            if (leaseChannelId) this.scheduler.heartbeat(leaseChannelId);
            streamFilter.push(delta);
          },
          onTool: (name, input) => {
            if (leaseChannelId) this.scheduler.heartbeat(leaseChannelId);
            const rawDetail =
              input && typeof input === 'object'
                ? JSON.stringify(input).slice(0, 120)
                : String(input ?? '');
            const detail = this.browserManager ? this.browserManager.redact(rawDetail) : rawDetail;
            const act = this.store.addActivity({
              projectId,
              agentId: agent.id,
              messageId: replyMsg.id,
              kind: 'tool',
              label: this.browserManager ? this.browserManager.redact(name) : name,
              detail,
            });
            turnActivities.push({
              id: act.id,
              kind: act.kind,
              label: act.label,
              detail: act.detail,
              createdAt: act.createdAt,
            });
          },
          onSession: (id) => {
            sessionId = id;
          },
          onUsage: (inputTokens, outputTokens, costUsd) => {
            usageIn = inputTokens;
            usageOut = outputTokens;
            usageCostUsd = typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : null;
          },
          onMemoryTail: (tokens, extras) => {
            memoryTokens.tail = tokens;
            if (extras?.stubs !== undefined) memoryTokens.stubs = extras.stubs;
            if (extras?.delta !== undefined) memoryTokens.delta = extras.delta;
          },
          onContextTokens: (tokens) => { providerContextTokens = Math.max(providerContextTokens, tokens); },
        },
      );

      streamFilter.flush();
      const finalText =
        stripAtelierActions(rawFinalText) ||
        (turnActivities.length > 0 ? 'Completed turn.' : rawFinalText.trim());

      const durationMs = Math.max(100, Date.now() - startedAt);
      let linkedTask: Task | null = null;
      if (item.kind === 'task' && item.refId) {
        linkedTask = this.store.getTask(item.refId);
        // Auto-transition in_progress -> in_review with summary if agent didn't explicitly update it
        if (linkedTask && linkedTask.status === 'in_progress') {
          linkedTask = this.store.updateTask(linkedTask.id, {
            status: 'in_review',
            deliverableSummary: finalText.slice(0, 320),
          });
        }
      }

      const designArtifacts = this.store.captureDesignArtifacts({ ...replyMsg, text: finalText });
      const roomMentions =
        isRoom && channel && projectId
          ? routeRoomMessage(
              { author: 'agent', agentId: agent.id, text: finalText },
              {
                channel,
                projectAgents: this.store.listProjectAgents(projectId),
                tasks: this.store.listProjectTasks(projectId),
              },
            ).targetAgentIds
          : [];

      const finalized = this.store.finalizeMessage(replyMsg.id, {
        text: finalText,
        streaming: false,
        durationMs,
        metadata: {
          ...(memorySelection
            ? {
                memoryUsed: {
                  pushed: memorySelection.pushedIds,
                  recalled: this.store.memory.endTurn(agent.id),
                  tokens: memorySelection.tokens.total,
                },
              }
            : {}),
          ...(Object.keys(designArtifacts).length ? { designArtifacts } : {}),
          ...(roomMentions.length ? { mentions: roomMentions, toAgentIds: roomMentions } : {}),
          activities: turnActivities,
          provider: effectiveProvider,
          model: effectiveModel,
          taskId: linkedTask?.id,
          taskIdentifier: linkedTask?.identifier,
          taskTitle: linkedTask?.title,
          ...(item.modelOverride && item.fallbackFrom
            ? {
                fallbackFrom: item.fallbackFrom,
                fallbackTo: item.modelOverride,
              }
            : {}),
        },
        cursorUpdate:
          isRoom && channel
            ? {
                channelId: channel.id,
                agentId: agent.id,
                sessionId: !switchingProvider ? sessionId : null,
              }
            : undefined,
      });

      const latestAgent = this.store.getAgent(agent.id) ?? agent;
      const shouldRotateNextTurn = providerContextTokens > MAX_RESUMED_PROVIDER_CONTEXT_TOKENS;
      const nextSessions = { ...(latestAgent.sessions ?? {}) };
      if (shouldRotateNextTurn) {
        delete nextSessions[scopeKey];
        if (isRoom && projectId) delete nextSessions[projectId];
      } else if (sessionId && !switchingProvider) {
        nextSessions[scopeKey] = sessionId;
        if (isRoom && projectId) nextSessions[projectId] = sessionId;
      }
      const sessionCanon = { ...(latestAgent.sessionCanon ?? {}) };
      if (shouldRotateNextTurn) {
        delete sessionCanon[scopeKey];
        if (isRoom && projectId) delete sessionCanon[projectId];
      } else if (sessionId && !switchingProvider) {
        sessionCanon[scopeKey] = { sessionId, version: canonVersion };
        if (isRoom && projectId) sessionCanon[projectId] = { sessionId, version: canonVersion };
      }

      const postMessages =
        isRoom && channel
          ? this.store.channels
              .listChannelMessagesWithRowids(channel.id, { sessionId: channel.currentSessionId })
              .map((r) => r.message)
          : this.store.listAgentMessages(agent.id, projectId);
      const activeCompaction =
        isRoom && channel
          ? this.store.channels.getChannel(channel.id)?.compaction
          : latestAgent.contextCompactions?.[scopeKey];
      const activeScopeTokens = providerContextTokens || usageIn ||
        estimateActiveContextTokens(postMessages, activeCompaction);
      const nextScopeTokens = {
        ...(latestAgent.scopeTokens ?? {}),
        [scopeKey]: activeScopeTokens,
        ...(isRoom && projectId ? { [projectId]: activeScopeTokens } : {}),
      };
      const activeConversationTokens = estimateConversationTokens(postMessages, activeCompaction);
      const nextConversationTokens = {
        ...(latestAgent.conversationTokens ?? {}),
        [scopeKey]: activeConversationTokens,
        ...(isRoom && projectId ? { [projectId]: activeConversationTokens } : {}),
      };

      const sessionMemorySent = { ...(latestAgent.sessionMemorySent ?? {}) };
      if (memorySelection && sessionId && !switchingProvider) {
        const entry = { sessionId, ids: { ...memoryCarry, ...memorySelection.written } };
        sessionMemorySent[scopeKey] = entry;
        if (isRoom && projectId) sessionMemorySent[projectId] = entry;
      }

      this.store.updateAgent(agent.id, {
        status: 'idle',
        currentTask: null,
        sessionId: shouldRotateNextTurn
          ? (latestAgent.sessionId === sessionId ? null : latestAgent.sessionId)
          : ((!switchingProvider ? sessionId : null) ?? latestAgent.sessionId),
        sessions: nextSessions,
        sessionCanon,
        ...(memorySelection ? { sessionMemorySent } : {}),
        scopeTokens: nextScopeTokens,
        conversationTokens: nextConversationTokens,
        lastError: null,
        pendingFallback: null,
        tokenUsage: {
          input: latestAgent.tokenUsage.input + usageIn,
          output: latestAgent.tokenUsage.output + usageOut,
        },
      });

      const afterSettings = this.store.getSettings();
      const loggedIn = usageIn > 0 ? usageIn : estimateTokens(item.prompt);
      const loggedOut = usageOut > 0 ? usageOut : estimateTokens(finalText);
      const costUsd =
        usageCostUsd ?? estimateTurnCostUsd(effectiveProvider, effectiveModel, loggedIn, loggedOut);
      this.store.recordUsageLog({
        provider: effectiveProvider,
        model: effectiveModel,
        agentId: agent.id,
        projectId,
        inputTokens: loggedIn,
        outputTokens: loggedOut,
        memoryTokens,
        rootMessageId: item.rootMessageId ?? null,
        turnPurpose: item.turnPurpose ?? 'work',
        estimatedCostUsd: costUsd,
      });
      if (process.env.ATELIER_LOG_LEVEL === 'debug') {
        console.debug('Atelier memory tokens', { scopeKey, agentId: agent.id, ...memoryTokens });
      }

      if (isRoom && channel && item.rootMessageId) {
        const roomSettings = { ...(afterSettings.room ?? {}), ...(channel.settings ?? {}) };
        const budgetRes = this.loopGuard.recordTurn(item.rootMessageId, channel.id, {
          tokens: loggedIn + loggedOut,
          costUsd,
          maxTurns: roomSettings.maxTurnsPerChain,
          maxTokens: roomSettings.maxTokensPerChain,
        });
        if (budgetRes.justWarned || budgetRes.justPaused) {
          this.store.channels.postMessage({
            channelId: channel.id,
            author: 'system',
            agentId: null,
            text: budgetRes.justPaused
              ? `Chain budget reached (${budgetRes.chain.turnsUsed}/${budgetRes.chain.maxTurns} turns, ${budgetRes.chain.tokensUsed} tokens) — paused.`
              : `Chain budget at 80% (${budgetRes.chain.turnsUsed}/${budgetRes.chain.maxTurns} turns).`,
            metadata: {
              event: {
                kind: 'chain_budget',
                rootMessageId: item.rootMessageId,
                turnsUsed: budgetRes.chain.turnsUsed,
                maxTurns: budgetRes.chain.maxTurns,
                tokensUsed: budgetRes.chain.tokensUsed,
                maxTokens: budgetRes.chain.maxTokens,
                warningOnly: budgetRes.justWarned,
              },
            },
          });
        }
      }

      const postTrigger = autoCompactTrigger(
        postMessages,
        activeCompaction,
        activeScopeTokens,
        afterSettings.autoCompact,
      );
      if (postTrigger) {
        if (isRoom && channel) {
          this.compactChannel(channel.id, agent.id, 'auto', effectiveProvider, postTrigger);
        } else {
          this.compactScope(latestAgent, projectId, 'auto', effectiveProvider, postTrigger);
        }
      }

      // In a project room, route explicit @mentions in the reply (skip targets already messaged via tool).
      if (isRoom && channel && roomMentions.length > 0 && finalized) {
        const alreadyMessaged = new Set(
          turnActivities
            .filter((a) => a.label === 'atelier.message_agent' && a.detail)
            .map((a) => {
              try {
                return (JSON.parse(a.detail!) as { targetAgentId?: string }).targetAgentId ?? '';
              } catch {
                return '';
              }
            })
            .filter(Boolean),
        );
        const rowid = this.store.channels.getMessageRowid(finalized.id);
        for (let idx = 0; idx < roomMentions.length; idx += 1) {
          const targetId = roomMentions[idx]!;
          if (alreadyMessaged.has(targetId)) continue;
          this.enqueue({
            agentId: targetId,
            projectId,
            channelId: channel.id,
            triggerMessageId: finalized.id,
            triggerRowid: rowid,
            mentionIndex: idx,
            trust: 'teammate',
            rootMessageId: item.rootMessageId ?? finalized.id,
            hop: (item.hop ?? 0) + 1,
            kind: 'teammate',
            prompt: finalText,
            refId: finalized.id,
          });
        }
      } else if (!isRoom && item.replyToAgentId && finalText) {
        this.enqueue({
          agentId: item.replyToAgentId,
          projectId,
          kind: 'teammate',
          prompt: `${agent.name} replied: ${finalText}`,
          refId: item.refId,
        });
      }
    } catch (err) {
      this.store.memory.endTurn(agent.id);
      const durationMs = Math.max(100, Date.now() - startedAt);
      const isAbort =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');

      if (this.shuttingDown) {
        return;
      }

      if (isAbort) {
        releaseReason = 'stopped';
        this.store.finalizeMessage(replyMsg.id, {
          appendText: ' (dihentikan)',
          streaming: false,
          durationMs,
          metadata: {
            cancelled: true,
            activities: turnActivities,
            provider: effectiveProvider,
            model: effectiveModel,
          },
        });
        this.store.updateAgent(agent.id, {
          status: 'idle',
          currentTask: null,
          pendingFallback: null,
        });
      } else {
        releaseReason = 'error';
        const message = err instanceof Error ? err.message : String(err);
        const classified = classifyTurnError(message);
        if (classified.cooldownMs > 0) {
          this.cooldowns.mark(effectiveProvider, effectiveModel, classified.cooldownMs, classified.kind);
        }

        const latestAgent = this.store.getAgent(agent.id) ?? agent;
        const latestSettings = this.store.getSettings();
        const candidates = resolveFallbackCandidates(
          latestAgent,
          latestSettings,
          effectiveProvider,
          effectiveModel,
        );
        const mode = latestSettings.fallbackMode ?? 'ask';
        const attempt = item.fallbackAttempt ?? 0;

        if (mode === 'auto' && classified.recoverable && attempt < 2 && candidates.length > 0) {
          const nextCandidate =
            candidates.find((c) => !this.cooldowns.isCoolingDown(c.provider, c.model)) ??
            candidates[0];

          if (nextCandidate) {
            this.store.addActivity({
              projectId,
              agentId: agent.id,
              messageId: replyMsg.id,
              kind: 'status',
              label: `Auto-switching to backup ${nextCandidate.provider}/${nextCandidate.model}`,
              detail: `${classified.label}: ${message}`,
            });
            this.store.finalizeMessage(replyMsg.id, {
              text: `${classified.label} on ${effectiveProvider}/${effectiveModel} — automatically switching to backup ${nextCandidate.provider}/${nextCandidate.model}…`,
              streaming: false,
              durationMs,
              metadata: {
                activities: turnActivities,
                provider: effectiveProvider,
                model: effectiveModel,
              },
            });
            this.store.enqueueItem({
              agentId: agent.id,
              projectId,
              channelId: channel?.id ?? item.channelId ?? null,
              triggerMessageId: item.triggerMessageId ?? null,
              triggerRowid: item.triggerRowid ?? null,
              mentionIndex: item.mentionIndex ?? 0,
              trust: item.trust ?? 'user',
              priority: 'resume',
              rootMessageId: item.rootMessageId ?? null,
              hop: item.hop ?? 0,
              ...(item.turnPurpose ? { turnPurpose: item.turnPurpose } : {}),
              kind: item.kind,
              prompt: item.prompt,
              refId: item.refId,
              replyToAgentId: item.replyToAgentId ?? null,
              modelOverride: nextCandidate,
              fallbackAttempt: attempt + 1,
              fallbackFrom: {
                provider: effectiveProvider,
                model: effectiveModel,
                reason: classified.kind,
              },
            });
            this.store.updateAgent(agent.id, {
              status: 'idle',
              currentTask: null,
              lastError: null,
              pendingFallback: null,
            });
            return;
          }
        }

        releaseReason = 'awaiting_fallback';
        const pendingFallback: PendingFallbackOffer = {
          projectId,
          prompt: item.prompt,
          kind: item.kind,
          refId: item.refId,
          replyToAgentId: item.replyToAgentId ?? null,
          failedProvider: effectiveProvider,
          failedModel: effectiveModel,
          errorKind: classified.kind,
          errorMessage: message,
          candidates,
          createdAt: new Date().toISOString(),
        };

        this.store.addActivity({
          projectId,
          agentId: agent.id,
          messageId: replyMsg.id,
          kind: 'error',
          label: classified.label,
          detail: message,
        });
        this.store.finalizeMessage(replyMsg.id, {
          text: `Error: ${message}`,
          streaming: false,
          durationMs,
          metadata: {
            activities: turnActivities,
            provider: effectiveProvider,
            model: effectiveModel,
          },
        });
        this.store.updateAgent(agent.id, {
          status: 'error',
          currentTask: null,
          lastError: message,
          pendingFallback,
        });
      }
    } finally {
      this.activeAborts.delete(agent.id);
      if (channel) {
        this.store.emitEvent({
          type: 'room-typing',
          payload: { channelId: channel.id, agentId: agent.id, state: 'idle' },
        });
      }
      if (leaseChannelId) {
        // Only release our own lease: a timed-out turn may finish long after its lease was
        // handed to another agent.
        this.scheduler.release(leaseChannelId, releaseReason, item.id);
        this.emitRoomQueue(leaseChannelId);
        this.kickNextInChannel(leaseChannelId);
      }
    }
  }
}
