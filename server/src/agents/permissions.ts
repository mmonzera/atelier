import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  McpServerConfig,
  PermissionGrant,
  PermissionGrantKind,
} from '@atelier/contracts';

export interface DetectedPermissionDenial {
  kind: PermissionGrantKind;
  target: string;
  rawTool: string;
  mcpTool?: string;
  reason: string;
}

/**
 * Normalizes MCP identifiers from any CLI format (`mcp(figelo/ping)`, `figelo/ping`,
 * `mcp__figelo__ping`, `mcp__figelo`, or `figelo`) into `{ server, mcpTool? }`.
 */
export function normalizeMcpTarget(raw: string): { server: string; mcpTool?: string } {
  const unwrapped = raw.trim().replace(/^mcp\((.*)\)$/i, '$1').trim();
  if (!unwrapped || unwrapped === '*') {
    return { server: '*' };
  }
  if (unwrapped.startsWith('mcp__')) {
    const rest = unwrapped.slice(5);
    if (!rest || rest === '*') return { server: '*' };
    const idx = rest.indexOf('__');
    if (idx >= 0) {
      const server = rest.slice(0, idx).trim() || '*';
      const tool = rest.slice(idx + 2).replace(/\/\*$/, '').trim();
      return tool && tool !== '*' ? { server, mcpTool: tool } : { server };
    }
    const cleaned = rest.replace(/\/\*$/, '').trim();
    return { server: cleaned || '*' };
  }
  if (unwrapped.includes('/')) {
    const slashIdx = unwrapped.indexOf('/');
    const server = unwrapped.slice(0, slashIdx).trim() || '*';
    const tool = unwrapped.slice(slashIdx + 1).trim();
    return tool && tool !== '*' ? { server, mcpTool: tool } : { server };
  }
  return { server: unwrapped };
}

export function makePermissionGrant(
  kind: PermissionGrantKind,
  target: string,
  mcpTools?: readonly string[],
  createdAt = new Date().toISOString(),
): PermissionGrant {
  const cleanTarget = target.trim() || '*';
  const cleanTools = Array.from(
    new Set((mcpTools ?? []).map((t) => t.trim()).filter((t) => Boolean(t) && t !== '*')),
  );
  const label =
    kind === 'mcp'
      ? cleanTarget === '*'
        ? 'All MCP servers'
        : `MCP · ${cleanTarget}`
      : kind === 'tool'
        ? `Tool · ${cleanTarget}`
        : `Command · ${cleanTarget}`;
  return {
    key: `${kind}:${cleanTarget}`,
    kind,
    target: cleanTarget,
    label,
    ...(cleanTools.length > 0 ? { mcpTools: cleanTools } : {}),
    createdAt,
  };
}

export function mergePermissionGrants(
  existing: readonly PermissionGrant[],
  incoming: PermissionGrant,
): PermissionGrant[] {
  const byKey = new Map<string, PermissionGrant>();
  for (const g of existing) {
    if (!g || !g.key) continue;
    byKey.set(g.key, {
      ...g,
      ...(g.mcpTools?.length ? { mcpTools: [...new Set(g.mcpTools)] } : {}),
    });
  }
  const prev = byKey.get(incoming.key);
  if (!prev) {
    byKey.set(incoming.key, incoming);
  } else {
    const mergedTools = Array.from(
      new Set([...(prev.mcpTools ?? []), ...(incoming.mcpTools ?? [])]),
    );
    byKey.set(incoming.key, {
      ...prev,
      label: incoming.label || prev.label,
      ...(mergedTools.length > 0 ? { mcpTools: mergedTools } : {}),
      createdAt: prev.createdAt || incoming.createdAt,
    });
  }
  return [...byKey.values()];
}

export function isPermissionAlreadyGranted(
  grants: readonly PermissionGrant[],
  candidate: { kind: PermissionGrantKind; target: string },
): boolean {
  const key = `${candidate.kind}:${candidate.target}`;
  if (grants.some((g) => g.key === key)) return true;
  if (candidate.kind === 'mcp' && grants.some((g) => g.key === 'mcp:*')) return true;
  return false;
}

export function buildEffectiveTurnGrants(opts: {
  settingsGrants?: readonly PermissionGrant[];
  oneTimeGrants?: readonly PermissionGrant[];
  attachedMcp?: readonly McpServerConfig[];
}): PermissionGrant[] {
  let merged: PermissionGrant[] = [];
  for (const s of opts.attachedMcp ?? []) {
    if (s.enabled && s.name.trim()) {
      merged = mergePermissionGrants(merged, makePermissionGrant('mcp', s.name.trim()));
    }
  }
  for (const g of opts.settingsGrants ?? []) {
    merged = mergePermissionGrants(merged, g);
  }
  for (const g of opts.oneTimeGrants ?? []) {
    merged = mergePermissionGrants(merged, g);
  }
  return merged;
}

const AGY_ALLOWED_TOOL_WRAPPERS = new Set(['read_file', 'write_file', 'read_url', 'mcp']);

export function buildAntigravityAllowedRules(
  grants: readonly PermissionGrant[],
  allowShell: boolean,
): string[] {
  const rules = new Set<string>();
  for (const g of grants) {
    if (g.kind === 'mcp') {
      if (g.target === '*') {
        rules.add('mcp(*)');
      } else {
        rules.add(`mcp(${g.target}/*)`);
        for (const tool of g.mcpTools ?? []) {
          rules.add(`mcp(${g.target}/${tool})`);
        }
      }
    } else if (g.kind === 'tool') {
      const lower = g.target.trim().toLowerCase();
      if (AGY_ALLOWED_TOOL_WRAPPERS.has(lower) || (lower === 'command' && allowShell)) {
        rules.add(`${lower}(*)`);
      }
    } else if (g.kind === 'command' && allowShell) {
      rules.add(`command(${g.target})`);
    }
  }
  return [...rules];
}

export function buildClaudeExtraAllowedTools(
  grants: readonly PermissionGrant[],
  allowShell: boolean,
  knownMcpServers?: Iterable<string>,
): string[] {
  const tools = new Set<string>();
  const knownServers = new Set<string>();
  for (const rawName of knownMcpServers ?? []) {
    const clean = rawName.trim();
    if (clean) knownServers.add(clean);
  }
  for (const g of grants) {
    if (g.kind === 'mcp') {
      if (g.target === '*') {
        tools.add('mcp__*');
        // Claude CLI does not treat a bare `mcp__*` as a wildcard across all MCP
        // servers — expand it to explicit per-server allow patterns for every known server.
        for (const server of knownServers) {
          tools.add(`mcp__${server}`);
          tools.add(`mcp__${server}__*`);
        }
      } else {
        tools.add(`mcp__${g.target}`);
        tools.add(`mcp__${g.target}__*`);
        for (const t of g.mcpTools ?? []) {
          tools.add(`mcp__${g.target}__${t}`);
        }
      }
    } else if (g.kind === 'tool') {
      tools.add(g.target);
    } else if (g.kind === 'command' && allowShell) {
      tools.add(`Bash(${g.target})`);
    }
  }
  return [...tools];
}

function collectMcpNamesFromJsonObject(obj: unknown, out: Set<string>): void {
  if (!obj || typeof obj !== 'object') return;
  const rec = obj as Record<string, unknown>;
  if (rec.mcpServers && typeof rec.mcpServers === 'object' && !Array.isArray(rec.mcpServers)) {
    for (const key of Object.keys(rec.mcpServers as Record<string, unknown>)) {
      const clean = key.trim();
      if (clean) out.add(clean);
    }
  }
  if (Array.isArray(rec.enabledMcpjsonServers)) {
    for (const item of rec.enabledMcpjsonServers) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
  }
}

function readJsonFileSafe(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function discoverGlobalClaudeMcpNames(opts?: {
  homeDir?: string;
  claudeConfigDir?: string;
  cwd?: string;
}): Set<string> {
  const names = new Set<string>();
  const homeDir = opts?.homeDir || os.homedir();
  const claudeConfigDir = opts?.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

  const claudeJsonCandidates = new Set<string>([
    path.join(homeDir, '.claude.json'),
    path.join(claudeConfigDir, '.claude.json'),
  ]);

  const normalizedCwd = opts?.cwd ? path.resolve(opts.cwd) : null;
  const compareCwd = normalizedCwd ? normalizePathForCompare(normalizedCwd) : null;
  for (const claudeJsonPath of claudeJsonCandidates) {
    const parsed = readJsonFileSafe(claudeJsonPath);
    if (!parsed || typeof parsed !== 'object') continue;
    collectMcpNamesFromJsonObject(parsed, names);
    const projects = (parsed as Record<string, unknown>).projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [projPath, projCfg] of Object.entries(projects as Record<string, unknown>)) {
        if (!compareCwd) {
          collectMcpNamesFromJsonObject(projCfg, names);
          continue;
        }
        const resolvedProj = normalizePathForCompare(projPath);
        const projPrefix = resolvedProj.endsWith(path.sep) ? resolvedProj : resolvedProj + path.sep;
        if (compareCwd === resolvedProj || compareCwd.startsWith(projPrefix)) {
          collectMcpNamesFromJsonObject(projCfg, names);
        }
      }
    }
  }

  const settingsFiles = [
    path.join(claudeConfigDir, 'settings.json'),
    path.join(claudeConfigDir, 'settings.local.json'),
    path.join(claudeConfigDir, '.mcp.json'),
  ];
  if (normalizedCwd) {
    settingsFiles.push(
      path.join(normalizedCwd, '.mcp.json'),
      path.join(normalizedCwd, '.claude', 'settings.json'),
      path.join(normalizedCwd, '.claude', 'settings.local.json'),
    );
  }
  for (const filePath of settingsFiles) {
    collectMcpNamesFromJsonObject(readJsonFileSafe(filePath), names);
  }

  return names;
}

export function discoverGlobalCodexMcpNames(codexHome?: string): Set<string> {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(home, 'config.toml');
  if (!fs.existsSync(configPath)) return new Set();
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const names = new Set<string>();
    const lines = raw.split(/\r?\n/);
    let currentServer: string | null = null;
    let currentHasTransport = false;
    const flush = () => {
      if (currentServer && currentHasTransport) {
        names.add(currentServer);
      }
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const headerMatch = /^\[mcp_servers\.([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (headerMatch) {
        flush();
        const inner = headerMatch[1]!.trim();
        const quoted = /^["']([^"']+)["']$/.exec(inner);
        if (quoted) {
          currentServer = quoted[1]!.trim();
          currentHasTransport = false;
        } else if (!inner.includes('.')) {
          currentServer = inner;
          currentHasTransport = false;
        } else {
          currentServer = null;
          currentHasTransport = false;
        }
        continue;
      }
      if (line.startsWith('[')) {
        flush();
        currentServer = null;
        currentHasTransport = false;
        continue;
      }
      if (currentServer && /^(?:command|url)\s*=/.test(line)) {
        currentHasTransport = true;
      }
    }
    flush();
    return names;
  } catch {
    return new Set();
  }
}

export function buildCodexPermissionArgs(
  grants: readonly PermissionGrant[],
  opts: {
    allowShell: boolean;
    memoryOnly: boolean;
    extraDirs?: readonly string[];
    knownMcpServers?: Iterable<string>;
  },
): string[] {
  if (opts.memoryOnly) return [];
  const args: string[] = ['--trust', '-c', 'approval_policy="never"'];
  for (const dir of opts.extraDirs ?? []) {
    if (dir && dir.trim()) {
      args.push(`--add-dir=${dir}`);
    }
  }
  const toKey = (name: string) =>
    /^[a-zA-Z0-9_-]+$/.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '-');

  const knownKeyByName = new Map<string, string>();
  for (const rawName of opts.knownMcpServers ?? []) {
    const clean = rawName.trim();
    if (!clean) continue;
    const keyName = toKey(clean);
    knownKeyByName.set(clean, keyName);
    knownKeyByName.set(keyName, keyName);
  }

  const seenOverrides = new Set<string>();
  const pushOverride = (override: string) => {
    if (!seenOverrides.has(override)) {
      seenOverrides.add(override);
      args.push('-c', override);
    }
  };

  for (const g of grants) {
    if (g.kind !== 'mcp') continue;
    if (g.target === '*') {
      for (const keyName of new Set(knownKeyByName.values())) {
        pushOverride(`mcp_servers.${keyName}.default_tools_approval_mode="approve"`);
      }
      continue;
    }
    const keyName = knownKeyByName.get(g.target) ?? knownKeyByName.get(toKey(g.target));
    if (!keyName) continue;
    pushOverride(`mcp_servers.${keyName}.default_tools_approval_mode="approve"`);
    for (const toolName of g.mcpTools ?? []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) continue;
      pushOverride(`mcp_servers.${keyName}.tools.${toolName}.approval_mode="approve"`);
    }
  }
  return args;
}

const AGY_FAILED_RE =
  /permission check failed for (\w+)\s+"([^"]+)"\s*:\s*user denied permission for ([a-zA-Z0-9_]+)\(([^)]+)\)/gi;
const AGY_USER_DENIED_RE = /user denied permission for ([a-zA-Z0-9_]+)\(([^)]+)\)/gi;
const CLAUDE_TEXT_DENIED_RE =
  /(?:requested permissions to use|Permission to use)\s+([a-zA-Z0-9_:-]+)(?:\s+has been denied)?/i;
const CODEX_TEXT_DENIED_RE =
  /(?:approval\s+(?:required|denied|rejected)\s+for\s+(?:mcp|tool|command)\s+"?([^"\n]+?)"?|(?:mcp(?:\s+tool)?|tool)\s+"?([a-zA-Z0-9_./:-]+)"?\s+(?:was\s+)?(?:rejected|denied|blocked)\s+by\s+(?:user|policy|approval))/i;
const CODEX_MCP_POLICY_NEVER_RE =
  /MCP tool call requires approval,\s*but approval policy is never/i;
const OPENCODE_TEXT_DENIED_RE =
  /(?:policy\s+denied\s+(?:for\s+)?(mcp\.use|tool\.use|plugin\.use|skill\.use)\s*(?:\(([^)]+)\)|[:\s]+"?([^"\n]+)"?)?|permission\s+denied\s+for\s+(?:mcp|tool)\s+"?([^"\n]+)"?)/i;

function denialFromWrapper(wrapper: string, inner: string, reason: string): DetectedPermissionDenial {
  const kindRaw = wrapper.trim().toLowerCase();
  const cleanInner = inner.trim();
  if (kindRaw === 'mcp') {
    const { server, mcpTool } = normalizeMcpTarget(cleanInner);
    return {
      kind: 'mcp',
      target: server,
      rawTool: mcpTool ? `${server}/${mcpTool}` : server,
      ...(mcpTool ? { mcpTool } : {}),
      reason,
    };
  }
  if (kindRaw === 'command' || kindRaw === 'bash' || kindRaw === 'shell') {
    return {
      kind: 'command',
      target: cleanInner.slice(0, 160),
      rawTool: cleanInner.slice(0, 160),
      reason,
    };
  }
  return {
    kind: 'tool',
    target: wrapper.trim(),
    rawTool: cleanInner ? `${wrapper.trim()}(${cleanInner})` : wrapper.trim(),
    reason,
  };
}

export function detectAllPermissionDenials(
  text: string,
  opts?: { strictCliOnly?: boolean },
): DetectedPermissionDenial[] {
  if (!text || !text.trim()) return [];
  const results: DetectedPermissionDenial[] = [];
  const seen = new Set<string>();
  const push = (d: DetectedPermissionDenial) => {
    const k = `${d.kind}:${d.target}:${d.mcpTool ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    results.push(d);
  };

  AGY_FAILED_RE.lastIndex = 0;
  for (let m = AGY_FAILED_RE.exec(text); m; m = AGY_FAILED_RE.exec(text)) {
    push(denialFromWrapper(m[3]!, m[4]!, m[0]));
  }

  AGY_USER_DENIED_RE.lastIndex = 0;
  for (let m = AGY_USER_DENIED_RE.exec(text); m; m = AGY_USER_DENIED_RE.exec(text)) {
    push(denialFromWrapper(m[1]!, m[2]!, m[0]));
  }

  if (opts?.strictCliOnly && results.length > 0) {
    return results;
  }

  const claudeMatch = CLAUDE_TEXT_DENIED_RE.exec(text);
  if (claudeMatch?.[1]) {
    const raw = claudeMatch[1].trim();
    if (raw.startsWith('mcp__')) {
      const { server, mcpTool } = normalizeMcpTarget(raw);
      push({
        kind: 'mcp',
        target: server,
        rawTool: mcpTool ? `${server}/${mcpTool}` : server,
        ...(mcpTool ? { mcpTool } : {}),
        reason: claudeMatch[0],
      });
    } else if (!opts?.strictCliOnly) {
      push({ kind: 'tool', target: raw, rawTool: raw, reason: claudeMatch[0] });
    }
  }

  const codexMatch = CODEX_TEXT_DENIED_RE.exec(text);
  if (codexMatch) {
    const raw = (codexMatch[1] || codexMatch[2] || '').trim();
    if (raw) {
      if (raw.includes('/') || raw.startsWith('mcp__')) {
        const { server, mcpTool } = normalizeMcpTarget(raw);
        push({
          kind: 'mcp',
          target: server,
          rawTool: mcpTool ? `${server}/${mcpTool}` : server,
          ...(mcpTool ? { mcpTool } : {}),
          reason: codexMatch[0],
        });
      } else {
        push({ kind: 'tool', target: raw, rawTool: raw, reason: codexMatch[0] });
      }
    }
  }
  if (CODEX_MCP_POLICY_NEVER_RE.test(text) && !results.some((r) => r.kind === 'mcp')) {
    push({
      kind: 'mcp',
      target: '*',
      rawTool: 'mcp/*',
      reason: 'MCP tool call requires approval, but approval policy is never',
    });
  }

  const ocMatch = OPENCODE_TEXT_DENIED_RE.exec(text);
  if (ocMatch) {
    const action = (ocMatch[1] || '').toLowerCase();
    const resource = (ocMatch[2] || ocMatch[3] || ocMatch[4] || '').trim();
    if (action === 'mcp.use' || ocMatch[4]) {
      const { server, mcpTool } = normalizeMcpTarget(resource || '*');
      push({
        kind: 'mcp',
        target: server,
        rawTool: mcpTool ? `${server}/${mcpTool}` : server,
        ...(mcpTool ? { mcpTool } : {}),
        reason: ocMatch[0],
      });
    } else if (resource) {
      push({ kind: 'tool', target: resource, rawTool: resource, reason: ocMatch[0] });
    }
  }

  return results;
}

export function detectPermissionDenial(
  text: string,
  opts?: { strictCliOnly?: boolean },
): DetectedPermissionDenial | null {
  return detectAllPermissionDenials(text, opts)[0] ?? null;
}

export function parseClaudeToolDenial(
  toolName: string,
  toolInput?: Record<string, unknown>,
  reason?: string,
): DetectedPermissionDenial | null {
  const cleanName = toolName.trim();
  if (!cleanName) return null;
  const why = reason?.trim() || `Permission denied for ${cleanName}`;
  if (cleanName.startsWith('mcp__')) {
    const { server, mcpTool } = normalizeMcpTarget(cleanName);
    return {
      kind: 'mcp',
      target: server,
      rawTool: mcpTool ? `${server}/${mcpTool}` : server,
      ...(mcpTool ? { mcpTool } : {}),
      reason: why,
    };
  }
  if (cleanName === 'Bash' || cleanName === 'PowerShell') {
    const cmd =
      (typeof toolInput?.command === 'string' && toolInput.command) ||
      (typeof toolInput?.cmd === 'string' && toolInput.cmd) ||
      cleanName;
    return {
      kind: 'command',
      target: cmd.slice(0, 160),
      rawTool: cmd.slice(0, 160),
      reason: why,
    };
  }
  return {
    kind: 'tool',
    target: cleanName,
    rawTool: cleanName,
    reason: why,
  };
}

const PERMISSION_ERR_RE =
  /permission|approval|denied|rejected|not\s+allowed|blocked\s+by\s+policy|untrusted|requires\s+approval/i;

export function parseCodexItemDenial(
  item: Record<string, unknown>,
): DetectedPermissionDenial | null {
  const type = typeof item.type === 'string' ? item.type : '';
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  const errText =
    typeof item.error === 'string'
      ? item.error
      : item.error && typeof item.error === 'object'
        ? String((item.error as Record<string, unknown>).message ?? JSON.stringify(item.error))
        : typeof item.aggregated_output === 'string'
          ? item.aggregated_output
          : '';

  if (type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server.trim() : '';
    const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
    const resultErr =
      item.result && typeof item.result === 'object' && (item.result as Record<string, unknown>).isError
        ? JSON.stringify(item.result)
        : '';
    const combinedErr = [errText, resultErr].filter(Boolean).join(' ');
    const isRejected =
      status === 'declined' ||
      status === 'rejected' ||
      ((status === 'failed' || Boolean(combinedErr)) && PERMISSION_ERR_RE.test(combinedErr));
    if (!isRejected) return null;

    const norm = server
      ? { server, ...(tool ? { mcpTool: tool } : {}) }
      : normalizeMcpTarget(tool || '*');
    return {
      kind: 'mcp',
      target: norm.server,
      rawTool: norm.mcpTool ? `${norm.server}/${norm.mcpTool}` : norm.server,
      ...(norm.mcpTool ? { mcpTool: norm.mcpTool } : {}),
      reason: combinedErr.slice(0, 300) || `Codex blocked MCP call ${norm.server}`,
    };
  }

  if (type === 'command_execution') {
    const isRejected =
      status === 'declined' ||
      status === 'rejected' ||
      /approval|rejected|permission denied by policy|blocked by policy/i.test(errText);
    if (!isRejected) return null;
    const cmd = typeof item.command === 'string' ? item.command.trim() : 'command';
    return {
      kind: 'command',
      target: cmd.slice(0, 160),
      rawTool: cmd.slice(0, 160),
      reason: errText.slice(0, 300) || `Codex declined command ${cmd.slice(0, 80)}`,
    };
  }

  return null;
}

export function parseOpenCodeEventDenial(
  ev: Record<string, unknown>,
): DetectedPermissionDenial | null {
  const evType = typeof ev.type === 'string' ? ev.type : '';
  if (
    evType === 'permission' ||
    evType === 'permission.asked' ||
    evType === 'permission.denied' ||
    evType === 'permission.rejected'
  ) {
    const perm = (ev.permission && typeof ev.permission === 'object'
      ? ev.permission
      : ev) as Record<string, unknown>;
    const rawTool = String(perm.tool || perm.name || perm.permission || perm.pattern || 'permission').trim();
    const reason = String(perm.message || perm.reason || `OpenCode permission required for ${rawTool}`);
    if (rawTool.startsWith('mcp') || rawTool.includes('/')) {
      const { server, mcpTool } = normalizeMcpTarget(rawTool);
      return {
        kind: 'mcp',
        target: server,
        rawTool: mcpTool ? `${server}/${mcpTool}` : server,
        ...(mcpTool ? { mcpTool } : {}),
        reason,
      };
    }
    if (/^(bash|shell)$/i.test(rawTool)) {
      const cmd = String(perm.pattern || perm.command || rawTool).slice(0, 160);
      return { kind: 'command', target: cmd, rawTool: cmd, reason };
    }
    return { kind: 'tool', target: rawTool, rawTool, reason };
  }

  if (evType === 'tool_use' || evType === 'tool') {
    const part = ev.part && typeof ev.part === 'object' ? (ev.part as Record<string, unknown>) : null;
    const state =
      part?.state && typeof part.state === 'object'
        ? (part.state as Record<string, unknown>)
        : null;
    const status = typeof state?.status === 'string' ? state.status.toLowerCase() : '';
    const errStr =
      typeof state?.error === 'string'
        ? state.error
        : typeof part?.error === 'string'
          ? part.error
          : '';
    if ((status === 'error' || errStr) && PERMISSION_ERR_RE.test(errStr)) {
      const toolName = String(part?.tool || ev.name || 'tool').trim();
      const fromText = detectPermissionDenial(errStr);
      if (fromText) return fromText;
      if (toolName.startsWith('mcp__') || toolName.includes('/')) {
        const { server, mcpTool } = normalizeMcpTarget(toolName);
        return {
          kind: 'mcp',
          target: server,
          rawTool: mcpTool ? `${server}/${mcpTool}` : server,
          ...(mcpTool ? { mcpTool } : {}),
          reason: errStr.slice(0, 300),
        };
      }
      if (toolName === 'bash') {
        const inputObj =
          state?.input && typeof state.input === 'object'
            ? (state.input as Record<string, unknown>)
            : null;
        const cmd = String(inputObj?.command || 'bash').slice(0, 160);
        return { kind: 'command', target: cmd, rawTool: cmd, reason: errStr.slice(0, 300) };
      }
      return { kind: 'tool', target: toolName, rawTool: toolName, reason: errStr.slice(0, 300) };
    }
  }

  if (evType === 'error') {
    const errObj = ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : null;
    const msg =
      (typeof errObj?.message === 'string' && errObj.message) ||
      (typeof ev.message === 'string' && ev.message) ||
      (typeof ev.error === 'string' && ev.error) ||
      '';
    if (msg && PERMISSION_ERR_RE.test(msg)) {
      return detectPermissionDenial(msg);
    }
  }

  return null;
}
