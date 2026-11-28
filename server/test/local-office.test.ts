import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMaxToolCallsPerTurn } from '../src/agents/cli-runners.js';
import { buildAgentSystemPrompt } from '../src/agents/prompts.js';
import { loadConfig } from '../src/config.js';
import { AtelierDb } from '../src/db.js';
import { buildFilePreviewData, parseExcelPreview, resolvePreviewTarget } from '../src/file-preview.js';
import { startAtelierServer, type AtelierServerHandle } from '../src/index.js';
import {
  editDocxDocument,
  editPptxDocument,
  editXlsxDocument,
  parsePptxPreview,
  readDocxAsMarkdown,
  readPdfDocument,
  readPptxAsMarkdown,
  readSpreadsheetAsMarkdown,
  writeDocxDocument,
  writePdfDocument,
  writePptxDocument,
  writeXlsxDocument,
} from '../src/office/documents.js';
import { applyOfficeAtelierActions } from '../src/office/tools.js';
import { AtelierStore } from '../src/store.js';

const tempDirs: string[] = [];
const handles: AtelierServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Local Office document engine (.docx, .xlsx, .pptx, .pdf)', () => {
  it('round-trips Word (.docx) write, read, and edit including tables, formatting, and links', () => {
    const buf = writeDocxDocument({
      title: 'Project Brief',
      subtitle: 'Q4 Execution Plan',
      markdown: [
        '## Overview',
        '',
        'This is **bold**, *italic*, `inlineCode`, and [Atelier](https://example.com).',
        '',
        '- First item',
        '- Second item',
        '',
        '| Owner | Deliverable | Status |',
        '| --- | --- | --- |',
        '| Alice | Proposal | Draft |',
      ].join('\n'),
    });

    const read1 = readDocxAsMarkdown(buf);
    expect(read1.blockCount).toBeGreaterThan(4);
    expect(read1.tableCount).toBe(1);
    expect(read1.markdown).toContain('# Project Brief');
    expect(read1.markdown).toContain('**bold**');
    expect(read1.markdown).toContain('[Atelier](https://example.com)');
    expect(read1.markdown).toContain('| Alice | Proposal | Draft |');

    const edited = editDocxDocument(buf, {
      replacements: [{ find: 'Draft', replace: 'Approved' }],
      appendMarkdown: '## Addendum\n\nSigned off by team.',
    });
    expect(edited.replacementsApplied).toBe(1);
    const read2 = readDocxAsMarkdown(edited.buffer);
    expect(read2.markdown).toContain('| Alice | Proposal | Approved |');
    expect(read2.markdown).toContain('## Addendum');
    expect(read2.markdown).toContain('Signed off by team.');
  });

  it('round-trips Excel (.xlsx) write, read, preview, and edit with formulas and multiple sheets', () => {
    const buf = writeXlsxDocument({
      sheets: [
        {
          name: 'Budget',
          headers: ['Item', 'Qty', 'UnitPrice', 'Total'],
          rows: [
            ['Laptop', 2, 1500, '=B2*C2'],
            ['Monitor', 4, 400, '=B3*C3'],
            ['Grand Total', null, null, '=SUM(D2:D3)'],
          ],
        },
        {
          name: 'Metadata',
          rows: [['Approved', true]],
        },
      ],
    });

    const read1 = readSpreadsheetAsMarkdown(buf, 'xlsx');
    expect(read1.sheets).toHaveLength(2);
    expect(read1.sheets[0]!.name).toBe('Budget');
    expect(read1.sheets[0]!.formulas.D2).toBe('=B2*C2');
    expect(read1.sheets[0]!.formulas.D4).toBe('=SUM(D2:D3)');
    expect(read1.markdown).toContain('Laptop');
    expect(read1.markdown).toContain('=SUM(D2:D3)');

    // Verify existing FilePreviewModal Excel parser compatibility
    const preview = parseExcelPreview(buf, 'xlsx');
    expect(preview.sheets).toHaveLength(2);
    expect(preview.sheets[0]!.rows[1]![0]).toBe('Laptop');

    const edited = editXlsxDocument(buf, {
      setCells: [{ sheet: 'Budget', cell: 'B2', value: 5 }],
      appendRows: { sheet: 'Budget', rows: [['Keyboard', 5, 100, '=B5*C5']] },
      upsertSheet: { name: 'Summary', headers: ['Metric', 'Value'], rows: [['Items', 3]] },
      deleteSheet: 'Metadata',
    });
    expect(edited.sheetCount).toBe(2);
    const read2 = readSpreadsheetAsMarkdown(edited.buffer, 'xlsx');
    expect(read2.sheets.map((s) => s.name)).toEqual(['Budget', 'Summary']);
    expect(read2.sheets[0]!.rows[1]![1]).toBe('5');
    expect(read2.sheets[0]!.rows[4]![0]).toBe('Keyboard');
    expect(read2.sheets[0]!.formulas.D2).toBe('=B2*C2');
  });

  it('round-trips PowerPoint (.pptx) write, preview, read, and edit including tables & notes', () => {
    const buf = writePptxDocument({
      title: 'Quarterly Deck',
      accentColor: '#2563EB',
      slides: [
        {
          layout: 'title',
          title: 'Q4 Product Roadmap',
          subtitle: 'Atelier Office Suite',
          notes: 'Welcome everyone to Q4 review.',
        },
        {
          layout: 'bullets',
          title: 'Key Priorities',
          bullets: ['Ship Local Office tools', 'Connect Cloud Workspace'],
          notes: 'Emphasize zero-setup UX.',
        },
        {
          layout: 'table',
          title: 'Metrics',
          table: [
            ['Metric', 'Target'],
            ['Latency', '< 50ms'],
          ],
        },
      ],
    });

    const preview = parsePptxPreview(buf);
    expect(preview.slides).toHaveLength(3);
    expect(preview.slides[0]!.title).toBe('Q4 Product Roadmap');
    expect(preview.slides[1]!.bullets).toEqual(['Ship Local Office tools', 'Connect Cloud Workspace']);
    expect(preview.slides[1]!.notes).toBe('Emphasize zero-setup UX.');
    expect(preview.slides[2]!.tables?.[0]).toEqual([
      ['Metric', 'Target'],
      ['Latency', '< 50ms'],
    ]);

    const md = readPptxAsMarkdown(buf);
    expect(md.markdown).toContain('## Slide 1: Q4 Product Roadmap');
    expect(md.markdown).toContain('| Latency | < 50ms |');

    const editedInPlace = editPptxDocument(buf, {
      replacements: [{ find: '< 50ms', replace: '< 20ms' }],
    });
    expect(editedInPlace.replacementsApplied).toBe(1);
    expect(parsePptxPreview(editedInPlace.buffer).slides[2]!.tables?.[0]?.[1]?.[1]).toBe('< 20ms');

    const editedAppended = editPptxDocument(editedInPlace.buffer, {
      appendSlides: [{ layout: 'section', title: 'Thank You', subtitle: 'Q&A' }],
    });
    expect(editedAppended.slidesCount).toBe(4);
    expect(parsePptxPreview(editedAppended.buffer).slides[3]!.title).toBe('Thank You');
  });

  it('round-trips PDF (.pdf) write and text extraction across multiple blocks', () => {
    const { buffer, pageCount } = writePdfDocument({
      title: 'Executive Summary',
      markdown: [
        '## Highlights',
        '',
        'Revenue grew by 35% year-over-year across all regions.',
        '',
        '- APAC expansion launched',
        '- Zero-setup Office engine live',
        '',
        '| Quarter | Revenue |',
        '| --- | --- |',
        '| Q1 | 120K |',
        '| Q2 | 165K |',
      ].join('\n'),
    });

    expect(pageCount).toBe(1);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const extracted = readPdfDocument(buffer);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain('Executive Summary');
    expect(extracted.text).toContain('Revenue grew by 35%');
    expect(extracted.text).toContain('APAC expansion launched');
    expect(extracted.text).toContain('165K');
  });
});

describe('Local Office MCP endpoint, FilePreview, and agent integration', () => {
  it('serves /mcp/office JSON-RPC, persists files, previews .pptx, and rejects path traversal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-office-int-'));
    tempDirs.push(dir);
    const handle = await startAtelierServer({
      configOverrides: {
        port: 0,
        dataDir: path.join(dir, 'data'),
        workspacesDir: path.join(dir, 'ws'),
        dbPath: path.join(dir, 'atelier.db'),
      },
    });
    handles.push(handle);

    const { project, agents } = handle.store.createProject({
      name: 'Office Integration',
      starterAgents: [{ name: 'Analyst', role: 'Business Analyst', allowShell: false }],
    });
    const agent = agents[0]!;
    const agentWs = path.join(dir, 'ws', project.id, 'agents', agent.id);
    fs.mkdirSync(agentWs, { recursive: true });

    // Prompt & tool-budget invariants
    expect(resolveMaxToolCallsPerTurn({ agent, prompt: 'Design review' })).toBe(10);
    expect(resolveMaxToolCallsPerTurn({ agent, prompt: 'Buatkan file Excel budget.xlsx' })).toBe(28);
    expect(buildAgentSystemPrompt(agent, project, [agent], [])).toContain('Local Office Tools (enabled)');

    const token = handle.officeManager.issueTurnToken({
      agentId: agent.id,
      projectId: project.id,
      cwd: agentWs,
      allowShell: false,
    });
    const mcpUrl = `http://127.0.0.1:${handle.port}/mcp/office`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // Unauthenticated call fails with 401
    const unauth = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);

    // tools/list returns all 7 built-in office tools
    const listRes = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual([
      'office_list_files',
      'office_read',
      'office_write_word',
      'office_write_excel',
      'office_write_powerpoint',
      'office_write_pdf',
      'office_edit',
    ]);

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const json = (await res.json()) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      return {
        isError: Boolean(json.result.isError),
        data: JSON.parse(json.result.content[0]!.text) as Record<string, unknown>,
      };
    };

    // Create Word, Excel, PowerPoint, and PDF inside workspace
    const pptWrite = await callTool('office_write_powerpoint', {
      path: 'deliverables/pitch.pptx',
      title: 'Pitch Deck',
      slides: [
        { layout: 'title', title: 'Atelier Pitch', subtitle: 'Local-First Studio' },
        { layout: 'bullets', title: 'Traction', bullets: ['100% Pure TS Office', 'Zero Setup'] },
      ],
    });
    expect(pptWrite.isError).toBe(false);
    expect(pptWrite.data.slideCount).toBe(2);

    const pptRead = await callTool('office_read', { path: 'deliverables/pitch.pptx' });
    expect(pptRead.isError).toBe(false);
    expect(String(pptRead.data.content)).toContain('Atelier Pitch');

    // Verify FilePreview resolves and builds PowerPoint preview data
    const target = resolvePreviewTarget(
      { path: 'deliverables/pitch.pptx', scope: project.id, agentId: agent.id },
      handle.store,
      handle.config,
    );
    expect(target?.kind).toBe('powerpoint');
    const preview = buildFilePreviewData(target!);
    expect(preview.kind).toBe('powerpoint');
    expect(preview.powerpoint?.slides).toHaveLength(2);

    // Path traversal outside workspace is rejected when allowShell=false
    const traversal = await callTool('office_write_word', {
      path: '../../escape.docx',
      markdown: 'nope',
    });
    expect(traversal.isError).toBe(true);
    expect(String(traversal.data.error)).toMatch(/inside workspace/i);

    // <atelier-action> fallback (used by Antigravity CLI) works too
    const actionRes = await applyOfficeAtelierActions(
      'Generated PDF.\n<atelier-action>{"tool":"office_write_pdf","path":"deliverables/summary.pdf","title":"Summary","markdown":"Hello **PDF** world."}</atelier-action>',
      { store: handle.store, config: handle.config },
      { agentId: agent.id, projectId: project.id, cwd: agentWs, allowShell: false },
      { onTool() {} },
    );
    expect(actionRes.cleanText).toBe('Generated PDF.');
    expect(actionRes.results).toHaveLength(1);
    expect(fs.existsSync(path.join(agentWs, 'deliverables', 'summary.pdf'))).toBe(true);

    // office_list_files finds created deliverables
    const listed = await callTool('office_list_files', {});
    const wsFiles = listed.data.workspaceFiles as Array<{ name: string }>;
    expect(wsFiles.some((f) => f.name === 'pitch.pptx')).toBe(true);
    expect(wsFiles.some((f) => f.name === 'summary.pdf')).toBe(true);
  });

  it('persists agent.office config in AtelierStore', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-office-store-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'atelier.db');
    const config = loadConfig({ dataDir: dir, workspacesDir: path.join(dir, 'ws'), dbPath });
    const db = new AtelierDb(dbPath);
    try {
      const store = new AtelierStore(db, config);
      const { agents } = store.createProject({
        name: 'Office Store',
        starterAgents: [{ name: 'DocBot', role: 'Docs', office: { enabled: false } }],
      });
      expect(agents[0]!.office).toEqual({ enabled: false });
      const updated = store.updateAgentConfig(agents[0]!.id, { office: { enabled: true } });
      expect(updated?.office).toEqual({ enabled: true });
    } finally {
      db.close();
    }
  });
});
