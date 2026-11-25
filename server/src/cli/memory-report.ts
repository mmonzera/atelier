/**
 * F0 selective memory: laporan token memory dari usage_logs (read-only).
 *
 *   npm run memory:report -- [--data-dir=PATH] [--days=30]
 *
 * Menjawab: berapa porsi input token yang berasal dari memory yang disisipkan Atelier
 * (Canon + ringkasan + tail), dan apakah ada project yang Canon-nya terpotong budget.
 */
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';
import { renderCanon } from '../agents/prompts.js';
import type { CanonEntry, UsageLogEntry } from '@atelier/contracts';

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function memoryTotal(m: NonNullable<UsageLogEntry['memoryTokens']>): number {
  return (m.canon ?? 0) + (m.summary ?? 0) + (m.tail ?? 0) + (m.stubs ?? 0) + (m.delta ?? 0) +
    (m.relevant ?? 0) + (m.catalog ?? 0) + (m.pinned ?? 0);
}

export interface MemoryReport {
  markdown: string;
  turns: number;
  /** median((canon + summary) / inputTokens) di seluruh turn yang punya data memory */
  medianStaticShare: number;
  projectsWithOmittedCanon: number;
}

export function buildMemoryReport(sqlite: DatabaseSync, days = 30): MemoryReport {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const hasTable = (name: string) =>
    Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const rows = hasTable('usage_logs')
    ? (sqlite
        .prepare('SELECT data FROM usage_logs WHERE created_at >= ? ORDER BY created_at')
        .all(since) as Array<{ data: string }>).map((r) => JSON.parse(r.data) as UsageLogEntry)
    : [];
  const withMemory = rows.filter((r) => r.memoryTokens && r.inputTokens > 0);

  const groups = new Map<string, UsageLogEntry[]>();
  for (const row of withMemory) {
    const key = `${row.provider} / ${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const lines: string[] = [
    `# Memory token report (${days} hari terakhir)`,
    '',
    `Turn tercatat: ${rows.length}, dengan data memory: ${withMemory.length}.`,
    '',
    '| Provider / model | Turn | Median input | P90 input | Median canon | Median summary | Median tail | Median memory total | Median memory/input |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const med = (pick: (r: UsageLogEntry) => number) => percentile(list.map(pick), 50);
    // Provider tertentu (mis. Claude) melaporkan input TANPA token cache, jadi input < memory dan rasio tak bermakna.
    const valid = list.filter((r) => r.inputTokens >= memoryTotal(r.memoryTokens!));
    const share = valid.length ? percentile(valid.map((r) => memoryTotal(r.memoryTokens!) / r.inputTokens), 50) : null;
    lines.push(
      `| ${key} | ${list.length} | ${med((r) => r.inputTokens)} | ${percentile(list.map((r) => r.inputTokens), 90)} | ` +
        `${med((r) => r.memoryTokens!.canon)} | ${med((r) => r.memoryTokens!.summary)} | ${med((r) => r.memoryTokens!.tail)} | ` +
        `${med((r) => memoryTotal(r.memoryTokens!))} | ${share === null ? 'n/a (input tanpa cache)' : (share * 100).toFixed(1) + '%'} |`,
    );
  }

  const staticShares = withMemory
    .filter((r) => r.inputTokens >= memoryTotal(r.memoryTokens!))
    .map((r) => ((r.memoryTokens!.canon ?? 0) + (r.memoryTokens!.summary ?? 0)) / r.inputTokens);
  const medianStaticShare = percentile(staticShares, 50);
  lines.push('', `Median (canon + summary) / input (hanya turn dengan input valid): **${(medianStaticShare * 100).toFixed(1)}%**.`);

  const selectiveTurns = withMemory.filter((r) => (r.memoryTokens!.pinned ?? 0) + (r.memoryTokens!.relevant ?? 0) + (r.memoryTokens!.catalog ?? 0) > 0);
  if (selectiveTurns.length) {
    const push = selectiveTurns.map((r) => (r.memoryTokens!.pinned ?? 0) + (r.memoryTokens!.relevant ?? 0) + (r.memoryTokens!.catalog ?? 0));
    lines.push(
      '',
      `Turn dengan selective memory: ${selectiveTurns.length}. Median push (pinned + relevant + catalog): ${percentile(push, 50)} token, P90: ${percentile(push, 90)} token.`,
    );
  }

  const canonRows = (hasTable('canon')
    ? (sqlite.prepare('SELECT project_id, data FROM canon').all() as Array<{ project_id: string | null; data: string }>)
    : [])
    .map((r) => ({ scope: r.project_id ?? 'direct', entry: JSON.parse(r.data) as CanonEntry }))
    .filter((r) => !r.entry.supersededBy);
  const byScope = new Map<string, CanonEntry[]>();
  for (const { scope, entry } of canonRows) byScope.set(scope, [...(byScope.get(scope) ?? []), entry]);
  let omittedScopes = 0;
  const canonLines: string[] = [];
  for (const [scope, entries] of byScope) {
    const { omitted } = renderCanon(entries);
    if (omitted > 0) omittedScopes += 1;
    canonLines.push(`| ${scope} | ${entries.length} | ${omitted} |`);
  }
  lines.push(
    '',
    '## Canon per project',
    '',
    '| Scope | Entri aktif | Terpotong budget 1.500 token |',
    '| --- | ---: | ---: |',
    ...(canonLines.length ? canonLines : ['| (tidak ada Canon) | 0 | 0 |']),
    '',
    `Project dengan Canon terpotong: **${omittedScopes}** dari ${byScope.size}.`,
    '',
    '## Keputusan gate (plan SELECTIVE-MEMORY-PLAN.md, F0)',
    '',
    medianStaticShare < 0.1 && omittedScopes === 0
      ? '- Median (canon + summary)/input < 10% dan tidak ada Canon terpotong: cukup F2 (search_memory). F3 dan F4 ditunda.'
      : '- Median >= 10% atau ada Canon terpotong: lanjutkan semua fase (F3 dan F4 bernilai).',
    '',
    'Catatan: usage_logs belum menyimpan rasio cache read dan status resume per turn, jadi bagian itu diukur manual.',
  );

  return { markdown: lines.join('\n'), turns: withMemory.length, medianStaticShare, projectsWithOmittedCanon: omittedScopes };
}

const isMain = !process.env.ATELIER_EMBEDDED && process.argv[1] && /memory-report\.(t|j)s$/.test(process.argv[1]);
if (isMain) {
  const argDir = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length);
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.slice('--days='.length)) || 30;
  const config = loadConfig(argDir ? { dataDir: argDir } : undefined);
  const sqlite = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    console.log(buildMemoryReport(sqlite, days).markdown);
  } finally {
    sqlite.close();
  }
}
