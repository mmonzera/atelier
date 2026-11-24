import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GhRepoItem, ProjectRepo } from '@atelier/contracts';

const execFileAsync = promisify(execFile);

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  username: string | null;
  message: string;
}

export function getProjectRepoPath(workspacesDir: string, projectId: string): string {
  return path.join(workspacesDir, projectId, 'repo');
}

export function getAgentWorkspacePath(
  workspacesDir: string,
  projectId: string,
  agentId: string,
): string {
  return path.join(workspacesDir, projectId, 'agents', agentId);
}

export function getDirectAgentWorkspacePath(workspacesDir: string, agentId: string): string {
  return path.join(workspacesDir, '_direct', agentId);
}

export async function getGhStatus(): Promise<GhStatus> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 });
  } catch {
    return {
      installed: false,
      authenticated: false,
      username: null,
      message: 'GitHub CLI (gh) is not installed on PATH.',
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], { timeout: 8000 });
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(/Logged in to [^\s]+ account ([^\s(]+)/i);
    return {
      installed: true,
      authenticated: true,
      username: match ? match[1] : null,
      message: 'GitHub CLI authenticated.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'GitHub CLI is not logged in.';
    return {
      installed: true,
      authenticated: false,
      username: null,
      message: msg.includes('not logged') ? 'Run `gh auth login` to connect GitHub.' : msg,
    };
  }
}

export async function listRepos(): Promise<GhRepoItem[]> {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'list', '--limit', '30', '--json', 'nameWithOwner,defaultBranchRef,url,description'],
    { timeout: 15000 },
  );

  const raw = JSON.parse(stdout) as Array<{
    nameWithOwner: string;
    defaultBranchRef?: { name?: string } | null;
    url: string;
    description?: string | null;
  }>;

  return raw.map((r) => ({
    nameWithOwner: r.nameWithOwner,
    defaultBranch: r.defaultBranchRef?.name || 'main',
    url: r.url,
    description: r.description || '',
  }));
}

export async function detectDefaultBranch(localPath: string, fallback = 'main'): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', localPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      { timeout: 5000 },
    );
    const trimmed = stdout.trim();
    const parts = trimmed.split('/');
    if (parts.length > 0 && parts[parts.length - 1]) {
      return parts[parts.length - 1];
    }
  } catch {
    // ignore
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 },
    );
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') {
      return branch;
    }
  } catch {
    // ignore
  }

  return fallback;
}

/** §11 Guardrail: write pre-push git hook blocking direct pushes to defaultBranch */
export function installPrePushHook(repoPath: string, defaultBranch: string): boolean {
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return false;
  }
  const safeBranch = /^[a-zA-Z0-9._/-]+$/.test(defaultBranch) ? defaultBranch : 'main';
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-push');
  const script = [
    '#!/bin/sh',
    '# Installed by Atelier: prevent direct pushes to the default branch',
    `PROTECTED_REF="refs/heads/${safeBranch}"`,
    'while read local_ref local_sha remote_ref remote_sha; do',
    '  if [ "$remote_ref" = "$PROTECTED_REF" ]; then',
    `    echo "Atelier guardrail: direct push to default branch '${safeBranch}' is blocked. Push an atelier/<handoffId> branch instead." >&2`,
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  return true;
}

export async function cloneRepo(
  workspacesDir: string,
  projectId: string,
  fullName: string,
  defaultBranchHint = 'main',
): Promise<ProjectRepo> {
  const targetDir = getProjectRepoPath(workspacesDir, projectId);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    await execFileAsync('gh', ['repo', 'clone', fullName, targetDir], { timeout: 60000 });
  }

  const defaultBranch = await detectDefaultBranch(targetDir, defaultBranchHint);
  installPrePushHook(targetDir, defaultBranch);
  return {
    fullName,
    defaultBranch,
    localPath: targetDir,
  };
}

export async function linkLocalRepo(
  localPath: string,
  fullNameHint?: string,
  defaultBranchHint = 'main',
): Promise<ProjectRepo> {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Local path does not exist: ${resolved}`);
  }
  const defaultBranch = await detectDefaultBranch(resolved, defaultBranchHint);
  installPrePushHook(resolved, defaultBranch);
  return {
    fullName: fullNameHint?.trim() || path.basename(resolved),
    defaultBranch,
    localPath: resolved,
  };
}
