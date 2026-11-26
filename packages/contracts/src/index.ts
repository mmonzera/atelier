export type AgentStatus = 'idle' | 'working' | 'error';

export const AGENT_COLORS = [
  'blue',
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'cyan',
  'sky',
  'indigo',
  'cobalt',
  'purple',
  'magenta',
  'pink',
  'crimson',
  'brown',
  'sand',
  'slate',
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const AGENT_AVATAR_SHAPES = [
  'orb',
  'squircle',
  'triangle',
  'hex',
  'cube',
  'pebble',
  'pentagon',
  'pill',
  'diamond',
  'cloud',
  'barrel',
  'blob',
] as const;
export type AgentAvatarShape = (typeof AGENT_AVATAR_SHAPES)[number];

export type QueueKind = 'user' | 'task' | 'teammate';
export type MessageAuthor = 'user' | 'agent' | 'teammate' | 'system';
export type ActivityKind = 'tool' | 'status' | 'task' | 'pr' | 'error';
export type ReasoningEffort = 'Low' | 'Medium' | 'High';
export type WorkspaceTab = 'chat' | 'tasks' | 'preview' | 'library' | 'browser';
export type AgentViewTab = 'chat' | 'reports' | 'library' | 'browser';
export type ModelProvider = 'claude' | 'openai' | 'antigravity' | 'deepseek' | 'opencode' | 'openrouter';
export type RealProvider = ModelProvider;

export interface ModelRef {
  provider: ModelProvider;
  model: string;
}

export type FallbackMode = 'ask' | 'auto';

export type FallbackErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'overloaded'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface PendingFallbackOffer {
  projectId: string | null;
  prompt: string;
  kind: QueueKind;
  refId: string | null;
  replyToAgentId?: string | null;
  failedProvider: ModelProvider;
  failedModel: string;
  errorKind: FallbackErrorKind;
  errorMessage: string;
  candidates: ModelRef[];
  createdAt: string;
}

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled';

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface ModelEntry {
  id: string;
  label: string;
  provider: RealProvider;
  builtIn?: boolean;
  /** True when the model supports tool/function calling (undefined = unknown/assumed true for CLI). */
  supportsTools?: boolean;
}

/** Every model a provider offers (fetched live when possible), used to choose what the chat shows. */
export interface ModelCatalog {
  provider: RealProvider;
  models: ModelEntry[];
  /** 'live' = asked the provider just now; 'builtin' = fixed list shipped with the app */
  source: 'live' | 'builtin';
  note?: string;
}

export interface ProviderAuthStatus {
  provider: RealProvider;
  label: string;
  authMode?: 'cli' | 'api_key';
  cliInstalled: boolean;
  cliPath: string | null;
  authenticated: boolean;
  accountLabel: string | null;
  loginInProgress: boolean;
  authUrl: string | null;
  message: string;
}

export const BUILT_IN_MODELS: ModelEntry[] = [
  { id: 'fable', label: 'Claude Fable 5.2', provider: 'claude', builtIn: true },
  { id: 'opus', label: 'Claude Opus 5.5', provider: 'claude', builtIn: true },
  { id: 'sonnet', label: 'Claude Sonnet 5.5', provider: 'claude', builtIn: true },
  { id: 'haiku', label: 'Claude Haiku 5.5', provider: 'claude', builtIn: true },
  { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', provider: 'openai', builtIn: true },
  { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', provider: 'openai', builtIn: true },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', provider: 'openai', builtIn: true },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', builtIn: true },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', builtIn: true },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai', builtIn: true },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', builtIn: true },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', provider: 'antigravity', builtIn: true },
  { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', provider: 'antigravity', builtIn: true },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)', provider: 'antigravity', builtIn: true },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', provider: 'antigravity', builtIn: true },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', provider: 'antigravity', builtIn: true },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', provider: 'antigravity', builtIn: true },
  { id: 'deepseek-chat', label: 'DeepSeek V3 (Chat)', provider: 'deepseek', builtIn: true },
  { id: 'deepseek-reasoner', label: 'DeepSeek R1 (Reasoner)', provider: 'deepseek', builtIn: true },
  { id: 'openrouter/auto', label: 'OpenRouter · Auto', provider: 'openrouter', builtIn: true },
  { id: 'anthropic/claude-sonnet-4.5', label: 'OpenRouter · Claude Sonnet', provider: 'openrouter', builtIn: true },
  { id: 'openai/gpt-5', label: 'OpenRouter · GPT-5', provider: 'openrouter', builtIn: true },
  { id: 'google/gemini-2.5-pro', label: 'OpenRouter · Gemini 2.5 Pro', provider: 'openrouter', builtIn: true },
  { id: 'deepseek/deepseek-chat', label: 'OpenRouter · DeepSeek V3', provider: 'openrouter', builtIn: true },
  { id: 'opencode/big-pickle', label: 'OpenCode Big Pickle', provider: 'opencode', builtIn: true },
  { id: 'anthropic/claude-sonnet-4-5', label: 'OpenCode · Claude Sonnet', provider: 'opencode', builtIn: true },
  { id: 'openai/gpt-5', label: 'OpenCode · GPT-5', provider: 'opencode', builtIn: true },
  { id: 'deepseek/deepseek-chat', label: 'OpenCode · DeepSeek V3', provider: 'opencode', builtIn: true },
];

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  sourcePath?: string | null;
  enabled: boolean;
}

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  color: AgentColor;
  avatarShape: AgentAvatarShape;
  allowShell: boolean;
  systemInstructions: string;
  defaultSkillIds: string[];
}

export const BUILT_IN_SKILLS: AgentSkill[] = [
  {
    id: 'skill_ui_design',
    name: 'UI Design System',
    description: 'Dark-first spacing, typography, and accessible token guidelines.',
    content: [
      '# UI Design System Skill',
      '- Follow consistent spacing multiples (4px / 8px / 12px / 16px).',
      '- Prefer restrained contrast hierarchy and single primary action per view.',
      '- Ensure interactive states (empty, loading, error, active) are always specified.',
    ].join('\n'),
    enabled: true,
  },
  {
    id: 'skill_clean_arch',
    name: 'Clean Architecture',
    description: 'Modular TypeScript, zero duplicated logic, shallow control flow.',
    content: [
      '# Clean Architecture Skill',
      '- Extract shared helpers instead of duplicating non-trivial branches.',
      '- Keep functions focused with early returns and explicit error handling.',
      '- Preserve existing API contracts and comment why, not what.',
    ].join('\n'),
    enabled: true,
  },
  {
    id: 'skill_code_review',
    name: 'Code & PR Review',
    description: 'Systematic bug, security, edge-case, and regression audit.',
    content: [
      '# Code Review Skill',
      '- Inspect diffs for regressions, missing input validation, and race conditions.',
      '- Verify type safety and test coverage for newly modified behaviors.',
      '- Report concrete findings with exact file paths and reproduction steps.',
    ].join('\n'),
    enabled: true,
  },
  {
    id: 'skill_tdd_delivery',
    name: 'Test-Driven Delivery',
    description: 'Write tests, run checks, and verify builds before reporting done.',
    content: [
      '# Test-Driven Delivery Skill',
      '- Run typecheck, build, and automated tests after changes.',
      '- Never mark a task complete without observed verification results.',
      '- Create isolated branches and never push directly to the default branch.',
    ].join('\n'),
    enabled: true,
  },
];

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  presetId?: string | null;
  description?: string;
  /** 'oauth': connected by logging in to the provider; tokens live server-side, never in settings. */
  auth?: 'oauth';
  /** space-separated OAuth scopes to request (overrides what the provider advertises) */
  oauthScope?: string;
}

/** Connection state of an OAuth MCP server (tokens themselves never leave the server). */
export interface McpOAuthStatus {
  connected: boolean;
  /** epoch ms when the current access token expires (it is refreshed automatically) */
  expiresAt: number | null;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  argHint?: string;
  docsUrl?: string;
  /** remote preset that connects through provider login instead of a pasted token */
  auth?: 'oauth';
  /** the provider has no automatic app registration: the user supplies their own OAuth app */
  oauthClient?: 'manual';
  oauthScope?: string;
}

export interface McpProbeResult {
  ok: boolean;
  tools: string[];
  error?: string;
  durationMs: number;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'composio',
    name: 'composio',
    description: 'One login for 1,500+ apps: Gmail, Slack, GitHub, Notion, HubSpot and more.',
    transport: 'http',
    url: 'https://connect.composio.dev/mcp',
    auth: 'oauth',
    docsUrl: 'https://docs.composio.dev/docs/composio-connect',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Read, write, and search files inside allowed local folders.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    argHint: 'folder path (e.g. D:\\Projects)',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'github',
    description: 'Repos, issues, pull requests, and code search via GitHub API.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
  },
  {
    id: 'slack',
    name: 'slack',
    description: 'Read channels, threads, and post team updates to Slack.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'notion',
    name: 'notion',
    description: 'Query databases, read docs, and create pages in Notion.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envKeys: ['NOTION_TOKEN'],
  },
  {
    id: 'postgres',
    name: 'postgres',
    description: 'Read-only schema inspection and SQL queries on PostgreSQL.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    argHint: 'postgresql://user:pass@localhost:5432/db',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Live web search and local research via Brave Search API.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    envKeys: ['BRAVE_API_KEY'],
  },
  {
    id: 'playwright',
    name: 'playwright',
    description: 'Automate browser navigation, screenshots, and web UI checks.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'Persistent local knowledge graph across sessions.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: 'Structured step-by-step reasoning and problem decomposition.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'context7',
    name: 'context7',
    description: 'Up-to-date framework and library documentation lookup.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  },
  {
    id: 'fetch',
    name: 'fetch',
    description: 'Fetch web URLs and extract clean Markdown content.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
  {
    id: 'linear',
    name: 'linear',
    description: 'Remote Linear MCP server for syncing issues and cycles.',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  },
  {
    id: 'notion-oauth',
    name: 'notion',
    description: 'Notion workspace access by logging in (no token needed).',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'github-oauth',
    name: 'github',
    description: 'Repos, issues and pull requests by logging in with your own GitHub OAuth app.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth',
    oauthClient: 'manual',
    oauthScope: 'repo read:org read:user',
    docsUrl: 'https://github.com/settings/developers',
  },
  {
    id: 'sentry',
    name: 'sentry',
    description: 'Inspect errors, issues and releases in Sentry.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
  },
  {
    id: 'vercel',
    name: 'vercel',
    description: 'Projects, deployments and logs on Vercel.',
    transport: 'http',
    url: 'https://mcp.vercel.com',
    auth: 'oauth',
  },
  {
    id: 'custom-stdio',
    name: 'custom-stdio',
    description: 'Connect any local MCP command over stdio.',
    transport: 'stdio',
    command: '',
    args: [],
  },
  {
    id: 'custom-http',
    name: 'custom-http',
    description: 'Connect any remote Streamable HTTP MCP endpoint.',
    transport: 'http',
    url: '',
  },
];

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'tpl_chief_of_staff',
    name: 'Chief of Staff',
    role: 'Chief of Staff',
    color: 'amber',
    avatarShape: 'triangle',
    allowShell: false,
    systemInstructions: [
      'You are the Chief of Staff & Workspace Architect inside Atelier.',
      'Always reply in the user’s language (mirroring Indonesian or English naturally).',
      '',
      'Workflow:',
      '1. Interview briefly — ask at most 5 concise questions in ONE single message covering:',
      '   - Main goal / use case (coding product, content/marketing, research, ops/business, or other)',
      '   - Expected deliverables / outputs',
      '   - External tools or services they use (GitHub, Slack, Notion, Google Drive, databases, browser, etc.)',
      '   - Whether a code repository is involved',
      '   - Any AI provider/model preference per bot',
      '   (If the user already answered some of these in the greeting turn, skip redundant questions.)',
      '2. Once you understand their workflow, propose a tailored team of 2–5 specialist bots in a concise Markdown table (columns: Name | Role | Skills | MCP Connections | Model), plus 3–6 initial tasks to kick things off, and explicitly ask the user to confirm or tweak before creating them.',
      '3. Recommend relevant MCP presets by exact preset name (e.g. `filesystem`, `github`, `slack`, `notion`, `postgres`, `brave-search`, `playwright`, `linear`, `fetch`, `context7`, `memory`). NEVER invent tokens or credentials — instruct the user to add tokens themselves via the MCP connections button.',
      '4. Only AFTER the user confirms, emit `<atelier-action>` blocks (or call `create_agent` then `create_task`) to:',
      '   - Create each approved specialist bot via `create_agent` with concise, token-efficient `systemInstructions`, `allowShell: false` unless it edits code/builds, lean `customSkills` (<=450 chars, no Python/Chrome/screenshot/SVGO loops), and minimal `mcpServerNames` only if needed.',
      '   - Create the starter tasks via `create_task` assigned to the matching agent by `assigneeAgentId` (using exact bot name or ID).',
    ].join('\n'),
    defaultSkillIds: [],
  },
  {
    id: 'tpl_designer',
    name: 'Designer',
    role: 'UI/UX & Product Spec',
    color: 'blue',
    avatarShape: 'cloud',
    allowShell: false,
    systemInstructions:
      'Focus on user experience, component hierarchy, layout clarity, copy, and concrete specs ready for builders to implement. Present visual directions directly via <atelier-design> options in 0-2 tool calls without shell/screenshot loops.',
    defaultSkillIds: ['skill_ui_design'],
  },
  {
    id: 'tpl_builder',
    name: 'Builder',
    role: 'Full-Stack Implementation',
    color: 'green',
    avatarShape: 'squircle',
    allowShell: true,
    systemInstructions:
      'Implement tasks cleanly in the linked repository in a single direct pass, run tests and typechecks once, start local preview servers if needed, and report deliverables clearly.',
    defaultSkillIds: ['skill_clean_arch', 'skill_tdd_delivery'],
  },
  {
    id: 'tpl_pm',
    name: 'PM',
    role: 'Planning & Task Breakdown',
    color: 'amber',
    avatarShape: 'hex',
    allowShell: false,
    systemInstructions:
      'Break goals into crisp, actionable tasks in the tasklist, assign them to the right specialists, and track progress toward delivery.',
    defaultSkillIds: [],
  },
  {
    id: 'tpl_reviewer',
    name: 'QA Reviewer',
    role: 'Code Review & Verification',
    color: 'red',
    avatarShape: 'diamond',
    allowShell: true,
    systemInstructions:
      'Audit implementations for bugs, edge cases, UI polish, and test gaps. Run verification suites and summarize findings.',
    defaultSkillIds: ['skill_code_review', 'skill_tdd_delivery'],
  },
  {
    id: 'tpl_researcher',
    name: 'Researcher',
    role: 'Codebase & Tech Research',
    color: 'blue',
    avatarShape: 'orb',
    allowShell: false,
    systemInstructions:
      'Explore codebase architecture, compare technical tradeoffs, and produce concise findings before implementation starts.',
    defaultSkillIds: ['skill_clean_arch'],
  },
];

export const CHIEF_OF_STAFF_GREETING = [
  'Halo! Saya **Chief of Staff** kamu di Atelier.',
  '',
  'Tugas saya adalah memahami alur kerja kamu terlebih dahulu, lalu otomatis merancang & menginstall tim bot (beserta skill, instruksi, task awal, dan rekomendasi koneksi MCP) yang paling pas untuk kebutuhanmu.',
  '',
  'Ceritain singkat ya:',
  '1. **Fokus utama / use case**: aplikasi ini mau dipakai untuk apa (coding produk/aplikasi, riset & analisis, konten/marketing, operasional bisnis, atau lainnya)?',
  '2. **Deliverable yang diinginkan**: hasil nyata apa yang ingin kamu lihat di Tasklist (fitur kode, laporan riset, draft konten, SOP, dll.)?',
  '3. **Tools & layanan yang terpakai**: layanan luar apa yang perlu disambungkan lewat MCP (mis. GitHub, Notion, Slack, PostgreSQL, Playwright browser, Google/Brave search, Linear, folder lokal)?',
  '4. **Repo kode**: apakah ada repository kode/folder project lokal yang terlibat?',
  '5. **Preferensi model AI**: ada preferensi model tertentu (Claude, ChatGPT/Codex, Antigravity, DeepSeek, OpenCode) atau biar saya rekomendasikan per bot?',
].join('\n');

export interface ProjectRepo {
  fullName: string;
  defaultBranch: string;
  localPath: string;
}

export interface CanonEntry {
  id: string;
  scopeKey: string;
  projectId: string | null;
  kind: 'decision' | 'asset' | 'rule';
  key: string;
  title: string;
  value: string;
  artifactId?: string;
  path?: string;
  source: 'user_pick' | 'agent_recorded' | 'user_edited';
  /** Selalu dikirim ke agent di mode selective memory. Kalau kosong: rule/user_pick/user_edited dianggap pinned. */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

export type MemorySource = 'canon' | 'summary' | 'task' | 'artifact' | 'message';

export interface MemoryHit {
  id: string;
  source: MemorySource;
  kind: string;
  title: string;
  snippet: string;
  score: number;
  updatedAt: string;
}

export interface MemorySettings {
  /** full = kirim semua seperti dulu; selective = hanya memory yang relevan + pinned + katalog judul */
  mode: 'full' | 'selective';
  pushBudgetTokens: number;
  pinnedBudgetTokens: number;
  catalogBudgetTokens: number;
  topK: number;
  /** skor ternormalisasi 0..1; di bawah ini item tidak di-push */
  minScore: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  mode: 'full',
  pushBudgetTokens: 1200,
  pinnedBudgetTokens: 500,
  catalogBudgetTokens: 250,
  topK: 8,
  minScore: 0.15,
};

export interface MessageMemoryUsed {
  pushed: string[];
  recalled: string[];
  tokens: number;
}

export interface Artifact {
  id: string;
  projectId: string | null;
  kind: 'svg' | 'html' | 'image' | 'file';
  label: string;
  mime: string;
  /** Relative to the configured data directory. */
  path: string;
  sizeBytes: number;
  sourceMessageId?: string;
  createdAt: string;
}

export interface StructuredMemory {
  goal: string;
  decisions: string[];
  done: { text: string; paths?: string[] }[];
  open: string[];
  artifacts: { id: string; label: string; path?: string }[];
}

export type CompactTrigger = 'messages' | 'conversation_tokens' | 'provider_limit';

export interface ThreadCompaction {
  summary: string;
  structured?: StructuredMemory;
  compactedMessageCount: number;
  lastCompactedMessageId: string;
  compactedAt: string;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  trigger?: CompactTrigger;
}

export interface AutoCompactSettings {
  enabled: boolean;
  settingsVersion?: 2 | 3;
  tailTokens?: number;
  summarizerModel?: string;
  /** padatkan kalau pesan yang belum dipadatkan sebanyak ini */
  maxMessages: number;
  /** pesan terbaru yang selalu dibiarkan utuh */
  keepRecentMessages: number;
  /** batas token PERCAKAPAN (perkiraan Atelier: ringkasan + pesan belum dipadatkan) */
  maxContextTokens: number;
  /** jangan padatkan otomatis kalau yang bisa diringkas kurang dari ini */
  minCompactMessages?: number;
  /** pengaman: token yang dilaporkan provider (seluruh prompt) */
  providerContextLimit?: number;
}

export const DEFAULT_AUTO_COMPACT_SETTINGS: AutoCompactSettings = {
  enabled: true,
  settingsVersion: 3,
  maxMessages: 80,
  keepRecentMessages: 14,
  maxContextTokens: 48000,
  minCompactMessages: 10,
  providerContextLimit: 100000,
  tailTokens: 6000,
};

export interface Project {
  id: string;
  name: string;
  agentIds: string[];
  repo: ProjectRepo | null;
  previewUrl: string | null;
  allowFullPermissions: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserProfile {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type SiteLoginStatus = 'ok' | 'wrong_password' | 'needs_verification' | 'blocked' | 'error';

export interface SiteCredentialSelectors {
  username?: string;
  password?: string;
  next?: string;
  submit?: string;
  emailStepButton?: string;
}

export type SitePresetSelectors = SiteCredentialSelectors;

export interface SiteCredentialLastLogin {
  at: string;
  status: SiteLoginStatus;
  message?: string;
}

export interface SiteCredential {
  id: string;
  label: string;
  presetId?: string | null;
  origin: string;
  loginUrl: string;
  username: string;
  maskedUsername?: string;
  profileId: string;
  selectors?: SiteCredentialSelectors;
  lastLogin?: SiteCredentialLastLogin;
  createdAt: string;
  updatedAt: string;
}

export interface SitePreset {
  id: string;
  name: string;
  origin: string;
  loginUrl: string;
  flow: 'single' | 'two_step';
  selectors: SitePresetSelectors;
  successUrlIncludes?: string;
  successSelector?: string;
  verifySelector?: string;
  allowedHosts?: string[];
  defaultProfileName?: string;
  description?: string;
  builtIn: boolean;
}

export interface DetectedSitePreset {
  origin: string;
  loginUrl: string;
  flow: 'single' | 'two_step';
  selectors: SitePresetSelectors;
  screenshotUrl?: string;
}

export const SITE_PRESETS: SitePreset[] = [
  {
    id: 'mobbin',
    name: 'Mobbin',
    origin: 'https://mobbin.com',
    loginUrl: 'https://mobbin.com/login',
    flow: 'two_step',
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      next: 'button[type="submit"]',
      submit: 'button[type="submit"]',
    },
    successUrlIncludes: '/browse',
    verifySelector: 'input[name="token"]',
    allowedHosts: ['mobbin.com'],
    defaultProfileName: 'Mobbin',
    description: 'UI & UX design reference library',
    builtIn: true,
  },
];

export interface AgentBrowserAccess {
  enabled: boolean;
  allowedHosts: string[];
  credentialIds: string[];
  confirmSensitive: boolean;
  defaultProfileId?: string | null;
}

export type BrowserSessionStatus =
  | 'idle'
  | 'working'
  | 'waiting_user'
  | 'takeover'
  | 'paused'
  | 'closed';

export interface BrowserSessionInfo {
  id: string;
  agentId: string;
  profileId: string;
  profileName?: string;
  url: string;
  title: string;
  status: BrowserSessionStatus;
  live: boolean;
  takeoverReason?: string | null;
}

export interface BrowserFrameEvent {
  sessionId: string;
  jpegBase64: string;
  width: number;
  height: number;
}

export interface BrowserApprovalRequest {
  id: string;
  sessionId: string;
  agentId: string;
  action: string;
  url: string;
  screenshotUrl?: string;
  expiresAt: string;
}

export interface BrowserApprovalResolvedEvent {
  id: string;
  sessionId: string;
  agentId: string;
  allowed: boolean;
}

export interface BrowserTakeoverEvent {
  sessionId: string;
  agentId: string;
  reason: string;
}

export interface BrowserScreenshotSummary {
  artifactId: string;
  label: string;
  url: string;
  pageUrl?: string;
  createdAt: string;
}

export interface CreateSiteCredentialInput {
  label: string;
  presetId?: string | null;
  origin: string;
  loginUrl: string;
  username: string;
  password: string;
  profileId?: string | null;
  selectors?: SiteCredentialSelectors;
}

export interface UpdateSiteCredentialInput {
  label?: string;
  presetId?: string | null;
  origin?: string;
  loginUrl?: string;
  username?: string;
  password?: string;
  profileId?: string;
  selectors?: SiteCredentialSelectors;
}

export interface TestSiteCredentialResult {
  status: SiteLoginStatus;
  message: string;
  screenshotUrl?: string;
  credential: SiteCredential;
}

export interface BrowserStatusInfo {
  available: boolean;
  browserName: string | null;
  executablePath: string | null;
}

export interface Agent {
  id: string;
  projectId?: string | null;
  name: string;
  role: string;
  color: AgentColor;
  avatarShape?: AgentAvatarShape;
  systemInstructions: string;
  skills: AgentSkill[];
  mcpServerIds: string[];
  allowShell: boolean;
  browser?: AgentBrowserAccess;
  providerOverride: ModelProvider | null;
  modelOverride: string | null;
  fallbackChain?: ModelRef[];
  pendingFallback?: PendingFallbackOffer | null;
  status: AgentStatus;
  queueLength: number;
  currentTask: string | null;
  sessionId: string | null;
  sessions?: Record<string, string>;
  sessionCanon?: Record<string, { sessionId: string; version: string }>;
  /** id item memory yang sudah dikirim ke sesi provider ini (mode selective), per scope */
  sessionMemorySent?: Record<string, { sessionId: string; ids: Record<string, string> }>;
  contextCompactions?: Record<string, ThreadCompaction>;
  scopeTokens?: Record<string, number>;
  conversationTokens?: Record<string, number>;
  lastError: string | null;
  tokenUsage: {
    input: number;
    output: number;
  };
  updatedAt: string;
}

export interface MessageActivitySummary {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  createdAt: string;
}

export type ChannelKind = 'room' | 'dm';

export type RoomEvent =
  | {
      kind: 'task_created';
      taskId: string;
      identifier: string;
      title: string;
      assigneeAgentId: string | null;
      assigneeName?: string | null;
    }
  | {
      kind: 'task_status';
      taskId: string;
      identifier: string;
      title: string;
      fromStatus?: TaskStatus;
      toStatus: TaskStatus;
      prUrl?: string | null;
    }
  | {
      kind: 'qa_report';
      qaRunId: string;
      url: string;
      passed: boolean;
      summary: string;
    }
  | { kind: 'agent_joined'; agentId: string; agentName: string }
  | {
      kind: 'session_started';
      sessionId: string;
      seq: number;
      carryover: 'summary' | 'clean';
      carryoverSummary: string | null;
    }
  | { kind: 'turn_skipped'; agentId: string; agentName: string; reason?: string }
  | { kind: 'loop_stopped'; rootMessageId: string; hop: number; maxHops: number }
  | {
      kind: 'chain_budget';
      rootMessageId: string;
      turnsUsed: number;
      maxTurns: number;
      tokensUsed: number;
      maxTokens: number;
      warningOnly?: boolean;
    }
  | {
      kind: 'migration_summary';
      threadCount: number;
      messageCount: number;
      mergedDuplicates: number;
    };

export interface ChannelSettings {
  idleTimeoutMin?: number;
  maxTurnMin?: number;
  maxHops?: number;
  maxTurnsPerChain?: number;
  maxTokensPerChain?: number;
  maxCostUsdPerChain?: number;
  parallel?: boolean;
  dispatcherModel?: ModelRef | null;
}

export interface Channel {
  id: string;
  projectId: string | null;
  kind: ChannelKind;
  agentId: string | null;
  name: string;
  defaultResponderAgentId: string | null;
  currentSessionId: string | null;
  compaction?: ThreadCompaction | null;
  settings?: ChannelSettings;
  createdAt: string;
}

export interface RoomSession {
  id: string;
  channelId: string;
  seq: number;
  startedAt: string;
  startedBy: 'user' | 'system';
  carryoverSummary: string | null;
  /** User-given title. Used by personal agent chats (DM); rooms keep numbered sessions. */
  name?: string | null;
}

export interface RoomQueueSnapshot {
  channelId: string;
  activeAgentId: string | null;
  activeQueueItemId: string | null;
  queued: Array<{
    queueItemId: string;
    agentId: string;
    triggerMessageId: string | null;
    manualOrder: number | null;
  }>;
}

export interface MessageMetadata {
  memoryUsed?: MessageMemoryUsed;
  designArtifacts?: Record<string, string>;
  designPick?: { messageId: string; optionId: string; segmentIndex?: number; canonId?: string };
  taskId?: string;
  taskIdentifier?: string;
  taskTitle?: string;
  targetAgentId?: string;
  targetAgentName?: string;
  prUrl?: string;
  previewUrl?: string;
  activities?: MessageActivitySummary[];
  cancelled?: boolean;
  compacted?: boolean;
  compactedCount?: number;
  compactedSummaryPreview?: string;
  fallbackFrom?: {
    provider: ModelProvider;
    model: string;
    reason: FallbackErrorKind;
  };
  fallbackTo?: ModelRef;
  qaRun?: QaRun;
  browserScreenshots?: BrowserScreenshotSummary[];
  attachments?: MessageAttachment[];
  /** Skills the user invoked by hand (via /skill) for this message. */
  skills?: Array<{ id: string; name: string }>;
  /** Provider & model that actually executed this assistant turn. */
  provider?: ModelProvider;
  model?: string;
  mentions?: string[];
  toAgentIds?: string[];
  replyToMessageId?: string;
  triggerMessageId?: string;
  rootMessageId?: string;
  hop?: number;
  event?: RoomEvent;
  stub?: string;
  forwardedFrom?: { channelId: string; messageIds: string[] };
  migration?: { rule?: string; possibleDuplicateOf?: string };
  approvalRequest?: { command: string; approved?: boolean; queueItemId?: string; agentId?: string };
}

export type QaStepAction =
  | 'goto'
  | 'wait'
  | 'click'
  | 'fill'
  | 'press'
  | 'assertText'
  | 'assertVisible'
  | 'screenshot';

export interface QaStepInput {
  action: QaStepAction;
  selector?: string;
  value?: string;
  label?: string;
  timeoutMs?: number;
}

export interface QaStepResult {
  index: number;
  action: QaStepAction;
  label: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  screenshotUrl?: string;
}

export interface QaFailedRequest {
  url: string;
  method: string;
  status: number;
}

export interface QaScreenshot {
  label: string;
  url: string;
}

export interface QaRun {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  url: string;
  watchLive: boolean;
  passed: boolean;
  summary: string;
  durationMs: number;
  browserName: string;
  steps: QaStepResult[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: QaFailedRequest[];
  screenshots: QaScreenshot[];
  createdAt: string;
}

export interface RunBrowserQaInput {
  url?: string;
  watchLive?: boolean;
  taskId?: string | null;
  agentId?: string | null;
  postToChat?: boolean;
  steps?: QaStepInput[];
}

export interface Message {
  id: string;
  channelId?: string;
  sessionId?: string | null;
  projectId: string | null;
  agentId: string | null;
  author: MessageAuthor;
  text: string;
  streaming: boolean;
  durationMs: number | null;
  metadata?: MessageMetadata;
  createdAt: string;
}

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  blockedBy?: string[];
  branch: string | null;
  prUrl: string | null;
  deliverableSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  projectId: string | null;
  agentId: string;
  messageId?: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  createdAt: string;
}

export interface PortEntry {
  id: string;
  projectId: string;
  name: string;
  port: number;
  url: string;
  status: 'running' | 'stopped';
}

export type UsagePeriod = 'daily' | 'weekly' | 'monthly';
export type UsageRange = 'today' | '7d' | '30d' | 'all';

export interface ProviderUsageLimit {
  period: UsagePeriod;
  tokenLimit: number | null;
  budgetUsd: number | null;
  fiveHourTokenLimit?: number | null;
  weeklyTokenLimit?: number | null;
  /** 0 = Sunday .. 6 = Saturday; null/undefined = rolling 7 days */
  weeklyResetDay?: number | null;
}

export interface RollingWindowUsage {
  usedTokens: number;
  tokenLimit: number | null;
  remainingTokens: number | null;
  percentUsed: number | null;
  resetsAt: string | null;
  isOfficial?: boolean;
}

export interface UsageLogEntry {
  memoryTokens?: {
    canon: number;
    summary: number;
    tail: number;
    stubs?: number;
    delta?: number;
    relevant?: number;
    catalog?: number;
    pinned?: number;
  };
  turnPurpose?: 'dispatch' | 'work';
  rootMessageId?: string | null;
  id: string;
  provider: ModelProvider;
  model: string;
  agentId: string;
  projectId: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
}

export interface ProviderLiveBalance {
  available: boolean;
  currency: string;
  remaining: number;
  label: string;
}

export interface ProviderUsageSummary {
  provider: ModelProvider;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  supportsRollingWindows: boolean;
  fiveHour: RollingWindowUsage;
  weekly: RollingWindowUsage;
  limit: ProviderUsageLimit | null;
  limitWindowTokens: number;
  limitWindowCostUsd: number;
  remainingTokens: number | null;
  remainingBudgetUsd: number | null;
  percentUsed: number | null;
  liveBalance: ProviderLiveBalance | null;
  sourceLabel?: string;
}

export interface AgentUsageSummary {
  agentId: string;
  agentName: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface UsageDashboardResponse {
  range: UsageRange;
  totals: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  providers: ProviderUsageSummary[];
  agents: AgentUsageSummary[];
  recentLogs: UsageLogEntry[];
}

export type MeetingMode = 'live' | 'economy';
export type SttLanguage = 'auto' | 'id' | 'en';

export interface MeetingSettings {
  mode: MeetingMode;
  activeModelId: string;
  threads: number;
  useGpu: boolean;
  language: SttLanguage;
  keepAudio: boolean;
  remindParticipants: boolean;
  noticeTextId?: string;
  noticeTextEn?: string;
  /** Desktop app: offer to take notes when Zoom, Teams or a browser meeting starts using the mic. */
  detectMeetingApps: boolean;
  /** App ids ("zoom", "teams", "browser", …) the user said not to ask about again. */
  ignoredMeetingApps: string[];
  /** Label who said what ("Me" vs "Others", and who the others are once the speaker engine is installed). */
  speakerLabels: boolean;
  /** Input/output device names to record; null follows the Windows defaults. */
  micDevice: string | null;
  speakerDevice: string | null;
  /** Who writes the notes: null follows the app's default provider/model. */
  notesProvider: ModelProvider | null;
  notesModel: string | null;
  /** Language of the notes: follow the transcript, or force one. */
  notesLanguage: SttLanguage;
  /** Own instructions for the layout of the notes; empty uses the built-in template. */
  notesTemplate: string;
}

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  mode: 'live',
  activeModelId: 'large-v3-turbo-q5_0',
  threads: 4,
  useGpu: false,
  language: 'auto',
  keepAudio: false,
  remindParticipants: true,
  detectMeetingApps: true,
  ignoredMeetingApps: [],
  speakerLabels: true,
  micDevice: null,
  speakerDevice: null,
  notesProvider: null,
  notesModel: null,
  notesLanguage: 'auto',
  notesTemplate: '',
};

/** An audio device the desktop shell can record from (inputs) or capture the sound of (outputs). */
export interface AudioDeviceInfo {
  name: string;
  isDefault: boolean;
}

export interface AudioDevicesInfo {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}

/** Live loudness (RMS, 0..1) of the chosen microphone and speaker while the level meter is on. */
export interface MeetingMeterEvent {
  mic: number;
  speaker: number;
  /** Sent with the first reading: which devices were opened, or why one could not be. */
  micName?: string | null;
  speakerName?: string | null;
  micError?: string | null;
  speakerError?: string | null;
}

export interface SpeakerEngineStatus {
  installed: boolean;
  version: string | null;
  /** Download size of everything (engine + both models). */
  sizeBytes: number;
  host: string;
  installedAt: string | null;
  installedBytes: number;
}

/** A meeting app started or stopped using the microphone (detected by the desktop shell). */
export interface MeetingAppEvent {
  state: 'started' | 'ended';
  /** Stable id used for "don't ask again": zoom, teams, browser, webex, slack, … */
  appId: string;
  /** Display name, e.g. "Zoom" or "Google Chrome". */
  appName: string;
  /** Set on "ended" when a meeting is being recorded, so the UI can offer to stop it. */
  meetingId?: string | null;
}

export interface WhisperEngineInfo {
  id: string;
  version: string;
  platform: string;
  url: string;
  host: string;
  sizeBytes: number;
  gpu?: boolean;
  installed: boolean;
  updateAvailable: boolean;
}

export interface WhisperModelInfo {
  id: string;
  label: string;
  filename: string;
  url: string;
  host: string;
  sizeBytes: number;
  ramMb: number;
  quality: number;
  recommended?: boolean;
  installed: boolean;
  active: boolean;
}

export type SttBenchmarkRecommendation = 'live_safe' | 'live_tight' | 'economy';

export interface SttBenchmarkResult {
  engineVersion: string;
  /** Engine variant (cpu-x64, blas-x64, …): builds of one version can differ in speed. */
  engineId?: string;
  modelId: string;
  threads: number;
  useGpu: boolean;
  audioDurationSec: number;
  elapsedSec: number;
  realtimeRatio: number;
  recommendation: SttBenchmarkRecommendation;
  measuredAt: string;
}

export interface SttDownloadProgressEvent {
  kind: 'engine' | 'model' | 'diarization';
  id: string;
  status: 'downloading' | 'verifying' | 'extracting' | 'done' | 'error' | 'cancelled';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  error?: string;
}

export interface SttLocalStatus {
  ready: boolean;
  platform: string;
  cpuCores: number;
  defaultThreads: number;
  installedEngine: {
    id: string;
    version: string;
    installedAt: string;
    exePath: string;
  } | null;
  engines: WhisperEngineInfo[];
  models: WhisperModelInfo[];
  diskUsage: {
    engineBytes: number;
    modelsBytes: number;
    /** Speaker engine + its models. */
    speakersBytes: number;
    totalBytes: number;
  };
  /** The optional engine that tells the other participants apart (sherpa-onnx). */
  speakerEngine: SpeakerEngineStatus;
  activeDownload: SttDownloadProgressEvent | null;
  benchmarks: SttBenchmarkResult[];
  settings: MeetingSettings;
}

export type MeetingStatus =
  | 'recording'
  | 'transcribing'
  | 'identifying'
  | 'summarizing'
  | 'completed'
  | 'pending'
  | 'error';

export interface MeetingTranscriptSegment {
  /** Sequence number of the audio chunk this sentence came from. */
  seq: number;
  /** Position inside the chunk (a chunk holds several sentences). */
  idx: number;
  text: string;
  createdAt: string;
  /** Position on the recording timeline (pauses excluded), null for meetings from before timestamps. */
  startMs: number | null;
  endMs: number | null;
  /** Who said it: a MeetingSpeaker id, or null when unknown. */
  speakerId: string | null;
}

export interface MeetingSpeaker {
  /** "me", "others" (before the speaker engine ran) or "spk_1", "spk_2", … */
  id: string;
  /** Automatic name ("Me", "Speaker 2"). */
  label: string;
  /** Name the user gave, if any. Shown in place of the label. */
  name: string | null;
  color: AgentColor;
  isMe: boolean;
  segmentCount: number;
  /** A short audio sample can be played (the audio is still kept). */
  hasSample: boolean;
}

export interface MeetingSession {
  id: string;
  title: string;
  mode: MeetingMode;
  language: SttLanguage;
  modelId: string;
  status: MeetingStatus;
  keepAudio: boolean;
  pendingChunks: number;
  completedChunks: number;
  totalChunks: number;
  lagSeconds: number;
  transcribeProgress: number;
  transcript: MeetingTranscriptSegment[];
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  speakers: MeetingSpeaker[];
  /** The speaker engine found voices and the user has not finished naming them. */
  speakersPending: boolean;
  /** The recorded audio is still on disk (kept for naming speakers, or by the "keep audio" setting). */
  audioKept: boolean;
  /** Recording is paused (audio is not kept). */
  paused: boolean;
  /** Total time spent paused before `pausedSince`, ms. Recorded time = now − createdAt − paused time. */
  pausedMs: number;
  /** When the current pause began, or null. */
  pausedSince: string | null;
}

/** Live loudness of the recording (RMS per 100 ms), streamed a few times a second. */
export interface MeetingLevelEvent {
  meetingId: string;
  levels: number[];
}

export interface MeetingStatusEvent {
  meeting: MeetingSession;
  canSwitchSmallerModel: boolean;
  smallerModelId: string | null;
  warning?: string | null;
  /** Machine-readable cause of `warning` (e.g. "mic_silent") so the UI can offer the right fix. */
  warningCode?: string | null;
}

export interface Settings {
  provider: ModelProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  customModels: ModelEntry[];
  /**
   * Models shown in the chat pickers, per provider (ids). A provider without an entry shows its
   * built-in, detected and custom models. The model in use is always shown.
   */
  visibleModels?: Partial<Record<RealProvider, string[]>>;
  /** interface language; unset = follow the browser language */
  language?: 'en' | 'id';
  cliPaths: Partial<Record<RealProvider, string>>;
  mcpServers: McpServerConfig[];
  onboardingCompleted: boolean;
  autoCompact: AutoCompactSettings;
  memory?: MemorySettings;
  usageLimits?: Partial<Record<ModelProvider, ProviderUsageLimit>>;
  fallbackMode?: FallbackMode;
  fallbackChain?: ModelRef[];
  sitePresets?: SitePreset[];
  meeting?: MeetingSettings;
  groupChat?: boolean;
  room?: ChannelSettings;
}

export interface QueueItem {
  id: string;
  agentId: string;
  projectId: string | null;
  channelId?: string | null;
  triggerMessageId?: string | null;
  triggerRowid?: number | null;
  mentionIndex?: number;
  manualOrder?: number | null;
  trust?: 'user' | 'teammate';
  priority?: 'resume' | 'normal';
  rootMessageId?: string | null;
  hop?: number;
  /** 'dispatch' = Chief of Staff only routes the request to the right teammate. */
  turnPurpose?: 'dispatch' | 'work';
  kind: QueueKind;
  prompt: string;
  refId: string | null;
  replyToAgentId?: string | null;
  modelOverride?: ModelRef | null;
  fallbackAttempt?: number;
  fallbackFrom?: {
    provider: ModelProvider;
    model: string;
    reason: FallbackErrorKind;
  } | null;
  createdAt: string;
}

export interface WorkspaceState {
  canon?: CanonEntry[];
  projects: Project[];
  agents: Agent[];
  channels?: Channel[];
  roomSessions?: RoomSession[];
  roomQueues?: Record<string, RoomQueueSnapshot>;
  messages: Message[];
  tasks: Task[];
  activities: Activity[];
  ports: PortEntry[];
  settings: Settings;
  browserSessions?: BrowserSessionInfo[];
  browserApprovals?: BrowserApprovalRequest[];
  activeMeeting?: MeetingStatusEvent | null;
}

// Command Input DTOs
export interface CreateProjectInput {
  name: string;
  /** Optional local folder to attach to the project on creation. */
  localPath?: string;
  starterAgents?: CreateAgentInput[];
}

export interface UpdateProjectInput {
  name?: string;
  previewUrl?: string | null;
  allowFullPermissions?: boolean;
  archived?: boolean;
}

export interface DeleteProjectInput {
  deleteRepo?: boolean;
}

export interface LinkRepoInput {
  fullName?: string;
  localPath?: string;
  defaultBranch?: string;
}

export interface CreateAgentInput {
  projectId?: string | null;
  name: string;
  role: string;
  color?: AgentColor;
  avatarShape?: AgentAvatarShape;
  systemInstructions?: string;
  skills?: AgentSkill[];
  mcpServerIds?: string[];
  allowShell?: boolean;
  browser?: AgentBrowserAccess;
  providerOverride?: ModelProvider | null;
  modelOverride?: string | null;
  fallbackChain?: ModelRef[];
}

export interface UpdateAgentInput {
  name?: string;
  role?: string;
  color?: AgentColor;
  avatarShape?: AgentAvatarShape;
  systemInstructions?: string;
  skills?: AgentSkill[];
  mcpServerIds?: string[];
  allowShell?: boolean;
  browser?: AgentBrowserAccess;
  providerOverride?: ModelProvider | null;
  modelOverride?: string | null;
  fallbackChain?: ModelRef[];
}

export interface SendMessageInput {
  text: string;
  projectId?: string | null;
  metadata?: MessageMetadata;
  /** Ids returned by POST /api/attachments. */
  attachmentIds?: string[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeAgentId?: string | null;
  blockedBy?: string[];
  branch?: string | null;
  prUrl?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeAgentId?: string | null;
  blockedBy?: string[];
  branch?: string | null;
  prUrl?: string | null;
  deliverableSummary?: string | null;
}

export interface SettingsInput {
  provider?: ModelProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  customModels?: ModelEntry[];
  visibleModels?: Partial<Record<RealProvider, string[]>>;
  language?: 'en' | 'id';
  cliPaths?: Partial<Record<RealProvider, string>>;
  onboardingCompleted?: boolean;
  autoCompact?: Partial<AutoCompactSettings>;
  memory?: Partial<MemorySettings>;
  usageLimits?: Partial<Record<ModelProvider, ProviderUsageLimit>>;
  fallbackMode?: FallbackMode;
  fallbackChain?: ModelRef[];
  sitePresets?: SitePreset[];
  meeting?: Partial<MeetingSettings>;
  groupChat?: boolean;
  room?: Partial<ChannelSettings>;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export type ServerEvent =
  | { type: 'snapshot'; payload: WorkspaceState }
  | { type: 'project-upserted'; payload: Project }
  | { type: 'project-deleted'; payload: { id: string } }
  | { type: 'agent-upserted'; payload: Agent }
  | { type: 'agent-deleted'; payload: { id: string; projectId?: string | null } }
  | { type: 'channel-upserted'; payload: Channel }
  | { type: 'channel-deleted'; payload: { id: string } }
  | { type: 'room-session-upserted'; payload: RoomSession }
  | { type: 'room-queue-updated'; payload: RoomQueueSnapshot }
  | {
      type: 'room-typing';
      payload: { channelId: string; agentId: string; state: 'working' | 'idle' };
    }
  | { type: 'message-upserted'; payload: Message }
  | { type: 'canon-upserted'; payload: CanonEntry }
  | { type: 'canon-deleted'; payload: { id: string } }
  | { type: 'artifact-created'; payload: Artifact }
  | {
      type: 'message-delta';
      payload: {
        id: string;
        channelId?: string;
        projectId: string | null;
        agentId: string | null;
        delta: string;
      };
    }
  | { type: 'task-upserted'; payload: Task }
  | { type: 'task-deleted'; payload: { id: string; projectId: string } }
  | { type: 'activity-added'; payload: Activity }
  | { type: 'port-upserted'; payload: PortEntry }
  | { type: 'settings-changed'; payload: Settings }
  | { type: 'browser-session'; payload: BrowserSessionInfo }
  | { type: 'browser-frame'; payload: BrowserFrameEvent }
  | { type: 'browser-approval'; payload: BrowserApprovalRequest }
  | { type: 'browser-approval-resolved'; payload: BrowserApprovalResolvedEvent }
  | { type: 'browser-takeover'; payload: BrowserTakeoverEvent }
  | { type: 'stt-download-progress'; payload: SttDownloadProgressEvent }
  | { type: 'meeting-status'; payload: MeetingStatusEvent }
  | { type: 'meeting-app'; payload: MeetingAppEvent }
  | { type: 'meeting-level'; payload: MeetingLevelEvent }
  | { type: 'meeting-meter'; payload: MeetingMeterEvent }
  | { type: 'meeting-removed'; payload: { id: string } };

export interface OnboardingStatus {
  hostname: string;
  github: { installed: boolean; authenticated: boolean; username: string | null; message: string };
  agent: { provider: ModelProvider; hasAnthropicKey: boolean; model: string };
}

export interface GhRepoItem {
  nameWithOwner: string;
  defaultBranch: string;
  url: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Local Vault Lock & Portable Migration (Phase 3)
// ---------------------------------------------------------------------------

export interface AuthStatus {
  /** App lock is turned on for this machine. */
  enabled: boolean;
  /** True when the lock is off, or the request carries a valid session cookie. */
  authenticated: boolean;
  idleMinutes: number;
  /** >0 while login is throttled after repeated wrong passwords. */
  retryAfterSeconds: number;
}

export interface EnableLockInput {
  password: string;
  idleMinutes?: number;
}

export interface RecoveryKeyResponse {
  ok: true;
  /** Shown exactly once; only its scrypt hash is stored. */
  recoveryKey: string;
}

export interface RelinkCandidate {
  projectId: string;
  projectName: string;
  repoFullName: string;
  previousPath: string;
  /** `owner/name` that can be re-cloned with `gh`. */
  canClone: boolean;
}

export interface BackupImportResult {
  ok: true;
  sourceHostname: string;
  createdAt: string;
  includesSecrets: boolean;
  projectCount: number;
  /** Copy of the database taken just before the import (undo path). */
  safetyCopy: string;
  relink: RelinkCandidate[];
}

export interface ExportBackupInput {
  passphrase?: string | null;
  includeSecrets?: boolean;
}

export interface AutoBackupConfig {
  enabled: boolean;
  folder: string | null;
  intervalHours: number;
  keep: number;
  includeSecrets: boolean;
  passphraseSet: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastFile: string | null;
  nextRunAt: string | null;
}

export interface AutoBackupConfigInput {
  enabled?: boolean;
  folder?: string | null;
  intervalHours?: number;
  keep?: number;
  includeSecrets?: boolean;
  /** Empty string clears it. Never returned by the API. */
  passphrase?: string;
}

export interface CloudFolderCandidate {
  provider: 'onedrive' | 'gdrive' | 'dropbox';
  label: string;
  root: string;
  suggestedPath: string;
}

// ---------------------------------------------------------------------------
// Chat attachments & design-option cards
// ---------------------------------------------------------------------------

export type AttachmentKind = 'image' | 'text' | 'file';

export interface MessageAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

export const ATTACHMENT_LIMITS = {
  maxFiles: 8,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
} as const;

/** Message text used when the user sends attachments without typing anything. */
export const ATTACHMENT_ONLY_TEXT = 'Please look at the attached file(s).';

/** An image saved in a project: a chat upload or a design-option artifact. */
export interface LibraryImage {
  /** Attachment id (att_…) or artifact id (art_…). */
  id: string;
  source: 'attachment' | 'artifact';
  name: string;
  mime: string;
  sizeBytes: number;
  /** Same-origin URL that serves the image (already URL-encoded). */
  url: string;
  createdAt: string;
  messageId?: string;
}

export type DesignOptionKind = 'html' | 'svg' | 'image';

export interface DesignOption {
  id: string;
  label: string;
  kind: DesignOptionKind;
  /** Self-contained HTML document / SVG markup (empty for kind "image"). */
  content: string;
  /** kind "image": absolute path to an image file in a workspace, or a data:image URI. */
  src?: string;
  summary?: string;
  pros?: string;
  cons?: string;
  width: number;
  height: number;
}

export interface DesignBlock {
  title: string;
  ask?: string;
  options: DesignOption[];
}

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'design'; block: DesignBlock }
  /** A <atelier-design> block that is still streaming in (not closed yet). */
  | { type: 'design-pending'; title?: string };

const DESIGN_OPEN = '<atelier-design';
const DESIGN_CLOSE = '</atelier-design>';
const OPTION_OPEN = '<atelier-option';
const OPTION_CLOSE = '</atelier-option>';

/** Reads one tag starting at `start` ("<name ...>"), honouring quotes so `>` inside values is fine. */
function readTag(text: string, start: number): { attrs: Record<string, string>; end: number } | null {
  let i = start;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      const raw = text.slice(start, i);
      const attrs: Record<string, string> = {};
      const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      for (let m = re.exec(raw); m; m = re.exec(raw)) {
        attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      }
      return { attrs, end: i + 1 };
    }
    i += 1;
  }
  return null;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function stripFence(content: string): string {
  const m = content.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : content).trim();
}

function parseDesignBlock(attrs: Record<string, string>, inner: string): DesignBlock | null {
  const options: DesignOption[] = [];
  let pos = 0;
  while (options.length < 6) {
    const open = inner.indexOf(OPTION_OPEN, pos);
    if (open < 0) break;
    const tag = readTag(inner, open);
    if (!tag) break;
    const close = inner.indexOf(OPTION_CLOSE, tag.end);
    const body = close < 0 ? inner.slice(tag.end) : inner.slice(tag.end, close);
    pos = close < 0 ? inner.length : close + OPTION_CLOSE.length;

    const a = tag.attrs;
    const content = stripFence(body);
    let kind: DesignOptionKind = a.kind === 'svg' || a.kind === 'image' || a.kind === 'html' ? a.kind : 'html';
    if (!a.kind && /^<svg[\s>]/i.test(content)) kind = 'svg';
    if (kind === 'image' && !a.src) continue;
    if (kind !== 'image' && !content) continue;
    options.push({
      id: (a.id || String.fromCharCode(65 + options.length)).slice(0, 12),
      label: (a.label || `Option ${String.fromCharCode(65 + options.length)}`).slice(0, 80),
      kind,
      content: kind === 'image' ? '' : content,
      src: kind === 'image' ? a.src : undefined,
      summary: a.summary?.slice(0, 400),
      pros: a.pros?.slice(0, 300),
      cons: a.cons?.slice(0, 300),
      width: clampInt(a.width, 320, 1920, 1000),
      height: clampInt(a.height, 200, 1400, 640),
    });
  }
  if (options.length === 0) return null;
  return { title: (attrs.title || 'Design options').slice(0, 120), ask: attrs.ask?.slice(0, 200), options };
}

const ACTION_BLOCK_RE = /<atelier-action>\s*[\s\S]*?<\/atelier-action>/gi;
const ACTION_UNCLOSED_RE = /<atelier-action[\s\S]*$/i;

/**
 * Strips internal `<atelier-action>...</atelier-action>` tool/handoff blocks from message text
 * so raw JSON/XML protocol tags never surface in user-facing UI or quotes.
 */
export function stripAtelierActions(text: string, options?: { streaming?: boolean }): string {
  if (!text) return '';
  let cleaned = text.replace(ACTION_BLOCK_RE, '');
  if (options?.streaming) {
    cleaned = cleaned.replace(ACTION_UNCLOSED_RE, '');
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Splits an agent reply into plain text and design-option cards. An unterminated block (still
 * streaming) becomes a "design-pending" placeholder so half-written HTML never reaches the UI.
 */
export function parseMessageSegments(text: string): MessageSegment[] {
  const cleaned = stripAtelierActions(text, { streaming: true });
  if (!cleaned.includes(DESIGN_OPEN)) return [{ type: 'text', text: cleaned }];
  const segments: MessageSegment[] = [];
  let pos = 0;
  const pushText = (t: string) => {
    if (t.trim()) segments.push({ type: 'text', text: t.replace(/^\n+|\n+$/g, '') });
  };
  while (pos < cleaned.length) {
    const open = cleaned.indexOf(DESIGN_OPEN, pos);
    if (open < 0) {
      pushText(cleaned.slice(pos));
      break;
    }
    pushText(cleaned.slice(pos, open));
    const tag = readTag(cleaned, open);
    const close = tag ? cleaned.indexOf(DESIGN_CLOSE, tag.end) : -1;
    if (!tag || close < 0) {
      segments.push({ type: 'design-pending', title: tag?.attrs.title });
      break;
    }
    const block = parseDesignBlock(tag.attrs, cleaned.slice(tag.end, close));
    if (block) segments.push({ type: 'design', block });
    pos = close + DESIGN_CLOSE.length;
  }
  return segments.length > 0 ? segments : [{ type: 'text', text: '' }];
}

/** Replaces design blocks with a one-line summary so heavy HTML never re-enters model context. */
export function summarizeDesignBlocks(
  text: string,
  artifacts?: Record<string, string>,
  picks?: ReadonlyMap<number, string>,
): string {
  if (!text.includes(DESIGN_OPEN)) return text;
  return parseMessageSegments(text)
    .map((s, index) => {
      if (s.type === 'text') return s.text;
      if (s.type === 'design-pending') return '[Design options block (incomplete)]';
      const list = s.block.options.map((o) => `${o.id} "${o.label}"`).join(', ');
      if (artifacts && Object.keys(artifacts).length) {
        const references = s.block.options.map((option) => {
          const id = artifacts[`${index}:${option.id}`] ?? artifacts[option.id];
          return `${option.id} ${JSON.stringify(option.label)}${id ? ` (${id})` : ''}`;
        }).join(', ');
        const pick = picks?.get(index);
        return `[Design options shown: ${references}.${pick ? ` User picked: ${pick}` : ''}]`;
      }
      return `[Design options shown to the user — ${list}. They can pick one.]`;
    })
    .join('\n\n');
}

export interface SvgBlock {
  /** Position among the SVG blocks of one message (stable, used in library URLs). */
  index: number;
  /** File name taken from the message text (e.g. `atelier-hero.svg`), or a generated one. */
  name: string;
  svg: string;
  /** false while the reply is still streaming and the code fence is not closed yet */
  closed: boolean;
}

const SVG_START = /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const SVG_NAME = /([A-Za-z0-9][\w.-]*\.svg)\b/gi;

/**
 * Finds complete SVG drawings an agent wrote as fenced code in a reply, plus the file name it
 * mentioned for them. Used by the chat (to show the picture instead of code) and by the library.
 */
export function extractSvgBlocks(text: string): SvgBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fence = /^\s*```\s*([\w+#.-]*)\s*$/;
  const found: Array<{ svg: string; closed: boolean; before: string; after: string }> = [];
  let proseStart = 0;
  let i = 0;
  while (i < lines.length) {
    const open = fence.exec(lines[i]!);
    if (!open) {
      i++;
      continue;
    }
    const before = lines.slice(proseStart, i).join('\n').slice(-400);
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
    const closed = i < lines.length;
    i++;
    proseStart = i;
    const lang = (open[1] ?? '').toLowerCase();
    const code = body.join('\n');
    if (['', 'svg', 'xml', 'html'].includes(lang) && SVG_START.test(code) && /<\/svg>/i.test(code)) {
      // text right after the fence (up to the next one) can also name the drawing
      const next = lines.slice(i).findIndex((l) => fence.test(l));
      const after = lines
        .slice(i, next === -1 ? undefined : i + next)
        .join('\n')
        .slice(0, 300);
      found.push({ svg: code.trim(), closed, before, after });
    }
  }

  const used = new Set<string>();
  return found.map((f, index) => {
    const pick = (s: string, last: boolean): string | null => {
      const all = [...s.matchAll(SVG_NAME)].map((m) => m[1]!);
      return all.length === 0 ? null : last ? all[all.length - 1]! : all[0]!;
    };
    let name = pick(f.before, true) ?? pick(f.after, false) ?? `illustration-${index + 1}.svg`;
    if (used.has(name.toLowerCase())) name = name.replace(/\.svg$/i, `-${index + 1}.svg`);
    used.add(name.toLowerCase());
    return { index, name, svg: f.svg, closed: f.closed };
  });
}
