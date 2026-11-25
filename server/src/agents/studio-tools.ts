import {
  AGENT_AVATAR_SHAPES,
  AGENT_COLORS,
  BUILT_IN_SKILLS,
  type Agent,
  type AgentSkill,
  type Project,
  type QueueKind,
  type Task,
} from '@atelier/contracts';
import { z } from 'zod';
import {
  BROWSER_TOOL_DEFS,
  type BrowserToolContext,
  executeBrowserTool,
} from '../browser/tools.js';
import type { BrowserManager } from '../browser/manager.js';
import { runBrowserQa } from '../qa/browser-qa.js';
import { type AtelierStore, newId } from '../store.js';
import { CANON_KEY, CanonInputFields, CanonInputSchema } from '../memory-files.js';

const CanonKeySchema = z.object({ key: z.string().regex(CANON_KEY) });
const SearchHistorySchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(8).optional(),
});
const ArchiveIdSchema = z.object({ id: z.string().min(1).max(80) });
const GetSkillSchema = z.object({ id: z.string().trim().min(1).max(120) });
const SKILL_READ_LIMIT = 12000;

export const MEMORY_ACTIONS = {
  record_decision: CanonInputSchema,
  forget_decision: CanonKeySchema,
  search_history: SearchHistorySchema,
  get_message: ArchiveIdSchema,
  get_artifact: ArchiveIdSchema,
  get_skill: GetSkillSchema,
};
export type MemoryAction = keyof typeof MEMORY_ACTIONS;

export type EnqueueTaskFn = (input: {
  agentId: string;
  projectId: string | null;
  channelId?: string | null;
  triggerMessageId?: string | null;
  triggerRowid?: number | null;
  mentionIndex?: number;
  trust?: 'user' | 'teammate';
  rootMessageId?: string | null;
  hop?: number;
  kind: QueueKind;
  prompt: string;
  refId: string | null;
  replyToAgentId?: string | null;
}) => void;

export const CreateTaskToolSchema = z.object({
  projectId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional().default('medium'),
  assigneeAgentId: z.string().optional().nullable(),
  dispatch: z.boolean().optional().default(false),
});

export const UpdateTaskToolSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']).optional(),
  branch: z.string().optional().nullable(),
  prUrl: z.string().optional().nullable(),
  deliverableSummary: z.string().optional().nullable(),
});

export const MessageAgentToolSchema = z.object({
  targetAgentId: z.string().min(1),
  message: z.string().min(1),
});

export const RunBrowserQaToolSchema = z.object({
  url: z.string().optional(),
  watchLive: z.boolean().optional().default(false),
  taskId: z.string().optional().nullable(),
  steps: z
    .array(
      z.object({
        action: z.enum([
          'goto',
          'wait',
          'click',
          'fill',
          'press',
          'assertText',
          'assertVisible',
          'screenshot',
        ]),
        selector: z.string().optional(),
        value: z.string().optional(),
        label: z.string().optional(),
        timeoutMs: z.number().int().optional(),
      }),
    )
    .max(30)
    .optional(),
});

export const CreateAgentToolSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  color: z.enum(AGENT_COLORS).optional().default('blue'),
  avatarShape: z.enum(AGENT_AVATAR_SHAPES).optional(),
  systemInstructions: z.string().optional().default(''),
  allowShell: z.boolean().optional().default(false),
  skillIds: z.array(z.string()).optional(),
  customSkills: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional().default(''),
        content: z.string().min(1),
      }),
    )
    .optional(),
  mcpServerNames: z.array(z.string()).optional(),
  providerOverride: z
    .enum(['claude', 'openai', 'antigravity', 'deepseek', 'opencode', 'openrouter'])
    .nullable()
    .optional(),
  modelOverride: z.string().nullable().optional(),
});

export interface StudioTools {
  memoryAction(name: MemoryAction, input: unknown): unknown;
  project_info(): {
    project: Project | null;
    projects?: Project[];
    agents: Agent[];
    tasks: Task[];
  };
  create_agent(input: z.infer<typeof CreateAgentToolSchema>): { agent: Agent };
  create_task(input: z.infer<typeof CreateTaskToolSchema>): { task: Task };
  update_task(input: z.infer<typeof UpdateTaskToolSchema>): { task: Task };
  message_agent(input: z.infer<typeof MessageAgentToolSchema>): { queued: boolean; targetAgentId: string | null };
  run_browser_qa(input: z.infer<typeof RunBrowserQaToolSchema>): { queued: boolean; url: string };
}

export function createStudioTools(deps: {
  store: AtelierStore;
  projectId: string | null;
  actingAgentId: string;
  enqueue: EnqueueTaskFn;
  dataDir?: string;
  trust?: 'user' | 'teammate';
  channelId?: string | null;
  rootMessageId?: string | null;
  hop?: number;
  postRoomTeammateMessage?: (target: Agent, message: string) => { queued: boolean; targetAgentId: string | null };
}): StudioTools {
  const { store, projectId, actingAgentId, enqueue, dataDir = './data', trust = 'user' } = deps;

  return {
    memoryAction(name, rawInput) {
      switch (name) {
        case 'record_decision': {
          const input = CanonInputSchema.parse(rawInput);
          const existing = store.listCanon(projectId ?? 'direct').find((entry) => entry.key === input.key);
          const artifactId = input.kind === 'asset' && existing?.path === input.path ? existing?.artifactId : undefined;
          return store.upsertCanon(projectId, { ...input, artifactId, source: 'agent_recorded' });
        }
        case 'forget_decision': {
          const { key } = CanonKeySchema.parse(rawInput);
          const entry = store.listCanon(projectId ?? 'direct').find((item) => item.key === key);
          if (entry) store.deleteCanon(entry.id);
          return { forgotten: !!entry };
        }
        case 'search_history': {
          const { query, limit } = SearchHistorySchema.parse(rawInput);
          return store.searchHistory(projectId, query, limit ?? 5);
        }
        case 'get_message': {
          const { id } = ArchiveIdSchema.parse(rawInput);
          const message = store.getMessage(id);
          if (!message || message.projectId !== projectId || message.streaming) return { found: false };
          return { id, author: message.author, createdAt: message.createdAt, text: message.text.slice(0, 6000),
            truncated: message.text.length > 6000 };
        }
        case 'get_skill': {
          const { id } = GetSkillSchema.parse(rawInput);
          const wanted = id.toLowerCase();
          const skill = store
            .getAgent(actingAgentId)
            ?.skills.find((s) => s.enabled && (s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted));
          if (!skill) return { found: false };
          const content = skill.content.trim();
          return {
            found: true,
            id: skill.id,
            name: skill.name,
            content: content.slice(0, SKILL_READ_LIMIT),
            truncated: content.length > SKILL_READ_LIMIT,
          };
        }
        case 'get_artifact': {
          const { id } = ArchiveIdSchema.parse(rawInput);
          const artifact = store.getArtifact(id);
          if (!artifact || artifact.projectId !== projectId) return { found: false };
          if (artifact.kind === 'svg' || artifact.kind === 'html') {
            const content = store.readArtifact(artifact).subarray(0, 6000).toString('utf8');
            let path: string | undefined;
            try {
              path = store.materializeArtifact(artifact);
            } catch {
              // Text remains available even when the local file cache is inaccessible.
            }
            return { ...artifact, content, truncated: artifact.sizeBytes > 6000, path };
          }
          return { ...artifact, path: store.materializeArtifact(artifact) };
        }
      }
    },
    project_info() {
      if (!projectId) {
        return {
          project: null,
          projects: store.listAgentProjects(actingAgentId),
          agents: store.listAgents(),
          tasks: store.listAgentTasks(actingAgentId),
        };
      }
      const project = store.getProject(projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }
      return {
        project,
        agents: store.listProjectAgents(projectId),
        tasks: store.listProjectTasks(projectId),
      };
    },

    create_agent(rawInput) {
      if (trust === 'teammate') {
        throw new Error('needs_user_approval: Creating agents requires explicit user approval.');
      }
      const input = CreateAgentToolSchema.parse(rawInput);

      const resolvedSkills: AgentSkill[] = [];
      const seenSkillNames = new Set<string>();
      for (const sid of input.skillIds ?? []) {
        const match = BUILT_IN_SKILLS.find(
          (s) => s.id === sid || s.name.toLowerCase() === sid.trim().toLowerCase(),
        );
        if (match && !seenSkillNames.has(match.name.toLowerCase())) {
          seenSkillNames.add(match.name.toLowerCase());
          resolvedSkills.push({ ...match, enabled: true });
        }
      }
      for (const cs of input.customSkills ?? []) {
        const name = cs.name.trim();
        if (name && !seenSkillNames.has(name.toLowerCase())) {
          seenSkillNames.add(name.toLowerCase());
          resolvedSkills.push({
            id: newId('skill'),
            name,
            description: cs.description ?? '',
            content: cs.content,
            enabled: true,
          });
        }
      }

      const configuredMcp = store.getSettings().mcpServers;
      const resolvedMcpIds: string[] = [];
      for (const ref of input.mcpServerNames ?? []) {
        const clean = ref.trim().toLowerCase();
        const found = configuredMcp.find(
          (m) => m.id === ref || m.name.toLowerCase() === clean,
        );
        if (found && !resolvedMcpIds.includes(found.id)) {
          resolvedMcpIds.push(found.id);
        }
      }

      const existing = store
        .listAgents()
        .find((a) => a.name.toLowerCase() === input.name.toLowerCase());

      const agent = existing
        ? store.updateAgentConfig(existing.id, {
            role: input.role,
            color: input.color,
            ...(input.avatarShape !== undefined ? { avatarShape: input.avatarShape } : {}),
            systemInstructions: input.systemInstructions,
            allowShell: input.allowShell,
            ...(input.skillIds !== undefined || input.customSkills !== undefined
              ? { skills: resolvedSkills }
              : {}),
            ...(input.mcpServerNames !== undefined ? { mcpServerIds: resolvedMcpIds } : {}),
            ...(input.providerOverride !== undefined
              ? { providerOverride: input.providerOverride }
              : {}),
            ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
          })
        : store.createAgent(projectId, {
            name: input.name,
            role: input.role,
            color: input.color,
            ...(input.avatarShape !== undefined ? { avatarShape: input.avatarShape } : {}),
            systemInstructions: input.systemInstructions,
            allowShell: input.allowShell,
            skills: resolvedSkills,
            mcpServerIds: resolvedMcpIds,
            providerOverride: input.providerOverride ?? null,
            modelOverride: input.modelOverride ?? null,
          });

      if (!agent) {
        throw new Error(`Project not found: ${projectId}`);
      }

      if (existing && projectId) {
        store.assignAgentToProject(projectId, agent.id);
      }

      store.addActivity({
        projectId,
        agentId: actingAgentId,
        kind: 'status',
        label: `Installed agent ${agent.name}`,
        detail: agent.role,
      });

      return { agent };
    },

    create_task(rawInput) {
      const input = CreateTaskToolSchema.parse(rawInput);
      const targetProjectId = input.projectId ?? projectId;
      if (!targetProjectId) {
        throw new Error('Specify a projectId to create a task outside a project.');
      }

      const candidates = store.listProjectAgents(targetProjectId);
      const allAgents = store.listAgents();
      let assigneeId: string | null = input.assigneeAgentId ?? null;
      if (assigneeId && !allAgents.some((a) => a.id === assigneeId)) {
        const byName =
          candidates.find((a) => a.name.toLowerCase() === assigneeId!.toLowerCase()) ??
          allAgents.find((a) => a.name.toLowerCase() === assigneeId!.toLowerCase());
        assigneeId = byName?.id ?? null;
      }

      if (assigneeId) {
        store.assignAgentToProject(targetProjectId, assigneeId);
      }

      const task = store.createTask(targetProjectId, {
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: input.dispatch && assigneeId ? 'in_progress' : 'todo',
        assigneeAgentId: assigneeId,
      });
      if (!task) {
        throw new Error(`Project not found: ${targetProjectId}`);
      }

      store.addActivity({
        projectId: targetProjectId,
        agentId: actingAgentId,
        kind: 'task',
        label: `Created ${task.identifier}: ${task.title}`,
      });

      if (input.dispatch && assigneeId) {
        const prompt = [
          `Assigned Task [${task.identifier}] (${task.id}): ${task.title}`,
          `Priority: ${task.priority}`,
          task.description ? `Description:\n${task.description}` : '',
          `When complete, update task ${task.id} with status "in_review" (or "done") and deliverableSummary.`,
        ]
          .filter(Boolean)
          .join('\n\n');

        enqueue({
          agentId: assigneeId,
          projectId: targetProjectId,
          kind: 'task',
          prompt,
          refId: task.id,
        });
      }

      return { task };
    },

    update_task(rawInput) {
      const input = UpdateTaskToolSchema.parse(rawInput);
      // Support matching either task id or identifier (e.g. AT-1)
      let target = store.getTask(input.taskId);
      if (!target && projectId) {
        target =
          store
            .listProjectTasks(projectId)
            .find((t) => t.identifier.toLowerCase() === input.taskId.toLowerCase()) ?? null;
      }
      if (!target) {
        target =
          store
            .listAgentTasks(actingAgentId)
            .find((t) => t.identifier.toLowerCase() === input.taskId.toLowerCase()) ?? null;
      }
      if (!target) {
        throw new Error(`Task not found: ${input.taskId}`);
      }

      const updated = store.updateTask(target.id, {
        status: input.status,
        branch: input.branch,
        prUrl: input.prUrl,
        deliverableSummary: input.deliverableSummary,
      });
      if (!updated) {
        throw new Error(`Task not found: ${input.taskId}`);
      }

      store.addActivity({
        projectId: target.projectId,
        agentId: actingAgentId,
        kind: input.prUrl ? 'pr' : 'task',
        label: `${updated.identifier} -> ${updated.status}`,
        detail: input.deliverableSummary ?? input.prUrl ?? undefined,
      });

      return { task: updated };
    },

    message_agent(rawInput) {
      const input = MessageAgentToolSchema.parse(rawInput);
      const projectAgents = projectId ? store.listProjectAgents(projectId) : [];
      const allAgents = store.listAgents();
      const target =
        projectAgents.find((a) => a.id === input.targetAgentId) ??
        projectAgents.find((a) => a.name.toLowerCase() === input.targetAgentId.toLowerCase()) ??
        allAgents.find((a) => a.id === input.targetAgentId) ??
        allAgents.find((a) => a.name.toLowerCase() === input.targetAgentId.toLowerCase()) ??
        null;

      if (!target) {
        return { queued: false, targetAgentId: null };
      }

      const sender = store.getAgent(actingAgentId);
      store.addActivity({
        projectId,
        agentId: actingAgentId,
        kind: 'task',
        label: `Messaged ${target.name}`,
        detail: input.message.slice(0, 120),
      });

      if (projectId && deps.postRoomTeammateMessage) {
        return deps.postRoomTeammateMessage(target, input.message);
      }

      if (projectId) {
        const room = store.channels.getRoomByProject(projectId);
        if (room) {
          const mentionText = `@${target.name} ${input.message}`;
          const { message: posted, rowid } = store.channels.postMessage({
            channelId: room.id,
            author: 'agent',
            agentId: actingAgentId,
            text: mentionText,
            metadata: {
              mentions: [target.id],
              toAgentIds: [target.id],
              rootMessageId: deps.rootMessageId ?? undefined,
              hop: (deps.hop ?? 0) + 1,
            },
          });
          enqueue({
            agentId: target.id,
            projectId,
            channelId: room.id,
            triggerMessageId: posted.id,
            triggerRowid: rowid,
            trust: 'teammate',
            rootMessageId: deps.rootMessageId ?? posted.id,
            hop: (deps.hop ?? 0) + 1,
            kind: 'teammate',
            prompt: input.message,
            refId: posted.id,
          });
          return { queued: true, targetAgentId: target.id };
        }
      }

      enqueue({
        agentId: target.id,
        projectId,
        kind: 'teammate',
        prompt: `Message from ${sender?.name ?? 'teammate'}: ${input.message}`,
        refId: null,
        replyToAgentId: actingAgentId,
      });

      return { queued: true, targetAgentId: target.id };
    },

    run_browser_qa(rawInput) {
      const input = RunBrowserQaToolSchema.parse(rawInput);
      const proj = projectId ? store.getProject(projectId) : null;
      const targetUrl = (input.url || proj?.previewUrl || '').trim();
      if (!targetUrl) {
        throw new Error('Provide url or set a Preview URL on the project before running Browser QA.');
      }

      const targetProjectId = projectId ?? proj?.id ?? 'direct';
      store.addActivity({
        projectId,
        agentId: actingAgentId,
        kind: 'tool',
        label: `Started Browser QA (${input.watchLive ? 'Watch Live' : 'Headless'})`,
        detail: targetUrl,
      });

      void runBrowserQa({
        dataDir,
        projectId: targetProjectId,
        url: targetUrl,
        watchLive: input.watchLive,
        taskId: input.taskId ?? null,
        agentId: actingAgentId,
        steps: input.steps,
      })
        .then((run) => {
          if (projectId) {
            store.saveQaRun(run);
          }
          store.addActivity({
            projectId,
            agentId: actingAgentId,
            kind: run.passed ? 'task' : 'error',
            label: `Browser QA ${run.passed ? 'Passed' : 'Failed'}`,
            detail: run.summary,
          });
          store.createMessage({
            projectId,
            agentId: actingAgentId,
            author: 'system',
            text: `Browser QA ${run.passed ? 'Passed' : 'Failed'} on ${run.url} — ${run.summary}`,
            streaming: false,
            durationMs: run.durationMs,
            metadata: {
              qaRun: run,
              taskId: input.taskId ?? undefined,
            },
          });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          store.addActivity({
            projectId,
            agentId: actingAgentId,
            kind: 'error',
            label: 'Browser QA Error',
            detail: msg,
          });
          store.createMessage({
            projectId,
            agentId: actingAgentId,
            author: 'system',
            text: `Browser QA failed to start on ${targetUrl}: ${msg}`,
            streaming: false,
          });
        });

      return { queued: true, url: targetUrl };
    },
  };
}

export async function createAtelierSdkMcpServer(
  tools: StudioTools,
  extraBrowser?: { browserManager: BrowserManager; ctx: BrowserToolContext },
): Promise<unknown | null> {
  try {
    const modName = '@anthropic-ai/claude-agent-sdk';
    const sdk = (await import(modName)) as {
      createSdkMcpServer?: (opts: Record<string, unknown>) => unknown;
      tool?: (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) => unknown;
    };
    if (typeof sdk.createSdkMcpServer !== 'function' || typeof sdk.tool !== 'function') {
      return null;
    }

    const wrapResult = (data: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    });

    return sdk.createSdkMcpServer({
      name: 'atelier',
      version: '0.2.0',
      tools: [
        ...(Object.keys(MEMORY_ACTIONS) as MemoryAction[]).map((name) =>
          sdk.tool!(name, {
            record_decision: 'Save a durable project decision, rule, or asset reference.',
            forget_decision: 'Remove a Canon entry by key at the user’s request.',
            search_history: 'Search archived messages within the current scope.',
            get_message: 'Read an archived message by ID.',
            get_artifact: 'Read an archived artifact by ID.',
            get_skill: 'Read the full instructions of an installed skill by ID before using it.',
          }[name], name === 'record_decision' ? CanonInputFields.shape : MEMORY_ACTIONS[name].shape, async (args) => {
            try {
              return wrapResult(tools.memoryAction(name, args));
            } catch {
              return { ...wrapResult({ error: 'Invalid memory action or unavailable data.' }), isError: true };
            }
          }),
        ),
        sdk.tool(
          'project_info',
          'Get project details, team agents, and tasklist.',
          {},
          async () => wrapResult(tools.project_info()),
        ),
        sdk.tool(
          'create_agent',
          'Create or update a specialist bot in this project with instructions, skills, and MCP server links.',
          CreateAgentToolSchema.shape,
          async (args) => wrapResult(tools.create_agent(CreateAgentToolSchema.parse(args))),
        ),
        sdk.tool(
          'create_task',
          'Create a task in the project Linear tasklist and optionally dispatch it.',
          CreateTaskToolSchema.shape,
          async (args) => wrapResult(tools.create_task(CreateTaskToolSchema.parse(args))),
        ),
        sdk.tool(
          'update_task',
          'Update task status, branch, PR URL, or deliverable summary.',
          UpdateTaskToolSchema.shape,
          async (args) => wrapResult(tools.update_task(UpdateTaskToolSchema.parse(args))),
        ),
        sdk.tool(
          'message_agent',
          'Send a message or question to another agent on the team.',
          MessageAgentToolSchema.shape,
          async (args) => wrapResult(tools.message_agent(MessageAgentToolSchema.parse(args))),
        ),
        sdk.tool(
          'run_browser_qa',
          'Run a real Chromium/Edge browser E2E QA check against a local preview URL and attach console, network, and screenshot reports.',
          RunBrowserQaToolSchema.shape,
          async (args) => wrapResult(tools.run_browser_qa(RunBrowserQaToolSchema.parse(args))),
        ),
        ...(extraBrowser
          ? BROWSER_TOOL_DEFS.map((def) =>
              sdk.tool!(def.name, def.description, def.schema.shape, async (args) => {
                const res = await executeBrowserTool(
                  extraBrowser.browserManager,
                  def.name,
                  args,
                  extraBrowser.ctx,
                );
                return {
                  content: [{ type: 'text', text: res.text }],
                  ...(res.isError ? { isError: true } : {}),
                };
              }),
            )
          : []),
      ],
    });
  } catch {
    return null;
  }
}
