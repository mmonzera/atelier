import crypto from 'node:crypto';
import type {
  Artifact,
  CanonEntry,
  MemorySource,
  StructuredMemory,
  Task,
  ThreadCompaction,
} from '@atelier/contracts';
import { estimateTokens } from '../agents/compactor.js';
import type { AtelierDb } from '../db.js';
import { buildFtsQuery, expandSynonyms, extractTerms } from './query.js';

export type IndexedSource = Exclude<MemorySource, 'message'>;

export interface MemoryItem {
  id: string;
  scopeKey: string;
  projectId: string | null;
  /** '' = dipakai bersama; "agent:<id>" / "channel:<id>" = hanya untuk pemiliknya */
  owner: string;
  source: IndexedSource;
  sourceId: string;
  kind: string;
  pinned: boolean;
  updatedAt: string;
  title: string;
  body: string;
  /** baris lengkap untuk blok memory */
  line: string;
  /** baris 1-baris untuk katalog judul */
  catalogLine: string;
  tokens: number;
  path?: string;
  artifactId?: string;
  status?: string;
}

export interface ScoredItem {
  item: MemoryItem;
  /** 0..1 setelah normalisasi + bobot */
  score: number;
}

/** Sumber kebenaran. Index hanyalah proyeksi dari ini dan selalu bisa dibangun ulang. */
export interface MemorySources {
  canon(scopeKey: string): CanonEntry[];
  tasks(projectId: string): Task[];
  artifacts(projectId: string | null): Artifact[];
  summaries(scopeKey: string): Array<{ owner: string; compaction: ThreadCompaction }>;
  projectExists(projectId: string): boolean;
}

const KIND_WEIGHT: Record<string, number> = {
  rule: 1.2, decision: 1.1, open: 1.1, asset: 1.0, goal: 1.0, task: 0.9, done: 0.7, artifact: 0.8, summary: 0.7,
};
const LINE_VALUE_CHARS = 400;
const RECENCY_HALF_LIFE_DAYS = 21;

function quote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export function memoryItemId(source: string, sourceId: string): string {
  return 'mem_' + crypto.createHash('sha1').update(`${source}:${sourceId}`).digest('hex').slice(0, 10);
}

export function defaultCanonPinned(entry: CanonEntry): boolean {
  if (entry.pinned !== undefined) return entry.pinned;
  // rule dari user + semua entri yang dipilih/diedit user. Catatan agent harus di-pin manual.
  return entry.source !== 'agent_recorded';
}

/** Overlap coefficient atas term; 0 bila salah satu terlalu pendek (< 3 term) agar frasa pendek tidak dianggap duplikat. */
export function termOverlap(a: string, b: string): number {
  const ta = new Set(extractTerms(a, 40));
  const tb = new Set(extractTerms(b, 40));
  if (ta.size < 3 || tb.size < 3) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

type Draft = Omit<MemoryItem, 'id' | 'tokens' | 'scopeKey' | 'projectId'>;

function finalize(scopeKey: string, d: Draft): MemoryItem {
  return {
    ...d,
    id: memoryItemId(d.source, d.sourceId),
    scopeKey,
    projectId: scopeKey === 'direct' ? null : scopeKey,
    tokens: estimateTokens(d.line),
  };
}

function structuredDrafts(owner: string, scopeKey: string, c: ThreadCompaction, s: StructuredMemory): Draft[] {
  const out: Draft[] = [];
  const base = { owner, source: 'summary' as const, pinned: false, updatedAt: c.compactedAt };
  const push = (section: string, i: number, kind: string, text: string, paths?: string[]) => {
    const clean = clip(text, 500);
    if (!clean) return;
    const pathNote = paths?.length ? ` · paths ${paths.slice(0, 4).map(quote).join(', ')}` : '';
    out.push({
      ...base,
      sourceId: `${scopeKey}:${owner}:${section}:${i}`,
      kind,
      title: clip(clean, 80),
      body: clean + (paths?.length ? ' ' + paths.join(' ') : ''),
      line: kind === 'goal' ? `Goal: ${quote(clean)}` : `[${kind}] ${quote(clean)}${pathNote}`,
      catalogLine: `[${kind}] ${quote(clip(clean, 80))}`,
    });
  };
  if (s.goal) push('goal', 0, 'goal', s.goal);
  s.decisions.forEach((t, i) => push('decision', i, 'decision', t));
  s.done.forEach((d, i) => push('done', i, 'done', d.text, d.paths));
  s.open.forEach((t, i) => push('open', i, 'open', t));
  return out;
}

type Row = {
  id: string; scope_key: string; project_id: string | null; owner: string; source: string;
  source_id: string; kind: string; pinned: number; updated_at: string; data: string;
};

export class MemoryIndex {
  private readonly known = new Set<string>();
  private readonly dirty = new Set<string>();
  private generation: number;
  private readonly recalled = new Map<string, Set<string>>();

  constructor(
    private readonly db: AtelierDb,
    private readonly sources: MemorySources,
  ) {
    this.generation = db.memoryGeneration;
  }

  /** Catat memory yang ditarik agent sendiri (search_memory/get_memory) selama satu turn. */
  beginTurn(agentId: string): void {
    this.recalled.set(agentId, new Set());
  }

  noteRecalled(agentId: string, ids: string[]): void {
    const set = this.recalled.get(agentId);
    if (set) for (const id of ids) set.add(id);
  }

  endTurn(agentId: string): string[] {
    const ids = [...(this.recalled.get(agentId) ?? [])];
    this.recalled.delete(agentId);
    return ids;
  }

  markDirty(scopeKey: string | null | undefined): void {
    this.dirty.add(scopeKey || 'direct');
  }

  /** Bangun ulang satu scope, atau (tanpa argumen) buang semuanya dan bangun saat dibutuhkan. */
  rebuild(scopeKey?: string): void {
    if (scopeKey) {
      this.refreshScope(scopeKey);
      return;
    }
    this.db.sqlite.exec('DELETE FROM memory_items');
    this.known.clear();
    this.dirty.clear();
  }

  private ensureFresh(scopeKey: string): void {
    if (this.generation !== this.db.memoryGeneration) {
      this.db.sqlite.exec('DELETE FROM memory_items');
      this.known.clear();
      this.dirty.clear();
      this.generation = this.db.memoryGeneration;
    }
    if (!this.known.has(scopeKey) || this.dirty.has(scopeKey)) this.refreshScope(scopeKey);
  }

  private project(scopeKey: string): MemoryItem[] {
    const drafts: Draft[] = [];
    for (const entry of this.sources.canon(scopeKey)) {
      const value = clip(entry.value, LINE_VALUE_CHARS);
      drafts.push({
        owner: '',
        source: 'canon',
        sourceId: `${scopeKey}:${entry.key}`,
        kind: entry.kind,
        pinned: defaultCanonPinned(entry),
        updatedAt: entry.updatedAt,
        title: `${entry.key} ${entry.title}`,
        body: `${entry.value} ${entry.path ?? ''}`.trim(),
        line: `[${entry.kind}] ${entry.key} ${quote(entry.title)} = ${quote(value)}` +
          (entry.path ? ` · path ${quote(entry.path)}` : '') +
          (entry.artifactId ? ` · artifact ${quote(entry.artifactId)}` : ''),
        catalogLine: `[${entry.kind}] ${entry.key} ${quote(clip(entry.title, 60))}`,
        path: entry.path,
        artifactId: entry.artifactId,
      });
    }
    if (scopeKey !== 'direct') {
      for (const task of this.sources.tasks(scopeKey)) {
        const detail = [task.description, task.deliverableSummary].filter(Boolean).join(' ');
        drafts.push({
          owner: '',
          source: 'task',
          sourceId: task.id,
          kind: 'task',
          pinned: false,
          updatedAt: task.updatedAt,
          title: `${task.identifier} ${task.title}`,
          body: detail,
          line: `[task ${task.identifier} · ${task.status}] ${quote(task.title)}` +
            (task.deliverableSummary ? ` — ${quote(clip(task.deliverableSummary, 200))}` : ''),
          catalogLine: `[task ${task.identifier} · ${task.status}] ${quote(clip(task.title, 60))}`,
          status: task.status,
        });
      }
    }
    for (const art of this.sources.artifacts(scopeKey === 'direct' ? null : scopeKey)) {
      drafts.push({
        owner: '',
        source: 'artifact',
        sourceId: art.id,
        kind: 'artifact',
        pinned: false,
        updatedAt: art.createdAt,
        title: art.label,
        body: `${art.path} ${art.kind}`,
        line: `[artifact ${art.kind}] ${quote(art.label)} · ${art.id} · path ${quote(art.path)}`,
        catalogLine: `[artifact ${art.kind}] ${quote(clip(art.label, 60))} · ${art.id}`,
        path: art.path,
        artifactId: art.id,
      });
    }
    for (const { owner, compaction } of this.sources.summaries(scopeKey)) {
      if (compaction.structured) {
        drafts.push(...structuredDrafts(owner, scopeKey, compaction, compaction.structured));
      } else if (compaction.summary.trim()) {
        compaction.summary.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 60).forEach((text, i) => {
          drafts.push({
            owner,
            source: 'summary',
            sourceId: `${scopeKey}:${owner}:text:${i}`,
            kind: 'summary',
            pinned: false,
            updatedAt: compaction.compactedAt,
            title: clip(text, 80),
            body: text,
            line: `[summary] ${quote(clip(text, 400))}`,
            catalogLine: `[summary] ${quote(clip(text, 80))}`,
          });
        });
      }
    }
    return drafts.map((d) => finalize(scopeKey, d));
  }

  private refreshScope(scopeKey: string): void {
    if (scopeKey !== 'direct' && !this.sources.projectExists(scopeKey)) {
      this.known.add(scopeKey);
      this.dirty.delete(scopeKey);
      return;
    }
    const items = this.project(scopeKey);
    const sqlite = this.db.sqlite;
    sqlite.exec('SAVEPOINT memidx');
    try {
      sqlite.prepare('DELETE FROM memory_items WHERE scope_key = ?').run(scopeKey);
      const insert = sqlite.prepare(`
        INSERT OR IGNORE INTO memory_items
          (id, scope_key, project_id, owner, source, source_id, kind, pinned, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.hasMemoryFts
        ? sqlite.prepare('INSERT INTO memory_fts(rowid, title, body) VALUES (?, ?, ?)')
        : null;
      for (const item of items) {
        const { id, scopeKey: sk, projectId, owner, source, sourceId, kind, pinned, updatedAt, ...rest } = item;
        const res = insert.run(id, sk, projectId, owner, source, sourceId, kind, pinned ? 1 : 0, updatedAt, JSON.stringify(rest));
        if (insertFts && Number(res.changes) > 0) insertFts.run(res.lastInsertRowid, item.title, item.body);
      }
      sqlite.exec('RELEASE memidx');
    } catch (err) {
      sqlite.exec('ROLLBACK TO memidx');
      sqlite.exec('RELEASE memidx');
      throw err;
    }
    this.known.add(scopeKey);
    this.dirty.delete(scopeKey);
  }

  private rowToItem(row: Row): MemoryItem {
    const rest = JSON.parse(row.data) as Pick<MemoryItem, 'title' | 'body' | 'line' | 'catalogLine' | 'tokens' | 'path' | 'artifactId' | 'status'>;
    return {
      ...rest,
      id: row.id,
      scopeKey: row.scope_key,
      projectId: row.project_id,
      owner: row.owner,
      source: row.source as IndexedSource,
      sourceId: row.source_id,
      kind: row.kind,
      pinned: row.pinned === 1,
      updatedAt: row.updated_at,
    };
  }

  private visible(item: MemoryItem, owners: string[]): boolean {
    return item.owner === '' || owners.includes(item.owner);
  }

  list(scopeKey: string, owners: string[] = []): MemoryItem[] {
    this.ensureFresh(scopeKey);
    const rows = this.db.sqlite
      .prepare('SELECT * FROM memory_items WHERE scope_key = ? ORDER BY updated_at DESC, id')
      .all(scopeKey) as Row[];
    return rows.map((r) => this.rowToItem(r)).filter((i) => this.visible(i, owners));
  }

  get(scopeKey: string, id: string, owners: string[] = []): MemoryItem | null {
    this.ensureFresh(scopeKey);
    const row = this.db.sqlite
      .prepare('SELECT * FROM memory_items WHERE id = ? AND scope_key = ?')
      .get(id, scopeKey) as Row | undefined;
    if (!row) return null;
    const item = this.rowToItem(row);
    return this.visible(item, owners) ? item : null;
  }

  /** Untuk inspector UI: ambil item berdasarkan id tanpa filter owner. */
  getByIds(scopeKey: string, ids: string[]): MemoryItem[] {
    if (!ids.length) return [];
    this.ensureFresh(scopeKey);
    const wanted = new Set(ids);
    return this.list(scopeKey, this.allOwners(scopeKey)).filter((i) => wanted.has(i.id));
  }

  private allOwners(scopeKey: string): string[] {
    const rows = this.db.sqlite
      .prepare("SELECT DISTINCT owner FROM memory_items WHERE scope_key = ? AND owner != ''")
      .all(scopeKey) as Array<{ owner: string }>;
    return rows.map((r) => r.owner);
  }

  /** Cari + beri skor. Query kosong (hanya stopword) menghasilkan []. */
  search(
    scopeKey: string,
    owners: string[],
    text: string,
    opts: { sources?: IndexedSource[]; limit?: number; now?: number } = {},
  ): ScoredItem[] {
    const terms = expandSynonyms(extractTerms(text));
    if (!terms.length) return [];
    this.ensureFresh(scopeKey);
    const limit = opts.limit ?? 40;
    const raw = new Map<string, number>();

    if (this.db.hasMemoryFts) {
      try {
        const rows = this.db.sqlite.prepare(`
          SELECT mi.id AS id, bm25(memory_fts, 2.0, 1.0) AS rank
          FROM memory_fts JOIN memory_items mi ON mi.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ? AND mi.scope_key = ?
          ORDER BY rank LIMIT 120
        `).all(buildFtsQuery(terms), scopeKey) as { id: string; rank: number }[];
        for (const r of rows) raw.set(r.id, Math.max(0.0001, -r.rank));
      } catch {
        // Sintaks FTS tidak valid untuk query ini: jatuh ke pemindaian biasa di bawah.
      }
    }
    const all = this.list(scopeKey, owners);
    if (!raw.size) {
      for (const item of all) {
        const title = item.title.toLowerCase();
        const hay = title + ' ' + item.body.toLowerCase();
        let r = 0;
        for (const term of terms) {
          if (title.includes(term)) r += 2;
          else if (hay.includes(term)) r += 1;
        }
        if (r > 0) raw.set(item.id, r);
      }
    }
    const byId = new Map(all.map((i) => [i.id, i]));
    let max = 0;
    for (const [id, r] of raw) if (byId.has(id)) max = Math.max(max, r);
    if (max <= 0) return [];

    const now = opts.now ?? Date.now();
    const scored: ScoredItem[] = [];
    for (const [id, r] of raw) {
      const item = byId.get(id);
      if (!item) continue;
      if (opts.sources && !opts.sources.includes(item.source)) continue;
      const ageDays = Math.max(0, (now - Date.parse(item.updatedAt)) / 86_400_000);
      const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS) : 0;
      let weight = KIND_WEIGHT[item.kind] ?? 0.8;
      if (item.kind === 'task' && item.status === 'done' && ageDays > 14) weight *= 0.5;
      scored.push({ item, score: weight * (0.8 * (r / max) + 0.2 * recency) });
    }
    return scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, limit);
  }
}
