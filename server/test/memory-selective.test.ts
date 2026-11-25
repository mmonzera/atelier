import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings, type ThreadCompaction } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/agents/compactor.js';
import type { AgentRunner, Turn } from '../src/agents/runner.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { renderCanon, SELECTIVE_MEMORY_PROMPT } from '../src/agents/prompts.js';
import { createStudioTools } from '../src/agents/studio-tools.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { extractTerms } from '../src/memory/query.js';
import { CATALOG_KEY, selectMemory } from '../src/memory/selector.js';
import { AtelierStore } from '../src/store.js';

const dirs: string[] = [];
const dbs: AtelierDb[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-selmem-'));
  dirs.push(dir);
  const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath: path.join(dir, 'atelier.db') });
  const db = new AtelierDb(config.dbPath);
  dbs.push(db);
  const store = new AtelierStore(db, config);
  const { project, agents: [agent] } = store.createProject({
    name: 'Orbit', starterAgents: [{ name: 'Builder', role: 'Builder' }],
  });
  return { dir, config, db, store, project, agent: agent! };
}

type Fixture = ReturnType<typeof fixture>;
const settings = (over: Partial<MemorySettings> = {}): MemorySettings => ({ ...DEFAULT_MEMORY_SETTINGS, mode: 'selective', ...over });

function addCanon(f: Fixture, key: string, title: string, value: string, source: 'agent_recorded' | 'user_pick' | 'user_edited' = 'agent_recorded', kind: 'decision' | 'rule' | 'asset' = 'decision') {
  return f.store.upsertCanon(f.project.id, { kind, key, title, value, source });
}

function compaction(over: Partial<ThreadCompaction> = {}): ThreadCompaction {
  return {
    summary: 'Goal: ship landing', compactedMessageCount: 4, lastCompactedMessageId: 'msg_x',
    compactedAt: new Date().toISOString(),
    structured: {
      goal: 'Ship the landing page',
      decisions: ['Use Astro for the landing site'],
      done: [{ text: 'Hero section built', paths: ['src/components/Hero.astro'] }],
      open: ['Footer is not responsive below 768px'],
      artifacts: [],
    },
    ...over,
  };
}

function sel(f: Fixture, queryText: string, over: Partial<MemorySettings> = {}, extra: { alreadySent?: Record<string, string>; owners?: string[] } = {}) {
  return selectMemory({
    index: f.store.memory, scopeKey: f.project.id, owners: extra.owners ?? [], queryText,
    settings: settings(over), alreadySent: extra.alreadySent,
  });
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('query builder', () => {
  it('drops stopwords, keeps identifiers first, and returns nothing for filler', () => {
    expect(extractTerms('ok makasih')).toEqual([]);
    expect(extractTerms('tolong ubah warna tombol di AT-12 dan src/Hero.astro')).toEqual([
      'at-12', 'src/hero.astro', 'ubah', 'warna', 'tombol',
    ]);
  });
});

describe('memory index (F1)', () => {
  it('projects canon, tasks and artifacts, and follows supersede and forget', () => {
    const f = fixture();
    addCanon(f, 'brand.color', 'Primary color', 'Use violet #6D28D9');
    expect(f.store.memory.list(f.project.id).filter((i) => i.source === 'canon')).toHaveLength(1);

    addCanon(f, 'brand.color', 'Primary color', 'Use teal #0D9488');
    const canon = f.store.memory.list(f.project.id).filter((i) => i.source === 'canon');
    expect(canon).toHaveLength(1);
    expect(canon[0]!.line).toContain('teal');

    const entry = f.store.listCanon(f.project.id)[0]!;
    f.store.deleteCanon(entry.id);
    expect(f.store.memory.list(f.project.id).filter((i) => i.source === 'canon')).toHaveLength(0);

    const task = f.store.createTask(f.project.id, { title: 'Build pricing table', description: 'Three tiers' })!;
    expect(f.store.memory.list(f.project.id).some((i) => i.source === 'task' && i.title.includes(task.identifier))).toBe(true);
    f.store.updateTask(task.id, { deliverableSummary: 'Pricing table merged' });
    expect(f.store.memory.list(f.project.id).find((i) => i.source === 'task')!.line).toContain('Pricing table merged');

    f.store.createArtifact({ projectId: f.project.id, kind: 'svg', label: 'Logo mark', mime: 'image/svg+xml' }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(f.store.memory.list(f.project.id).some((i) => i.source === 'artifact' && i.title === 'Logo mark')).toBe(true);
  });

  it('replaces summary items on every compaction instead of piling up', () => {
    const f = fixture();
    f.store.updateAgent(f.agent.id, { contextCompactions: { [f.project.id]: compaction() } });
    const owner = `agent:${f.agent.id}`;
    const count = () => f.store.memory.list(f.project.id, [owner]).filter((i) => i.source === 'summary').length;
    expect(count()).toBe(4); // goal + decision + done + open
    f.store.updateAgent(f.agent.id, { contextCompactions: { [f.project.id]: compaction({
      structured: { goal: 'Ship', decisions: [], done: [], open: ['One thing'], artifacts: [] },
    }) } });
    expect(count()).toBe(2);
  });

  it('keeps summaries private to their owner', () => {
    const f = fixture();
    f.store.updateAgent(f.agent.id, { contextCompactions: { [f.project.id]: compaction() } });
    expect(f.store.memory.list(f.project.id, []).filter((i) => i.source === 'summary')).toHaveLength(0);
    expect(f.store.memory.list(f.project.id, ['channel:other']).filter((i) => i.source === 'summary')).toHaveLength(0);
    expect(f.store.memory.list(f.project.id, [`agent:${f.agent.id}`]).filter((i) => i.source === 'summary')).toHaveLength(4);
  });

  it('rebuild() from an empty index reproduces the incremental result', () => {
    const f = fixture();
    addCanon(f, 'a.one', 'One', 'first');
    addCanon(f, 'a.two', 'Two', 'second', 'user_pick', 'rule');
    f.store.createTask(f.project.id, { title: 'Task A' });
    const before = f.store.memory.list(f.project.id).map((i) => [i.id, i.line, i.pinned]);
    f.store.memory.rebuild();
    expect(f.store.memory.list(f.project.id).map((i) => [i.id, i.line, i.pinned])).toEqual(before);
  });

  it('cascades when the project goes away and never leaks across scopes', () => {
    const f = fixture();
    addCanon(f, 'only.here', 'Only here', 'secret');
    const other = f.store.createProject({ name: 'Other', starterAgents: [{ name: 'B', role: 'B' }] }).project;
    expect(f.store.memory.list(other.id)).toHaveLength(0);
    expect(f.store.memory.list('direct')).toHaveLength(0);
    expect(f.store.searchMemory(other.id, [], 'secret')).toEqual([]);
  });

  it('works without FTS5 by scanning (fallback)', () => {
    const f = fixture();
    addCanon(f, 'nav.style', 'Navigation style', 'Sticky top navigation with blur');
    (f.db as unknown as { hasMemoryFts: boolean }).hasMemoryFts = false;
    const hits = f.store.searchMemory(f.project.id, [], 'navigation', { sources: ['canon'] });
    expect(hits.map((h) => h.title)).toContain('nav.style Navigation style');
  });
});

describe('search_memory / get_memory (F2)', () => {
  it('finds canon that never fit the push budget, with OR + prefix + synonyms', () => {
    const f = fixture();
    for (let i = 0; i < 80; i += 1) addCanon(f, `filler.item${i}`, `Filler ${i}`, `Filler value number ${i} lorem ipsum dolor sit amet`);
    addCanon(f, 'button.primary.color', 'Button color', 'Primary button uses violet');
    const tools = createStudioTools({ store: f.store, projectId: f.project.id, actingAgentId: f.agent.id, enqueue() {} });
    const hits = tools.memoryAction('search_memory', { query: 'warna tombol utama', limit: 3 }) as Array<{ id: string; title: string }>;
    expect(hits[0]!.title).toContain('button.primary.color');
    const full = tools.memoryAction('get_memory', { id: hits[0]!.id }) as { found: boolean; entry: { value: string } };
    expect(full.found).toBe(true);
    expect(full.entry.value).toContain('violet');
    expect(renderCanon(f.store.listCanon(f.project.id)).omitted).toBeGreaterThan(0);
  });

  it('returns [] for filler-only queries and rejects foreign scopes', () => {
    const f = fixture();
    addCanon(f, 'x.y', 'Thing', 'value');
    const tools = createStudioTools({ store: f.store, projectId: f.project.id, actingAgentId: f.agent.id, enqueue() {} });
    expect(tools.memoryAction('search_memory', { query: 'ok makasih' })).toEqual([]);
    const other = f.store.createProject({ name: 'Other', starterAgents: [{ name: 'B', role: 'B' }] });
    const otherTools = createStudioTools({ store: f.store, projectId: other.project.id, actingAgentId: other.agents[0]!.id, enqueue() {} });
    const id = f.store.memory.list(f.project.id)[0]!.id;
    expect(otherTools.memoryAction('get_memory', { id })).toEqual({ found: false });
  });

  it('keeps search_history strict (AND) while search_memory relaxes messages to OR', () => {
    const f = fixture();
    f.store.createMessage({ projectId: f.project.id, agentId: f.agent.id, author: 'user', text: 'We settled on cobalt gradients for the hero', streaming: false });
    expect(f.store.searchHistory(f.project.id, 'cobalt unicorn', 5)).toEqual([]);
    const hits = f.store.searchMemory(f.project.id, [], 'cobalt unicorn', { sources: ['message'] });
    expect(hits).toHaveLength(1);
  });
});

describe('selector (F3)', () => {
  it('sends only pinned + index for filler prompts and stays under the push budget', () => {
    const f = fixture();
    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors', 'user_edited', 'rule');
    for (let i = 0; i < 60; i += 1) addCanon(f, `note.n${i}`, `Note ${i}`, `Agent note about topic ${i} with extra words to take space`);
    const r = sel(f, 'makasih');
    expect(r.text).toContain('rule.tokens');
    expect(r.tokens.relevant).toBe(0);
    expect(r.text).toContain('Index (titles only)');
    expect(r.text).toMatch(/\+\d+ more items/);
    expect(r.tokens.total).toBeLessThanOrEqual(DEFAULT_MEMORY_SETTINGS.pushBudgetTokens);
  });

  it('pulls relevant items for the request and always keeps pinned user rules', () => {
    const f = fixture();
    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors', 'user_edited', 'rule');
    addCanon(f, 'footer.layout', 'Footer layout', 'Footer uses four columns with newsletter form');
    addCanon(f, 'hero.copy', 'Hero copy', 'Headline says Ship faster');
    const r = sel(f, 'please fix the footer layout columns');
    expect(r.text).toContain('Pinned:');
    expect(r.text).toContain('rule.tokens');
    const relevant = (r.text.split('Relevant:')[1] ?? '').split('Index (titles only)')[0]!;
    expect(relevant).toContain('footer.layout');
    expect(relevant).not.toContain('hero.copy');
  });

  it('puts overflowing pinned entries through the relevance path and reports the overflow', () => {
    const f = fixture();
    for (let i = 0; i < 12; i += 1) addCanon(f, `pick.p${i}`, `Pick ${i}`, 'x'.repeat(250), 'user_pick');
    const r = sel(f, 'pick', { pinnedBudgetTokens: 100 });
    expect(r.pinnedOverflow).toBeGreaterThan(0);
  });

  it('dedups summary points that repeat a canon entry', () => {
    const f = fixture();
    addCanon(f, 'stack.site', 'Landing stack', 'Use Astro for the landing site', 'user_pick');
    f.store.updateAgent(f.agent.id, { contextCompactions: { [f.project.id]: compaction() } });
    const r = sel(f, 'which stack for the landing site', {}, { owners: [`agent:${f.agent.id}`] });
    expect(r.text.match(/Use Astro for the landing site/g)?.length).toBe(1);
  });

  it('skips items already sent to a resumed session and only sends changes', () => {
    const f = fixture();
    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors', 'user_edited', 'rule');
    const first = sel(f, 'footer');
    expect(first.text).toContain('Relevant Memory');
    const again = sel(f, 'footer', {}, { alreadySent: first.written });
    expect(again.text).toBe('');
    expect(again.pushedIds).toEqual(first.pushedIds);

    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors or radii', 'user_edited', 'rule');
    const changed = sel(f, 'footer', {}, { alreadySent: first.written });
    expect(changed.text).toContain('Memory update since last turn');
    expect(changed.text).toContain('radii');
    expect(changed.written[CATALOG_KEY]).toBeUndefined();
  });

  it('pin flag overrides the default and survives edits', () => {
    const f = fixture();
    const entry = addCanon(f, 'agent.note', 'Agent note', 'Remember this');
    expect(f.store.memory.list(f.project.id).find((i) => i.sourceId.endsWith('agent.note'))!.pinned).toBe(false);
    f.store.setCanonPinned(entry.id, true);
    expect(f.store.memory.list(f.project.id).find((i) => i.sourceId.endsWith('agent.note'))!.pinned).toBe(true);
    addCanon(f, 'agent.note', 'Agent note', 'Remember this too');
    expect(f.store.memory.list(f.project.id).find((i) => i.sourceId.endsWith('agent.note'))!.pinned).toBe(true);
  });
});

describe('settings', () => {
  it('defaults to full, clamps values and merges partial updates', () => {
    const f = fixture();
    expect(f.store.getSettings().memory?.mode).toBe('full');
    const updated = f.store.updateSettings({ memory: { mode: 'selective', pushBudgetTokens: 999_999, topK: 0 } });
    expect(updated.memory).toMatchObject({ mode: 'selective', pushBudgetTokens: 8000, topK: 1, pinnedBudgetTokens: 500 });
    expect(f.store.updateSettings({ memory: { topK: 5 } }).memory?.mode).toBe('selective');
  });
});

describe('runtime wiring (F3/F4)', () => {
  async function drive(f: Fixture, prompts: string[], mode: 'full' | 'selective') {
    f.store.updateSettings({ memory: { mode } });
    const turns: Turn[] = [];
    const runner: AgentRunner = {
      async run(turn, cb) {
        turns.push(turn);
        cb.onSession('claude:sess_1');
        cb.onText('ok');
        return { finalText: 'ok' };
      },
    };
    const runtime = new AgentRuntime(f.store, f.config, runner);
    try {
      for (const [i, prompt] of prompts.entries()) {
        runtime.enqueue({ agentId: f.agent.id, projectId: f.project.id, kind: 'user', prompt });
        const deadline = Date.now() + 5000;
        while (turns.length < i + 1 || f.store.getAgent(f.agent.id)!.status !== 'idle') {
          if (Date.now() > deadline) throw new Error('timeout');
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    } finally {
      await runtime.shutdown();
    }
    return turns;
  }

  it('full mode is untouched: Canon goes to the system prompt, no memory block', async () => {
    const f = fixture();
    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors', 'user_edited', 'rule');
    const [turn] = await drive(f, ['hello'], 'full');
    expect(turn!.memoryBlock).toBeUndefined();
    expect(turn!.omitCompaction).toBeUndefined();
    expect(turn!.canonText).toBe(renderCanon(f.store.listCanon(f.project.id)).text);
  });

  it('selective mode keeps the system-side text constant and sends memory in the user block', async () => {
    const f = fixture();
    addCanon(f, 'rule.tokens', 'Use tokens', 'Never hardcode colors', 'user_edited', 'rule');
    addCanon(f, 'footer.layout', 'Footer layout', 'Footer uses four columns');
    const turns = await drive(f, ['please fix the footer layout', 'rename the pricing page'], 'selective');
    expect(turns[0]!.canonText).toBe(SELECTIVE_MEMORY_PROMPT);
    expect(turns[1]!.canonText).toBe(turns[0]!.canonText);
    expect(turns[0]!.canonChanged).toBe(false);
    expect(turns[0]!.omitCompaction).toBe(true);
    expect(turns[0]!.memoryBlock).toContain('footer.layout');
    expect(turns[0]!.memoryBlock).toContain('rule.tokens');

    // Second turn resumes the provider session: pinned rule is already there and is not resent.
    expect(turns[1]!.resumeSessionId).toBe('claude:sess_1');
    expect(turns[1]!.memoryBlock ?? '').not.toContain('rule.tokens');
    const reply = f.store.listAgentMessages(f.agent.id, f.project.id).filter((m) => m.author === 'agent');
    expect(reply[0]!.metadata?.memoryUsed?.pushed.length).toBeGreaterThan(0);
    expect(f.store.getAgent(f.agent.id)!.sessionMemorySent?.[f.project.id]?.sessionId).toBe('claude:sess_1');
  });
});

describe('golden set + token A/B (F6)', () => {
  type Golden = { query: string; expect: string[] };
  // Proyek sintetis: 45 entri Canon di 9 topik, 6 di antaranya di-pin sebagai aturan user.
  const topics: Record<string, string[]> = {
    footer: ['footer.columns', 'footer.newsletter', 'footer.legal'],
    hero: ['hero.headline', 'hero.cta', 'hero.background'],
    pricing: ['pricing.tiers', 'pricing.toggle', 'pricing.currency'],
    nav: ['nav.sticky', 'nav.mobile', 'nav.cta'],
    typography: ['type.scale', 'type.heading', 'type.mono'],
    color: ['color.primary', 'color.surface', 'color.danger'],
    motion: ['motion.reveal', 'motion.hover', 'motion.reduced'],
    faq: ['faq.accordion', 'faq.schema', 'faq.order'],
    seo: ['seo.title', 'seo.og', 'seo.sitemap'],
  };
  const golden: Golden[] = [
    { query: 'fix the footer newsletter signup', expect: ['footer.newsletter'] },
    { query: 'change the hero headline copy', expect: ['hero.headline'] },
    { query: 'ubah tombol cta di hero', expect: ['hero.cta'] },
    { query: 'pricing tiers need a yearly toggle', expect: ['pricing.tiers', 'pricing.toggle'] },
    { query: 'mobile navigation menu is broken', expect: ['nav.mobile'] },
    { query: 'heading typography scale is too big', expect: ['type.heading', 'type.scale'] },
    { query: 'warna primary dan surface', expect: ['color.primary', 'color.surface'] },
    { query: 'respect reduced motion on reveal animations', expect: ['motion.reduced', 'motion.reveal'] },
    { query: 'faq accordion should be accessible', expect: ['faq.accordion'] },
    { query: 'add open graph image for seo', expect: ['seo.og'] },
    { query: 'legal links in the footer', expect: ['footer.legal'] },
    { query: 'sitemap generation', expect: ['seo.sitemap'] },
  ];

  function build() {
    const f = fixture();
    for (const [topic, keys] of Object.entries(topics)) {
      for (const key of keys) {
        const words = key.split('.').join(' ');
        const extra: Record<string, string> = {
          'hero.cta': 'Call to action tombol button label and link target',
          'footer.newsletter': 'Newsletter signup form with email field',
          'pricing.toggle': 'Monthly yearly toggle for the pricing tiers',
          'nav.mobile': 'Mobile navigation menu drawer behaviour',
          'color.primary': 'Primary warna color violet',
          'color.surface': 'Surface warna color dark neutral',
          'faq.accordion': 'Accordion pattern with accessible buttons',
          'seo.og': 'Open graph image 1200x630',
          'motion.reduced': 'Respect prefers reduced motion for animations',
          'motion.reveal': 'Reveal on scroll animation',
          'type.heading': 'Heading typography sizes and weights',
          'type.scale': 'Type scale ratio for typography',
          'footer.legal': 'Legal links privacy terms in footer',
          'seo.sitemap': 'Sitemap generation for seo',
          'hero.headline': 'Hero headline copy says Ship faster',
          'pricing.tiers': 'Three pricing tiers free pro team',
        };
        addCanon(f, key, `${words} (${topic})`, `${extra[key] ?? `Decision about ${words} for the ${topic} area of the landing page`}. Details: ${'lorem ipsum dolor sit amet '.repeat(6)}`);
      }
    }
    for (let i = 0; i < 6; i += 1) addCanon(f, `rule.r${i}`, `House rule ${i}`, `Always follow house rule ${i} when editing`, 'user_edited', 'rule');
    return f;
  }

  it('recall@topK >= 0.85 on the golden set and pinned recall = 1.0', () => {
    const f = build();
    let found = 0;
    let total = 0;
    for (const g of golden) {
      const r = sel(f, g.query, { topK: 8 });
      for (const key of g.expect) {
        total += 1;
        const item = f.store.memory.list(f.project.id).find((i) => i.sourceId.endsWith(`:${key}`))!;
        if (r.pushedIds.includes(item.id)) found += 1;
      }
      const pinned = f.store.memory.list(f.project.id).filter((i) => i.pinned);
      for (const p of pinned.slice(0, 6)) expect(r.pushedIds).toContain(p.id);
    }
    expect(found / total).toBeGreaterThanOrEqual(0.85);
  });

  it('cuts memory tokens by >= 40% versus sending the whole Canon (project with > 30 items)', () => {
    const f = build();
    expect(f.store.memory.list(f.project.id).length).toBeGreaterThan(30);
    // Mode full mengirim seluruh Canon yang muat (<= 1500 token); selective mengirim memory yang dipilih.
    const fullTokens = estimateTokens(renderCanon(f.store.listCanon(f.project.id)).text);
    const perTurn = golden.map((g) => sel(f, g.query).tokens.total);
    const median = [...perTurn].sort((a, b) => a - b)[Math.floor(perTurn.length / 2)]!;
    expect(median).toBeLessThanOrEqual(DEFAULT_MEMORY_SETTINGS.pushBudgetTokens);
    expect(median).toBeLessThanOrEqual(fullTokens * 0.6);
    // Tidak ada yang tersembunyi: semua entri bisa dijangkau lewat search_memory.
    const unreachable = f.store.listCanon(f.project.id).filter((c) =>
      !f.store.searchMemory(f.project.id, [], `${c.key.replace('.', ' ')}`, { sources: ['canon'], limit: 5 }).some((h) => h.title.startsWith(c.key)));
    expect(unreachable).toEqual([]);
  });
});
