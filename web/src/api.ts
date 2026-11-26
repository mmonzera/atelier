import type {
  AppUpdateStatus,
  AudioDevicesInfo,
  ModelProvider as MeetingNotesProvider,
  Agent,
  BrowserApprovalRequest,
  BrowserProfile,
  BrowserSessionInfo,
  BrowserStatusInfo,
  CanonEntry,
  Channel,
  ChannelSettings,
  AuthStatus,
  AutoBackupConfig,
  AutoBackupConfigInput,
  BackupImportResult,
  CloudFolderCandidate,
  CreateSiteCredentialInput,
  DetectedSitePreset,
  ExportBackupInput,
  LibraryImage,
  MeetingMode,
  MeetingSession,
  MeetingStatusEvent,
  Message,
  MessageAttachment,
  RecoveryKeyResponse,
  RelinkCandidate,
  RoomQueueSnapshot,
  RoomSession,
  ApiErrorResponse,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteProjectInput,
  GhRepoItem,
  LinkRepoInput,
  McpOAuthStatus,
  ModelCatalog,
  McpProbeResult,
  McpServerConfig,
  ModelEntry,
  ModelProvider,
  OnboardingStatus,
  Project,
  ProviderAuthStatus,
  ProviderUsageLimit,
  QaRun,
  RealProvider,
  RunBrowserQaInput,
  Settings,
  SettingsInput,
  SiteCredential,
  SitePreset,
  SttBenchmarkResult,
  SttLanguage,
  SttLocalStatus,
  Task,
  ThreadCompaction,
  TestSiteCredentialResult,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateSiteCredentialInput,
  UpdateTaskInput,
  UsageDashboardResponse,
  UsageRange,
  WorkspaceState,
} from '@atelier/contracts';

/** Fired when the server answers 401 `locked` (idle timeout, "Lock now" from another window/tray). */
export const LOCKED_EVENT = 'atelier:locked';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorResponse>;
  if (!res.ok) {
    const code = data.error?.code ?? null;
    if (res.status === 401 && code === 'locked') {
      window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
    }
    throw new ApiError(data.error?.message || `Request failed (${res.status})`, code, res.status);
  }
  return data;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  return parseResponse<T>(res);
}

/** Native helpers exposed by the Electron preload (absent in a normal browser). */
export interface AtelierDesktopBridge {
  isDesktop: true;
  pickFolder: (title?: string) => Promise<string | null>;
  appVersion?: string;
}

export function getDesktopBridge(): AtelierDesktopBridge | null {
  const bridge = (window as unknown as { atelierDesktop?: AtelierDesktopBridge }).atelierDesktop;
  return bridge?.isDesktop ? bridge : null;
}

export const attachmentUrl = (a: Pick<MessageAttachment, 'id' | 'name'>) =>
  `/api/attachments/${a.id}/${encodeURIComponent(a.name)}`;

/** Image files an agent saved in a workspace (design-option cards). */
export const workspaceImageUrl = (path: string) => `/api/workspace-image?path=${encodeURIComponent(path)}`;

export const authApi = {
  status: () => request<AuthStatus>('/api/auth/status'),
  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  lockNow: () => request<{ ok: true }>('/api/auth/lock-now', { method: 'POST' }),
  heartbeat: () => request<{ ok: true }>('/api/auth/heartbeat', { method: 'POST' }),
  recover: (recoveryKey: string, newPassword: string) =>
    request<RecoveryKeyResponse>('/api/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ recoveryKey, newPassword }),
    }),
  enable: (password: string, idleMinutes: number) =>
    request<RecoveryKeyResponse>('/api/auth/enable', {
      method: 'POST',
      body: JSON.stringify({ password, idleMinutes }),
    }),
  disable: (password: string) =>
    request<{ ok: true }>('/api/auth/disable', { method: 'POST', body: JSON.stringify({ password }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  regenerateRecoveryKey: (password: string) =>
    request<RecoveryKeyResponse>('/api/auth/recovery-key', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  setIdleMinutes: (idleMinutes: number) =>
    request<AuthStatus>('/api/auth/settings', { method: 'PATCH', body: JSON.stringify({ idleMinutes }) }),
};

export const backupApi = {
  /** Returns the backup file as a Blob plus its suggested filename. */
  exportFile: async (body: ExportBackupInput): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch('/api/backup/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await parseResponse(res);
    const filename = res.headers.get('X-Atelier-Filename') || 'atelier.atelier-backup';
    return { blob: await res.blob(), filename };
  },
  importFile: async (file: File, passphrase: string): Promise<BackupImportResult> => {
    const form = new FormData();
    form.set('file', file);
    if (passphrase) form.set('passphrase', passphrase);
    const res = await fetch('/api/backup/import', { method: 'POST', credentials: 'same-origin', body: form });
    return parseResponse<BackupImportResult>(res);
  },
  relink: () => request<{ relink: RelinkCandidate[] }>('/api/backup/relink'),
  getAuto: () => request<{ config: AutoBackupConfig }>('/api/backup/auto'),
  updateAuto: (body: AutoBackupConfigInput) =>
    request<{ config: AutoBackupConfig }>('/api/backup/auto', { method: 'PUT', body: JSON.stringify(body) }),
  runAuto: () => request<{ config: AutoBackupConfig }>('/api/backup/auto/run', { method: 'POST' }),
  cloudFolders: () => request<{ folders: CloudFolderCandidate[] }>('/api/backup/cloud-folders'),
};

export const api = {
  getState: () => request<WorkspaceState>('/api/state'),
  getOnboardingStatus: () => request<OnboardingStatus>('/api/onboarding-status'),

  createProject: (body: CreateProjectInput) =>
    request<{ project: Project; agents: Agent[] }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateProject: (id: string, body: UpdateProjectInput) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string, body: DeleteProjectInput = {}) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),

  getGithubRepos: () => request<{ repos: GhRepoItem[]; error?: string }>('/api/github/repos'),

  pickFolder: async (): Promise<{ path: string | null }> => {
    const desktop = getDesktopBridge();
    if (desktop) return { path: await desktop.pickFolder() };
    return request<{ path: string | null }>('/api/fs/pick-folder', { method: 'POST' });
  },

  unlinkRepo: (projectId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/repo`, { method: 'DELETE' }),

  linkRepo: (projectId: string, body: LinkRepoInput) =>
    request<{ project: Project }>(`/api/projects/${projectId}/repo`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Custom Agents & Skills (Global + Project Assignment)
  createGlobalAgent: (body: CreateAgentInput) =>
    request<{ agent: Agent }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createAgent: (projectId: string, body: CreateAgentInput) =>
    request<{ agent: Agent }>(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  assignAgentToProject: (projectId: string, agentId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/agents/${agentId}`, {
      method: 'POST',
    }),

  unassignAgentFromProject: (projectId: string, agentId: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/agents/${agentId}`, {
      method: 'DELETE',
    }),

  updateAgent: (agentId: string, body: UpdateAgentInput) =>
    request<{ agent: Agent }>(`/api/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteAgent: (agentId: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}`, {
      method: 'DELETE',
    }),

  readSkillFile: (filePath: string) =>
    request<{ skill: { name: string; description: string; content: string; sourcePath: string } }>(
      '/api/skills/read-file',
      {
        method: 'POST',
        body: JSON.stringify({ filePath }),
      },
    ),

  libraryImages: (scope: string | null, agentId?: string) =>
    request<{ images: LibraryImage[] }>(
      `/api/projects/${encodeURIComponent(scope ?? 'direct')}/library${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`,
    ),

  pickDesign: (scope: string | null, messageId: string, optionId: string, segmentIndex: number) =>
    request<{ entry: CanonEntry }>(`/api/projects/${encodeURIComponent(scope ?? 'direct')}/canon/pick`, {
      method: 'POST', body: JSON.stringify({ messageId, optionId, segmentIndex }),
    }),
  editCanon: (entry: CanonEntry, patch: Pick<CanonEntry, 'title' | 'value' | 'path'>) =>
    request<{ entry: CanonEntry }>(`/api/projects/${encodeURIComponent(entry.scopeKey)}/canon/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  pinCanon: (entry: CanonEntry, pinned: boolean) =>
    request<{ entry: CanonEntry }>(`/api/projects/${encodeURIComponent(entry.scopeKey)}/canon/${encodeURIComponent(entry.id)}/pin`, {
      method: 'PATCH', body: JSON.stringify({ pinned }),
    }),
  rebuildMemoryIndex: () => request<{ ok: boolean }>('/api/memory/rebuild', { method: 'POST' }),
  memoryItems: (scope: string | null, ids: string[]) =>
    request<{ items: Array<{ id: string; source: string; kind: string; title: string; line: string; pinned: boolean; updatedAt: string }> }>(
      `/api/projects/${encodeURIComponent(scope ?? 'direct')}/memory?ids=${encodeURIComponent(ids.join(','))}`,
    ),
  deleteCanon: (entry: CanonEntry) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(entry.scopeKey)}/canon/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE',
    }),
  sendMessage: (
    agentId: string,
    text: string,
    projectId?: string | null,
    attachmentIds?: string[],
    skillIds?: string[],
    mentionAgentIds?: string[],
  ) =>
    request<{ ok: boolean; agentId?: string; dispatchedAgentIds?: string[] }>(`/api/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        projectId: projectId ?? null,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(skillIds?.length ? { skillIds } : {}),
        ...(mentionAgentIds?.length ? { mentionAgentIds } : {}),
      }),
    }),

  uploadAttachments: async (files: File[]): Promise<{ attachments: MessageAttachment[] }> => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    // no JSON content-type: the browser sets the multipart boundary
    const res = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin', body: form });
    return parseResponse<{ attachments: MessageAttachment[] }>(res);
  },

  deleteAttachment: (id: string) => request<{ ok: boolean }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  stopAgent: (agentId: string) =>
    request<{ ok: boolean; stopped: boolean }>(`/api/agents/${agentId}/stop`, {
      method: 'POST',
    }),

  // Project Group Chat Rooms & Channels
  getProjectRoom: (projectId: string) =>
    request<{
      channel: Channel;
      members: Agent[];
      sessions: RoomSession[];
      queue: RoomQueueSnapshot;
    }>(`/api/projects/${projectId}/room`),

  updateChannel: (
    channelId: string,
    patch: { defaultResponderAgentId?: string | null; settings?: ChannelSettings },
  ) =>
    request<{ channel: Channel }>(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listChannelMessages: (
    channelId: string,
    opts?: { beforeRowid?: number; limit?: number; sessionId?: string },
  ) => {
    const params = new URLSearchParams();
    if (opts?.beforeRowid !== undefined) params.set('beforeRowid', String(opts.beforeRowid));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.sessionId) params.set('sessionId', opts.sessionId);
    const qs = params.toString();
    return request<{ messages: Message[]; oldestRowid: number | null; hasMore: boolean }>(
      `/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
    );
  },

  sendChannelMessage: (
    channelId: string,
    input: {
      text: string;
      mentionAgentIds?: string[];
      attachmentIds?: string[];
      skillIds?: string[];
      replyToMessageId?: string;
    },
  ) =>
    request<{
      ok: boolean;
      messageId: string;
      deliveredTo: string[];
      queueItemId: string | null;
    }>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  startRoomSession: (channelId: string, carryover: 'summary' | 'clean' = 'summary') =>
    request<{ session: RoomSession; channel: Channel }>(`/api/channels/${channelId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ carryover }),
    }),

  /** Starts a named, clean session in an agent's personal chat (DM channel). */
  startAgentSession: (channelId: string, name?: string) =>
    request<{ session: RoomSession; channel: Channel }>(`/api/channels/${channelId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ carryover: 'clean', ...(name ? { name } : {}) }),
    }),

  activateAgentSession: (channelId: string, sessionId: string) =>
    request<{ channel: Channel }>(`/api/channels/${channelId}/sessions/${sessionId}/activate`, {
      method: 'POST',
    }),

  renameSession: (channelId: string, sessionId: string, name: string) =>
    request<{ session: RoomSession }>(`/api/channels/${channelId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  forwardToChannel: (channelId: string, fromChannelId: string, messageIds: string[]) =>
    request<{ ok: boolean; message: Message }>(`/api/channels/${channelId}/forward`, {
      method: 'POST',
      body: JSON.stringify({ fromChannelId, messageIds }),
    }),

  skipRoomTurn: (channelId: string) =>
    request<{ ok: boolean; skipped: boolean; agentId: string | null }>(
      `/api/channels/${channelId}/skip`,
      { method: 'POST' },
    ),

  stopRoom: (channelId: string) =>
    request<{ ok: boolean; stopped: boolean }>(`/api/channels/${channelId}/stop`, {
      method: 'POST',
    }),

  reorderRoomQueue: (channelId: string, order: string[]) =>
    request<{ ok: boolean; queue: RoomQueueSnapshot }>(`/api/channels/${channelId}/queue`, {
      method: 'PATCH',
      body: JSON.stringify({ order }),
    }),

  approveRoomAction: (channelId: string, messageId: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/approvals/${messageId}/approve`, {
      method: 'POST',
    }),

  continueRoomChain: (channelId: string, rootMessageId: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/chains/${rootMessageId}/continue`, {
      method: 'POST',
    }),

  retryAgent: (
    agentId: string,
    opts?: { provider?: ModelProvider; model?: string; makeDefault?: boolean },
  ) =>
    request<{ ok: boolean; agent?: Agent }>(`/api/agents/${agentId}/retry`, {
      method: 'POST',
      body: opts ? JSON.stringify(opts) : undefined,
    }),

  dismissFallback: (agentId: string) =>
    request<{ ok: boolean; agent: Agent }>(`/api/agents/${agentId}/fallback`, {
      method: 'DELETE',
    }),

  compactAgent: (agentId: string, projectId?: string | null) =>
    request<{
      ok: boolean;
      compacted: boolean;
      compactedCount: number;
      compaction: ThreadCompaction | null;
      agent: Agent | null;
    }>(`/api/agents/${agentId}/compact`, {
      method: 'POST',
      body: JSON.stringify({ projectId: projectId ?? null }),
    }),

  // Linear-Style Tasks
  createTask: (projectId: string, body: CreateTaskInput) =>
    request<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateTask: (taskId: string, body: UpdateTaskInput) =>
    request<{ task: Task }>(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteTask: (taskId: string) =>
    request<{ ok: boolean }>(`/api/tasks/${taskId}`, {
      method: 'DELETE',
    }),

  dispatchTask: (taskId: string) =>
    request<{ ok: boolean; task: Task; agentId: string }>(`/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
    }),

  // Settings & Providers
  getSettings: () => request<{ settings: Settings }>('/api/settings'),

  updateSettings: (body: SettingsInput) =>
    request<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getModelCatalog: (provider: string, refresh = false) =>
    request<ModelCatalog>(`/api/providers/${provider}/models${refresh ? '?refresh=1' : ''}`),

  getProvidersStatus: () =>
    request<{ providers: ProviderAuthStatus[]; discoveredModels?: ModelEntry[] }>(
      '/api/providers/status',
    ),

  loginProvider: (provider: RealProvider) =>
    request<{ status: ProviderAuthStatus }>(`/api/providers/${provider}/login`, {
      method: 'POST',
    }),

  logoutProvider: (provider: RealProvider) =>
    request<{ status: ProviderAuthStatus }>(`/api/providers/${provider}/logout`, {
      method: 'POST',
    }),

  saveProviderApiKey: (provider: RealProvider, apiKey: string) =>
    request<{ status: ProviderAuthStatus }>(`/api/providers/${provider}/api-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  clearProviderApiKey: (provider: RealProvider) =>
    request<{ status: ProviderAuthStatus }>(`/api/providers/${provider}/api-key`, {
      method: 'DELETE',
    }),

  getUsage: (range: UsageRange = '30d', refresh = false) =>
    request<UsageDashboardResponse>(`/api/usage?range=${range}${refresh ? '&refresh=1' : ''}`),

  updateUsageLimit: (provider: ModelProvider, body: ProviderUsageLimit | { clear: true }) =>
    request<{ settings: Settings }>(`/api/usage/limits/${provider}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  clearUsageLogs: () =>
    request<{ ok: boolean }>('/api/usage/logs', {
      method: 'DELETE',
    }),

  // MCP Connections & Chief of Staff Onboarding
  createMcpServer: (body: Omit<McpServerConfig, 'id'>) =>
    request<{ server: McpServerConfig }>('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateMcpServer: (id: string, body: Partial<Omit<McpServerConfig, 'id'>>) =>
    request<{ server: McpServerConfig }>(`/api/mcp/servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteMcpServer: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/mcp/servers/${id}`, {
      method: 'DELETE',
    }),

  importMcpJson: (json: string) =>
    request<{ servers: McpServerConfig[] }>('/api/mcp/import', {
      method: 'POST',
      body: JSON.stringify({ json }),
    }),

  getMcpOAuthStatus: () =>
    request<{ status: Record<string, McpOAuthStatus>; redirectUri: string }>(
      '/api/mcp/oauth-status',
    ),

  startMcpOAuth: (id: string, creds?: { clientId: string; clientSecret?: string }) =>
    request<{ authUrl: string }>(`/api/mcp/servers/${id}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify(creds ?? {}),
    }),

  disconnectMcpOAuth: (id: string) =>
    request<{ ok: true }>(`/api/mcp/servers/${id}/oauth`, { method: 'DELETE' }),

  testMcpServer: (body: { id: string } | Omit<McpServerConfig, 'id'>) =>
    request<McpProbeResult>('/api/mcp/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  startChiefOfStaff: (projectId?: string) =>
    request<{ project: Project; agent: Agent }>('/api/onboarding/chief-of-staff', {
      method: 'POST',
      body: JSON.stringify(projectId ? { projectId } : {}),
    }),

  getQaBrowserStatus: () =>
    request<{ available: boolean; browserName: string | null; executablePath: string | null }>(
      '/api/qa/browser-status',
    ),

  listProjectQaRuns: (projectId: string) =>
    request<{ runs: QaRun[] }>(`/api/projects/${projectId}/qa/runs`),

  runProjectQa: (projectId: string, body: RunBrowserQaInput = {}) =>
    request<{ run: QaRun }>(`/api/projects/${projectId}/qa/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  dismissOnboarding: () =>
    request<{ ok: boolean }>('/api/onboarding/dismiss', {
      method: 'POST',
    }),

  getAppUpdate: () => request<{ update: AppUpdateStatus }>('/api/app-update'),

  checkAppUpdate: () =>
    request<{ update: AppUpdateStatus }>('/api/app-update/check', {
      method: 'POST',
    }),

  installAppUpdate: () =>
    request<{ update: AppUpdateStatus }>('/api/app-update/install', {
      method: 'POST',
    }),
};

export const browserApi = {
  status: () => request<BrowserStatusInfo>('/api/browser/status'),
  presets: () => request<{ presets: SitePreset[] }>('/api/browser/presets'),
  detectPreset: (loginUrl: string) =>
    request<{ detected: DetectedSitePreset }>('/api/browser/presets/detect', {
      method: 'POST',
      body: JSON.stringify({ loginUrl }),
    }),
  listProfiles: () => request<{ profiles: BrowserProfile[] }>('/api/browser/profiles'),
  createProfile: (name: string) =>
    request<{ profile: BrowserProfile }>('/api/browser/profiles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateProfile: (id: string, name: string) =>
    request<{ profile: BrowserProfile }>(`/api/browser/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteProfile: (id: string) =>
    request<{ ok: boolean }>(`/api/browser/profiles/${id}`, { method: 'DELETE' }),
  clearProfileCookies: (id: string) =>
    request<{ ok: boolean }>(`/api/browser/profiles/${id}/clear-cookies`, { method: 'POST' }),
  openProfileWindow: (id: string, url?: string) =>
    request<{ ok: boolean }>(`/api/browser/profiles/${id}/open`, {
      method: 'POST',
      body: JSON.stringify(url ? { url } : {}),
    }),
  listCredentials: () => request<{ credentials: SiteCredential[] }>('/api/browser/credentials'),
  createCredential: (body: CreateSiteCredentialInput) =>
    request<{ credential: SiteCredential }>('/api/browser/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateCredential: (id: string, body: UpdateSiteCredentialInput) =>
    request<{ credential: SiteCredential }>(`/api/browser/credentials/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteCredential: (id: string) =>
    request<{ ok: boolean }>(`/api/browser/credentials/${id}`, { method: 'DELETE' }),
  testCredential: (id: string) =>
    request<TestSiteCredentialResult>(`/api/browser/credentials/${id}/test`, {
      method: 'POST',
    }),
  listSessions: () => request<{ sessions: BrowserSessionInfo[] }>('/api/browser/sessions'),
  watchSession: (id: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/watch`, { method: 'POST' }),
  unwatchSession: (id: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/unwatch`, {
      method: 'POST',
    }),
  takeoverSession: (id: string, reason?: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/takeover`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  releaseSession: (id: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/release`, {
      method: 'POST',
    }),
  pauseSession: (id: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/pause`, {
      method: 'POST',
    }),
  resumeSession: (id: string) =>
    request<{ session: BrowserSessionInfo }>(`/api/browser/sessions/${id}/resume`, {
      method: 'POST',
    }),
  closeSession: (id: string) =>
    request<{ ok: boolean }>(`/api/browser/sessions/${id}/close`, { method: 'POST' }),
  listApprovals: () => request<{ approvals: BrowserApprovalRequest[] }>('/api/browser/approvals'),
  resolveApproval: (id: string, allow: boolean) =>
    request<{ ok: boolean }>(`/api/browser/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ allow }),
    }),
};

export const sttApi = {
  status: () => request<{ status: SttLocalStatus }>('/api/stt/local/status'),
  installEngine: (id = 'cpu-x64') =>
    request<{ status: SttLocalStatus }>('/api/stt/local/install-engine', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  downloadModel: (id: string) =>
    request<{ status: SttLocalStatus }>(`/api/stt/local/models/${encodeURIComponent(id)}/download`, {
      method: 'POST',
    }),
  deleteModel: (id: string) =>
    request<{ ok: boolean; status: SttLocalStatus }>(`/api/stt/local/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  deleteEngine: () =>
    request<{ ok: boolean; status: SttLocalStatus }>('/api/stt/local/engine', {
      method: 'DELETE',
    }),
  clearAll: () =>
    request<{ ok: boolean; status: SttLocalStatus }>('/api/stt/local/all', {
      method: 'DELETE',
    }),
  cancel: () =>
    request<{ ok: boolean; cancelled: boolean; status: SttLocalStatus }>('/api/stt/local/cancel', {
      method: 'POST',
    }),
  benchmark: (modelId?: string) =>
    request<{ result: SttBenchmarkResult; status: SttLocalStatus }>('/api/stt/local/benchmark', {
      method: 'POST',
      body: JSON.stringify(modelId ? { modelId } : {}),
    }),
  installSpeakers: () =>
    request<{ ok: boolean; status: SttLocalStatus }>('/api/stt/local/speakers/install', { method: 'POST' }),
  deleteSpeakers: () =>
    request<{ ok: boolean; status: SttLocalStatus }>('/api/stt/local/speakers', { method: 'DELETE' }),
};

export const meetingsApi = {
  list: () =>
    request<{ meetings: MeetingSession[]; active: MeetingStatusEvent | null; captureAvailable: boolean }>(
      '/api/meetings',
    ),
  get: (id: string) => request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}`),
  start: (body?: {
    title?: string;
    mode?: MeetingMode;
    language?: SttLanguage;
    modelId?: string;
    keepAudio?: boolean;
    prompt?: string;
  }) =>
    request<MeetingStatusEvent>('/api/meetings/start', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  stop: (id: string) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  defer: (id: string) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/defer`, {
      method: 'POST',
    }),
  switchModel: (id: string, modelId: string) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/switch-model`, {
      method: 'POST',
      body: JSON.stringify({ modelId }),
    }),
  resume: (id: string) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  pause: (id: string, paused: boolean) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    }),
  discard: (id: string) =>
    request<{ ok: boolean }>(`/api/meetings/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
    }),
  audioDevices: () => request<AudioDevicesInfo>('/api/meetings/audio-devices'),
  /** Level meter for the pickers in Settings; `micDevice`/`speakerDevice` preview an unsaved choice. */
  audioMeter: (enabled: boolean, devices?: { micDevice?: string | null; speakerDevice?: string | null }) =>
    request<{ ok: boolean }>('/api/meetings/audio-meter', {
      method: 'POST',
      body: JSON.stringify({ enabled, ...devices }),
    }),
  regenerateNotes: (id: string, override?: { provider: MeetingNotesProvider | null; model: string | null }) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/regenerate-notes`, {
      method: 'POST',
      body: JSON.stringify(override ?? {}),
    }),
  renameSpeaker: (id: string, speakerId: string, name: string | null) =>
    request<MeetingStatusEvent>(
      `/api/meetings/${encodeURIComponent(id)}/speakers/${encodeURIComponent(speakerId)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    ),
  mergeSpeaker: (id: string, speakerId: string, into: string) =>
    request<MeetingStatusEvent>(
      `/api/meetings/${encodeURIComponent(id)}/speakers/${encodeURIComponent(speakerId)}/merge`,
      { method: 'POST', body: JSON.stringify({ into }) },
    ),
  speakerSampleUrl: (id: string, speakerId: string) =>
    `/api/meetings/${encodeURIComponent(id)}/speakers/${encodeURIComponent(speakerId)}/sample.wav`,
  diarize: (id: string, participants: number | null) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/diarize`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),
  speakersDone: (id: string, regenerate: boolean) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}/speakers-done`, {
      method: 'POST',
      body: JSON.stringify({ regenerate }),
    }),
  rename: (id: string, title: string) =>
    request<MeetingStatusEvent>(`/api/meetings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/meetings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
