import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §10.3 guard: project chat history lives in channels now. The legacy per-agent reader
 * `listAgentMessages` may only be used by the modules that still need it for the DM / legacy
 * paths. A new module reaching for it is almost certainly reading the wrong thread.
 */
const ALLOWED = new Set([
  'store.ts',
  'http.ts',
  path.join('agents', 'claude-runner.ts'),
  path.join('agents', 'cli-runners.ts'),
  path.join('agents', 'compactor.ts'),
  path.join('agents', 'runtime.ts'),
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('legacy per-agent history reader is fenced off', () => {
  it('is not used by modules outside the allowlist (including everything in channels/)', () => {
    const root = path.resolve(__dirname, '../src');
    const offenders = walk(root)
      .filter((f) => /\blistAgentMessages\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });
});
