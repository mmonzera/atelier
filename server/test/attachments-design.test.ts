import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACHMENT_ONLY_TEXT,
  type LibraryImage,
  type MessageAttachment,
  parseMessageSegments,
  summarizeDesignBlocks,
} from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { formatUncompactedConversation } from '../src/agents/compactor.js';
import type { AgentRunner, Turn } from '../src/agents/runner.js';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const handles: AtelierServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(runner?: AgentRunner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-att-'));
  dirs.push(dir);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
    },
    customRunner: runner,
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dir };
}

function upload(base: string, files: Array<{ name: string; bytes: Buffer }>) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([new Uint8Array(f.bytes)]), f.name);
  return fetch(`${base}/api/attachments`, { method: 'POST', body: form });
}

describe('design option blocks', () => {
  const block = `Berikut opsinya:

<atelier-design title="Pilih arah" ask="Mau yang mana?">
<atelier-option id="A" label="Scope chip" pros="Jelas > cepat" cons="Perlu belajar" width="900" height="500">
<!doctype html><html><body><select><option>x</option></select></body></html>
</atelier-option>
<atelier-option id="B" label="Logo"><svg viewBox="0 0 10 10"><circle r="4"/></svg></atelier-option>
<atelier-option id="C" label="Render" kind="image" src="C:\\work\\shot.png"></atelier-option>
<atelier-option id="D" label="Kosong"></atelier-option>
</atelier-design>

Pilih salah satu ya.`;

  it('parses options (HTML containing <option>, svg autodetect, image src, quotes with ">")', () => {
    const segs = parseMessageSegments(block);
    expect(segs.map((s) => s.type)).toEqual(['text', 'design', 'text']);
    const design = segs[1];
    if (design.type !== 'design') throw new Error('expected design');
    expect(design.block.title).toBe('Pilih arah');
    expect(design.block.options.map((o) => [o.id, o.kind])).toEqual([
      ['A', 'html'],
      ['B', 'svg'],
      ['C', 'image'],
    ]); // D is empty and dropped
    expect(design.block.options[0].pros).toBe('Jelas > cepat');
    expect(design.block.options[0].content).toContain('<select><option>x</option></select>');
    expect(design.block.options[0].width).toBe(900);
    expect(design.block.options[2].src).toBe('C:\\work\\shot.png');
  });

  it('shows a placeholder while the block is still streaming and never leaks half-written HTML', () => {
    const partial = block.slice(0, block.indexOf('<atelier-option id="B"'));
    const segs = parseMessageSegments(partial);
    expect(segs.at(-1)).toEqual({ type: 'design-pending', title: 'Pilih arah' });
    expect(JSON.stringify(segs)).not.toContain('<!doctype');
  });

  it('leaves ordinary messages untouched and summarises blocks for model history', () => {
    expect(parseMessageSegments('halo **dunia**')).toEqual([{ type: 'text', text: 'halo **dunia**' }]);
    const summary = summarizeDesignBlocks(block);
    expect(summary).toContain('Design options shown to the user');
    expect(summary).toContain('A "Scope chip"');
    expect(summary).not.toContain('<!doctype');
    expect(summary).toContain('Pilih salah satu ya.');
  });
});

describe('chat attachments', () => {
  it('stores files safely, classifies by content, and serves only real images inline', async () => {
    const { base } = await boot();
    const res = await upload(base, [
      { name: 'shot.png', bytes: PNG },
      { name: 'notes.md', bytes: Buffer.from('# hello\nworld') },
      { name: '..\\..\\evil<>.txt', bytes: Buffer.from('plain') },
      { name: 'fake.png', bytes: Buffer.from('<html><script>alert(1)</script></html>') }, // not a PNG
      { name: 'page.html', bytes: Buffer.from('<html><script>alert(1)</script></html>') },
    ]);
    expect(res.status).toBe(200);
    const { attachments } = (await res.json()) as { attachments: MessageAttachment[] };
    const [shot, notes, evil, fake, page] = attachments;
    expect([shot.kind, shot.mime]).toEqual(['image', 'image/png']);
    expect(notes.kind).toBe('text');
    expect(evil.name).not.toMatch(/[<>\\/]/);
    expect(fake.kind).not.toBe('image');
    expect(page.kind).toBe('text');

    const img = await fetch(`${base}/api/attachments/${shot.id}/${shot.name}`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-disposition')).toMatch(/^inline/);
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');

    for (const a of [fake, page, notes]) {
      const r = await fetch(`${base}/api/attachments/${a.id}/${a.name}`);
      expect(r.headers.get('content-type')).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
    }

    expect((await fetch(`${base}/api/attachments/att_000000000000/x`)).status).toBe(404);
    expect((await fetch(`${base}/api/attachments/..%2F..%2Fsecret/x`)).status).toBe(404);
    expect((await upload(base, [{ name: 'empty.txt', bytes: Buffer.alloc(0) }])).status).toBe(400);
  });

  it('puts file paths and small text files into the prompt, forwards attachments, and keeps history tidy', async () => {
    const turns: Turn[] = [];
    const runner: AgentRunner = {
      async run(turn, cb) {
        turns.push(turn);
        cb.onText('ok');
        return { finalText: 'ok' };
      },
    };
    const { handle, base } = await boot(runner);
    const { project, agents } = handle.store.createProject({
      name: 'Att',
      starterAgents: [{ name: 'Bot', role: 'Eng' }],
    });
    const agent = agents[0]!;

    const up = (await (
      await upload(base, [
        { name: 'shot.png', bytes: PNG },
        { name: 'brief.txt', bytes: Buffer.from('Warna utama: hijau tua') },
      ])
    ).json()) as { attachments: MessageAttachment[] };
    const ids = up.attachments.map((a) => a.id);

    const send = (body: unknown) =>
      fetch(`${base}/api/agents/${agent.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await send({ text: 'lihat ini', projectId: project.id, attachmentIds: ['att_aaaaaaaaaaaa'] })).status).toBe(404);
    expect((await send({ text: '', projectId: project.id })).status).toBe(400);

    expect((await send({ text: 'lihat ini', projectId: project.id, attachmentIds: ids })).status).toBe(202);
    const start = Date.now();
    while (turns.length < 1 && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 40));

    const turn = turns[0]!;
    expect(turn.prompt).toContain('lihat ini');
    expect(turn.prompt).toContain('[Attached files');
    expect(turn.prompt).toContain(handle.config.dataDir.replace(/\\/g, path.sep));
    expect(turn.prompt).toContain('Warna utama: hijau tua'); // small text file inlined
    expect(turn.attachments?.map((a) => a.name)).toEqual(['shot.png', 'brief.txt']);

    // the chat bubble keeps the user's own words; the attachment list lives in metadata
    const msgs = handle.store.listAgentMessages(agent.id, project.id);
    const userMsg = msgs.find((m) => m.author === 'user')!;
    expect(userMsg.text).toBe('lihat ini');
    expect(userMsg.metadata?.attachments).toHaveLength(2);

    // attachment-only message gets the neutral default text
    await new Promise((r) => setTimeout(r, 200));
    const only = (await (await upload(base, [{ name: 'a.png', bytes: PNG }])).json()) as { attachments: MessageAttachment[] };
    expect((await send({ text: '', projectId: project.id, attachmentIds: [only.attachments[0].id] })).status).toBe(202);
    const t2 = Date.now();
    while (turns.length < 2 && Date.now() - t2 < 8000) await new Promise((r) => setTimeout(r, 40));
    expect(turns[1]!.prompt.startsWith(ATTACHMENT_ONLY_TEXT)).toBe(true);

    // sent attachments cannot be deleted; unsent ones can
    expect((await fetch(`${base}/api/attachments/${ids[0]}`, { method: 'DELETE' })).status).toBe(409);
    const spare = (await (await upload(base, [{ name: 'spare.png', bytes: PNG }])).json()) as { attachments: MessageAttachment[] };
    expect((await fetch(`${base}/api/attachments/${spare.attachments[0].id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/api/attachments/${spare.attachments[0].id}/spare.png`)).status).toBe(404);
  });

  it('formats history without duplicating the current message and without design HTML', () => {
    const note = (m: { metadata?: { attachments?: MessageAttachment[] } }) =>
      m.metadata?.attachments?.length ? '\n[Attached files]\n- a.png' : '';
    const att = [{ id: 'att_aaaaaaaaaaaa', name: 'a.png', mime: 'image/png', size: 1, kind: 'image' as const }];
    const mk = (id: string, author: 'user' | 'agent', text: string, attachments?: MessageAttachment[]) => ({
      id,
      projectId: null,
      agentId: 'a',
      author,
      text,
      streaming: false,
      durationMs: null,
      metadata: attachments ? { attachments } : undefined,
      createdAt: new Date().toISOString(),
    });
    const history = [
      mk('1', 'user', 'buat desain'),
      mk('2', 'agent', 'ini <atelier-design title="t"><atelier-option id="A" label="x"><html>BIG</html></atelier-option></atelier-design>'),
      mk('3', 'user', 'pilih A', att),
    ];
    const out = formatUncompactedConversation(history as never, null, `pilih A${note(history[2] as never)}\n\nexcerpt`, 6000, note as never);
    expect(out).not.toContain('BIG');
    expect(out).toContain('Design options shown to the user');
    expect(out.match(/pilih A/g)).toHaveLength(1); // current message appears once (as CURRENT MESSAGE)
  });
});

describe('workspace images for design cards', () => {
  it('serves only real image files inside workspaces / linked repos / attachments', async () => {
    const { handle, base, dir } = await boot();
    const wsImg = path.join(handle.config.workspacesDir, 'p1', 'render.png');
    fs.mkdirSync(path.dirname(wsImg), { recursive: true });
    fs.writeFileSync(wsImg, PNG);
    const outside = path.join(dir, 'outside.png');
    fs.writeFileSync(outside, PNG);
    const fakePng = path.join(handle.config.workspacesDir, 'p1', 'fake.png');
    fs.writeFileSync(fakePng, 'not an image');
    const secret = path.join(handle.config.workspacesDir, 'p1', 'secret.txt');
    fs.writeFileSync(secret, 'top secret');

    const get = (p: string) => fetch(`${base}/api/workspace-image?path=${encodeURIComponent(p)}`);
    expect((await get(wsImg)).status).toBe(200);
    expect((await get(wsImg)).headers.get('content-type')).toBe('image/png');
    expect((await get(outside)).status).toBe(403);
    expect((await get(fakePng)).status).toBe(400);
    expect((await get(secret)).status).toBe(400);
    expect((await get(path.join(handle.config.workspacesDir, '..', 'outside.png'))).status).toBe(403);
    expect((await get(path.join(handle.config.workspacesDir, 'nope.png'))).status).toBe(404);

    // a linked repo folder is allowed too
    const repo = path.join(dir, 'myrepo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'mock.png'), PNG);
    const { project } = handle.store.createProject({ name: 'R' });
    handle.store.updateProject(project.id, { repo: { fullName: 'a/b', defaultBranch: 'main', localPath: repo } });
    expect((await get(path.join(repo, 'mock.png'))).status).toBe(200);
  });
});

describe('project image library', () => {
  it('lists chat uploads and image artifacts per project and serves them safely', async () => {
    const runner: AgentRunner = {
      async run(_turn, cb) {
        cb.onText('ok');
        return { finalText: 'ok' };
      },
    };
    const { handle, base } = await boot(runner);
    const { project, agents } = handle.store.createProject({ name: 'Lib', starterAgents: [{ name: 'Bot', role: 'Eng' }] });
    const other = handle.store.createProject({ name: 'Other', starterAgents: [{ name: 'Bot2', role: 'Eng' }] }).project;

    const up = (await (await upload(base, [{ name: 'shot.png', bytes: PNG }, { name: 'brief.txt', bytes: Buffer.from('hi') }])).json()) as {
      attachments: MessageAttachment[];
    };
    const unsent = (await (await upload(base, [{ name: 'unsent.png', bytes: PNG }])).json()) as { attachments: MessageAttachment[] };
    await fetch(`${base}/api/agents/${agents[0]!.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'lihat', projectId: project.id, attachmentIds: up.attachments.map((a) => a.id) }),
    });

    const svg = handle.store.createArtifact(
      { projectId: project.id, kind: 'svg', label: 'Logo', mime: 'image/svg+xml' },
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle r="1"/></svg>'),
    );
    const badImage = handle.store.createArtifact(
      { projectId: project.id, kind: 'image', label: 'Fake', mime: 'image/png' },
      Buffer.from('<script>alert(1)</script>'),
    );
    handle.store.createArtifact({ projectId: project.id, kind: 'html', label: 'Page', mime: 'text/html' }, Buffer.from('<p>x</p>'));
    handle.store.createArtifact({ projectId: other.id, kind: 'svg', label: 'Foreign', mime: 'image/svg+xml' }, Buffer.from('<svg/>'));

    const list = async (scope: string) => (await fetch(`${base}/api/projects/${scope}/library`)).json() as Promise<{ images: LibraryImage[] }>;
    const { images } = await list(project.id);
    const names = images.map((i) => i.name).sort();
    // sent image + svg + the fake image artifact; not the text file, unsent upload, html page or other project's art
    expect(names).toEqual(['Fake', 'Logo', 'shot.png']);
    expect(images.find((i) => i.name === 'shot.png')!.source).toBe('attachment');
    expect(unsent.attachments[0]!.id).not.toBe(up.attachments[0]!.id);
    expect(images.some((i) => i.id === unsent.attachments[0]!.id)).toBe(false);

    for (const image of images.filter((i) => i.name !== 'Fake')) {
      const res = await fetch(`${base}${image.url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const logo = images.find((i) => i.id === svg.id)!;
    expect((await fetch(`${base}${logo.url}`)).headers.get('content-type')).toBe('image/svg+xml');
    expect((await fetch(`${base}/api/projects/${project.id}/library/artifacts/${badImage.id}`)).status).toBe(400);
    expect((await fetch(`${base}/api/projects/${other.id}/library/artifacts/${svg.id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/nope/library`)).status).toBe(404);
    expect((await list('direct')).images).toEqual([]);
  });
});
