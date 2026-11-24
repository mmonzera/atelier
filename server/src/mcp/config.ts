import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@atelier/contracts';

const WIN_SHIM_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'uvx']);

export interface LaunchSpec {
  command: string;
  args: string[];
}

export function toLaunchSpec(
  server: Pick<McpServerConfig, 'command' | 'args'>,
  platform: NodeJS.Platform = process.platform,
): LaunchSpec {
  const command = (server.command ?? '').trim();
  const args = server.args ?? [];
  if (
    platform === 'win32' &&
    command &&
    !path.extname(command) &&
    WIN_SHIM_COMMANDS.has(command.toLowerCase())
  ) {
    return {
      command: 'cmd',
      args: ['/c', command, ...args],
    };
  }
  return { command, args };
}

function formatTomlStringMap(entries: Record<string, string>): string {
  const parts = Object.entries(entries).map(([k, v]) => {
    const key = /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
    return `${key}=${JSON.stringify(v)}`;
  });
  return `{${parts.join(',')}}`;
}

export function buildClaudeMcpJson(
  servers: McpServerConfig[],
  platform: NodeJS.Platform = process.platform,
): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const spec = toLaunchSpec(s, platform);
      const entry: Record<string, unknown> = {
        type: 'stdio',
        command: spec.command,
        args: spec.args,
      };
      if (s.env && Object.keys(s.env).length > 0) {
        entry.env = s.env;
      }
      mcpServers[s.name] = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: s.transport,
        url: s.url ?? '',
      };
      if (s.headers && Object.keys(s.headers).length > 0) {
        entry.headers = s.headers;
      }
      mcpServers[s.name] = entry;
    }
  }
  return { mcpServers };
}

export function buildCodexMcpArgs(
  servers: McpServerConfig[],
  platform: NodeJS.Platform = process.platform,
  autoApproveTools?: Record<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const s of servers) {
    if (s.transport === 'sse') continue;
    const keyName = /^[a-zA-Z0-9_-]+$/.test(s.name)
      ? s.name
      : s.name.replace(/[^a-zA-Z0-9_-]/g, '-');
    if (s.transport === 'stdio') {
      const spec = toLaunchSpec(s, platform);
      out.push('-c', `mcp_servers.${keyName}.command=${JSON.stringify(spec.command)}`);
      out.push('-c', `mcp_servers.${keyName}.args=${JSON.stringify(spec.args)}`);
      if (s.env && Object.keys(s.env).length > 0) {
        out.push('-c', `mcp_servers.${keyName}.env=${formatTomlStringMap(s.env)}`);
      }
    } else {
      out.push('-c', `mcp_servers.${keyName}.url=${JSON.stringify(s.url ?? '')}`);
      if (s.headers && Object.keys(s.headers).length > 0) {
        out.push('-c', `mcp_servers.${keyName}.http_headers=${formatTomlStringMap(s.headers)}`);
      }
    }
    const approved = autoApproveTools?.[s.name] ?? autoApproveTools?.[keyName];
    if (approved) {
      for (const toolName of approved) {
        if (/^[a-zA-Z0-9_-]+$/.test(toolName)) {
          out.push('-c', `mcp_servers.${keyName}.tools.${toolName}.approval_mode="approve"`);
        }
      }
    }
  }
  return out;
}

export function writeAgentMcpConfigFile(
  dataDir: string,
  agentId: string,
  servers: McpServerConfig[],
): string {
  const dir = path.join(dataDir, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${agentId}.json`);
  const payload = buildClaudeMcpJson(servers);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export function claudeAllowedMcpTools(servers: McpServerConfig[]): string[] {
  return servers.map((s) => `mcp__${s.name}`);
}

export function buildOpenCodeMcpConfig(
  servers: McpServerConfig[],
  majorVersion = 2,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const spec = toLaunchSpec(s, platform);
      entries[s.name] = {
        type: 'local',
        command: [spec.command, ...spec.args].filter(Boolean),
        ...(s.env && Object.keys(s.env).length > 0 ? { environment: s.env } : {}),
        ...(majorVersion >= 2 ? { disabled: false } : { enabled: true }),
      };
    } else {
      entries[s.name] = {
        type: 'remote',
        url: s.url ?? '',
        ...(s.headers && Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
        ...(majorVersion >= 2 ? { disabled: false } : { enabled: true }),
      };
    }
  }
  return majorVersion >= 2
    ? { $schema: 'https://opencode.ai/config.json', mcp: { servers: entries } }
    : { $schema: 'https://opencode.ai/config.json', mcp: entries };
}

export function writeOpenCodeConfigFile(
  dataDir: string,
  turnKey: string,
  configObj: Record<string, unknown>,
): string {
  const dir = path.join(dataDir, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const safeKey = turnKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(dir, `opencode-${safeKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(configObj, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}
