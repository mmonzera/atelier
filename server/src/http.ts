import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_AVATAR_SHAPES,
  AGENT_COLORS,
  AGENT_TEMPLATES,
  CHIEF_OF_STAFF_GREETING,
  type AgentSkill,
  type ApiErrorResponse,
  type McpServerConfig,
  type Settings,
  type UsageRange,
} from '@atelier/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { discoverLocalCodexModels } from './agents/cli-runners.js';
import { getModelCatalog } from './agents/model-catalog.js';
import { ProviderAuthManager } from './agents/provider-auth.js';
import type { AgentRuntime } from './agents/runtime.js';
import { buildUsageDashboard } from './agents/usage.js';
import { type AppConfig, isAllowedHost, isAllowedOrigin } from './config.js';
import { cloneRepo, getGhStatus, linkLocalRepo, listRepos } from './github.js';
import {
  OAuthClientRequiredError,
  completeMcpOAuth,
  disconnectMcpOAuth,
  getMcpOAuthStatus,
  resolveMcpAuth,
  startMcpOAuth,
} from './mcp/oauth.js';
import { probeMcpServer } from './mcp/probe.js';
import { detectLocalBrowser, resolveQaArtifactPath, runBrowserQa } from './qa/browser-qa.js';
import type { AtelierStore } from './store.js';
import { lockGate } from './security/routes.js';
import type { LocalVault } from './security/vault.js';
import { ATTACHMENT_ONLY_TEXT } from '@atelier/contracts';
import { AttachmentError, AttachmentStore } from './attachments.js';
import { createAttachmentRoutes } from './attachments-routes.js';
import { createLibraryRoutes } from './library-routes.js';
import { CanonInputSchema } from './memory-files.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

function parseSkillMarkdown(raw: string, fallbackName: string): {
  name: string;
  description: string;
  content: string;
} {
  let name = fallbackName;
  let description = '';
  let content = raw;

  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    content = fmMatch[2].trim();
    const nameLine = fm.match(/^name:\s*(.+)$/m);
    const descLine = fm.match(/^description:\s*(.+)$/m);
    if (nameLine) name = nameLine[1].trim().replace(/^["']|["']$/g, '');
    if (descLine) description = descLine[1].trim().replace(/^["']|["']$/g, '');
  } else {
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (h1) name = h1[1].trim();
  }

  return { name, description, content: content.trim() };
}

export function createHttpRouter(deps: {
  store: AtelierStore;
  runtime: AgentRuntime;
  config: AppConfig;
  authManager?: ProviderAuthManager;
  /** Optional app lock: when set, every route except the lock screen's requires a session. */
  vault?: LocalVault;
  /** Auth + backup routes, mounted behind the origin check (and the lock gate for non-public ones). */
  securityRoutes?: Hono;
  /** Remote browser routes, mounted behind the origin check and lock gate. */
  browserRoutes?: Hono;
  /** Local STT routes, mounted behind the origin check and lock gate. */
  sttRoutes?: Hono;
  /** Meeting transcription routes, mounted behind the origin check and lock gate. */
  meetingRoutes?: Hono;
}): Hono {
  const { store, runtime, config } = deps;
  const authManager = deps.authManager ?? new ProviderAuthManager();
  const api = new Hono();

  api.use('*', async (c, next) => {
    const host = c.req.header('host');
    const origin = c.req.header('origin');
    if (!isAllowedHost(host, config.port) || !isAllowedOrigin(origin, config.port)) {
      return c.json(
        apiError('forbidden_origin', 'Requests are restricted to localhost Atelier origins.'),
        403,
      );
    }
    await next();
  });

  if (deps.vault) api.use('*', lockGate(deps.vault));
  if (deps.securityRoutes) api.route('/', deps.securityRoutes);
  if (deps.browserRoutes) api.route('/', deps.browserRoutes);
  if (deps.sttRoutes) api.route('/', deps.sttRoutes);
  if (deps.meetingRoutes) api.route('/', deps.meetingRoutes);
  api.route('/', createAttachmentRoutes({ store, config }));
  api.route('/', createLibraryRoutes({ store, config }));

  api.get('/health', (c) => {
    const settings = store.getSettings();
    return c.json({
      ok: true,
      service: 'atelier',
      hostname: os.hostname(),
      events: store.getEventCount(),
      provider: settings.provider,
      model: settings.model,
    });
  });

  api.get('/state', (c) => {
    return c.json(store.getSnapshot());
  });

  api.get('/onboarding-status', async (c) => {
    const settings = store.getSettings();
    const gh = await getGhStatus();

    return c.json({
      hostname: os.hostname(),
      github: gh,
      agent: {
        provider: settings.provider,
        hasAnthropicKey: Boolean(config.anthropicApiKey),
        model: settings.model,
      },
    });
  });

  const providerSchema = z.enum(['claude', 'openai', 'antigravity', 'deepseek', 'opencode', 'openrouter']);

  const modelRefSchema = z.object({
    provider: providerSchema,
    model: z.string().trim().min(1).regex(/^[a-zA-Z0-9._:/-]+$/),
  });

  const skillSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(240).default(''),
    content: z.string(),
    sourcePath: z.string().nullable().optional(),
    enabled: z.boolean().default(true),
  });

  const browserAccessSchema = z.object({
    enabled: z.boolean().default(false),
    allowedHosts: z.array(z.string().trim().max(200)).max(50).default([]),
    credentialIds: z.array(z.string().trim().max(80)).max(50).default([]),
    confirmSensitive: z.boolean().default(true),
    defaultProfileId: z.string().trim().max(80).nullable().optional(),
  });

  const agentInputSchema = z.object({
    projectId: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(60),
    role: z.string().trim().min(1).max(80),
    color: z.enum(AGENT_COLORS).optional().default('green'),
    avatarShape: z.enum(AGENT_AVATAR_SHAPES).optional(),
    systemInstructions: z.string().optional().default(''),
    skills: z.array(skillSchema).optional().default([]),
    mcpServerIds: z.array(z.string()).optional().default([]),
    allowShell: z.boolean().optional().default(true),
    browser: browserAccessSchema.optional(),
    providerOverride: providerSchema.nullable().optional(),
    modelOverride: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._:/-]+$/)
      .nullable()
      .optional(),
    fallbackChain: z.array(modelRefSchema).max(5).optional(),
  });

  // Projects
  api.post('/projects', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80),
        localPath: z.string().trim().min(1).optional(),
        starterAgents: z.array(agentInputSchema).optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_project', 'Project name must be a non-empty string.'), 400);
    }

    // Validate the folder before creating anything, so a bad path leaves no orphan project.
    let repo: Awaited<ReturnType<typeof linkLocalRepo>> | null = null;
    if (parsed.data.localPath) {
      try {
        repo = await linkLocalRepo(parsed.data.localPath);
      } catch (err) {
        return c.json(
          apiError('repo_link_failed', err instanceof Error ? err.message : 'Invalid folder.'),
          400,
        );
      }
    }

    const result = store.createProject({
      name: parsed.data.name,
      starterAgents: parsed.data.starterAgents,
    });
    const project = repo
      ? (store.updateProject(result.project.id, { repo }) ?? result.project)
      : result.project;
    return c.json({ project, agents: result.agents }, 201);
  });

  api.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        previewUrl: z.string().trim().nullable().optional(),
        allowFullPermissions: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_project_update', 'Invalid project update payload.'), 400);
    }

    const project = store.updateProject(id, parsed.data);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${id} not found.`), 404);
    }
    return c.json({ project });
  });

  api.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const existing = store.getProject(id);
    if (!existing) {
      return c.json(apiError('project_not_found', `Project ${id} not found.`), 404);
    }

    const body = await c.req.json().catch(() => null);
    const bodyParsed = z.object({ deleteRepo: z.boolean().optional() }).safeParse(body);
    const deleteRepo =
      (bodyParsed.success && bodyParsed.data.deleteRepo) ||
      c.req.query('deleteRepo') === 'true';

    if (deleteRepo && existing.repo?.localPath) {
      const workspacesRoot = path.resolve(config.workspacesDir);
      const target = path.resolve(existing.repo.localPath);
      if (target.startsWith(workspacesRoot + path.sep) && fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }

    store.deleteProject(id);
    return c.json({ ok: true, id });
  });

  // Agents & Skills CRUD (Global + Project Assignment)
  api.post('/agents', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = agentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_agent', 'Agent name and role are required.'), 400);
    }

    const agent = store.createAgent(parsed.data.projectId ?? null, parsed.data);
    if (!agent) {
      return c.json(apiError('project_not_found', 'Target project not found.'), 404);
    }
    return c.json({ agent }, 201);
  });

  api.post('/projects/:id/agents', async (c) => {
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = agentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_agent', 'Agent name and role are required.'), 400);
    }

    const agent = store.createAgent(projectId, parsed.data);
    if (!agent) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }
    return c.json({ agent }, 201);
  });

  api.post('/projects/:id/agents/:agentId', (c) => {
    const projectId = c.req.param('id');
    const agentId = c.req.param('agentId');
    const project = store.assignAgentToProject(projectId, agentId);
    if (!project) {
      return c.json(apiError('not_found', 'Project or agent not found.'), 404);
    }
    return c.json({ project });
  });

  api.delete('/projects/:id/agents/:agentId', (c) => {
    const projectId = c.req.param('id');
    const agentId = c.req.param('agentId');
    const project = store.unassignAgentFromProject(projectId, agentId);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }
    return c.json({ project });
  });

  api.patch('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = agentInputSchema.partial().safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_agent_update', 'Invalid agent update payload.'), 400);
    }

    const agent = store.updateAgentConfig(id, parsed.data);
    if (!agent) {
      return c.json(apiError('agent_not_found', `Agent ${id} not found.`), 404);
    }
    return c.json({ agent });
  });

  api.delete('/agents/:id', (c) => {
    const id = c.req.param('id');
    const ok = store.deleteAgent(id);
    if (!ok) {
      return c.json(apiError('agent_not_found', `Agent ${id} not found.`), 404);
    }
    return c.json({ ok: true, id });
  });

  api.post('/skills/read-file', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ filePath: z.string().trim().min(1) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_path', 'Provide a local skill markdown path.'), 400);
    }

    const resolved = path.resolve(parsed.data.filePath);
    if (!/\.(md|txt)$/i.test(resolved)) {
      return c.json(apiError('unsupported_file', 'Only .md or .txt skill files are supported.'), 400);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return c.json(apiError('file_not_found', `File not found: ${resolved}`), 404);
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 256 * 1024) {
      return c.json(apiError('file_too_large', 'Skill file exceeds 256 KB limit.'), 400);
    }

    const raw = fs.readFileSync(resolved, 'utf8');
    const fallbackName = path.basename(resolved, path.extname(resolved));
    const parsedSkill = parseSkillMarkdown(raw, fallbackName);
    return c.json({
      skill: {
        ...parsedSkill,
        sourcePath: resolved,
      },
    });
  });

  // GitHub
  // Native folder picker (server runs on the user's own machine).
  api.post('/fs/pick-folder', async (c) => {
    if (process.platform !== 'win32') {
      return c.json(apiError('unsupported', 'Folder picker is only available on Windows.'), 501);
    }
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description='Pilih folder project';$d.ShowNewFolderButton=$true;" +
      "$f=New-Object System.Windows.Forms.Form;$f.TopMost=$true;" +
      "if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}";
    const picked = await new Promise<string>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { timeout: 120_000, windowsHide: false },
        (_err, stdout) => resolve(String(stdout ?? '').trim()),
      );
    });
    return c.json({ path: picked || null });
  });

  api.get('/github/status', async (c) => {
    return c.json(await getGhStatus());
  });

  api.get('/github/repos', async (c) => {
    try {
      const repos = await listRepos();
      return c.json({ repos });
    } catch (err) {
      return c.json(
        {
          repos: [],
          error: err instanceof Error ? err.message : 'Unable to list GitHub repositories',
        },
        200,
      );
    }
  });

  api.post('/projects/:id/repo', async (c) => {
    const id = c.req.param('id');
    const project = store.getProject(id);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${id} not found.`), 404);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        fullName: z.string().trim().min(1).optional(),
        localPath: z.string().trim().min(1).optional(),
        defaultBranch: z.string().trim().optional(),
      })
      .safeParse(body);

    if (!parsed.success || (!parsed.data.fullName && !parsed.data.localPath)) {
      return c.json(apiError('invalid_repo', 'Provide fullName or localPath.'), 400);
    }

    try {
      const repo = parsed.data.localPath
        ? await linkLocalRepo(
            parsed.data.localPath,
            parsed.data.fullName,
            parsed.data.defaultBranch || 'main',
          )
        : await cloneRepo(
            config.workspacesDir,
            project.id,
            parsed.data.fullName!,
            parsed.data.defaultBranch || 'main',
          );

      const updated = store.updateProject(project.id, { repo });
      return c.json({ project: updated });
    } catch (err) {
      return c.json(
        apiError(
          'repo_link_failed',
          err instanceof Error ? err.message : 'Failed to link repository.',
        ),
        400,
      );
    }
  });

  // Detach a repo without touching files on disk (relink wizard: "skip for now").
  api.delete('/projects/:id/repo', (c) => {
    const updated = store.updateProject(c.req.param('id'), { repo: null });
    if (!updated) {
      return c.json(apiError('project_not_found', `Project ${c.req.param('id')} not found.`), 404);
    }
    return c.json({ project: updated });
  });

  // Project and direct-chat Canon.
  api.post('/projects/:id/canon/pick', async (c) => {
    const scope = c.req.param('id');
    const projectId = scope === 'direct' ? null : scope;
    const parsed = z.object({
      messageId: z.string().min(1), optionId: z.string().min(1).max(12),
      segmentIndex: z.number().int().nonnegative().optional(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('invalid_pick', 'Invalid design selection.'), 400);
    const { messageId, optionId, segmentIndex } = parsed.data;
    const message = store.getMessage(messageId);
    if (!message || message.projectId !== projectId || (projectId && !store.getProject(projectId))) {
      return c.json(apiError('not_found', 'Design message not found.'), 404);
    }
    try {
      const { entry, option, notify } = store.pickDesign(projectId, message, optionId, segmentIndex);
      if (notify && message.agentId) runtime.enqueue({
        agentId: message.agentId,
        projectId,
        kind: 'user',
        prompt: `Saya pilih opsi ${option.id} — ${option.label}. Lanjutkan dengan opsi ini.`,
        metadata: { designPick: { messageId, optionId, segmentIndex, canonId: entry.id } },
      });
      return c.json({ entry });
    } catch (err) {
      return c.json(apiError('invalid_pick', err instanceof Error ? err.message : 'Could not save design selection.'), 400);
    }
  });

  api.patch('/projects/:id/canon/:entryId', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json(apiError('invalid_canon', 'Invalid Canon update.'), 400);
    }
    const scope = c.req.param('id');
    const entry = store.listCanon(scope).find((item) => item.id === c.req.param('entryId'));
    if (!entry) return c.json(apiError('not_found', 'Canon entry not found.'), 404);
    const parsed = CanonInputSchema.safeParse({
      ...entry, ...body,
      key: entry.key, kind: entry.kind,
    });
    if (!parsed.success) return c.json(apiError('invalid_canon', 'Invalid Canon title, value, or path.'), 400);
    return c.json({ entry: store.upsertCanon(entry.projectId, {
      ...parsed.data, artifactId: entry.artifactId, source: 'user_edited',
    }) });
  });

  api.patch('/projects/:id/canon/:entryId/pin', async (c) => {
    const body = await c.req.json().catch(() => null) as { pinned?: unknown } | null;
    if (!body || typeof body.pinned !== 'boolean') {
      return c.json(apiError('invalid_canon', 'pinned must be a boolean.'), 400);
    }
    const entry = store.listCanon(c.req.param('id')).find((item) => item.id === c.req.param('entryId'));
    if (!entry) return c.json(apiError('not_found', 'Canon entry not found.'), 404);
    const updated = store.setCanonPinned(entry.id, body.pinned);
    return updated ? c.json({ entry: updated }) : c.json(apiError('not_found', 'Canon entry not found.'), 404);
  });

  api.get('/projects/:id/memory', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((v) => v.trim()).filter(Boolean).slice(0, 50);
    const items = store.memory.getByIds(c.req.param('id'), ids).map((item) => ({
      id: item.id, source: item.source, kind: item.kind, title: item.title,
      line: item.line, pinned: item.pinned, updatedAt: item.updatedAt,
    }));
    return c.json({ items });
  });

  api.post('/memory/rebuild', (c) => {
    store.memory.rebuild();
    return c.json({ ok: true });
  });

  api.delete('/projects/:id/canon/:entryId', (c) => {
    const entry = store.listCanon(c.req.param('id')).find((item) => item.id === c.req.param('entryId'));
    if (!entry) return c.json(apiError('not_found', 'Canon entry not found.'), 404);
    store.deleteCanon(entry.id);
    return c.json({ ok: true });
  });

  api.get('/projects/:id/canon-artifacts/:artifactId', (c) => {
    const artifact = store.getArtifact(c.req.param('artifactId'));
    const scope = c.req.param('id');
    if (!artifact || artifact.kind !== 'svg' || (artifact.projectId ?? 'direct') !== scope) {
      return c.json(apiError('not_found', 'SVG artifact not found.'), 404);
    }
    return new Response(new Uint8Array(store.readArtifact(artifact)), { headers: {
      'Content-Type': 'image/svg+xml',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    } });
  });

  // Agent messaging, stop, retry
  api.post('/agents/:id/messages', async (c) => {
    const agentId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        text: z.string().trim().default(''),
        projectId: z.string().trim().min(1).nullable().optional(),
        attachmentIds: z.array(z.string()).max(8).optional(),
        skillIds: z.array(z.string().trim().min(1).max(120)).max(5).optional(),
        mentionAgentIds: z.array(z.string().trim().min(1)).max(5).optional(),
      })
      .safeParse(body);

    if (!parsed.success || (!parsed.data.text && !parsed.data.attachmentIds?.length)) {
      return c.json(apiError('invalid_message', 'Message text is required.'), 400);
    }

    let attachments: ReturnType<AttachmentStore['resolve']> = [];
    try {
      attachments = new AttachmentStore(config.dataDir).resolve(parsed.data.attachmentIds ?? []);
    } catch (err) {
      if (err instanceof AttachmentError) return c.json(apiError(err.code, err.message), err.status);
      throw err;
    }

    if (parsed.data.projectId && !store.getProject(parsed.data.projectId)) {
      return c.json(
        apiError('project_not_found', `Project ${parsed.data.projectId} not found.`),
        404,
      );
    }

    const mentionIds = parsed.data.mentionAgentIds?.length
      ? Array.from(new Set(parsed.data.mentionAgentIds))
      : [];
    if (mentionIds.length > 0) {
      const projectAgentIds = parsed.data.projectId
        ? new Set(store.listProjectAgents(parsed.data.projectId).map((a) => a.id))
        : null;
      for (const targetId of mentionIds) {
        if (!store.getAgent(targetId)) {
          return c.json(apiError('agent_not_found', `Agent ${targetId} not found.`), 404);
        }
        if (projectAgentIds && !projectAgentIds.has(targetId)) {
          return c.json(
            apiError('invalid_mention', `Agent ${targetId} does not belong to project ${parsed.data.projectId}.`),
            400,
          );
        }
      }
    }

    // Skills invoked by hand with /skill must be installed on this agent (enabled or not).
    const invokedSkills: AgentSkill[] = [];
    if (parsed.data.skillIds?.length) {
      const owner = store.getAgent(agentId);
      if (!owner) return c.json(apiError('agent_not_found', 'Agent not found.'), 404);
      for (const id of new Set(parsed.data.skillIds)) {
        const skill = owner.skills.find((s) => s.id === id);
        if (!skill) return c.json(apiError('skill_not_found', `Skill ${id} is not installed on this agent.`), 404);
        invokedSkills.push(skill);
      }
    }

    try {
      const promptText = parsed.data.text || ATTACHMENT_ONLY_TEXT;
      if (parsed.data.projectId && store.getSettings().groupChat !== false) {
        const proj = store.getProject(parsed.data.projectId);
        if (!proj) {
          return c.json(
            apiError('project_not_found', `Project ${parsed.data.projectId} not found.`),
            404,
          );
        }
        const room = store.channels.ensureRoom(
          proj.id,
          proj.name,
          store.listProjectAgents(proj.id),
        );
        const owner = store.getAgent(agentId);
        if (!owner) {
          return c.json(apiError('agent_not_found', `Agent ${agentId} not found.`), 404);
        }
        const mentionTargets = mentionIds.length > 0 ? mentionIds : [agentId];
        const res = runtime.postToChannel(room.id, {
          text: promptText,
          mentionAgentIds: mentionTargets,
          attachments,
          skills: invokedSkills,
        });
        return c.json(
          {
            ok: true,
            agentId: res.dispatchedAgentIds[0] ?? agentId,
            messageId: res.message.id,
            ...(mentionIds.length > 0 ? { dispatchedAgentIds: res.dispatchedAgentIds } : {}),
            queueItemId: res.queueItemId,
          },
          202,
        );
      }

      const targetIds = mentionIds.length > 0 ? mentionIds : [agentId];
      const results = targetIds.map((targetId) =>
        runtime.enqueue({
          skills: targetId === agentId ? invokedSkills : [],
          agentId: targetId,
          projectId: parsed.data.projectId ?? null,
          kind: 'user',
          prompt: promptText,
          attachments,
        }),
      );
      return c.json(
        {
          ok: true,
          agentId: results[0]!.agent.id,
          ...(mentionIds.length > 0 ? { dispatchedAgentIds: results.map((r) => r.agent.id) } : {}),
          queueItemId: results[0]!.item.id,
        },
        202,
      );
    } catch (err) {
      return c.json(
        apiError('agent_not_found', err instanceof Error ? err.message : 'Agent not found.'),
        404,
      );
    }
  });

  // Project Group Chat Rooms & Channels
  api.get('/projects/:id/room', (c) => {
    const projectId = c.req.param('id');
    const project = store.getProject(projectId);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }
    const members = store.listProjectAgents(project.id);
    const channel = store.channels.ensureRoom(project.id, project.name, members);
    const sessions = store.channels.listRoomSessions(channel.id);
    const queue = runtime.getRoomQueueSnapshot(channel.id);
    return c.json({ channel, members, sessions, queue });
  });

  api.patch('/channels/:id', async (c) => {
    const channelId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        defaultResponderAgentId: z.string().nullable().optional(),
        settings: z
          .object({
            idleTimeoutMin: z.number().int().min(1).max(120).optional(),
            maxTurnMin: z.number().int().min(1).max(240).optional(),
            maxHops: z.number().int().min(1).max(20).optional(),
            maxTurnsPerChain: z.number().int().min(1).max(50).optional(),
            maxTokensPerChain: z.number().int().min(1000).max(2_000_000).optional(),
            parallel: z.boolean().optional(),
          })
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_channel_update', 'Invalid channel update payload.'), 400);
    }
    const updated = store.channels.updateChannel(channelId, parsed.data);
    if (!updated) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    return c.json({ channel: updated });
  });

  api.get('/channels/:id/messages', (c) => {
    const channelId = c.req.param('id');
    const channel = store.channels.getChannel(channelId);
    if (!channel) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    const beforeRaw = c.req.query('beforeRowid');
    const limitRaw = c.req.query('limit');
    const sessionId = c.req.query('sessionId') || undefined;
    const beforeRowid = beforeRaw ? Number(beforeRaw) : undefined;
    const limit = limitRaw ? Number(limitRaw) : 100;
    const res = store.channels.listChannelMessages(channelId, {
      beforeRowid: Number.isFinite(beforeRowid) ? beforeRowid : undefined,
      limit: Number.isFinite(limit) ? limit : 100,
      sessionId,
    });
    return c.json(res);
  });

  api.post('/channels/:id/messages', async (c) => {
    const channelId = c.req.param('id');
    const channel = store.channels.getChannel(channelId);
    if (!channel) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        text: z.string().trim().default(''),
        mentionAgentIds: z.array(z.string().trim().min(1)).max(5).optional(),
        attachmentIds: z.array(z.string()).max(8).optional(),
        skillIds: z.array(z.string().trim().min(1).max(120)).max(5).optional(),
        replyToMessageId: z.string().trim().min(1).optional(),
      })
      .safeParse(body);

    if (!parsed.success || (!parsed.data.text && !parsed.data.attachmentIds?.length)) {
      return c.json(apiError('invalid_message', 'Message text is required.'), 400);
    }

    let attachments: ReturnType<AttachmentStore['resolve']> = [];
    try {
      attachments = new AttachmentStore(config.dataDir).resolve(parsed.data.attachmentIds ?? []);
    } catch (err) {
      if (err instanceof AttachmentError) return c.json(apiError(err.code, err.message), err.status);
      throw err;
    }

    const mentionIds = parsed.data.mentionAgentIds?.length
      ? Array.from(new Set(parsed.data.mentionAgentIds))
      : [];
    if (mentionIds.length > 0) {
      const projectAgentIds = channel.projectId
        ? new Set(store.listProjectAgents(channel.projectId).map((a) => a.id))
        : null;
      for (const targetId of mentionIds) {
        if (!store.getAgent(targetId)) {
          return c.json(apiError('agent_not_found', `Agent ${targetId} not found.`), 404);
        }
        if (projectAgentIds && !projectAgentIds.has(targetId)) {
          return c.json(
            apiError('invalid_mention', `Agent ${targetId} does not belong to project ${channel.projectId}.`),
            400,
          );
        }
      }
    }

    const invokedSkills: AgentSkill[] = [];
    if (parsed.data.skillIds?.length) {
      const skillOwnerId = mentionIds[0] ?? channel.defaultResponderAgentId ?? channel.agentId;
      const owner = skillOwnerId ? store.getAgent(skillOwnerId) : null;
      if (owner) {
        for (const id of new Set(parsed.data.skillIds)) {
          const skill = owner.skills.find((s) => s.id === id);
          if (!skill) return c.json(apiError('skill_not_found', `Skill ${id} is not installed on this agent.`), 404);
          invokedSkills.push(skill);
        }
      }
    }

    const res = runtime.postToChannel(channelId, {
      text: parsed.data.text || ATTACHMENT_ONLY_TEXT,
      mentionAgentIds: mentionIds.length > 0 ? mentionIds : undefined,
      attachments,
      skills: invokedSkills,
      replyToMessageId: parsed.data.replyToMessageId,
    });
    return c.json(
      {
        ok: true,
        messageId: res.message.id,
        deliveredTo: res.dispatchedAgentIds,
        queueItemId: res.queueItemId,
      },
      202,
    );
  });

  api.post('/channels/:id/sessions', async (c) => {
    const channelId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        carryover: z.enum(['summary', 'clean']).optional().default('summary'),
        name: z.string().trim().max(80).optional(),
      })
      .safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(apiError('invalid_session_input', 'Invalid session options.'), 400);
    }
    const dm = store.channels.getChannel(channelId);
    if (dm?.kind === 'dm' && dm.agentId) {
      const res = runtime.startNewDmSession(dm.agentId, parsed.data.name);
      if (res === 'busy') {
        return c.json(apiError('agent_busy', 'Wait for the agent to finish before starting a new session.'), 409);
      }
      if (!res) return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
      return c.json(res, 201);
    }
    const res = runtime.startNewRoomSession(channelId, parsed.data.carryover);
    if (!res) {
      return c.json(apiError('channel_not_found', `Room channel ${channelId} not found.`), 404);
    }
    return c.json(res, 201);
  });

  api.patch('/channels/:id/sessions/:sessionId', async (c) => {
    const channel = store.channels.getChannel(c.req.param('id'));
    const session = store.channels.getRoomSession(c.req.param('sessionId'));
    if (!channel || !session || session.channelId !== channel.id) {
      return c.json(apiError('session_not_found', 'Session not found.'), 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ name: z.string().trim().max(80) }).safeParse(body);
    if (!parsed.success) return c.json(apiError('invalid_session_input', 'A session name is required.'), 400);
    return c.json({ session: store.channels.renameSession(session.id, parsed.data.name) });
  });

  api.post('/channels/:id/sessions/:sessionId/activate', (c) => {
    const channel = store.channels.getChannel(c.req.param('id'));
    if (!channel || channel.kind !== 'dm' || !channel.agentId) {
      return c.json(apiError('channel_not_found', 'Personal chat not found.'), 404);
    }
    const res = runtime.activateDmSession(channel.agentId, c.req.param('sessionId'));
    if (res === 'busy') {
      return c.json(apiError('agent_busy', 'Wait for the agent to finish before switching sessions.'), 409);
    }
    if (!res) return c.json(apiError('session_not_found', 'Session not found.'), 404);
    return c.json(res);
  });

  api.post('/channels/:id/forward', async (c) => {
    const channelId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        fromChannelId: z.string().trim().min(1),
        messageIds: z.array(z.string().trim().min(1)).min(1).max(20),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_forward', 'fromChannelId and messageIds are required.'), 400);
    }
    const agents = new Map(store.listAgents().map((a) => [a.id, a.name]));
    const res = store.channels.forwardMessages(channelId, {
      ...parsed.data,
      agentNameLookup: (id) => (id ? agents.get(id) ?? 'Agent' : 'Agent'),
    });
    if (!res) {
      return c.json(apiError('forward_failed', 'Target channel or source messages not found.'), 404);
    }
    return c.json({ ok: true, message: res.message }, 201);
  });

  api.post('/channels/:id/skip', (c) => {
    const channelId = c.req.param('id');
    if (!store.channels.getChannel(channelId)) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    const res = runtime.skipRoomTurn(channelId);
    return c.json({ ok: true, ...res });
  });

  api.post('/channels/:id/stop', async (c) => {
    const channelId = c.req.param('id');
    if (!store.channels.getChannel(channelId)) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    const res = await runtime.stopRoom(channelId);
    return c.json({ ok: true, ...res });
  });

  api.patch('/channels/:id/queue', async (c) => {
    const channelId = c.req.param('id');
    if (!store.channels.getChannel(channelId)) {
      return c.json(apiError('channel_not_found', `Channel ${channelId} not found.`), 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ order: z.array(z.string().trim().min(1)).max(50) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_queue_order', 'order array is required.'), 400);
    }
    store.reorderChannelQueue(channelId, parsed.data.order);
    const snapshot = runtime.getRoomQueueSnapshot(channelId);
    store.emitEvent({ type: 'room-queue-updated', payload: snapshot });
    return c.json({ ok: true, queue: snapshot });
  });

  api.post('/channels/:id/approvals/:messageId/approve', (c) => {
    const channelId = c.req.param('id');
    const res = runtime.approveRoomAction(channelId, c.req.param('messageId'));
    if (!res.ok) {
      const status = res.reason === 'already_approved' ? 409 : 404;
      return c.json(apiError(`approval_${res.reason ?? 'failed'}`, 'Approval request cannot be approved.'), status);
    }
    return c.json({ ok: true });
  });

  api.post('/channels/:id/chains/:rootMessageId/continue', (c) => {
    const channelId = c.req.param('id');
    const rootMessageId = c.req.param('rootMessageId');
    const ok = runtime.continueRoomChain(channelId, rootMessageId);
    if (!ok) {
      return c.json(apiError('chain_not_found', `Chain ${rootMessageId} not found.`), 404);
    }
    return c.json({ ok: true });
  });

  api.post('/agents/:id/stop', async (c) => {
    const agentId = c.req.param('id');
    const res = await runtime.stop(agentId);
    if (!res.agent) {
      return c.json(apiError('agent_not_found', `Agent ${agentId} not found.`), 404);
    }
    return c.json({ ok: true, stopped: res.stopped });
  });

  api.post('/agents/:id/retry', async (c) => {
    const agentId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        provider: providerSchema.optional(),
        model: z.string().trim().min(1).regex(/^[a-zA-Z0-9._:/-]+$/).optional(),
        makeDefault: z.boolean().optional(),
      })
      .safeParse(body ?? {});

    const modelOverride =
      parsed.success && parsed.data.provider && parsed.data.model
        ? { provider: parsed.data.provider, model: parsed.data.model }
        : undefined;

    const res = runtime.retry(agentId, {
      modelOverride,
      makeDefault: parsed.success ? Boolean(parsed.data.makeDefault) : false,
    });
    if (!res.agent) {
      return c.json(apiError('agent_not_found', `Agent ${agentId} not found.`), 404);
    }
    return c.json({ ok: true, agentId: res.agent.id, agent: res.agent });
  });

  api.delete('/agents/:id/fallback', (c) => {
    const agentId = c.req.param('id');
    const agent = runtime.dismissFallback(agentId);
    if (!agent) {
      return c.json(apiError('agent_not_found', `Agent ${agentId} not found.`), 404);
    }
    return c.json({ ok: true, agent });
  });

  api.post('/agents/:id/compact', async (c) => {
    const agentId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        projectId: z.string().trim().min(1).nullable().optional(),
      })
      .safeParse(body ?? {});

    if (!parsed.success) {
      return c.json(apiError('invalid_compact_input', 'Invalid compact payload.'), 400);
    }

    const projectId = parsed.data.projectId ?? null;
    if (projectId && !store.getProject(projectId)) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }

    try {
      const result = runtime.compact(agentId, projectId);
      return c.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to compact context.';
      if (message.includes('not found')) {
        return c.json(apiError('agent_not_found', message), 404);
      }
      if (message.includes('running a turn')) {
        return c.json(apiError('agent_busy', message), 409);
      }
      return c.json(apiError('compact_failed', message), 400);
    }
  });

  // Linear-Style Tasks CRUD & Dispatch
  api.post('/projects/:id/tasks', async (c) => {
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160),
        description: z.string().optional().default(''),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'])
          .optional()
          .default('todo'),
        priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional().default('medium'),
        assigneeAgentId: z.string().nullable().optional(),
        blockedBy: z.array(z.string().trim().min(1)).max(20).optional(),
        branch: z.string().nullable().optional(),
        prUrl: z.string().nullable().optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_task', 'Task title is required.'), 400);
    }

    const task = store.createTask(projectId, parsed.data);
    if (!task) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }
    return c.json({ task }, 201);
  });

  api.patch('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160).optional(),
        description: z.string().optional(),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'])
          .optional(),
        priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
        assigneeAgentId: z.string().nullable().optional(),
        blockedBy: z.array(z.string().trim().min(1)).max(20).optional(),
        branch: z.string().nullable().optional(),
        prUrl: z.string().nullable().optional(),
        deliverableSummary: z.string().nullable().optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_task_update', 'Invalid task update payload.'), 400);
    }

    let task: ReturnType<typeof store.updateTask>;
    try {
      task = store.updateTask(id, parsed.data);
    } catch (err) {
      return c.json(
        apiError('invalid_task_dependency', err instanceof Error ? err.message : 'Invalid task update.'),
        400,
      );
    }
    if (!task) {
      return c.json(apiError('task_not_found', `Task ${id} not found.`), 404);
    }
    return c.json({ task });
  });

  api.delete('/tasks/:id', (c) => {
    const id = c.req.param('id');
    const ok = store.deleteTask(id);
    if (!ok) {
      return c.json(apiError('task_not_found', `Task ${id} not found.`), 404);
    }
    return c.json({ ok: true, id });
  });

  api.post('/tasks/:id/dispatch', (c) => {
    const id = c.req.param('id');
    try {
      const res = runtime.dispatchTask(id);
      return c.json({ ok: true, task: res.task, agentId: res.agent.id }, 202);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to dispatch task.';
      const status = msg.includes('not found') ? 404 : 400;
      return c.json(apiError('dispatch_failed', msg), status);
    }
  });

  // Settings
  api.get('/settings', (c) => {
    const settings: Settings = store.getSettings();
    return c.json({ settings });
  });

  api.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const modelEntrySchema = z.object({
      id: z.string().trim().min(1).regex(/^[a-zA-Z0-9._:/-]+$/),
      label: z.string().trim().min(1).max(80),
      provider: providerSchema,
      builtIn: z.boolean().optional(),
    });
    const parsed = z
      .object({
        provider: providerSchema.optional(),
        model: z.string().trim().min(1).regex(/^[a-zA-Z0-9._:/-]+$/).optional(),
        reasoningEffort: z.enum(['Low', 'Medium', 'High']).optional(),
        customModels: z.array(modelEntrySchema).optional(),
        language: z.enum(['en', 'id']).optional(),
        visibleModels: z
          .record(z.string(), z.array(z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:/-]+$/)).max(3000))
          .optional(),
        cliPaths: z
          .object({
            claude: z.string().optional(),
            openai: z.string().optional(),
            antigravity: z.string().optional(),
            opencode: z.string().optional(),
          })
          .optional(),
        onboardingCompleted: z.boolean().optional(),
        autoCompact: z
          .object({
            enabled: z.boolean().optional(),
            maxMessages: z.number().int().min(4).max(200).optional(),
            keepRecentMessages: z.number().int().min(1).max(199).optional(),
            maxContextTokens: z.number().int().min(4000).max(500000).optional(),
            minCompactMessages: z.number().int().min(2).max(50).optional(),
            providerContextLimit: z.number().int().min(8000).max(2000000).optional(),
            tailTokens: z.number().int().min(1000).max(6000).optional(),
            summarizerModel: z.string().max(120).regex(/^[a-zA-Z0-9._:/-]*$/).optional(),
          })
          .optional(),
        memory: z
          .object({
            mode: z.enum(['full', 'selective']).optional(),
            pushBudgetTokens: z.number().int().min(200).max(8000).optional(),
            pinnedBudgetTokens: z.number().int().min(0).max(4000).optional(),
            catalogBudgetTokens: z.number().int().min(0).max(2000).optional(),
            topK: z.number().int().min(1).max(30).optional(),
            minScore: z.number().min(0).max(1).optional(),
          })
          .optional(),
        fallbackMode: z.enum(['ask', 'auto']).optional(),
        fallbackChain: z.array(modelRefSchema).max(5).optional(),
        sitePresets: z
          .array(
            z.object({
              id: z.string().trim().min(1).max(80),
              name: z.string().trim().min(1).max(80),
              origin: z.string().trim().url(),
              loginUrl: z.string().trim().url(),
              flow: z.enum(['single', 'two_step']).default('single'),
              selectors: z
                .object({
                  username: z.string().max(240).optional(),
                  password: z.string().max(240).optional(),
                  next: z.string().max(240).optional(),
                  submit: z.string().max(240).optional(),
                  emailStepButton: z.string().max(240).optional(),
                })
                .default({}),
              successUrlIncludes: z.string().max(240).optional(),
              successSelector: z.string().max(240).optional(),
              verifySelector: z.string().max(240).optional(),
              allowedHosts: z.array(z.string().trim().max(200)).max(20).optional(),
              defaultProfileName: z.string().max(60).optional(),
              description: z.string().max(240).optional(),
              builtIn: z.boolean().default(false),
            }),
          )
          .max(50)
          .optional(),
        meeting: z
          .object({
            mode: z.enum(['live', 'economy']).optional(),
            activeModelId: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
            threads: z.number().int().min(1).max(128).optional(),
            useGpu: z.boolean().optional(),
            language: z.enum(['auto', 'id', 'en']).optional(),
            keepAudio: z.boolean().optional(),
            remindParticipants: z.boolean().optional(),
            noticeTextId: z.string().max(1000).optional(),
            noticeTextEn: z.string().max(1000).optional(),
            speakerLabels: z.boolean().optional(),
            micDevice: z.string().trim().min(1).max(200).nullable().optional(),
            speakerDevice: z.string().trim().min(1).max(200).nullable().optional(),
            notesProvider: z
              .enum(['claude', 'openai', 'antigravity', 'deepseek', 'opencode', 'openrouter'])
              .nullable()
              .optional(),
            notesModel: z.string().trim().min(1).max(120).nullable().optional(),
            notesLanguage: z.enum(['auto', 'id', 'en']).optional(),
            notesTemplate: z.string().max(4000).optional(),
            detectMeetingApps: z.boolean().optional(),
            ignoredMeetingApps: z
              .array(z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/))
              .max(50)
              .optional(),
          })
          .optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_settings', 'Invalid settings input.'), 400);
    }

    const settings = store.updateSettings(parsed.data);
    return c.json({ settings });
  });

  // External MCP Connections
  const mcpServerSchema = z.object({
    name: z.string().trim().min(1).max(60),
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional().default(true),
    presetId: z.string().nullable().optional(),
    description: z.string().optional(),
    auth: z.literal('oauth').optional(),
    oauthScope: z.string().trim().max(300).optional(),
  });

  api.post('/mcp/servers', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = mcpServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_mcp_server', 'Invalid MCP server configuration.'), 400);
    }
    const data = parsed.data;
    if (data.transport === 'stdio' && !data.command?.trim()) {
      return c.json(apiError('invalid_mcp_server', 'Stdio MCP server requires a command.'), 400);
    }
    if (data.transport !== 'stdio' && !data.url?.trim()) {
      return c.json(apiError('invalid_mcp_server', 'Remote MCP server requires a URL.'), 400);
    }
    if (data.auth === 'oauth' && data.transport === 'stdio') {
      return c.json(apiError('invalid_mcp_server', 'Login is only for remote MCP servers.'), 400);
    }
    const server = store.addMcpServer(data);
    return c.json({ server }, 201);
  });

  // ── OAuth login for remote MCP servers ──
  api.get('/mcp/oauth-status', (c) =>
    c.json({
      status: getMcpOAuthStatus(store),
      redirectUri: `http://127.0.0.1:${config.port}/api/mcp/oauth/callback`,
    }),
  );

  api.post('/mcp/servers/:id/oauth/start', async (c) => {
    const id = c.req.param('id');
    const server = store.getSettings().mcpServers.find((s) => s.id === id);
    if (!server) {
      return c.json(apiError('mcp_not_found', `MCP server ${id} not found.`), 404);
    }
    const creds = z
      .object({ clientId: z.string().trim().max(200).optional(), clientSecret: z.string().max(500).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    try {
      const redirectUri = `http://127.0.0.1:${config.port}/api/mcp/oauth/callback`;
      const authUrl = await startMcpOAuth(
        store,
        server,
        redirectUri,
        creds.success ? creds.data : undefined,
      );
      return c.json({ authUrl });
    } catch (err) {
      const code = err instanceof OAuthClientRequiredError ? 'oauth_client_required' : 'oauth_start_failed';
      return c.json(
        apiError(code, err instanceof Error ? err.message : 'Could not start login.'),
        400,
      );
    }
  });

  api.delete('/mcp/servers/:id/oauth', (c) => {
    disconnectMcpOAuth(store, c.req.param('id'));
    return c.json({ ok: true });
  });

  // The provider redirects the browser here after login.
  api.get('/mcp/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const providerError = c.req.query('error_description') ?? c.req.query('error');
    let ok = false;
    let message = 'Connected. You can close this window.';
    try {
      if (providerError) throw new Error(providerError);
      if (!code || !state) throw new Error('Missing code or state in the login response.');
      await completeMcpOAuth(store, code, state);
      ok = true;
    } catch (err) {
      message = err instanceof Error ? err.message : 'Login failed.';
    }
    const payload = JSON.stringify({ type: 'atelier-mcp-oauth', ok, message }).replace(/</g, '\\u003c');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Atelier</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0d0d11;color:#e4e4ea;font:14px system-ui">
<div style="text-align:center;max-width:360px;padding:24px"><div id="m" style="line-height:20px"></div>
<div style="margin-top:10px;color:#9494a3;font-size:12px">You can close this window.</div></div>
<script>const p=${payload};document.getElementById('m').textContent=(p.ok?'✓ ':'✕ ')+p.message;
try{window.opener&&window.opener.postMessage(p,'*')}catch(e){}
if(p.ok)setTimeout(()=>window.close(),1200)</script>`);
  });

  api.patch('/mcp/servers/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = mcpServerSchema.partial().safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_mcp_server', 'Invalid MCP update payload.'), 400);
    }
    const server = store.updateMcpServer(id, parsed.data);
    if (!server) {
      return c.json(apiError('mcp_not_found', `MCP server ${id} not found.`), 404);
    }
    return c.json({ server });
  });

  api.delete('/mcp/servers/:id', (c) => {
    const id = c.req.param('id');
    const ok = store.deleteMcpServer(id);
    if (!ok) {
      return c.json(apiError('mcp_not_found', `MCP server ${id} not found.`), 404);
    }
    return c.json({ ok: true, id });
  });

  api.post('/mcp/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ json: z.string().min(1) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_mcp_json', 'Provide a JSON string to import.'), 400);
    }

    let rawObj: unknown;
    try {
      rawObj = JSON.parse(parsed.data.json);
    } catch {
      return c.json(apiError('invalid_mcp_json', 'Malformed JSON syntax.'), 400);
    }

    if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
      return c.json(
        apiError('invalid_mcp_json', 'JSON must be an object or { "mcpServers": { ... } }.'),
        400,
      );
    }

    const root = rawObj as Record<string, unknown>;
    const mapSource =
      root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
        ? (root.mcpServers as Record<string, unknown>)
        : root;

    const entrySchema = z.union([
      z.object({
        type: z.literal('stdio').optional(),
        command: z.string().trim().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        description: z.string().optional(),
      }),
      z.object({
        type: z.enum(['http', 'sse']).optional(),
        url: z.string().trim().min(1),
        headers: z.record(z.string()).optional(),
        description: z.string().optional(),
      }),
    ]);

    const toAdd: Array<Omit<McpServerConfig, 'id'>> = [];
    for (const [name, entryRaw] of Object.entries(mapSource)) {
      const valid = entrySchema.safeParse(entryRaw);
      if (!valid.success) {
        return c.json(
          apiError('invalid_mcp_json', `Invalid MCP entry for "${name}".`),
          400,
        );
      }
      const val = valid.data;
      if ('command' in val) {
        toAdd.push({
          name,
          transport: 'stdio',
          command: val.command,
          args: val.args ?? [],
          env: val.env,
          enabled: true,
          description: val.description,
        });
      } else {
        toAdd.push({
          name,
          transport: val.type ?? 'http',
          url: val.url,
          headers: val.headers,
          enabled: true,
          description: val.description,
        });
      }
    }

    if (toAdd.length === 0) {
      return c.json(apiError('invalid_mcp_json', 'No MCP server entries found in JSON.'), 400);
    }

    const servers = toAdd.map((item) => store.addMcpServer(item));
    return c.json({ servers }, 201);
  });

  api.post('/mcp/test', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return c.json(apiError('invalid_mcp_server', 'Provide an MCP server id or config.'), 400);
    }

    let target: McpServerConfig | null = null;
    if (typeof body.id === 'string' && body.id.trim()) {
      target = store.getSettings().mcpServers.find((s) => s.id === body.id) ?? null;
      if (!target) {
        return c.json(apiError('mcp_not_found', `MCP server ${body.id} not found.`), 404);
      }
    } else {
      const parsed = mcpServerSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(apiError('invalid_mcp_server', 'Invalid MCP server config.'), 400);
      }
      target = { id: 'probe', ...parsed.data };
    }

    const [resolved] = await resolveMcpAuth(store, [target]);
    const result = await probeMcpServer(resolved);
    return c.json(result);
  });

  // Chief of Staff Onboarding
  api.post('/onboarding/chief-of-staff', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({ projectId: z.string().trim().min(1).optional() })
      .safeParse(body ?? {});
    const projectId = parsed.success ? parsed.data.projectId : undefined;

    const cosTpl = AGENT_TEMPLATES.find((t) => t.id === 'tpl_chief_of_staff')!;
    const cosInput = {
      name: cosTpl.name,
      role: cosTpl.role,
      color: cosTpl.color,
      avatarShape: cosTpl.avatarShape,
      allowShell: cosTpl.allowShell,
      systemInstructions: cosTpl.systemInstructions,
      skills: [],
      mcpServerIds: [],
    };

    let project = projectId ? store.getProject(projectId) : null;
    if (projectId && !project) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }

    let agent = null;
    if (!project) {
      const created = store.createProject({
        name: 'My Workspace',
        starterAgents: [cosInput],
      });
      project = created.project;
      agent = created.agents[0]!;
    } else {
      agent =
        store
          .listProjectAgents(project.id)
          .find((a) => /chief of staff/i.test(a.role)) ??
        store.createAgent(project.id, cosInput);
    }

    if (!agent) {
      return c.json(apiError('onboarding_failed', 'Could not create Chief of Staff agent.'), 500);
    }

    const existingMsgs = store.listAgentMessages(agent.id);
    if (existingMsgs.length === 0) {
      store.createMessage({
        projectId: project.id,
        agentId: agent.id,
        author: 'agent',
        text: CHIEF_OF_STAFF_GREETING,
        streaming: false,
      });
    }

    store.updateSettings({ onboardingCompleted: true });
    return c.json({ project, agent }, 201);
  });

  api.post('/onboarding/dismiss', (c) => {
    store.updateSettings({ onboardingCompleted: true });
    return c.json({ ok: true });
  });

  // Multi-provider OAuth login, API keys & CLI status
  api.get('/providers/status', async (c) => {
    const [providers, discoveredModels] = await Promise.all([
      authManager.getStatuses(store.getSettings(), store),
      Promise.resolve(discoverLocalCodexModels()),
    ]);
    return c.json({ providers, discoveredModels });
  });

  // Every model a provider offers (live where the provider has a list), for the model picker settings
  api.get('/providers/:provider/models', async (c) => {
    const parsed = providerSchema.safeParse(c.req.param('provider'));
    if (!parsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    const refresh = c.req.query('refresh') === '1';
    return c.json(await getModelCatalog(parsed.data, config, store.getSettings(), refresh));
  });

  api.post('/providers/:provider/login', async (c) => {
    const parsed = providerSchema.safeParse(c.req.param('provider'));
    if (!parsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    const status = await authManager.startLogin(parsed.data, store.getSettings(), store);
    return c.json({ status });
  });

  api.post('/providers/:provider/logout', async (c) => {
    const parsed = providerSchema.safeParse(c.req.param('provider'));
    if (!parsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    const status = await authManager.logout(parsed.data, store.getSettings(), store);
    return c.json({ status });
  });

  api.post('/providers/:provider/api-key', async (c) => {
    const parsed = providerSchema.safeParse(c.req.param('provider'));
    if (!parsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    if (parsed.data !== 'deepseek' && parsed.data !== 'openrouter' && parsed.data !== 'antigravity') {
      return c.json(apiError('unsupported_api_key', 'This provider uses CLI/OAuth login.'), 400);
    }
    const body = await c.req.json().catch(() => null);
    const keyParsed = z.object({ apiKey: z.string().trim().min(1).max(400) }).safeParse(body);
    if (!keyParsed.success) {
      return c.json(apiError('invalid_api_key', 'A valid API key is required.'), 400);
    }
    store.setProviderSecret(parsed.data, keyParsed.data.apiKey);
    const status = await authManager.getStatus(parsed.data, store.getSettings(), store);
    return c.json({ status });
  });

  api.delete('/providers/:provider/api-key', async (c) => {
    const parsed = providerSchema.safeParse(c.req.param('provider'));
    if (!parsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    store.setProviderSecret(parsed.data, null);
    const status = await authManager.getStatus(parsed.data, store.getSettings(), store);
    return c.json({ status });
  });

  api.get('/providers/cooldowns', (c) => {
    return c.json({ cooldowns: runtime.getCooldowns() });
  });

  api.delete('/providers/cooldowns', (c) => {
    const providerParam = c.req.query('provider');
    const modelParam = c.req.query('model');
    if (providerParam) {
      const parsed = providerSchema.safeParse(providerParam);
      if (!parsed.success) {
        return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
      }
      runtime.clearCooldown(parsed.data, modelParam || undefined);
    } else {
      runtime.clearCooldown();
    }
    return c.json({ ok: true, cooldowns: runtime.getCooldowns() });
  });

  // Usage Analytics & Provider Limits
  api.get('/usage', async (c) => {
    const rawRange = c.req.query('range') ?? '30d';
    const rangeParsed = z.enum(['today', '7d', '30d', 'all']).safeParse(rawRange);
    const range: UsageRange = rangeParsed.success ? rangeParsed.data : '30d';
    const forceRefresh = c.req.query('refresh') === '1';
    const dashboard = await buildUsageDashboard(store, config, range, { forceRefresh });
    return c.json(dashboard);
  });

  api.put('/usage/limits/:provider', async (c) => {
    const provParsed = providerSchema.safeParse(c.req.param('provider'));
    if (!provParsed.success) {
      return c.json(apiError('invalid_provider', 'Unsupported provider.'), 400);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .union([
        z.object({ clear: z.literal(true) }),
        z.object({
          period: z.enum(['daily', 'weekly', 'monthly']),
          tokenLimit: z.number().int().positive().max(1_000_000_000).nullable(),
          budgetUsd: z.number().positive().max(100_000).nullable(),
          fiveHourTokenLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
          weeklyTokenLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
          weeklyResetDay: z.number().int().min(0).max(6).nullable().optional(),
        }),
      ])
      .safeParse(body);

    if (!parsed.success) {
      return c.json(apiError('invalid_usage_limit', 'Provide valid period, tokenLimit, or budgetUsd.'), 400);
    }

    if (
      'clear' in parsed.data ||
      (parsed.data.tokenLimit === null &&
        parsed.data.budgetUsd === null &&
        parsed.data.fiveHourTokenLimit == null &&
        parsed.data.weeklyTokenLimit == null &&
        parsed.data.weeklyResetDay == null)
    ) {
      const settings = store.setUsageLimit(provParsed.data, null);
      return c.json({ settings });
    }

    const settings = store.setUsageLimit(provParsed.data, parsed.data);
    return c.json({ settings });
  });

  api.delete('/usage/logs', (c) => {
    store.clearUsageLogs();
    return c.json({ ok: true });
  });

  // Browser E2E QA
  api.get('/qa/browser-status', (c) => {
    const detected = detectLocalBrowser();
    return c.json({
      available: Boolean(detected),
      browserName: detected?.browserName ?? null,
      executablePath: detected?.executablePath ?? null,
    });
  });

  api.get('/projects/:id/qa/runs', (c) => {
    const projectId = c.req.param('id');
    const project = store.getProject(projectId);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }
    return c.json({ runs: store.listProjectQaRuns(projectId) });
  });

  const qaStepSchema = z.object({
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
    selector: z.string().max(300).optional(),
    value: z.string().max(1000).optional(),
    label: z.string().max(160).optional(),
    timeoutMs: z.number().int().min(200).max(30_000).optional(),
  });

  api.post('/projects/:id/qa/run', async (c) => {
    const projectId = c.req.param('id');
    const project = store.getProject(projectId);
    if (!project) {
      return c.json(apiError('project_not_found', `Project ${projectId} not found.`), 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        url: z.string().trim().optional(),
        watchLive: z.boolean().optional().default(false),
        taskId: z.string().trim().nullable().optional(),
        agentId: z.string().trim().nullable().optional(),
        postToChat: z.boolean().optional().default(false),
        steps: z.array(qaStepSchema).max(30).optional(),
      })
      .safeParse(body ?? {});

    if (!parsed.success) {
      return c.json(apiError('invalid_qa_input', 'Invalid Browser QA configuration.'), 400);
    }

    const targetUrl = (parsed.data.url || project.previewUrl || '').trim();
    if (!targetUrl) {
      return c.json(
        apiError('missing_preview_url', 'Set a Preview URL on the project or pass a url.'),
        400,
      );
    }

    try {
      const run = await runBrowserQa({
        dataDir: config.dataDir,
        projectId: project.id,
        url: targetUrl,
        watchLive: parsed.data.watchLive,
        taskId: parsed.data.taskId ?? null,
        agentId: parsed.data.agentId ?? null,
        steps: parsed.data.steps,
      });

      store.saveQaRun(run);

      if (parsed.data.taskId) {
        const existingTask = store.getTask(parsed.data.taskId);
        if (existingTask) {
          const prev = existingTask.deliverableSummary ? `${existingTask.deliverableSummary}\n` : '';
          store.updateTask(existingTask.id, {
            deliverableSummary: `${prev}[Browser QA] ${run.summary}`.slice(0, 400),
          });
        }
      }

      const targetAgentId =
        parsed.data.agentId ||
        (parsed.data.taskId ? store.getTask(parsed.data.taskId)?.assigneeAgentId : null) ||
        project.agentIds[0] ||
        null;

      if (targetAgentId) {
        store.addActivity({
          projectId: project.id,
          agentId: targetAgentId,
          kind: run.passed ? 'task' : 'error',
          label: `Browser QA ${run.passed ? 'Passed' : 'Failed'}`,
          detail: run.summary,
        });
      }

      if (parsed.data.postToChat && targetAgentId) {
        store.createMessage({
          projectId: project.id,
          agentId: targetAgentId,
          author: 'system',
          text: `Browser QA ${run.passed ? 'Passed' : 'Failed'} on ${run.url} — ${run.summary}`,
          streaming: false,
          durationMs: run.durationMs,
          metadata: {
            qaRun: run,
            taskId: parsed.data.taskId ?? undefined,
          },
        });
      }

      return c.json({ run });
    } catch (err) {
      return c.json(
        apiError('qa_run_failed', err instanceof Error ? err.message : 'Browser QA failed.'),
        400,
      );
    }
  });

  api.get('/qa/artifacts/:runId/:filename', (c) => {
    const runId = c.req.param('runId');
    const filename = c.req.param('filename');
    const filePath = resolveQaArtifactPath(config.dataDir, runId, filename);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return c.json(apiError('artifact_not_found', 'QA screenshot not found.'), 404);
    }
    return new Response(fs.readFileSync(filePath), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  return api;
}
