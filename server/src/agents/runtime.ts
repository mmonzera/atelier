import { createHash } from 'node:crypto';
import type {
  Agent,
  AgentSkill,
  MessageActivitySummary,
  MessageAttachment,
  MessageMetadata,
  ModelProvider,
  ModelRef,
  PendingFallbackOffer,
  QueueItem,
  QueueKind,
  Task,
} from '@atelier/contracts';
import { AttachmentStore } from '../attachments.js';
import type { BrowserManager } from '../browser/manager.js';
import type { AppConfig } from '../config.js';
import type { AtelierStore } from '../store.js';
import { CliAgentRunner } from './cli-runners.js';
import {
  type CompactScopeResult,
  type CompactTrigger,
  autoCompactTrigger,
  compactAgentScope,
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
import { renderCanon } from './prompts.js';

export class AgentRuntime {
  private readonly draining = new Set<string>();
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly activeTurns = new Map<string, Promise<void>>();
  private readonly memorySummaries = new Map<string, AbortController>();
  private readonly cooldowns = new ProviderCooldownTracker();
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
  ) {
    this.browserManager = browserManager;
    this.attachmentStore = new AttachmentStore(config.dataDir);
    const getEnqueue = () => this.enqueue.bind(this);
    this.runner =
      customRunner ??
      customRunnerFactory?.({ store, enqueue: this.enqueue.bind(this) }) ??
      new CliAgentRunner(store, config, getEnqueue, browserManager);
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
    const author = input.kind === 'user' ? 'user' : 'teammate';
    const prompt = this.promptWithSkills(this.promptWithAttachments(input.prompt, input.attachments), input.skills);
    const { item, agent: updatedAgent } = this.store.enqueueMessage({
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
      kind: input.kind,
      // The chat bubble shows the plain text; the model also gets the file list (+ small text files).
      prompt,
      refId: input.refId ?? null,
      replyToAgentId: input.replyToAgentId ?? null,
    });

    if (agent.status === 'error') {
      this.store.updateAgent(agent.id, { lastError: null });
    }

    void this.drain(agent.id);

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
    return this.compactScope(agent, projectId, 'manual');
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

        const { item } = this.store.shiftQueue(agentId);
        if (!item) break;

        const turnPromise = this.executeTurn(item);
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

  private async executeTurn(item: QueueItem): Promise<void> {
    const project = item.projectId ? this.store.getProject(item.projectId) : null;
    if (item.projectId && !project) return;
    let agent = this.store.getAgent(item.agentId);
    if (!agent) return;

    const projectId = project?.id ?? null;
    const scopeKey = getScopeKey(projectId);
    const settings = this.store.getSettings();
    const preMessages = this.store.listAgentMessages(agent.id, projectId);
    const preTrigger = autoCompactTrigger(
      preMessages,
      agent.contextCompactions?.[scopeKey],
      agent.scopeTokens?.[scopeKey],
      settings.autoCompact,
    );
    if (preTrigger === 'provider_limit') {
      const compactRes = this.compactScope(
        agent,
        projectId,
        'auto',
        item.modelOverride?.provider,
        preTrigger,
      );
      if (compactRes.agent) {
        agent = compactRes.agent;
      }
    }

    const primaryProvider = agent.providerOverride ?? settings.provider;
    const effectiveProvider = item.modelOverride?.provider ?? primaryProvider;
    const effectiveModel = item.modelOverride?.model || agent.modelOverride || settings.model;
    const switchingProvider =
      Boolean(item.modelOverride) && item.modelOverride!.provider !== primaryProvider;
    const initialResumeId = switchingProvider
      ? null
      : (agent.sessions?.[scopeKey] ?? (project && agent.projectId === project.id &&
          !Object.values(agent.sessions ?? {}).includes(agent.sessionId ?? '') ? agent.sessionId : null));

    const canon = renderCanon(this.store.listCanon(scopeKey), (id) => {
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
    const memoryTokens = {
      canon: estimateTokens(canon.text),
      summary: estimateTokens((agent.contextCompactions?.[scopeKey]?.summary ?? '').slice(0, 8000)),
      tail: 0,
    };
    if (canon.omitted) {
      this.store.addActivity({
        projectId, agentId: agent.id, kind: 'status', label: 'Canon prompt budget reached',
        detail: `${canon.omitted} entries remain available in the Canon panel.`,
      });
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.activeAborts.set(agent.id, controller);

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

    const replyMsg = this.store.createMessage({
      projectId,
      agentId: agent.id,
      author: 'agent',
      text: '',
      streaming: true,
      metadata: {
        provider: effectiveProvider,
        model: effectiveModel,
      },
    });

    const turnActivities: MessageActivitySummary[] = [];
    let sessionId: string | null = initialResumeId;
    let usageIn = 0;
    let usageOut = 0;
    let usageCostUsd: number | null = null;
    let providerContextTokens = 0;

    try {
      const { finalText } = await this.runner.run(
        {
          agent,
          project,
          prompt: item.prompt,
          attachments: item.refId ? this.store.getMessage(item.refId)?.metadata?.attachments : undefined,
          resumeSessionId: initialResumeId,
          currentMessageId: item.kind === 'user' ? item.refId : null,
          replyMessageId: replyMsg.id,
          canonText: canon.text,
          canonChanged,
          providerOverride: item.modelOverride?.provider,
          modelOverride: item.modelOverride?.model,
          signal: controller.signal,
        },
        {
          onText: (delta) => {
            this.store.appendMessageDelta(replyMsg.id, delta);
          },
          onTool: (name, input) => {
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
          onMemoryTail: (tokens) => { memoryTokens.tail = tokens; },
          onContextTokens: (tokens) => { providerContextTokens = Math.max(providerContextTokens, tokens); },
        },
      );

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
      this.store.finalizeMessage(replyMsg.id, {
        text: finalText,
        streaming: false,
        durationMs,
        metadata: {
          ...(Object.keys(designArtifacts).length ? { designArtifacts } : {}),
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
      });

      const latestAgent = this.store.getAgent(agent.id) ?? agent;
      const nextSessions = { ...(latestAgent.sessions ?? {}) };
      if (sessionId && !switchingProvider) nextSessions[scopeKey] = sessionId;
      const sessionCanon = { ...(latestAgent.sessionCanon ?? {}) };
      if (sessionId && !switchingProvider) sessionCanon[scopeKey] = { sessionId, version: canonVersion };

      const postMessages = this.store.listAgentMessages(agent.id, projectId);
      const activeCompaction = latestAgent.contextCompactions?.[scopeKey];
      const activeScopeTokens = providerContextTokens || usageIn ||
        estimateActiveContextTokens(postMessages, activeCompaction);
      const nextScopeTokens = {
        ...(latestAgent.scopeTokens ?? {}),
        [scopeKey]: activeScopeTokens,
      };
      const activeConversationTokens = estimateConversationTokens(postMessages, activeCompaction);
      const nextConversationTokens = {
        ...(latestAgent.conversationTokens ?? {}),
        [scopeKey]: activeConversationTokens,
      };

      this.store.updateAgent(agent.id, {
        status: 'idle',
        currentTask: null,
        sessionId: (!switchingProvider ? sessionId : null) ?? latestAgent.sessionId,
        sessions: nextSessions,
        sessionCanon,
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
      this.store.recordUsageLog({
        provider: effectiveProvider,
        model: effectiveModel,
        agentId: agent.id,
        projectId,
        inputTokens: loggedIn,
        outputTokens: loggedOut,
        memoryTokens,
        estimatedCostUsd:
          usageCostUsd ?? estimateTurnCostUsd(effectiveProvider, effectiveModel, loggedIn, loggedOut),
      });
      if (process.env.ATELIER_LOG_LEVEL === 'debug') {
        console.debug('Atelier memory tokens', { scopeKey, agentId: agent.id, ...memoryTokens });
      }

      const postTrigger = autoCompactTrigger(
        postMessages,
        activeCompaction,
        activeScopeTokens,
        afterSettings.autoCompact,
      );
      if (postTrigger) {
        this.compactScope(latestAgent, projectId, 'auto', effectiveProvider, postTrigger);
      }

      if (item.replyToAgentId && finalText) {
        this.enqueue({
          agentId: item.replyToAgentId,
          projectId,
          kind: 'teammate',
          prompt: `${agent.name} replied: ${finalText}`,
          refId: item.refId,
        });
      }
    } catch (err) {
      const durationMs = Math.max(100, Date.now() - startedAt);
      const isAbort =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');

      if (this.shuttingDown) {
        return;
      }

      if (isAbort) {
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
    }
  }
}
