import type {
  Agent,
  CanonEntry,
  AuthStatus,
  AutoBackupConfig,
  AutoBackupConfigInput,
  BackupImportResult,
  CloudFolderCandidate,
  ExportBackupInput,
  LibraryImage,
  MessageAttachment,
  RecoveryKeyResponse,
  RelinkCandidate,
  ApiErrorResponse,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteProjectInput,
  GhRepoItem,
  LinkRepoInput,
  McpOAuthStatus,
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
  Task,
  ThreadCompaction,
  UpdateAgentInput,
  UpdateProjectInput,
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
  deleteCanon: (entry: CanonEntry) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(entry.scopeKey)}/canon/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE',
    }),
  sendMessage: (agentId: string, text: string, projectId?: string | null, attachmentIds?: string[]) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        projectId: projectId ?? null,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
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
};
