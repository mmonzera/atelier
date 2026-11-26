import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FilePreviewData, LibraryImage, MessageAttachment, WorkspaceFileEntry } from '@atelier/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type AtelierServerHandle, startAtelierServer } from '../src/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Builds a minimal valid ZIP archive in memory from filename -> utf8/Buffer entries. */
function buildZipArchive(files: Record<string, string | Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(files);

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const compressed = zlib.deflateRawSync(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt32LE(0, 10); // time/date
    localHeader.writeUInt32LE(0, 14); // crc32 (unused by reader)
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method: deflate
    centralHeader.writeUInt32LE(0, 12); // time/date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // int attrs
    centralHeader.writeUInt32LE(0, 38); // ext attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const handles: AtelierServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-preview-'));
  dirs.push(dir);
  const handle = await startAtelierServer({
    configOverrides: {
      port: 0,
      dataDir: path.join(dir, 'data'),
      workspacesDir: path.join(dir, 'ws'),
      claudeProjectsDir: null,
      codexSessionsDir: null,
    },
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, dir };
}

describe('file previewer & show file path', () => {
  it('previews Markdown, Word (.docx), Excel (.xlsx & .csv), PDF, and Images with full file paths', async () => {
    const { handle, base, dir } = await boot();
    const repoDir = path.join(dir, 'project-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    const { project } = handle.store.createProject({
      name: 'PreviewProj',
      starterAgents: [{ name: 'Builder', role: 'Dev' }],
    });
    handle.store.updateProject(project.id, {
      repo: { fullName: 'org/repo', defaultBranch: 'main', localPath: repoDir },
    });

    // 1. Markdown file
    const mdPath = path.join(repoDir, 'README.md');
    fs.writeFileSync(mdPath, '# Judul Proyek\n\nIni adalah **markdown** preview.');

    // 2. Word (.docx) file
    const docxPath = path.join(repoDir, 'proposal.docx');
    const docxBuf = buildZipArchive({
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p>
              <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
              <w:r><w:t>Ringkasan Proposal</w:t></w:r>
            </w:p>
            <w:p>
              <w:r><w:rPr><w:b/></w:rPr><w:t>Poin penting:</w:t></w:r>
              <w:r><w:t> mendukung preview Word langsung.</w:t></w:r>
            </w:p>
            <w:tbl>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Fitur</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Show Path</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Siap</w:t></w:r></w:p></w:tc>
              </w:tr>
            </w:tbl>
          </w:body>
        </w:document>`,
    });
    fs.writeFileSync(docxPath, docxBuf);

    // 3. Excel (.xlsx) file
    const xlsxPath = path.join(repoDir, 'budget.xlsx');
    const xlsxBuf = buildZipArchive({
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets>
            <sheet name="Q1 Budget" sheetId="1" r:id="rId1"/>
          </sheets>
        </workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships>
          <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        </Relationships>`,
      'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <sst count="3" uniqueCount="3">
          <si><t>Item</t></si>
          <si><t>Biaya</t></si>
          <si><t>Server</t></si>
        </sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet>
          <sheetData>
            <row r="1">
              <c r="A1" t="s"><v>0</v></c>
              <c r="B1" t="s"><v>1</v></c>
            </row>
            <row r="2">
              <c r="A2" t="s"><v>2</v></c>
              <c r="B2"><v>1500</v></c>
            </row>
          </sheetData>
        </worksheet>`,
    });
    fs.writeFileSync(xlsxPath, xlsxBuf);

    // 4. PDF file
    const pdfPath = path.join(repoDir, 'manual.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

    // 5. Generated image artifact
    const genArt = handle.store.createArtifact(
      { projectId: project.id, kind: 'image', label: 'hero-render.png', mime: 'image/png' },
      PNG,
    );

    // Test Markdown preview + file path
    const mdRes = await fetch(`${base}/api/files/preview?path=${encodeURIComponent(mdPath)}`);
    expect(mdRes.status).toBe(200);
    const mdData = ((await mdRes.json()) as { preview: FilePreviewData }).preview;
    expect(mdData.kind).toBe('markdown');
    expect(mdData.filePath).toBe(fs.realpathSync(mdPath));
    expect(mdData.markdown).toContain('# Judul Proyek');

    // Test Word (.docx) preview + file path
    const docxRes = await fetch(`${base}/api/files/preview?path=${encodeURIComponent(docxPath)}`);
    expect(docxRes.status).toBe(200);
    const docxData = ((await docxRes.json()) as { preview: FilePreviewData }).preview;
    expect(docxData.kind).toBe('word');
    expect(docxData.filePath).toBe(fs.realpathSync(docxPath));
    expect(docxData.word?.blocks).toHaveLength(3);
    expect(docxData.word?.blocks[0]).toEqual({
      type: 'heading',
      level: 1,
      runs: [{ text: 'Ringkasan Proposal' }],
    });
    expect(docxData.word?.blocks[2]?.type).toBe('table');

    // Test Excel (.xlsx) preview + file path
    const xlsxRes = await fetch(`${base}/api/files/preview?path=${encodeURIComponent(xlsxPath)}`);
    expect(xlsxRes.status).toBe(200);
    const xlsxData = ((await xlsxRes.json()) as { preview: FilePreviewData }).preview;
    expect(xlsxData.kind).toBe('excel');
    expect(xlsxData.filePath).toBe(fs.realpathSync(xlsxPath));
    expect(xlsxData.excel?.sheets[0]?.name).toBe('Q1 Budget');
    expect(xlsxData.excel?.sheets[0]?.rows).toEqual([
      ['Item', 'Biaya'],
      ['Server', '1500'],
    ]);

    // Test PDF preview + inline raw PDF headers (no sandbox blocking Chromium PDF viewer)
    const pdfRes = await fetch(`${base}/api/files/preview?path=${encodeURIComponent(pdfPath)}`);
    expect(pdfRes.status).toBe(200);
    const pdfData = ((await pdfRes.json()) as { preview: FilePreviewData }).preview;
    expect(pdfData.kind).toBe('pdf');
    expect(pdfData.filePath).toBe(fs.realpathSync(pdfPath));
    const pdfRaw = await fetch(`${base}${pdfData.rawUrl}`);
    expect(pdfRaw.status).toBe(200);
    expect(pdfRaw.headers.get('content-type')).toBe('application/pdf');
    expect(pdfRaw.headers.get('content-disposition')).toMatch(/^inline/);
    expect(pdfRaw.headers.get('content-security-policy')).toBeNull();

    // Test Generated Image artifact preview + file path
    const artRes = await fetch(`${base}/api/files/preview?artifactId=${encodeURIComponent(genArt.id)}`);
    expect(artRes.status).toBe(200);
    const artData = ((await artRes.json()) as { preview: FilePreviewData }).preview;
    expect(artData.kind).toBe('image');
    expect(artData.filePath).toContain(genArt.id);
    expect(fs.existsSync(artData.filePath)).toBe(true);

    // Test workspace files scanner
    const filesRes = await fetch(`${base}/api/projects/${project.id}/files`);
    expect(filesRes.status).toBe(200);
    const { files } = (await filesRes.json()) as { files: WorkspaceFileEntry[] };
    expect(files.map((f) => f.name).sort()).toEqual(['README.md', 'budget.xlsx', 'manual.pdf', 'proposal.docx']);

    // Test Library includes filePath on images and returns workspace/uploaded documents
    const libRes = await fetch(`${base}/api/projects/${project.id}/library`);
    expect(libRes.status).toBe(200);
    const libPayload = (await libRes.json()) as { images: LibraryImage[]; documents: LibraryImage[] };
    expect(libPayload.images[0]?.filePath).toBeTruthy();
    expect(libPayload.documents.map((d) => d.name).sort()).toEqual(['README.md', 'budget.xlsx', 'manual.pdf', 'proposal.docx']);

    // Forbid paths outside workspace
    const outsidePath = path.join(dir, 'outside-secret.md');
    fs.writeFileSync(outsidePath, 'secret');
    const forbidden = await fetch(`${base}/api/files/preview?path=${encodeURIComponent(outsidePath)}`);
    expect(forbidden.status).toBe(404);
  });

  it('previews uploaded chat attachments (.md, .csv) and resolves their disk path', async () => {
    const { base } = await boot();
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(Buffer.from('Nama,Skor\nBudi,95'))]), 'nilai.csv');
    const upRes = await fetch(`${base}/api/attachments`, { method: 'POST', body: form });
    expect(upRes.status).toBe(200);
    const { attachments } = (await upRes.json()) as { attachments: MessageAttachment[] };
    const csvAtt = attachments[0]!;

    const prevRes = await fetch(`${base}/api/files/preview?attachmentId=${csvAtt.id}`);
    expect(prevRes.status).toBe(200);
    const { preview } = (await prevRes.json()) as { preview: FilePreviewData };
    expect(preview.kind).toBe('excel');
    expect(preview.filePath).toContain(csvAtt.id);
    expect(preview.excel?.sheets[0]?.rows).toEqual([
      ['Nama', 'Skor'],
      ['Budi', '95'],
    ]);
  });
});
