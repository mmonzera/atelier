import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_AVATAR_SHAPES,
  AGENT_COLORS,
  AGENT_TEMPLATES,
  BUILT_IN_SKILLS,
  DEFAULT_AUTO_COMPACT_SETTINGS,
  parseMessageSegments,
  type Artifact,
  type CanonEntry,
  type DesignOption,
  type Activity,
  type ActivityKind,
  type Agent,
  type AgentAvatarShape,
  type AgentBrowserAccess,
  type AgentColor,
  type AutoCompactSettings,
  type BrowserScreenshotSummary,
  type CreateAgentInput,
  type CreateTaskInput,
  type FallbackErrorKind,
  type FallbackMode,
  type McpServerConfig,
  type Message,
  type MessageAuthor,
  type MessageMetadata,
  type ModelProvider,
  type ModelRef,
  type PendingFallbackOffer,
  type PortEntry,
  type Project,
  type ProjectRepo,
  type ProviderUsageLimit,
  type QaRun,
  type QueueItem,
  type QueueKind,
  type ServerEvent,
  type Settings,
  type SettingsInput,
  type SitePreset,
  type Task,
  type ThreadCompaction,
  type UpdateAgentInput,
  type UpdateTaskInput,
  type UsageLogEntry,
  type WorkspaceState,
} from '@atelier/contracts';
import type { EventBus } from './bus.js';
import type { AppConfig } from './config.js';
import type { AtelierDb } from './db.js';
import { getAgentWorkspacePath, getDirectAgentWorkspacePath, getProjectRepoPath } from './github.js';
import { CanonInputSchema, memoryFilePath, readDesignImage, validateArtifactSize, writeMemoryFile } from './memory-files.js';

const AGENT_COLOR_SET = new Set<string>(AGENT_COLORS);
const AGENT_SHAPE_SET = new Set<string>(AGENT_AVATAR_SHAPES);

export function newId(prefix = ''): string {
  const short = crypto.randomUUID().slice(0, 8);
  return prefix ? `${prefix}_${short}` : short;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class AtelierStore {
  private bus: EventBus | null = null;
  private transactionEvents?: ServerEvent[];
  private snapshotAugmenter?: (base: WorkspaceState) => WorkspaceState;

  constructor(
    private readonly db: AtelierDb,
    private readonly config: AppConfig,
  ) {
    this.seedSettings();
  }

  public attachBus(bus: EventBus): void {
    this.bus = bus;
  }

  public setSnapshotAugmenter(fn: (base: WorkspaceState) => WorkspaceState): void {
    this.snapshotAugmenter = fn;
  }

  private broadcast(event: ServerEvent): void {
    this.bus?.broadcast(event);
  }

  /** Re-sends the whole state to every client (used after a backup import swaps the DB contents). */
  public broadcastSnapshot(): void {
    this.broadcast({ type: 'snapshot', payload: this.getSnapshot() });
  }

  private appendEvent(event: ServerEvent): void {
    this.db.sqlite
      .prepare(`INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)`)
      .run(event.type, JSON.stringify(event.payload), nowIso());
  }

  private runTx(fn: () => ServerEvent[]): void {
    if (this.transactionEvents) {
      this.transactionEvents.push(...fn());
      return;
    }
    this.db.sqlite.exec('BEGIN');
    const events: ServerEvent[] = [];
    this.transactionEvents = events;
    try {
      events.push(...fn());
      for (const ev of events) {
        this.appendEvent(ev);
      }
      this.db.sqlite.exec('COMMIT');
    } catch (err) {
      this.db.sqlite.exec('ROLLBACK');
      throw err;
    } finally {
      this.transactionEvents = undefined;
    }
    for (const ev of events) {
      this.broadcast(ev);
    }
  }

  private seedSettings(): void {
    const existing = this.db.sqlite.prepare(`SELECT id FROM settings WHERE id = 1`).get();
    if (!existing) {
      const initial: Settings = {
        provider: 'claude',
        model: 'sonnet',
        reasoningEffort: 'High',
        customModels: [],
        cliPaths: {},
        mcpServers: [],
        onboardingCompleted: false,
        autoCompact: DEFAULT_AUTO_COMPACT_SETTINGS,
        usageLimits: {},
      };
      this.db.sqlite
        .prepare(`INSERT INTO settings (id, data) VALUES (1, ?)`)
        .run(JSON.stringify(initial));
    }
  }

  private hydrateProject(raw: Record<string, unknown>): Project {
    return {
      id: String(raw.id),
      name: String(raw.name),
      agentIds: Array.isArray(raw.agentIds) ? raw.agentIds.map(String) : [],
      repo: (raw.repo as ProjectRepo | null) ?? null,
      previewUrl: (raw.previewUrl as string | null) ?? null,
      allowFullPermissions: Boolean(raw.allowFullPermissions),
      archived: Boolean(raw.archived),
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt),
    };
  }

  private hydrateAgent(raw: Record<string, unknown>): Agent {
    const rawRole = String(raw.role || 'Specialist');
    const isLegacyDesign = rawRole === 'design';
    const isLegacyBuilder = rawRole === 'builder';

    return {
      id: String(raw.id),
      projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,
      name: String(raw.name || (isLegacyDesign ? 'Designer' : isLegacyBuilder ? 'Builder' : 'Agent')),
      role: isLegacyDesign
        ? 'UI/UX & Product Spec'
        : isLegacyBuilder
          ? 'Full-Stack Implementation'
          : rawRole,
      color:
        typeof raw.color === 'string' && AGENT_COLOR_SET.has(raw.color)
          ? (raw.color as AgentColor)
          : isLegacyDesign
            ? 'blue'
            : 'green',
      ...(typeof raw.avatarShape === 'string' && AGENT_SHAPE_SET.has(raw.avatarShape)
        ? { avatarShape: raw.avatarShape as AgentAvatarShape }
        : {}),
      systemInstructions:
        typeof raw.systemInstructions === 'string'
          ? raw.systemInstructions
          : isLegacyDesign
            ? AGENT_TEMPLATES[0].systemInstructions
            : isLegacyBuilder
              ? AGENT_TEMPLATES[1].systemInstructions
              : '',
      skills: Array.isArray(raw.skills) ? (raw.skills as Agent['skills']) : [],
      mcpServerIds: Array.isArray(raw.mcpServerIds) ? raw.mcpServerIds.map(String) : [],
      allowShell: typeof raw.allowShell === 'boolean' ? raw.allowShell : !isLegacyDesign,
      ...(raw.browser && typeof raw.browser === 'object'
        ? {
            browser: {
              enabled: Boolean((raw.browser as AgentBrowserAccess).enabled),
              allowedHosts: Array.isArray((raw.browser as AgentBrowserAccess).allowedHosts)
                ? (raw.browser as AgentBrowserAccess).allowedHosts.map(String)
                : [],
              credentialIds: Array.isArray((raw.browser as AgentBrowserAccess).credentialIds)
                ? (raw.browser as AgentBrowserAccess).credentialIds.map(String)
                : [],
              confirmSensitive:
                typeof (raw.browser as AgentBrowserAccess).confirmSensitive === 'boolean'
                  ? (raw.browser as AgentBrowserAccess).confirmSensitive
                  : true,
              defaultProfileId:
                typeof (raw.browser as AgentBrowserAccess).defaultProfileId === 'string'
                  ? (raw.browser as AgentBrowserAccess).defaultProfileId
                  : null,
            },
          }
        : {}),
      providerOverride:
        raw.providerOverride === 'claude' ||
        raw.providerOverride === 'openai' ||
        raw.providerOverride === 'antigravity' ||
        raw.providerOverride === 'deepseek' ||
        raw.providerOverride === 'opencode' ||
        raw.providerOverride === 'openrouter'
          ? raw.providerOverride
          : null,
      modelOverride: typeof raw.modelOverride === 'string' ? raw.modelOverride : null,
      fallbackChain: Array.isArray(raw.fallbackChain) ? (raw.fallbackChain as ModelRef[]) : [],
      pendingFallback:
        raw.pendingFallback && typeof raw.pendingFallback === 'object'
          ? (raw.pendingFallback as PendingFallbackOffer)
          : null,
      status:
        raw.status === 'working' || raw.status === 'error' || raw.status === 'idle'
          ? raw.status
          : 'idle',
      queueLength: Number(raw.queueLength ?? 0),
      currentTask: typeof raw.currentTask === 'string' ? raw.currentTask : null,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      sessions:
        raw.sessions && typeof raw.sessions === 'object'
          ? (raw.sessions as Record<string, string>)
          : {},
      sessionCanon: raw.sessionCanon as Agent['sessionCanon'],
      contextCompactions:
        raw.contextCompactions && typeof raw.contextCompactions === 'object'
          ? (raw.contextCompactions as Record<string, ThreadCompaction>)
          : {},
      scopeTokens:
        raw.scopeTokens && typeof raw.scopeTokens === 'object'
          ? (raw.scopeTokens as Record<string, number>)
          : {},
      conversationTokens:
        raw.conversationTokens && typeof raw.conversationTokens === 'object'
          ? (raw.conversationTokens as Record<string, number>)
          : {},
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      tokenUsage: (raw.tokenUsage as Agent['tokenUsage']) ?? { input: 0, output: 0 },
      updatedAt: String(raw.updatedAt || nowIso()),
    };
  }

  public recoverOnStartup(): void {
    const now = nowIso();
    this.db.sqlite.exec('BEGIN');
    try {
      const msgRows = this.db.sqlite
        .prepare(`SELECT id, data FROM messages`)
        .all() as Array<{ id: string; data: string }>;
      for (const row of msgRows) {
        const msg = JSON.parse(row.data) as Message;
        if (msg.streaming) {
          const closed: Message = {
            ...msg,
            streaming: false,
            text: msg.text ? `${msg.text} (terputus)` : '(terputus)',
          };
          this.db.sqlite
            .prepare(`UPDATE messages SET data = ? WHERE id = ?`)
            .run(JSON.stringify(closed), row.id);
        }
      }

      const agentRows = this.db.sqlite
        .prepare(`SELECT id, data FROM agents`)
        .all() as Array<{ id: string; data: string }>;
      for (const row of agentRows) {
        const agent = this.hydrateAgent(JSON.parse(row.data) as Record<string, unknown>);
        const cntRow = this.db.sqlite
          .prepare(`SELECT COUNT(*) AS cnt FROM agent_queue WHERE agent_id = ?`)
          .get(agent.id) as { cnt: number };

        const cleanedSessionId =
          agent.sessionId && agent.sessionId.startsWith('mock-') ? null : agent.sessionId;

        if (agent.status === 'working') {
          const errored: Agent = {
            ...agent,
            status: 'error',
            currentTask: null,
            sessionId: cleanedSessionId,
            queueLength: cntRow.cnt,
            lastError: 'Server restart saat turn berjalan',
            updatedAt: now,
          };
          this.db.sqlite
            .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
            .run(JSON.stringify(errored), agent.id);
        } else {
          const synced: Agent = {
            ...agent,
            queueLength: cntRow.cnt,
            sessionId: cleanedSessionId,
          };
          this.db.sqlite
            .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
            .run(JSON.stringify(synced), agent.id);
        }
      }
      this.db.sqlite.exec('COMMIT');
    } catch (err) {
      this.db.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  public getEventCount(): number {
    const row = this.db.sqlite.prepare(`SELECT COUNT(*) AS cnt FROM events`).get() as { cnt: number };
    return row.cnt;
  }

  public getSnapshot(): WorkspaceState {
    const projects = (
      this.db.sqlite.prepare(`SELECT data FROM projects ORDER BY created_at ASC`).all() as Array<{
        data: string;
      }>
    ).map((r) => this.hydrateProject(JSON.parse(r.data) as Record<string, unknown>));

    const agents = (
      this.db.sqlite.prepare(`SELECT data FROM agents ORDER BY created_at ASC`).all() as Array<{
        data: string;
      }>
    ).map((r) => this.hydrateAgent(JSON.parse(r.data) as Record<string, unknown>));

    const parseRows = <T>(table: string, orderBy = 'created_at ASC'): T[] =>
      (
        this.db.sqlite
          .prepare(`SELECT data FROM ${table} ORDER BY ${orderBy}`)
          .all() as Array<{ data: string }>
      ).map((r) => JSON.parse(r.data) as T);

    const base: WorkspaceState = {
      projects,
      agents,
      messages: parseRows<Message>('messages'),
      canon: parseRows<CanonEntry>('canon').filter((entry) => !entry.supersededBy),
      tasks: parseRows<Task>('tasks', 'created_at DESC'),
      activities: parseRows<Activity>('activities'),
      ports: parseRows<PortEntry>('ports', 'port ASC'),
      settings: this.getSettings(),
    };
    return this.snapshotAugmenter ? this.snapshotAugmenter(base) : base;
  }

  private migrateLegacyModel(provider: Settings['provider'], model?: string): string {
    const legacyToModern: Record<string, string> = {
      'claude-sonnet-4-20250514': 'sonnet',
      'claude-sonnet-4-6': 'sonnet',
      'claude-opus-4-6': 'opus',
      'gpt-5.3-codex': 'gpt-6.2-astra',
      'gpt-5.2': 'gpt-6.2-sol',
      o3: 'gpt-6.1-terra',
      'gemini-2.5-pro': 'gemini-4-neon',
      'gemini-2.5-flash': 'gemini-4-hydrogen',
    };
    if (model && legacyToModern[model]) return legacyToModern[model];
    if (model) return model;
    if (provider === 'openai') return 'gpt-6.2-astra';
    if (provider === 'antigravity') return 'gemini-4-neon';
    if (provider === 'deepseek') return 'deepseek-chat';
    if (provider === 'opencode') return 'opencode/big-pickle';
    if (provider === 'openrouter') return 'openrouter/auto';
    return 'sonnet';
  }

  private normalizeAutoCompact(raw?: Partial<AutoCompactSettings>): AutoCompactSettings {
    const base = DEFAULT_AUTO_COMPACT_SETTINGS;
    if (
      raw &&
      raw.settingsVersion !== 2 &&
      raw.settingsVersion !== 3 &&
      raw.maxMessages === 20 &&
      raw.keepRecentMessages === 6 &&
      raw.maxContextTokens === 40000
    ) {
      raw = {
        ...raw,
        maxMessages: base.maxMessages,
        keepRecentMessages: base.keepRecentMessages,
        maxContextTokens: base.maxContextTokens,
      };
    } else if (
      raw &&
      raw.settingsVersion !== 3 &&
      raw.maxMessages === 60 &&
      raw.keepRecentMessages === 14 &&
      raw.maxContextTokens === 24000
    ) {
      raw = {
        ...raw,
        maxMessages: base.maxMessages,
        keepRecentMessages: base.keepRecentMessages,
        maxContextTokens: base.maxContextTokens,
      };
    }
    const rawMaxMsgs = Number(raw?.maxMessages ?? base.maxMessages);
    const maxMessages = Number.isFinite(rawMaxMsgs)
      ? Math.min(200, Math.max(4, Math.round(rawMaxMsgs)))
      : base.maxMessages;
    const rawKeep = Number(raw?.keepRecentMessages ?? base.keepRecentMessages);
    const keepRecentMessages = Number.isFinite(rawKeep)
      ? Math.min(maxMessages - 1, Math.max(1, Math.round(rawKeep)))
      : Math.min(base.keepRecentMessages, maxMessages - 1);
    const rawTokens = Number(raw?.maxContextTokens ?? base.maxContextTokens);
    const maxContextTokens = Number.isFinite(rawTokens)
      ? Math.min(500_000, Math.max(4_000, Math.round(rawTokens)))
      : base.maxContextTokens;
    const maxBatchUpper = Math.max(1, Math.min(50, maxMessages - keepRecentMessages));
    const minBatchLower = Math.min(2, maxBatchUpper);
    const rawMinBatch = Number(raw?.minCompactMessages ?? base.minCompactMessages ?? 10);
    const minCompactMessages = Number.isFinite(rawMinBatch)
      ? Math.min(maxBatchUpper, Math.max(minBatchLower, Math.round(rawMinBatch)))
      : Math.min(maxBatchUpper, Math.max(minBatchLower, base.minCompactMessages ?? 10));
    const rawProviderLimit = Number(
      raw?.providerContextLimit ?? base.providerContextLimit ?? 100_000,
    );
    const providerContextLimit = Number.isFinite(rawProviderLimit)
      ? Math.min(2_000_000, Math.max(8_000, Math.round(rawProviderLimit)))
      : (base.providerContextLimit ?? 100_000);
    return {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : base.enabled,
      settingsVersion: 3,
      ...(typeof raw?.tailTokens === 'number' && Number.isFinite(raw.tailTokens)
        ? { tailTokens: Math.max(1000, Math.min(6000, Math.round(raw.tailTokens))) }
        : typeof base.tailTokens === 'number'
          ? { tailTokens: base.tailTokens }
          : {}),
      ...(typeof raw?.summarizerModel === 'string' && /^[a-zA-Z0-9._:/-]+$/.test(raw.summarizerModel)
        ? { summarizerModel: raw.summarizerModel }
        : {}),
      maxMessages,
      keepRecentMessages,
      maxContextTokens,
      minCompactMessages,
      providerContextLimit,
    };
  }

  public getSettings(): Settings {
    const row = this.db.sqlite.prepare(`SELECT data FROM settings WHERE id = 1`).get() as {
      data: string;
    };
    const parsed = JSON.parse(row.data) as Partial<Settings> & { provider?: string };
    const provider: Settings['provider'] =
      parsed.provider === 'openai' ||
      parsed.provider === 'antigravity' ||
      parsed.provider === 'claude' ||
      parsed.provider === 'deepseek' ||
      parsed.provider === 'opencode' ||
      parsed.provider === 'openrouter'
        ? parsed.provider
        : 'claude';
    const model = this.migrateLegacyModel(provider, parsed.model);

    return {
      provider,
      model,
      reasoningEffort: parsed.reasoningEffort ?? 'High',
      customModels: parsed.customModels ?? [],
      visibleModels: this.normalizeVisibleModels(parsed.visibleModels),
      language: parsed.language === 'en' || parsed.language === 'id' ? parsed.language : undefined,
      cliPaths: parsed.cliPaths ?? {},
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      onboardingCompleted:
        typeof parsed.onboardingCompleted === 'boolean' ? parsed.onboardingCompleted : false,
      autoCompact: this.normalizeAutoCompact(parsed.autoCompact),
      usageLimits:
        parsed.usageLimits && typeof parsed.usageLimits === 'object' ? parsed.usageLimits : {},
      fallbackMode: parsed.fallbackMode === 'auto' ? 'auto' : 'ask',
      fallbackChain: Array.isArray(parsed.fallbackChain) ? parsed.fallbackChain : [],
      sitePresets: Array.isArray(parsed.sitePresets) ? (parsed.sitePresets as SitePreset[]) : [],
    };
  }

  private normalizeVisibleModels(raw: unknown): Settings['visibleModels'] {
    if (!raw || typeof raw !== 'object') return undefined;
    const providers = ['claude', 'openai', 'antigravity', 'deepseek', 'opencode', 'openrouter'] as const;
    const out: NonNullable<Settings['visibleModels']> = {};
    for (const p of providers) {
      const list = (raw as Record<string, unknown>)[p];
      if (Array.isArray(list)) out[p] = [...new Set(list.map(String))];
    }
    return out;
  }

  public updateSettings(input: SettingsInput): Settings {
    let updated!: Settings;
    this.runTx(() => {
      const current = this.getSettings();
      updated = {
        provider: input.provider ?? current.provider,
        model: input.model ?? current.model,
        reasoningEffort: input.reasoningEffort ?? current.reasoningEffort,
        customModels: input.customModels ?? current.customModels,
        visibleModels: input.visibleModels
          ? this.normalizeVisibleModels(input.visibleModels)
          : current.visibleModels,
        language: input.language ?? current.language,
        cliPaths: input.cliPaths ? { ...current.cliPaths, ...input.cliPaths } : current.cliPaths,
        mcpServers: current.mcpServers,
        onboardingCompleted:
          input.onboardingCompleted !== undefined
            ? input.onboardingCompleted
            : current.onboardingCompleted,
        autoCompact: input.autoCompact
          ? this.normalizeAutoCompact({ ...current.autoCompact, ...input.autoCompact })
          : current.autoCompact,
        usageLimits: input.usageLimits
          ? { ...(current.usageLimits ?? {}), ...input.usageLimits }
          : (current.usageLimits ?? {}),
        fallbackMode: input.fallbackMode ?? current.fallbackMode ?? 'ask',
        fallbackChain: input.fallbackChain ?? current.fallbackChain ?? [],
        sitePresets: input.sitePresets !== undefined ? input.sitePresets : (current.sitePresets ?? []),
      };
      this.db.sqlite
        .prepare(`UPDATE settings SET data = ? WHERE id = 1`)
        .run(JSON.stringify(updated));
      return [{ type: 'settings-changed', payload: updated }];
    });
    return updated;
  }

  public setUsageLimit(
    provider: ModelProvider,
    limit: ProviderUsageLimit | null,
  ): Settings {
    let updated!: Settings;
    this.runTx(() => {
      const current = this.getSettings();
      const nextLimits = { ...(current.usageLimits ?? {}) };
      if (!limit) {
        delete nextLimits[provider];
      } else {
        nextLimits[provider] = limit;
      }
      updated = {
        ...current,
        usageLimits: nextLimits,
      };
      this.db.sqlite
        .prepare(`UPDATE settings SET data = ? WHERE id = 1`)
        .run(JSON.stringify(updated));
      return [{ type: 'settings-changed', payload: updated }];
    });
    return updated;
  }

  // Usage Logs
  public recordUsageLog(
    input: Omit<UsageLogEntry, 'id' | 'createdAt'> & { createdAt?: string },
  ): UsageLogEntry {
    const entry: UsageLogEntry = {
      id: newId('usg'),
      provider: input.provider,
      model: input.model,
      agentId: input.agentId,
      projectId: input.projectId ?? null,
      inputTokens: Math.max(0, Math.round(input.inputTokens)),
      outputTokens: Math.max(0, Math.round(input.outputTokens)),
      memoryTokens: input.memoryTokens,
      estimatedCostUsd: Math.max(0, input.estimatedCostUsd),
      createdAt: input.createdAt ?? nowIso(),
    };
    this.db.sqlite
      .prepare(
        `INSERT INTO usage_logs (id, provider, agent_id, project_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.provider,
        entry.agentId,
        entry.projectId ?? null,
        entry.createdAt,
        JSON.stringify(entry),
      );
    return entry;
  }

  public listUsageLogs(sinceIso?: string): UsageLogEntry[] {
    const rows = sinceIso
      ? (this.db.sqlite
          .prepare(`SELECT data FROM usage_logs WHERE created_at >= ? ORDER BY created_at DESC`)
          .all(sinceIso) as Array<{ data: string }>)
      : (this.db.sqlite
          .prepare(`SELECT data FROM usage_logs ORDER BY created_at DESC`)
          .all() as Array<{ data: string }>);
    return rows.map((r) => JSON.parse(r.data) as UsageLogEntry);
  }

  public clearUsageLogs(): void {
    this.db.sqlite.prepare(`DELETE FROM usage_logs`).run();
  }

  private uniqueMcpName(rawName: string, existingNames: Set<string>): string {
    const base =
      rawName
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'mcp';
    if (!existingNames.has(base)) return base;
    let n = 2;
    while (existingNames.has(`${base}-${n}`)) {
      n += 1;
    }
    return `${base}-${n}`;
  }

  public addMcpServer(input: Omit<McpServerConfig, 'id'>): McpServerConfig {
    let created!: McpServerConfig;
    this.runTx(() => {
      const current = this.getSettings();
      const taken = new Set(current.mcpServers.map((s) => s.name));
      created = {
        ...input,
        id: newId('mcp'),
        name: this.uniqueMcpName(input.name, taken),
      };
      const updated: Settings = {
        ...current,
        mcpServers: [...current.mcpServers, created],
      };
      this.db.sqlite
        .prepare(`UPDATE settings SET data = ? WHERE id = 1`)
        .run(JSON.stringify(updated));
      return [{ type: 'settings-changed', payload: updated }];
    });
    return created;
  }

  public updateMcpServer(
    id: string,
    patch: Partial<Omit<McpServerConfig, 'id'>>,
  ): McpServerConfig | null {
    let updatedServer: McpServerConfig | null = null;
    this.runTx(() => {
      const current = this.getSettings();
      const existing = current.mcpServers.find((s) => s.id === id);
      if (!existing) return [];
      const otherNames = new Set(
        current.mcpServers.filter((s) => s.id !== id).map((s) => s.name),
      );
      const nextName =
        patch.name !== undefined ? this.uniqueMcpName(patch.name, otherNames) : existing.name;
      updatedServer = {
        ...existing,
        ...patch,
        id: existing.id,
        name: nextName,
      };
      const updated: Settings = {
        ...current,
        mcpServers: current.mcpServers.map((s) => (s.id === id ? updatedServer! : s)),
      };
      this.db.sqlite
        .prepare(`UPDATE settings SET data = ? WHERE id = 1`)
        .run(JSON.stringify(updated));
      return [{ type: 'settings-changed', payload: updated }];
    });
    return updatedServer;
  }

  public deleteMcpServer(id: string): boolean {
    let removed = false;
    this.runTx(() => {
      const current = this.getSettings();
      if (!current.mcpServers.some((s) => s.id === id)) return [];
      removed = true;
      this.db.sqlite.prepare(`DELETE FROM mcp_oauth WHERE server_id = ?`).run(id);
      const updated: Settings = {
        ...current,
        mcpServers: current.mcpServers.filter((s) => s.id !== id),
      };
      this.db.sqlite
        .prepare(`UPDATE settings SET data = ? WHERE id = 1`)
        .run(JSON.stringify(updated));

      const events: ServerEvent[] = [{ type: 'settings-changed', payload: updated }];
      const agentRows = this.db.sqlite
        .prepare(`SELECT id, data FROM agents`)
        .all() as Array<{ id: string; data: string }>;
      const now = nowIso();
      for (const row of agentRows) {
        const agt = this.hydrateAgent(JSON.parse(row.data) as Record<string, unknown>);
        if (agt.mcpServerIds.includes(id)) {
          const nextAgent: Agent = {
            ...agt,
            mcpServerIds: agt.mcpServerIds.filter((mid) => mid !== id),
            updatedAt: now,
          };
          this.db.sqlite
            .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
            .run(JSON.stringify(nextAgent), nextAgent.id);
          events.push({ type: 'agent-upserted', payload: nextAgent });
        }
      }
      return events;
    });
    return removed;
  }

  /** OAuth credentials for MCP servers: kept out of `settings`, which is broadcast to the browser. */
  public getMcpOAuth(serverId: string): string | null {
    const row = this.db.sqlite
      .prepare(`SELECT data FROM mcp_oauth WHERE server_id = ?`)
      .get(serverId) as { data: string } | undefined;
    return row?.data ?? null;
  }

  public setMcpOAuth(serverId: string, data: string | null): void {
    if (data === null) {
      this.db.sqlite.prepare(`DELETE FROM mcp_oauth WHERE server_id = ?`).run(serverId);
      return;
    }
    this.db.sqlite
      .prepare(
        `INSERT INTO mcp_oauth (server_id, data) VALUES (?, ?)
         ON CONFLICT(server_id) DO UPDATE SET data = excluded.data`,
      )
      .run(serverId, data);
  }

  public listMcpOAuthIds(): string[] {
    return (
      this.db.sqlite.prepare(`SELECT server_id FROM mcp_oauth`).all() as Array<{ server_id: string }>
    ).map((r) => r.server_id);
  }

  public getProviderSecret(provider: string): string | null {
    const row = this.db.sqlite
      .prepare(`SELECT data FROM provider_secrets WHERE provider = ?`)
      .get(provider) as { data: string } | undefined;
    return row?.data ?? null;
  }

  public setProviderSecret(provider: string, value: string | null): void {
    const trimmed = value?.trim() || null;
    if (!trimmed) {
      this.db.sqlite.prepare(`DELETE FROM provider_secrets WHERE provider = ?`).run(provider);
      return;
    }
    this.db.sqlite
      .prepare(
        `INSERT INTO provider_secrets (provider, data) VALUES (?, ?)
         ON CONFLICT(provider) DO UPDATE SET data = excluded.data`,
      )
      .run(provider, trimmed);
  }

  public getMcpServersForAgent(agent: Agent): McpServerConfig[] {
    if (!agent.mcpServerIds || agent.mcpServerIds.length === 0) return [];
    const allowed = new Set(agent.mcpServerIds);
    return this.getSettings().mcpServers.filter((s) => s.enabled && allowed.has(s.id));
  }

  // Projects
  public listProjects(): Project[] {
    return (
      this.db.sqlite.prepare(`SELECT data FROM projects ORDER BY created_at ASC`).all() as Array<{
        data: string;
      }>
    ).map((r) => this.hydrateProject(JSON.parse(r.data) as Record<string, unknown>));
  }

  public getProject(id: string): Project | null {
    const row = this.db.sqlite.prepare(`SELECT data FROM projects WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? this.hydrateProject(JSON.parse(row.data) as Record<string, unknown>) : null;
  }

  private buildAgentEntity(
    projectId: string | null,
    input: CreateAgentInput,
    now = nowIso(),
  ): Agent {
    return {
      id: newId('agt'),
      projectId,
      name: input.name.trim(),
      role: input.role.trim() || 'Specialist',
      color: input.color ?? 'green',
      ...(input.avatarShape ? { avatarShape: input.avatarShape } : {}),
      systemInstructions: input.systemInstructions?.trim() ?? '',
      skills: input.skills ?? [],
      mcpServerIds: input.mcpServerIds ?? [],
      allowShell: input.allowShell ?? true,
      ...(input.browser ? { browser: input.browser } : {}),
      providerOverride: input.providerOverride ?? null,
      modelOverride: input.modelOverride ?? null,
      fallbackChain: input.fallbackChain ?? [],
      pendingFallback: null,
      status: 'idle',
      queueLength: 0,
      currentTask: null,
      sessionId: null,
      sessions: {},
      contextCompactions: {},
      scopeTokens: {},
      conversationTokens: {},
      lastError: null,
      tokenUsage: { input: 0, output: 0 },
      updatedAt: now,
    };
  }

  public createProject(input: {
    name: string;
    starterAgents?: CreateAgentInput[];
  }): { project: Project; agents: Agent[] } {
    const now = nowIso();
    const projectId = newId('prj');
    // No default agent team: projects start empty unless starterAgents are supplied (e.g. Chief of Staff onboarding).
    const starterInputs: CreateAgentInput[] = input.starterAgents ?? [];
    const agents = starterInputs.map((a) => this.buildAgentEntity(projectId, a, now));

    const project: Project = {
      id: projectId,
      name: input.name.trim(),
      agentIds: agents.map((a) => a.id),
      repo: null,
      previewUrl: null,
      allowFullPermissions: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };

    this.runTx(() => {
      this.db.sqlite
        .prepare(`INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)`)
        .run(project.id, project.createdAt, JSON.stringify(project));

      for (const agt of agents) {
        this.db.sqlite
          .prepare(`INSERT INTO agents (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`)
          .run(agt.id, agt.projectId ?? null, now, JSON.stringify(agt));
      }

      return [
        { type: 'project-upserted', payload: project },
        ...agents.map((a): ServerEvent => ({ type: 'agent-upserted', payload: a })),
      ];
    });

    return { project, agents };
  }

  public updateProject(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'repo' | 'previewUrl' | 'allowFullPermissions' | 'archived'>>,
  ): Project | null {
    let updated: Project | null = null;
    this.runTx(() => {
      const existing = this.getProject(id);
      if (!existing) return [];
      updated = {
        ...existing,
        name: patch.name !== undefined ? patch.name : existing.name,
        repo: patch.repo !== undefined ? patch.repo : existing.repo,
        previewUrl: patch.previewUrl !== undefined ? patch.previewUrl : existing.previewUrl,
        allowFullPermissions:
          patch.allowFullPermissions !== undefined
            ? patch.allowFullPermissions
            : existing.allowFullPermissions,
        archived: patch.archived !== undefined ? patch.archived : existing.archived,
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'project-upserted', payload: updated }];
    });
    return updated;
  }

  public deleteProject(id: string): boolean {
    let deleted = false;
    this.runTx(() => {
      const existing = this.getProject(id);
      if (!existing) return [];
      const events: ServerEvent[] = [];

      const affectedAgents = (
        this.db.sqlite
          .prepare(`SELECT DISTINCT agent_id FROM agent_queue WHERE project_id = ?`)
          .all(id) as Array<{ agent_id: string }>
      ).map((r) => r.agent_id);

      this.db.sqlite.prepare(`DELETE FROM messages WHERE project_id = ?`).run(id);
      this.db.sqlite.prepare(`DELETE FROM activities WHERE project_id = ?`).run(id);
      this.db.sqlite.prepare(`DELETE FROM agent_queue WHERE project_id = ?`).run(id);
      this.db.sqlite.prepare(`DELETE FROM projects WHERE id = ?`).run(id);

      for (const agtId of affectedAgents) {
        const agt = this.getAgent(agtId);
        if (!agt) continue;
        const cntRow = this.db.sqlite
          .prepare(`SELECT COUNT(*) AS cnt FROM agent_queue WHERE agent_id = ?`)
          .get(agtId) as { cnt: number };
        const synced: Agent = { ...agt, queueLength: cntRow.cnt, updatedAt: nowIso() };
        this.db.sqlite
          .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
          .run(JSON.stringify(synced), synced.id);
        events.push({ type: 'agent-upserted', payload: synced });
      }

      deleted = true;
      events.push({ type: 'project-deleted', payload: { id } });
      return events;
    });
    return deleted;
  }

  // Agents CRUD (Global + Project Assignment)
  public listAgents(): Agent[] {
    return (
      this.db.sqlite
        .prepare(`SELECT data FROM agents ORDER BY created_at ASC`)
        .all() as Array<{ data: string }>
    ).map((r) => this.hydrateAgent(JSON.parse(r.data) as Record<string, unknown>));
  }

  public listProjectAgents(projectId: string): Agent[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    const all = this.listAgents();
    if (project.agentIds.length > 0) {
      const byId = new Map(all.map((a) => [a.id, a]));
      return project.agentIds
        .map((id) => byId.get(id))
        .filter((a): a is Agent => Boolean(a));
    }
    return all.filter((a) => a.projectId === projectId);
  }

  public listAgentProjects(agentId: string): Project[] {
    return this.listProjects().filter(
      (p) => !p.archived && p.agentIds.includes(agentId),
    );
  }

  public listAgentTasks(agentId: string): Task[] {
    return (
      this.db.sqlite
        .prepare(`SELECT data FROM tasks ORDER BY created_at DESC`)
        .all() as Array<{ data: string }>
    )
      .map((r) => JSON.parse(r.data) as Task)
      .filter((t) => t.assigneeAgentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public getAgent(id: string): Agent | null {
    const row = this.db.sqlite.prepare(`SELECT data FROM agents WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? this.hydrateAgent(JSON.parse(row.data) as Record<string, unknown>) : null;
  }

  public createAgent(projectId: string | null, input: CreateAgentInput): Agent | null {
    const targetProjectId = projectId ?? input.projectId ?? null;
    if (targetProjectId !== null && !this.getProject(targetProjectId)) {
      return null;
    }

    const now = nowIso();
    const agent = this.buildAgentEntity(targetProjectId, input, now);
    this.runTx(() => {
      this.db.sqlite
        .prepare(`INSERT INTO agents (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`)
        .run(agent.id, agent.projectId ?? null, now, JSON.stringify(agent));

      const events: ServerEvent[] = [{ type: 'agent-upserted', payload: agent }];

      if (targetProjectId) {
        const proj = this.getProject(targetProjectId);
        if (proj && !proj.agentIds.includes(agent.id)) {
          const nextProj: Project = {
            ...proj,
            agentIds: [...proj.agentIds, agent.id],
            updatedAt: now,
          };
          this.db.sqlite
            .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
            .run(JSON.stringify(nextProj), nextProj.id);
          events.push({ type: 'project-upserted', payload: nextProj });
        }
      }

      return events;
    });
    return agent;
  }

  public assignAgentToProject(projectId: string, agentId: string): Project | null {
    let updated: Project | null = null;
    this.runTx(() => {
      const proj = this.getProject(projectId);
      const agt = this.getAgent(agentId);
      if (!proj || !agt) return [];
      if (proj.agentIds.includes(agentId)) {
        updated = proj;
        return [];
      }
      updated = {
        ...proj,
        agentIds: [...proj.agentIds, agentId],
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'project-upserted', payload: updated }];
    });
    return updated;
  }

  public unassignAgentFromProject(projectId: string, agentId: string): Project | null {
    let updated: Project | null = null;
    this.runTx(() => {
      const proj = this.getProject(projectId);
      if (!proj) return [];
      if (!proj.agentIds.includes(agentId)) {
        updated = proj;
        return [];
      }
      updated = {
        ...proj,
        agentIds: proj.agentIds.filter((id) => id !== agentId),
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'project-upserted', payload: updated }];
    });
    return updated;
  }

  public updateAgentConfig(id: string, patch: UpdateAgentInput): Agent | null {
    let updated: Agent | null = null;
    this.runTx(() => {
      const existing = this.getAgent(id);
      if (!existing) return [];
      updated = {
        ...existing,
        name: patch.name !== undefined ? patch.name.trim() : existing.name,
        role: patch.role !== undefined ? patch.role.trim() : existing.role,
        color: patch.color !== undefined ? patch.color : existing.color,
        avatarShape: patch.avatarShape !== undefined ? patch.avatarShape : existing.avatarShape,
        systemInstructions:
          patch.systemInstructions !== undefined
            ? patch.systemInstructions
            : existing.systemInstructions,
        skills: patch.skills !== undefined ? patch.skills : existing.skills,
        mcpServerIds:
          patch.mcpServerIds !== undefined ? patch.mcpServerIds : existing.mcpServerIds,
        allowShell: patch.allowShell !== undefined ? patch.allowShell : existing.allowShell,
        ...(patch.browser !== undefined
          ? { browser: patch.browser }
          : existing.browser !== undefined
            ? { browser: existing.browser }
            : {}),
        providerOverride:
          patch.providerOverride !== undefined ? patch.providerOverride : existing.providerOverride,
        modelOverride:
          patch.modelOverride !== undefined ? patch.modelOverride : existing.modelOverride,
        fallbackChain:
          patch.fallbackChain !== undefined ? patch.fallbackChain : (existing.fallbackChain ?? []),
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'agent-upserted', payload: updated }];
    });
    return updated;
  }

  public deleteAgent(id: string): boolean {
    let deleted = false;
    this.runTx(() => {
      const existing = this.getAgent(id);
      if (!existing) return [];
      const events: ServerEvent[] = [];
      const now = nowIso();

      // Remove from every project's agentIds
      for (const proj of this.listProjects()) {
        if (proj.agentIds.includes(id)) {
          const nextProj: Project = {
            ...proj,
            agentIds: proj.agentIds.filter((aid) => aid !== id),
            updatedAt: now,
          };
          this.db.sqlite
            .prepare(`UPDATE projects SET data = ? WHERE id = ?`)
            .run(JSON.stringify(nextProj), nextProj.id);
          events.push({ type: 'project-upserted', payload: nextProj });
        }
      }

      // Unassign tasks across all projects pointing to the deleted agent
      const allTasks = (
        this.db.sqlite.prepare(`SELECT data FROM tasks`).all() as Array<{ data: string }>
      )
        .map((r) => JSON.parse(r.data) as Task)
        .filter((t) => t.assigneeAgentId === id);
      for (const t of allTasks) {
        const nextTask: Task = { ...t, assigneeAgentId: null, updatedAt: now };
        this.db.sqlite
          .prepare(`UPDATE tasks SET data = ? WHERE id = ?`)
          .run(JSON.stringify(nextTask), nextTask.id);
        events.push({ type: 'task-upserted', payload: nextTask });
      }

      this.db.sqlite.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
      deleted = true;
      events.push({
        type: 'agent-deleted',
        payload: { id, projectId: existing.projectId ?? null },
      });
      return events;
    });
    return deleted;
  }

  public updateAgent(
    id: string,
    patch: Partial<
      Pick<
        Agent,
        | 'status'
        | 'queueLength'
        | 'currentTask'
        | 'sessionId'
        | 'sessions'
        | 'sessionCanon'
        | 'contextCompactions'
        | 'scopeTokens'
        | 'conversationTokens'
        | 'lastError'
        | 'pendingFallback'
        | 'tokenUsage'
      >
    >,
  ): Agent | null {
    let updated: Agent | null = null;
    this.runTx(() => {
      const existing = this.getAgent(id);
      if (!existing) return [];
      updated = {
        ...existing,
        status: patch.status !== undefined ? patch.status : existing.status,
        queueLength: patch.queueLength !== undefined ? patch.queueLength : existing.queueLength,
        currentTask: patch.currentTask !== undefined ? patch.currentTask : existing.currentTask,
        sessionId: patch.sessionId !== undefined ? patch.sessionId : existing.sessionId,
        sessions: patch.sessions !== undefined ? patch.sessions : existing.sessions,
        sessionCanon: patch.sessionCanon !== undefined ? patch.sessionCanon : existing.sessionCanon,
        contextCompactions:
          patch.contextCompactions !== undefined
            ? patch.contextCompactions
            : existing.contextCompactions,
        scopeTokens: patch.scopeTokens !== undefined ? patch.scopeTokens : existing.scopeTokens,
        conversationTokens:
          patch.conversationTokens !== undefined
            ? patch.conversationTokens
            : existing.conversationTokens,
        lastError: patch.lastError !== undefined ? patch.lastError : existing.lastError,
        pendingFallback:
          patch.pendingFallback !== undefined
            ? patch.pendingFallback
            : (existing.pendingFallback ?? null),
        tokenUsage: patch.tokenUsage !== undefined ? patch.tokenUsage : existing.tokenUsage,
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'agent-upserted', payload: updated }];
    });
    return updated;
  }

  public listCanon(scopeKey: string): CanonEntry[] {
    const rows = this.db.sqlite.prepare(`
      SELECT data FROM canon WHERE project_id IS ? AND json_extract(data, '$.supersededBy') IS NULL
      ORDER BY created_at DESC, rowid DESC
    `).all(scopeKey === 'direct' ? null : scopeKey) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as CanonEntry);
  }

  public upsertCanon(projectId: string | null, input: Pick<CanonEntry, 'kind' | 'key' | 'title' | 'value' | 'path' | 'artifactId' | 'source'>): CanonEntry {
    const fields = CanonInputSchema.parse(input);
    if (input.artifactId && this.getArtifact(input.artifactId)?.projectId !== projectId) {
      throw new Error('Artifact does not belong to this scope.');
    }
    const oneLine = (value: string) => value.replace(/[\s\u2028\u2029]+/g, ' ').trim();
    const scopeKey = projectId ?? 'direct';
    const createdAt = nowIso();
    const entry: CanonEntry = {
      ...fields, id: newId('can'), scopeKey, projectId,
      title: oneLine(fields.title), value: oneLine(fields.value),
      artifactId: input.artifactId, source: input.source, createdAt, updatedAt: createdAt,
    };
    this.runTx(() => {
      const previous = this.listCanon(scopeKey).find((item) => item.key === entry.key);
      if (previous) {
        this.db.sqlite.prepare('UPDATE canon SET data = ? WHERE id = ?')
          .run(JSON.stringify({ ...previous, supersededBy: entry.id, updatedAt: createdAt }), previous.id);
      }
      this.db.sqlite.prepare('INSERT INTO canon (id, project_id, created_at, data) VALUES (?, ?, ?, ?)')
        .run(entry.id, projectId, createdAt, JSON.stringify(entry));
      return [
        ...(previous ? [{ type: 'canon-deleted' as const, payload: { id: previous.id } }] : []),
        { type: 'canon-upserted', payload: entry },
      ];
    });
    return entry;
  }

  public deleteCanon(id: string): void {
    this.runTx(() => {
      const result = this.db.sqlite.prepare('DELETE FROM canon WHERE id = ?').run(id);
      return result.changes ? [{ type: 'canon-deleted', payload: { id } }] : [];
    });
  }

  public createArtifact(input: Omit<Artifact, 'id' | 'path' | 'createdAt' | 'sizeBytes'>, bytes: Buffer): Artifact {
    validateArtifactSize(bytes);
    const id = 'art_' + crypto.randomUUID();
    const ext = input.kind === 'image' ? input.mime.split('/')[1] : input.kind === 'file' ? 'bin' : input.kind;
    const artifact: Artifact = {
      ...input, id, path: `artifacts/${input.projectId ?? 'direct'}/${id}.${ext}`,
      createdAt: nowIso(), sizeBytes: bytes.length,
    };
    writeMemoryFile(this.config.dataDir, artifact.path, bytes);
    try {
      this.runTx(() => {
        this.db.sqlite.prepare('INSERT INTO artifacts (id, project_id, created_at, data, content) VALUES (?, ?, ?, ?, ?)')
          .run(id, artifact.projectId, artifact.createdAt, JSON.stringify(artifact), bytes);
        return [{ type: 'artifact-created', payload: artifact }];
      });
    } catch (err) {
      fs.rmSync(memoryFilePath(this.config.dataDir, artifact.path), { force: true });
      throw err;
    }
    return artifact;
  }

  public getArtifact(id: string): Artifact | null {
    const row = this.db.sqlite.prepare('SELECT data FROM artifacts WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Artifact : null;
  }

  public listArtifacts(projectId: string | null): Artifact[] {
    const rows = this.db.sqlite.prepare('SELECT data FROM artifacts WHERE project_id IS ? ORDER BY created_at DESC')
      .all(projectId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Artifact);
  }

  public readArtifact(artifact: Artifact): Buffer {
    const row = this.db.sqlite.prepare('SELECT content FROM artifacts WHERE id = ?')
      .get(artifact.id) as { content: Uint8Array } | undefined;
    if (!row) throw new Error('Artifact was removed.');
    return Buffer.from(row.content);
  }

  public materializeArtifact(artifact: Artifact): string {
    const root = this.config.dataDir;
    const relative = artifact.path;
    const scope = artifact.projectId ?? 'direct';
    if (!/^art_[a-f0-9-]+$/.test(artifact.id) ||
        path.posix.dirname(relative) !== `artifacts/${scope}` ||
        !path.posix.basename(relative).startsWith(artifact.id + '.')) throw new Error('Invalid artifact path.');
    writeMemoryFile(root, relative, this.readArtifact(artifact));
    return memoryFilePath(root, relative);
  }

  public artifactDirectory(projectId: string | null): string {
    return memoryFilePath(this.config.dataDir, `artifacts/${projectId ?? 'direct'}`);
  }

  private managedWorkspace(target: string): string {
    return memoryFilePath(this.config.workspacesDir,
      path.relative(this.config.workspacesDir, target).split(path.sep).join('/'));
  }

  public restoreCanonWorkspaceAssets(projectId: string | null, agentId?: string, includeLinkedRepo = true): void {
    const project = projectId ? this.getProject(projectId) : null;
    if (project?.repo && (!includeLinkedRepo || !fs.existsSync(project.repo.localPath))) return;
    for (const entry of this.listCanon(projectId ?? 'direct')) {
      if (entry.kind !== 'asset' || !entry.path || !entry.artifactId) continue;
      const artifact = this.getArtifact(entry.artifactId);
      if (!artifact || artifact.projectId !== projectId) continue;
      const sourceAgentId = artifact.sourceMessageId ? this.getMessage(artifact.sourceMessageId)?.agentId : undefined;
      const directAgentId = agentId ?? sourceAgentId;
      try {
        const root = project
          ? project.repo?.localPath ?? this.managedWorkspace(getProjectRepoPath(this.config.workspacesDir, project.id))
          : directAgentId ? this.managedWorkspace(getDirectAgentWorkspacePath(this.config.workspacesDir, directAgentId)) : null;
        if (!root) continue;
        if (!fs.existsSync(memoryFilePath(root, entry.path))) {
          writeMemoryFile(root, entry.path, this.readArtifact(artifact));
        }
      } catch {
        // A broken local path must not hide the saved asset from the agent.
      }
    }
  }

  private designRoots(message: Message): string[] {
    if (!message.projectId) return [this.managedWorkspace(getDirectAgentWorkspacePath(this.config.workspacesDir, message.agentId))];
    return [
      this.getProject(message.projectId)?.repo?.localPath ||
        this.managedWorkspace(getProjectRepoPath(this.config.workspacesDir, message.projectId)),
      this.managedWorkspace(getAgentWorkspacePath(this.config.workspacesDir, message.projectId, message.agentId)),
    ];
  }

  private saveDesignOption(message: Message, option: DesignOption): Artifact {
    const { bytes, mime } = option.kind === 'image'
      ? readDesignImage(option.src ?? '', this.designRoots(message))
      : { bytes: Buffer.from(option.content), mime: option.kind === 'svg' ? 'image/svg+xml' : 'text/html' };
    return this.createArtifact({
      projectId: message.projectId ?? null, sourceMessageId: message.id, kind: option.kind,
      label: option.label, mime,
    }, bytes);
  }

  public captureDesignArtifacts(message: Message): Record<string, string> {
    const artifacts = new Map(Object.entries(message.metadata?.designArtifacts ?? {}));
    for (const [index, segment] of parseMessageSegments(message.text).entries()) {
      if (segment.type !== 'design') continue;
      for (const option of segment.block.options) {
        const key = index + ':' + option.id;
        if (artifacts.has(key)) continue;
        try {
          const id = this.saveDesignOption(message, option).id;
          artifacts.set(key, id);
          if (!artifacts.has(option.id)) artifacts.set(option.id, id);
        } catch (err) {
          console.warn('Could not archive design option', message.id, option.id, err instanceof Error ? err.message : err);
        }
      }
    }
    return Object.fromEntries(artifacts);
  }

  public pickDesign(projectId: string | null, message: Message, optionId: string, segmentIndex?: number) {
    const segments = parseMessageSegments(message.text);
    const index = segmentIndex ?? segments.findIndex((segment) => segment.type === 'design' &&
      segment.block.options.some((option) => option.id === optionId));
    const segment = segments[index];
    const option = segment?.type === 'design' ? segment.block.options.find((item) => item.id === optionId) : undefined;
    if (!option || message.projectId !== projectId || message.author !== 'agent' || message.streaming) {
      throw new Error('This design option is unavailable.');
    }
    const optionKey = index + ':' + optionId;
    const artifactId = message.metadata?.designArtifacts?.[optionKey] ?? (segmentIndex === undefined
      ? message.metadata?.designArtifacts?.[optionId] : undefined);
    let artifact = artifactId ? this.getArtifact(artifactId) : null;
    if (!artifact || artifact.projectId !== projectId || artifact.sourceMessageId !== message.id) {
      artifact = this.saveDesignOption(message, option);
      this.finalizeMessage(message.id, {
        streaming: false,
        metadata: {
          ...message.metadata,
          designArtifacts: { ...message.metadata?.designArtifacts, [optionKey]: artifact.id, [optionId]: artifact.id },
        },
      });
    }
    const thread = this.listAgentMessages(message.agentId, projectId);
    const context = thread.slice(0, thread.findIndex((item) => item.id === message.id))
      .filter((item) => item.author === 'user').at(-1);
    const isLogo = option.kind === 'svg' && /\b(?:logo|logomark|wordmark)\b/i.test(
      [option.label, option.summary, segment?.type === 'design' ? segment.block.title : '', context?.text].join(' '),
    );
    const key = isLogo ? 'brand.logo' : `design.${message.id}.${index}.chosen`;
    const previous = this.listCanon(projectId ?? 'direct').find((item) => item.key === key);
    const slug = option.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'option';
    const relative = isLogo ? 'brand/logo.svg' : option.kind === 'svg' ? `brand/${slug}.svg` : undefined;
    const fields = CanonInputSchema.parse({
      kind: 'asset', key, title: option.label, value: option.summary?.trim().slice(0, 300) || option.label,
      path: relative,
    });
    let undo: (() => void) | undefined;
    if (relative) {
      const root = this.designRoots(message)[0]!;
      const target = memoryFilePath(root, relative);
      const old = previous?.path === relative && previous.artifactId ? this.getArtifact(previous.artifactId) : null;
      const replaced = old && old.projectId === projectId && fs.existsSync(target) ? this.readArtifact(old) : undefined;
      const bytes = this.readArtifact(artifact);
      const existed = fs.existsSync(target);
      const written = writeMemoryFile(root, relative, bytes, replaced);
      if (written) undo = () => {
        const file = memoryFilePath(root, relative);
        if (!fs.existsSync(file) || !bytes.equals(fs.readFileSync(file))) return;
        if (!existed) fs.rmSync(file, { force: true });
        else if (replaced) writeMemoryFile(root, relative, replaced, bytes);
      };
    }
    if (previous?.artifactId === artifact.id) return {
      entry: previous, option,
      notify: !thread.some((item) => item.metadata?.designPick?.canonId === previous.id),
    };
    try {
      const entry = this.upsertCanon(projectId, { ...fields, artifactId: artifact.id, source: 'user_pick' });
      return { entry, option, notify: true };
    } catch (err) {
      undo?.();
      throw err;
    }
  }

  // Messages
  public searchHistory(projectId: string | null, query: string, limit: number) {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!words.length) return [];
    const cappedLimit = Math.min(8, Math.max(1, limit));
    type Match = { id: string; author: string; createdAt: string; snippet: string };
    let rows: Match[];
    if (this.db.hasMessageFts) {
      rows = this.db.sqlite.prepare(`
        SELECT m.id, json_extract(m.data, '$.author') AS author, m.created_at AS createdAt,
          snippet(messages_fts, 0, '', '', '…', 24) AS snippet
        FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ? AND scope = ? AND m.project_id IS ?
        ORDER BY rank, m.created_at DESC LIMIT ?
      `).all(words.map((word) => '"' + word + '"').join(' AND '), projectId ?? 'direct', projectId, cappedLimit) as Match[];
    } else {
      const matches = words.map(() => "text LIKE ? ESCAPE '!'").join(' AND ');
      rows = this.db.sqlite.prepare(`
        WITH recent AS (
          SELECT id, created_at, json_extract(data, '$.author') AS author, json_extract(data, '$.text') AS text
          FROM messages WHERE project_id IS ? AND coalesce(json_extract(data, '$.streaming'), 0) = 0
            AND coalesce(json_extract(data, '$.metadata.compacted'), 0) = 0
          ORDER BY created_at DESC LIMIT 1500
        )
        SELECT id, author, created_at AS createdAt,
          substr(text, max(1, instr(lower(text), lower(?)) - 80), 300) AS snippet
        FROM recent WHERE ${matches} LIMIT ?
      `).all(projectId, words[0]!, ...words.map((word) => `%${word.replaceAll('_', '!_')}%`), cappedLimit) as Match[];
    }
    return rows.map(({ id, author, createdAt, snippet }) => ({
      messageId: id, author, createdAt, snippet: snippet.slice(0, 300),
    }));
  }

  public getMessage(id: string): Message | null {
    const row = this.db.sqlite.prepare(`SELECT data FROM messages WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Message) : null;
  }

  /** True when any message references this attachment (used to sweep abandoned uploads). */
  public isAttachmentReferenced(attachmentId: string): boolean {
    const row = this.db.sqlite
      .prepare(`SELECT 1 AS x FROM messages WHERE data LIKE ? LIMIT 1`)
      .get(`%"${attachmentId}"%`);
    return Boolean(row);
  }

  /** Messages in a scope that carry attachments (used by the image library). */
  public listMessagesWithAttachments(projectId: string | null, agentId?: string): Message[] {
    const rows = this.db.sqlite
      .prepare(`SELECT data FROM messages WHERE project_id IS ? AND (? IS NULL OR agent_id = ?) AND data LIKE '%"attachments"%' ORDER BY created_at DESC, rowid DESC`)
      .all(projectId, agentId ?? null, agentId ?? null) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Message);
  }

  /** Agent replies in a scope that contain an <svg (used by the image library). */
  public listMessagesWithSvg(projectId: string | null, agentId?: string): Message[] {
    const rows = this.db.sqlite
      .prepare(`SELECT data FROM messages WHERE project_id IS ? AND (? IS NULL OR agent_id = ?) AND data LIKE '%<svg%' ORDER BY created_at DESC, rowid DESC`)
      .all(projectId, agentId ?? null, agentId ?? null) as { data: string }[];
    return rows
      .map((row) => JSON.parse(row.data) as Message)
      .filter((m) => m.author === 'agent' && !m.streaming);
  }

  public listAgentMessages(agentId: string, projectId?: string | null): Message[] {
    const rows = projectId === undefined
      ? this.db.sqlite.prepare('SELECT data FROM messages WHERE agent_id = ? ORDER BY created_at, rowid').all(agentId)
      : this.db.sqlite.prepare('SELECT data FROM messages WHERE project_id IS ? AND agent_id = ? ORDER BY created_at, rowid')
        .all(projectId, agentId);
    return (rows as { data: string }[]).map((row) => JSON.parse(row.data) as Message);
  }

  public createMessage(input: {
    id?: string;
    projectId: string | null;
    agentId: string;
    author: MessageAuthor;
    text: string;
    streaming?: boolean;
    durationMs?: number | null;
    metadata?: MessageMetadata;
  }): Message {
    const message: Message = {
      id: input.id ?? newId('msg'),
      projectId: input.projectId,
      agentId: input.agentId,
      author: input.author,
      text: input.text,
      streaming: input.streaming ?? false,
      durationMs: input.durationMs ?? null,
      metadata: input.metadata,
      createdAt: nowIso(),
    };
    this.runTx(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO messages (id, project_id, agent_id, created_at, data) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.projectId,
          message.agentId,
          message.createdAt,
          JSON.stringify(message),
        );
      return [{ type: 'message-upserted', payload: message }];
    });
    return message;
  }

  public appendMessageDelta(messageId: string, delta: string): void {
    if (!delta) return;
    let projectId: string | null = null;
    let agentId = '';
    this.db.sqlite.exec('BEGIN');
    try {
      const row = this.db.sqlite.prepare(`SELECT data FROM messages WHERE id = ?`).get(messageId) as
        | { data: string }
        | undefined;
      if (!row) {
        this.db.sqlite.exec('ROLLBACK');
        return;
      }
      const msg = JSON.parse(row.data) as Message;
      msg.text += delta;
      projectId = msg.projectId ?? null;
      agentId = msg.agentId;
      this.db.sqlite
        .prepare(`UPDATE messages SET data = ? WHERE id = ?`)
        .run(JSON.stringify(msg), messageId);
      this.db.sqlite.exec('COMMIT');
    } catch (err) {
      this.db.sqlite.exec('ROLLBACK');
      throw err;
    }

    this.broadcast({
      type: 'message-delta',
      payload: { id: messageId, projectId, agentId, delta },
    });
  }

  public finalizeMessage(
    messageId: string,
    patch: {
      text?: string;
      appendText?: string;
      streaming: boolean;
      durationMs?: number | null;
      metadata?: MessageMetadata;
    },
  ): Message | null {
    let updated: Message | null = null;
    this.runTx(() => {
      const row = this.db.sqlite.prepare(`SELECT data FROM messages WHERE id = ?`).get(messageId) as
        | { data: string }
        | undefined;
      if (!row) return [];
      const current = JSON.parse(row.data) as Message;
      let nextText = patch.text !== undefined ? patch.text : current.text;
      if (patch.appendText) {
        nextText = `${nextText}${patch.appendText}`;
      }
      updated = {
        ...current,
        text: nextText,
        streaming: patch.streaming,
        durationMs: patch.durationMs !== undefined ? patch.durationMs : current.durationMs,
        metadata:
          patch.metadata !== undefined
            ? {
                ...(current.metadata?.browserScreenshots
                  ? { browserScreenshots: current.metadata.browserScreenshots }
                  : {}),
                ...patch.metadata,
              }
            : current.metadata,
      };
      this.db.sqlite
        .prepare(`UPDATE messages SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), messageId);
      return [{ type: 'message-upserted', payload: updated }];
    });
    return updated;
  }

  public addMessageBrowserScreenshot(messageId: string, shot: BrowserScreenshotSummary): Message | null {
    let updated: Message | null = null;
    this.runTx(() => {
      const row = this.db.sqlite.prepare(`SELECT data FROM messages WHERE id = ?`).get(messageId) as
        | { data: string }
        | undefined;
      if (!row) return [];
      const current = JSON.parse(row.data) as Message;
      const prevShots = current.metadata?.browserScreenshots ?? [];
      updated = {
        ...current,
        metadata: {
          ...current.metadata,
          browserScreenshots: [...prevShots, shot],
        },
      };
      this.db.sqlite
        .prepare(`UPDATE messages SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), messageId);
      return [{ type: 'message-upserted', payload: updated }];
    });
    return updated;
  }

  // Activities
  public addActivity(input: {
    projectId: string | null;
    agentId: string;
    messageId?: string;
    kind: ActivityKind;
    label: string;
    detail?: string;
  }): Activity {
    const activity: Activity = {
      id: newId('act'),
      projectId: input.projectId,
      agentId: input.agentId,
      messageId: input.messageId,
      kind: input.kind,
      label: input.label,
      detail: input.detail,
      createdAt: nowIso(),
    };
    this.runTx(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO activities (id, project_id, agent_id, created_at, data) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          activity.id,
          activity.projectId,
          activity.agentId,
          activity.createdAt,
          JSON.stringify(activity),
        );
      return [{ type: 'activity-added', payload: activity }];
    });
    return activity;
  }

  // Linear-Style Tasks CRUD
  public listProjectTasks(projectId: string): Task[] {
    return (
      this.db.sqlite
        .prepare(`SELECT data FROM tasks WHERE project_id = ? ORDER BY created_at DESC`)
        .all(projectId) as Array<{ data: string }>
    ).map((r) => JSON.parse(r.data) as Task);
  }

  public getTask(id: string): Task | null {
    const row = this.db.sqlite.prepare(`SELECT data FROM tasks WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Task) : null;
  }

  private nextTaskIdentifier(projectId: string): string {
    const existing = this.listProjectTasks(projectId);
    let maxNum = 0;
    for (const t of existing) {
      const m = t.identifier.match(/^AT-(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (n > maxNum) maxNum = n;
      }
    }
    return `AT-${maxNum + 1}`;
  }

  public createTask(projectId: string, input: CreateTaskInput): Task | null {
    if (!this.getProject(projectId)) return null;
    const now = nowIso();
    let task!: Task;
    this.runTx(() => {
      task = {
        id: newId('tsk'),
        identifier: this.nextTaskIdentifier(projectId),
        projectId,
        title: input.title.trim(),
        description: input.description?.trim() ?? '',
        status: input.status ?? 'todo',
        priority: input.priority ?? 'medium',
        assigneeAgentId: input.assigneeAgentId ?? null,
        branch: input.branch ?? null,
        prUrl: input.prUrl ?? null,
        deliverableSummary: null,
        createdAt: now,
        updatedAt: now,
      };
      this.db.sqlite
        .prepare(`INSERT INTO tasks (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`)
        .run(task.id, task.projectId, task.createdAt, JSON.stringify(task));
      return [{ type: 'task-upserted', payload: task }];
    });
    return task;
  }

  public updateTask(id: string, patch: UpdateTaskInput): Task | null {
    let updated: Task | null = null;
    this.runTx(() => {
      const existing = this.getTask(id);
      if (!existing) return [];
      updated = {
        ...existing,
        title: patch.title !== undefined ? patch.title.trim() : existing.title,
        description: patch.description !== undefined ? patch.description : existing.description,
        status: patch.status !== undefined ? patch.status : existing.status,
        priority: patch.priority !== undefined ? patch.priority : existing.priority,
        assigneeAgentId:
          patch.assigneeAgentId !== undefined ? patch.assigneeAgentId : existing.assigneeAgentId,
        branch: patch.branch !== undefined ? patch.branch : existing.branch,
        prUrl: patch.prUrl !== undefined ? patch.prUrl : existing.prUrl,
        deliverableSummary:
          patch.deliverableSummary !== undefined
            ? patch.deliverableSummary
            : existing.deliverableSummary,
        updatedAt: nowIso(),
      };
      this.db.sqlite
        .prepare(`UPDATE tasks SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'task-upserted', payload: updated }];
    });
    return updated;
  }

  public deleteTask(id: string): boolean {
    let deleted = false;
    this.runTx(() => {
      const existing = this.getTask(id);
      if (!existing) return [];
      this.db.sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      deleted = true;
      return [{ type: 'task-deleted', payload: { id, projectId: existing.projectId } }];
    });
    return deleted;
  }

  // Ports
  public upsertPort(input: {
    id?: string;
    projectId: string;
    name: string;
    port: number;
    url: string;
    status: 'running' | 'stopped';
  }): PortEntry {
    let entry!: PortEntry;
    this.runTx(() => {
      const existing = this.db.sqlite
        .prepare(`SELECT id FROM ports WHERE project_id = ? AND port = ?`)
        .get(input.projectId, input.port) as { id: string } | undefined;

      entry = {
        id: input.id ?? existing?.id ?? newId('prt'),
        projectId: input.projectId,
        name: input.name,
        port: input.port,
        url: input.url,
        status: input.status,
      };

      this.db.sqlite
        .prepare(
          `INSERT INTO ports (id, project_id, port, data) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET port = excluded.port, data = excluded.data`,
        )
        .run(entry.id, entry.projectId, entry.port, JSON.stringify(entry));

      return [{ type: 'port-upserted', payload: entry }];
    });
    return entry;
  }

  // Persistent FIFO Queue
  public enqueueMessage(
    message: Parameters<AtelierStore['createMessage']>[0],
    queue: Parameters<AtelierStore['enqueueItem']>[0],
  ): ReturnType<AtelierStore['enqueueItem']> {
    let result!: ReturnType<AtelierStore['enqueueItem']>;
    this.runTx(() => {
      const created = this.createMessage(message);
      result = this.enqueueItem({ ...queue, refId: queue.refId ?? created.id });
      return [];
    });
    return result;
  }

  public enqueueItem(input: {
    agentId: string;
    projectId: string | null;
    kind: QueueKind;
    prompt: string;
    refId: string | null;
    replyToAgentId?: string | null;
    modelOverride?: ModelRef | null;
    fallbackAttempt?: number;
    fallbackFrom?: { provider: ModelProvider; model: string; reason: FallbackErrorKind } | null;
  }): { item: QueueItem; agent: Agent | null } {
    const item: QueueItem = {
      id: newId('q'),
      agentId: input.agentId,
      projectId: input.projectId,
      kind: input.kind,
      prompt: input.prompt,
      refId: input.refId,
      replyToAgentId: input.replyToAgentId ?? null,
      modelOverride: input.modelOverride ?? null,
      fallbackAttempt: input.fallbackAttempt ?? 0,
      fallbackFrom: input.fallbackFrom ?? null,
      createdAt: nowIso(),
    };
    let updatedAgent: Agent | null = null;

    this.runTx(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO agent_queue (id, agent_id, project_id, created_at, data) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(item.id, item.agentId, item.projectId, item.createdAt, JSON.stringify(item));

      const cntRow = this.db.sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM agent_queue WHERE agent_id = ?`)
        .get(item.agentId) as { cnt: number };

      const agt = this.getAgent(item.agentId);
      if (!agt) return [];
      updatedAgent = { ...agt, queueLength: cntRow.cnt, updatedAt: nowIso() };
      this.db.sqlite
        .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updatedAgent), updatedAgent.id);

      return [{ type: 'agent-upserted', payload: updatedAgent }];
    });

    return { item, agent: updatedAgent };
  }

  public shiftQueue(agentId: string): { item: QueueItem | null; queueLength: number } {
    let item: QueueItem | null = null;
    let queueLength = 0;

    this.runTx(() => {
      const row = this.db.sqlite
        .prepare(`SELECT seq, data FROM agent_queue WHERE agent_id = ? ORDER BY seq ASC LIMIT 1`)
        .get(agentId) as { seq: number; data: string } | undefined;

      if (!row) {
        return [];
      }

      item = JSON.parse(row.data) as QueueItem;
      this.db.sqlite.prepare(`DELETE FROM agent_queue WHERE seq = ?`).run(row.seq);

      const cntRow = this.db.sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM agent_queue WHERE agent_id = ?`)
        .get(agentId) as { cnt: number };
      queueLength = cntRow.cnt;

      const agt = this.getAgent(agentId);
      if (!agt) return [];
      const updated: Agent = { ...agt, queueLength, updatedAt: nowIso() };
      this.db.sqlite
        .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);

      return [{ type: 'agent-upserted', payload: updated }];
    });

    return { item, queueLength };
  }

  public listQueue(agentId: string): QueueItem[] {
    return (
      this.db.sqlite
        .prepare(`SELECT data FROM agent_queue WHERE agent_id = ? ORDER BY seq ASC`)
        .all(agentId) as Array<{ data: string }>
    ).map((r) => JSON.parse(r.data) as QueueItem);
  }

  public clearQueue(agentId: string): Agent | null {
    let updated: Agent | null = null;
    this.runTx(() => {
      this.db.sqlite.prepare(`DELETE FROM agent_queue WHERE agent_id = ?`).run(agentId);
      const agt = this.getAgent(agentId);
      if (!agt) return [];
      updated = { ...agt, queueLength: 0, updatedAt: nowIso() };
      this.db.sqlite
        .prepare(`UPDATE agents SET data = ? WHERE id = ?`)
        .run(JSON.stringify(updated), updated.id);
      return [{ type: 'agent-upserted', payload: updated }];
    });
    return updated;
  }

  // Browser E2E QA Runs
  public saveQaRun(run: QaRun): QaRun {
    this.db.sqlite
      .prepare(
        `INSERT INTO qa_runs (id, project_id, created_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(run.id, run.projectId, run.createdAt, JSON.stringify(run));
    return run;
  }

  public listProjectQaRuns(projectId: string, limit = 15): QaRun[] {
    return (
      this.db.sqlite
        .prepare(`SELECT data FROM qa_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(projectId, limit) as Array<{ data: string }>
    ).map((r) => JSON.parse(r.data) as QaRun);
  }
}
