import zlib from 'node:zlib';
import type { PptxPreviewSlide, WordPreviewRun } from '@atelier/contracts';
import { parseDelimitedTable, parseDocxPreview } from '../file-preview.js';
import { decodeXmlEntities, escapeXml, readZipEntries, writeZipEntries } from './zip.js';

/* -------------------------------------------------------------------------- */
/* Shared Markdown Block Parser                                               */
/* -------------------------------------------------------------------------- */

export type OfficeMdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list-item'; ordered: boolean; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; rows: string[][] };

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function parseMarkdownBlocks(markdown: string): OfficeMdBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: OfficeMdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fence = /^```([a-zA-Z0-9_-]*)\s*$/.exec(trimmed);
    if (fence) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const rows: string[][] = [parseTableRow(trimmed)];
      i += 2;
      while (i < lines.length && lines[i]!.trim().includes('|') && lines[i]!.trim() !== '') {
        rows.push(parseTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    // List item (unordered or ordered)
    const ulMatch = /^(\s*)([-*+])\s+(.+)$/.exec(line);
    if (ulMatch) {
      const indent = ulMatch[1]!.replace(/\t/g, '  ').length;
      blocks.push({
        type: 'list-item',
        ordered: false,
        level: Math.min(3, Math.floor(indent / 2)),
        text: ulMatch[3]!.trim(),
      });
      i += 1;
      continue;
    }

    const olMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      const indent = olMatch[1]!.replace(/\t/g, '  ').length;
      blocks.push({
        type: 'list-item',
        ordered: true,
        level: Math.min(3, Math.floor(indent / 2)),
        text: olMatch[2]!.trim(),
      });
      i += 1;
      continue;
    }

    // Paragraph (collapse contiguous non-empty, non-block lines)
    const paraLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      const nt = next.trim();
      if (
        !nt ||
        /^#{1,6}\s+/.test(nt) ||
        /^```/.test(nt) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(next) ||
        (nt.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(nt);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

export function parseInlineMarkdown(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const tokenRe =
    /(\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g;
  let lastIndex = 0;

  for (const m of text.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ text: text.slice(lastIndex, idx) });
    }
    if (m[2] !== undefined && m[3] !== undefined) {
      segments.push({ text: m[2], href: m[3] });
    } else if (m[4] !== undefined) {
      segments.push({ text: m[4], code: true });
    } else if (m[5] !== undefined || m[6] !== undefined) {
      segments.push({ text: (m[5] ?? m[6])!, bold: true });
    } else if (m[7] !== undefined) {
      segments.push({ text: m[7], strike: true });
    } else if (m[8] !== undefined || m[9] !== undefined) {
      segments.push({ text: (m[8] ?? m[9])!, italic: true });
    }
    lastIndex = idx + m[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ text }];
}

function stripInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .map((s) => s.text)
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Word (.docx) Read / Write / Edit                                           */
/* -------------------------------------------------------------------------- */

function formatWordRunsToMarkdown(runs: WordPreviewRun[]): string {
  return runs
    .map((r) => {
      let s = r.text;
      if (!s) return '';
      if (r.code) s = `\`${s}\``;
      if (r.bold) s = `**${s}**`;
      if (r.italic) s = `*${s}*`;
      if (r.strike) s = `~~${s}~~`;
      if (r.href) s = `[${s}](${r.href})`;
      return s;
    })
    .join('');
}

export function readDocxAsMarkdown(buffer: Buffer): {
  markdown: string;
  blockCount: number;
  tableCount: number;
} {
  const { blocks } = parseDocxPreview(buffer);
  const lines: string[] = [];
  let tableCount = 0;

  for (const b of blocks) {
    if (b.type === 'heading') {
      const level = Math.min(6, Math.max(1, b.level));
      lines.push(`${'#'.repeat(level)} ${formatWordRunsToMarkdown(b.runs)}`);
      lines.push('');
    } else if (b.type === 'paragraph') {
      lines.push(formatWordRunsToMarkdown(b.runs));
      lines.push('');
    } else if (b.type === 'list-item') {
      const indent = '  '.repeat(Math.max(0, b.level));
      const bullet = b.ordered ? '1.' : '-';
      lines.push(`${indent}${bullet} ${formatWordRunsToMarkdown(b.runs)}`);
    } else if (b.type === 'table') {
      tableCount += 1;
      const rows = b.rows.map((row) =>
        row.map((cell) => formatWordRunsToMarkdown(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()),
      );
      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length), 1);
        const pad = (r: string[]) => Array.from({ length: colCount }, (_, idx) => r[idx] ?? '');
        const head = pad(rows[0]!);
        lines.push(`| ${head.join(' | ')} |`);
        lines.push(`| ${head.map(() => '---').join(' | ')} |`);
        for (const r of rows.slice(1)) {
          lines.push(`| ${pad(r).join(' | ')} |`);
        }
        lines.push('');
      }
    } else if (b.type === 'image') {
      lines.push(`![${b.alt ?? 'embedded image'}](embedded-image)`);
      lines.push('');
    }
  }

  return {
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    blockCount: blocks.length,
    tableCount,
  };
}

const DOCX_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="1F2937"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="140" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="80" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/><w:color w:val="111827"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="200"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="4B5563"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:color w:val="111827"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/><w:color w:val="1F2937"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="180" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="374151"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="140" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="374151"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
</w:styles>`;

const DOCX_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

function renderDocxRunsXml(
  text: string,
  links: Array<{ id: string; url: string }>,
  nextRelNum: () => number,
  opts?: { forceBold?: boolean; forceCode?: boolean },
): string {
  const segs = opts?.forceCode ? [{ text, code: true }] : parseInlineMarkdown(text);
  return segs
    .map((seg) => {
      const rPrParts: string[] = [];
      if (seg.bold || opts?.forceBold) rPrParts.push('<w:b/>');
      if (seg.italic) rPrParts.push('<w:i/>');
      if (seg.strike) rPrParts.push('<w:strike/>');
      if (seg.code) {
        rPrParts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
        rPrParts.push('<w:sz w:val="20"/>');
      }
      if (seg.href) {
        rPrParts.push('<w:color w:val="2563EB"/><w:u w:val="single"/>');
      }
      const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
      const lines = seg.text.split('\n');
      const inner = lines
        .map((part, idx) => {
          const tXml = `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
          return idx === 0 ? tXml : `<w:br/>${tXml}`;
        })
        .join('');
      const runXml = `<w:r>${rPr}${inner}</w:r>`;
      if (seg.href) {
        const rId = `rId${nextRelNum()}`;
        links.push({ id: rId, url: seg.href });
        return `<w:hyperlink r:id="${rId}">${runXml}</w:hyperlink>`;
      }
      return runXml;
    })
    .join('');
}

function renderMarkdownBlocksToDocxBodyXml(
  markdown: string,
  links: Array<{ id: string; url: string }>,
  nextRelNum: () => number,
  extra?: { title?: string; subtitle?: string },
): string {
  const out: string[] = [];
  if (extra?.title?.trim()) {
    out.push(
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${renderDocxRunsXml(extra.title.trim(), links, nextRelNum)}</w:p>`,
    );
  }
  if (extra?.subtitle?.trim()) {
    out.push(
      `<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>${renderDocxRunsXml(extra.subtitle.trim(), links, nextRelNum)}</w:p>`,
    );
  }

  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.type === 'heading') {
      const level = Math.min(6, Math.max(1, block.level));
      out.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${renderDocxRunsXml(block.text, links, nextRelNum)}</w:p>`,
      );
    } else if (block.type === 'paragraph') {
      out.push(`<w:p>${renderDocxRunsXml(block.text, links, nextRelNum)}</w:p>`);
    } else if (block.type === 'list-item') {
      const numId = block.ordered ? 2 : 1;
      const ilvl = Math.min(2, Math.max(0, block.level));
      out.push(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:after="60"/></w:pPr>${renderDocxRunsXml(block.text, links, nextRelNum)}</w:p>`,
      );
    } else if (block.type === 'code') {
      const codeLines = block.text.split('\n');
      for (const cl of codeLines) {
        out.push(
          `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:ind w:left="240" w:right="240"/><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr>${renderDocxRunsXml(cl || ' ', links, nextRelNum, { forceCode: true })}</w:p>`,
        );
      }
    } else if (block.type === 'table') {
      const colCount = Math.max(...block.rows.map((r) => r.length), 1);
      const colW = Math.floor(9000 / colCount);
      const gridCols = Array.from({ length: colCount }, () => `<w:gridCol w:w="${colW}"/>`).join('');
      const rowsXml = block.rows
        .map((row, rowIdx) => {
          const isHeader = rowIdx === 0;
          const cellsXml = Array.from({ length: colCount }, (_, cIdx) => {
            const cellText = row[cIdx] ?? '';
            const shd = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F6"/>' : '';
            return `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}<w:tcMar><w:top w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${renderDocxRunsXml(cellText, links, nextRelNum, { forceBold: isHeader })}</w:p></w:tc>`;
          }).join('');
          return `<w:tr>${cellsXml}</w:tr>`;
        })
        .join('');
      out.push(
        `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`,
      );
    }
  }

  if (out.length === 0) {
    out.push('<w:p><w:r><w:t></w:t></w:r></w:p>');
  }
  return out.join('');
}

export function writeDocxDocument(input: {
  title?: string;
  subtitle?: string;
  markdown: string;
}): Buffer {
  const links: Array<{ id: string; url: string }> = [];
  let relCounter = 3; // rId1 = styles.xml, rId2 = numbering.xml
  const nextRelNum = () => relCounter++;

  const bodyXml = renderMarkdownBlocksToDocxBodyXml(input.markdown, links, nextRelNum, {
    title: input.title,
    subtitle: input.subtitle,
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const relsEntries = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...links.map(
      (l) =>
        `<Relationship Id="${l.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`,
    ),
  ];

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relsEntries.join('\n  ')}
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${escapeXml(input.title?.trim() || 'Document')}</dc:title>
  <dc:creator>Atelier</dc:creator>
</cp:coreProperties>`;

  return writeZipEntries([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'docProps/core.xml', data: coreXml },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: DOCX_STYLES_XML },
    { name: 'word/numbering.xml', data: DOCX_NUMBERING_XML },
    { name: 'word/_rels/document.xml.rels', data: docRelsXml },
  ]);
}

function replaceTextInXmlParagraphs(
  xml: string,
  tagPrefix: 'w' | 'a',
  replacements: Array<{ find: string; replace: string }>,
): { xml: string; count: number } {
  if (replacements.length === 0) return { xml, count: 0 };
  let totalCount = 0;

  // First pass: replace inside individual <w:t> / <a:t> elements
  const tRe = new RegExp(`(<${tagPrefix}:t\\b[^>]*>)([\\s\\S]*?)(<\\/${tagPrefix}:t>)`, 'gi');
  let out = xml.replace(tRe, (full, open: string, inner: string, close: string) => {
    let text = decodeXmlEntities(inner);
    let changed = false;
    for (const r of replacements) {
      if (!r.find) continue;
      if (text.includes(r.find)) {
        const parts = text.split(r.find);
        totalCount += parts.length - 1;
        text = parts.join(r.replace);
        changed = true;
      }
    }
    if (!changed) return full;
    const openWithSpace = open.includes('xml:space')
      ? open
      : open.replace(/>$/, ' xml:space="preserve">');
    return `${openWithSpace}${escapeXml(text)}${close}`;
  });

  // Second pass: handle finds split across multiple <w:r> / <a:r> runs within a paragraph
  for (const r of replacements) {
    if (!r.find) continue;
    const pRe = new RegExp(`<${tagPrefix}:p\\b[^>]*>[\\s\\S]*?<\\/${tagPrefix}:p>`, 'gi');
    out = out.replace(pRe, (pXml) => {
      const texts: string[] = [];
      for (const tm of pXml.matchAll(tRe)) {
        texts.push(decodeXmlEntities(tm[2]!));
      }
      const joined = texts.join('');
      if (!joined.includes(r.find)) return pXml;

      const updated = joined.split(r.find);
      totalCount += updated.length - 1;
      const replacedText = updated.join(r.replace);

      const pPr = new RegExp(`<${tagPrefix}:pPr\\b[^>]*>[\\s\\S]*?<\\/${tagPrefix}:pPr>`, 'i').exec(pXml)?.[0] ?? '';
      const firstRPr = new RegExp(`<${tagPrefix}:rPr\\b[^>]*>[\\s\\S]*?<\\/${tagPrefix}:rPr>`, 'i').exec(pXml)?.[0] ?? '';
      const pOpen = new RegExp(`^<${tagPrefix}:p\\b[^>]*>`, 'i').exec(pXml)?.[0] ?? `<${tagPrefix}:p>`;
      return `${pOpen}${pPr}<${tagPrefix}:r>${firstRPr}<${tagPrefix}:t xml:space="preserve">${escapeXml(replacedText)}</${tagPrefix}:t></${tagPrefix}:r></${tagPrefix}:p>`;
    });
  }

  return { xml: out, count: totalCount };
}

export function editDocxDocument(
  buffer: Buffer,
  ops: {
    replacements?: Array<{ find: string; replace: string }>;
    appendMarkdown?: string;
  },
): { buffer: Buffer; replacementsApplied: number } {
  const entries = readZipEntries(buffer);
  let docXml = entries.get('word/document.xml')?.toString('utf8');
  if (!docXml) {
    throw new Error('Invalid .docx file: word/document.xml not found.');
  }

  let replacementsApplied = 0;
  if (ops.replacements && ops.replacements.length > 0) {
    const res = replaceTextInXmlParagraphs(docXml, 'w', ops.replacements);
    docXml = res.xml;
    replacementsApplied = res.count;
  }

  if (ops.appendMarkdown && ops.appendMarkdown.trim()) {
    const relsPath = 'word/_rels/document.xml.rels';
    let relsXml =
      entries.get(relsPath)?.toString('utf8') ??
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    let maxId = 0;
    for (const m of relsXml.matchAll(/\bId\s*=\s*"rId(\d+)"/gi)) {
      maxId = Math.max(maxId, Number.parseInt(m[1]!, 10));
    }
    let nextId = maxId + 1;
    const links: Array<{ id: string; url: string }> = [];
    const appendXml = renderMarkdownBlocksToDocxBodyXml(ops.appendMarkdown, links, () => nextId++);

    if (/<w:sectPr\b/i.test(docXml)) {
      docXml = docXml.replace(/<w:sectPr\b/i, `${appendXml}<w:sectPr`);
    } else if (/<\/w:body>/i.test(docXml)) {
      docXml = docXml.replace(/<\/w:body>/i, `${appendXml}</w:body>`);
    }

    if (links.length > 0) {
      const newRels = links
        .map(
          (l) =>
            `<Relationship Id="${l.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`,
        )
        .join('');
      relsXml = relsXml.replace(/<\/Relationships>/i, `${newRels}</Relationships>`);
      entries.set(relsPath, Buffer.from(relsXml, 'utf8'));
    }

    if (!entries.has('word/numbering.xml')) {
      entries.set('word/numbering.xml', Buffer.from(DOCX_NUMBERING_XML, 'utf8'));
    }
    if (!entries.has('word/styles.xml')) {
      entries.set('word/styles.xml', Buffer.from(DOCX_STYLES_XML, 'utf8'));
    }
  }

  entries.set('word/document.xml', Buffer.from(docXml, 'utf8'));
  const outEntries = [...entries.entries()].map(([name, data]) => ({ name, data }));
  return { buffer: writeZipEntries(outEntries), replacementsApplied };
}

/* -------------------------------------------------------------------------- */
/* Excel (.xlsx / .csv / .tsv) Read / Write / Edit                            */
/* -------------------------------------------------------------------------- */

export interface ParsedSpreadsheetSheet {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
  formulas: Record<string, string>;
}

function colLettersToIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0]?.toUpperCase() ?? '';
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

export function indexToColLetters(colIndex: number): string {
  let n = colIndex + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseCellCoord(cell: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
  if (!m) {
    throw new Error(`Invalid cell reference "${cell}". Expected A1 notation (e.g. "B4").`);
  }
  const col = colLettersToIndex(m[1]!);
  const row = Number.parseInt(m[2]!, 10) - 1;
  if (row < 0) {
    throw new Error(`Invalid row in cell reference "${cell}".`);
  }
  return { col, row };
}

export function parseXlsxWorkbook(
  buffer: Buffer,
  opts?: { maxRows?: number; maxCols?: number },
): ParsedSpreadsheetSheet[] {
  const maxRows = opts?.maxRows ?? 2000;
  const maxCols = opts?.maxCols ?? 100;
  const zip = readZipEntries(buffer);

  const sharedStrings: string[] = [];
  const sstXml = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sstXml) {
    for (const siMatch of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      let cellText = '';
      for (const tMatch of siMatch[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
        cellText += decodeXmlEntities(tMatch[1]!);
      }
      sharedStrings.push(cellText);
    }
  }

  const workbookXml = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const workbookRelsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map<string, string>();
  for (const rm of workbookRelsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attrs = rm[1] ?? '';
    const id = /\bId\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (id && target) {
      const clean = target.replace(/^\/+/, '');
      relMap.set(id, clean.startsWith('xl/') ? clean : `xl/${clean}`);
    }
  }

  const sheetSpecs: Array<{ name: string; path: string }> = [];
  for (const sm of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/gi)) {
    const attrs = sm[1] ?? '';
    const name = /\bname\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const rId = /\br:id\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const targetPath = rId ? relMap.get(rId) : undefined;
    if (name && targetPath && zip.has(targetPath)) {
      sheetSpecs.push({ name: decodeXmlEntities(name), path: targetPath });
    }
  }

  if (sheetSpecs.length === 0) {
    const fallbackPaths = [...zip.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort();
    fallbackPaths.forEach((p, idx) => sheetSpecs.push({ name: `Sheet${idx + 1}`, path: p }));
  }

  const sheets: ParsedSpreadsheetSheet[] = [];
  for (const spec of sheetSpecs) {
    const xml = zip.get(spec.path)?.toString('utf8');
    if (!xml) continue;
    const rows: string[][] = [];
    const formulas: Record<string, string> = {};
    let totalRows = 0;
    let totalCols = 0;

    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
      const rowAttrs = rowMatch[1] ?? '';
      const explicitRow = /\br\s*=\s*"(\d+)"/i.exec(rowAttrs)?.[1];
      const rowIdx = explicitRow ? Number.parseInt(explicitRow, 10) - 1 : totalRows;
      totalRows = Math.max(totalRows + 1, rowIdx + 1);
      const rowCells: string[] = [];
      let nextCol = 0;

      for (const cMatch of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/gi)) {
        const attrs = cMatch[1] ?? '';
        const inner = cMatch[2] ?? '';
        const ref = /\br\s*=\s*"([A-Za-z]+\d+)"/i.exec(attrs)?.[1];
        const cellType = /\bt\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
        const colIdx = ref ? colLettersToIndex(ref) : nextCol;
        nextCol = colIdx + 1;
        if (nextCol > totalCols) totalCols = nextCol;
        if (rowIdx >= maxRows || colIdx >= maxCols) continue;

        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(inner)?.[1];
        if (formula) {
          const cellRef = ref ?? `${indexToColLetters(colIdx)}${rowIdx + 1}`;
          formulas[cellRef] = `=${decodeXmlEntities(formula)}`;
        }

        let value = '';
        if (cellType === 'inlineStr') {
          for (const tm of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)) {
            value += decodeXmlEntities(tm[1]!);
          }
        } else {
          const rawV = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)?.[1];
          if (rawV !== undefined) {
            if (cellType === 's') {
              const sstIdx = Number.parseInt(rawV, 10);
              value = sharedStrings[sstIdx] ?? rawV;
            } else if (cellType === 'b') {
              value = rawV === '1' ? 'TRUE' : 'FALSE';
            } else {
              value = decodeXmlEntities(rawV);
            }
          } else if (formula) {
            value = `=${decodeXmlEntities(formula)}`;
          }
        }

        while (rowCells.length < colIdx) rowCells.push('');
        rowCells[colIdx] = value;
      }

      if (rowIdx < maxRows) {
        while (rows.length < rowIdx) rows.push([]);
        rows[rowIdx] = rowCells;
      }
    }

    const displayCols = Math.min(totalCols, maxCols);
    for (const r of rows) {
      while (r.length < displayCols) r.push('');
    }
    sheets.push({ name: spec.name, rows, totalRows, totalCols, formulas });
  }

  return sheets;
}

export function readSpreadsheetAsMarkdown(
  buffer: Buffer,
  ext: string,
  opts?: { sheet?: string; maxRows?: number; maxCols?: number },
): { sheets: ParsedSpreadsheetSheet[]; markdown: string } {
  const maxRows = opts?.maxRows ?? 200;
  const maxCols = opts?.maxCols ?? 40;
  let sheets: ParsedSpreadsheetSheet[];

  if (ext === 'csv' || ext === 'tsv') {
    const delimiter = ext === 'tsv' ? '\t' : ',';
    const parsedRows = parseDelimitedTable(buffer.toString('utf8'), delimiter);
    const totalRows = parsedRows.length;
    const totalCols = parsedRows.reduce((m, r) => Math.max(m, r.length), 0);
    const rows = parsedRows.slice(0, maxRows).map((r) => {
      const sliced = r.slice(0, maxCols);
      while (sliced.length < Math.min(totalCols, maxCols)) sliced.push('');
      return sliced;
    });
    sheets = [{ name: ext.toUpperCase(), rows, totalRows, totalCols, formulas: {} }];
  } else {
    sheets = parseXlsxWorkbook(buffer, { maxRows, maxCols });
    if (opts?.sheet) {
      const target = opts.sheet.trim().toLowerCase();
      sheets = sheets.filter((s) => s.name.toLowerCase() === target);
    }
  }

  const mdParts: string[] = [];
  for (const s of sheets) {
    mdParts.push(`### ${s.name} (${s.totalRows} rows x ${s.totalCols} cols)`);
    if (s.rows.length === 0) {
      mdParts.push('_Empty sheet_');
      mdParts.push('');
      continue;
    }
    const cols = Math.max(...s.rows.map((r) => r.length), 1);
    const colLetters = Array.from({ length: cols }, (_, i) => indexToColLetters(i));
    mdParts.push(`| Row | ${colLetters.join(' | ')} |`);
    mdParts.push(`| --- | ${colLetters.map(() => '---').join(' | ')} |`);
    s.rows.forEach((row, rIdx) => {
      const cells = Array.from({ length: cols }, (_, cIdx) =>
        (row[cIdx] ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'),
      );
      mdParts.push(`| ${rIdx + 1} | ${cells.join(' | ')} |`);
    });
    const formulaEntries = Object.entries(s.formulas);
    if (formulaEntries.length > 0) {
      mdParts.push('');
      mdParts.push(
        `Formulas: ${formulaEntries
          .slice(0, 30)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
      );
    }
    mdParts.push('');
  }

  return { sheets, markdown: mdParts.join('\n').trim() };
}

export type SpreadsheetCellInput = string | number | boolean | null | undefined;

export interface ExcelSheetInput {
  name: string;
  headers?: string[];
  rows: SpreadsheetCellInput[][];
}

export function writeDelimitedText(rows: SpreadsheetCellInput[][], delimiter: string): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell === null || cell === undefined ? '' : String(cell);
          if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(delimiter),
    )
    .join('\n');
}

export function writeXlsxDocument(input: { sheets: ExcelSheetInput[] }): Buffer {
  const inputSheets =
    input.sheets.length > 0 ? input.sheets : [{ name: 'Sheet1', rows: [['']] }];

  const sharedStrings: string[] = [];
  const sstIndexMap = new Map<string, number>();
  const internString = (val: string): number => {
    const existing = sstIndexMap.get(val);
    if (existing !== undefined) return existing;
    const idx = sharedStrings.length;
    sharedStrings.push(val);
    sstIndexMap.set(val, idx);
    return idx;
  };

  const usedNames = new Set<string>();
  const normalizedSheets = inputSheets.map((sheet, idx) => {
    let base = sheet.name.replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31) || `Sheet${idx + 1}`;
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      const tag = `_${suffix++}`;
      candidate = `${base.slice(0, 31 - tag.length)}${tag}`;
    }
    usedNames.add(candidate.toLowerCase());
    const combinedRows: SpreadsheetCellInput[][] = [
      ...(sheet.headers && sheet.headers.length > 0 ? [sheet.headers] : []),
      ...sheet.rows,
    ];
    return {
      name: candidate,
      hasHeaderRow: Boolean(sheet.headers && sheet.headers.length > 0),
      rows: combinedRows,
    };
  });

  const worksheetEntries: Array<{ name: string; data: string }> = [];
  const sheetManifests: Array<{ name: string; rId: string; sheetId: number; path: string }> = [];

  normalizedSheets.forEach((sheet, sIdx) => {
    const sheetNum = sIdx + 1;
    const colWidths = new Map<number, number>();
    const rowXmlParts: string[] = [];

    sheet.rows.forEach((row, rIdx) => {
      const rowNum = rIdx + 1;
      const isHeader = sheet.hasHeaderRow && rIdx === 0;
      const cellParts: string[] = [];

      row.forEach((rawVal, cIdx) => {
        if (rawVal === null || rawVal === undefined || rawVal === '') return;
        const ref = `${indexToColLetters(cIdx)}${rowNum}`;
        const strLen = String(rawVal).length;
        colWidths.set(cIdx, Math.max(colWidths.get(cIdx) ?? 10, Math.min(48, strLen + 4)));
        const styleAttr = isHeader ? ' s="1"' : '';

        if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
          cellParts.push(`<c r="${ref}"${styleAttr}><v>${rawVal}</v></c>`);
        } else if (typeof rawVal === 'boolean') {
          cellParts.push(`<c r="${ref}" t="b"${styleAttr}><v>${rawVal ? 1 : 0}</v></c>`);
        } else {
          const text = String(rawVal);
          if (text.startsWith('=') && text.length > 1) {
            cellParts.push(`<c r="${ref}"${styleAttr}><f>${escapeXml(text.slice(1))}</f></c>`);
          } else {
            const sstIdx = internString(text);
            cellParts.push(`<c r="${ref}" t="s"${styleAttr}><v>${sstIdx}</v></c>`);
          }
        }
      });

      if (cellParts.length > 0) {
        rowXmlParts.push(`<row r="${rowNum}">${cellParts.join('')}</row>`);
      }
    });

    const colsXml =
      colWidths.size > 0
        ? `<cols>${[...colWidths.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(
              ([cIdx, w]) =>
                `<col min="${cIdx + 1}" max="${cIdx + 1}" width="${w}" customWidth="1"/>`,
            )
            .join('')}</cols>`
        : '';

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXml}
  <sheetData>${rowXmlParts.join('')}</sheetData>
</worksheet>`;

    const relPath = `worksheets/sheet${sheetNum}.xml`;
    worksheetEntries.push({ name: `xl/${relPath}`, data: sheetXml });
    sheetManifests.push({
      name: sheet.name,
      rId: `rId${sheetNum}`,
      sheetId: sheetNum,
      path: relPath,
    });
  });

  const sstItemsXml = sharedStrings
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join('');
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sstItemsXml}</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F6"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><bottom style="thin"><color rgb="FFD1D5DB"/></bottom></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetManifests
      .map(
        (m) =>
          `<sheet name="${escapeXml(m.name)}" sheetId="${m.sheetId}" r:id="${m.rId}"/>`,
      )
      .join('\n    ')}
  </sheets>
</workbook>`;

  const stylesRelId = `rId${sheetManifests.length + 1}`;
  const sstRelId = `rId${sheetManifests.length + 2}`;
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetManifests
    .map(
      (m) =>
        `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${m.path}"/>`,
    )
    .join('\n  ')}
  <Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="${sstRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${sheetManifests
    .map(
      (m) =>
        `<Override PartName="/xl/${m.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('\n  ')}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return writeZipEntries([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml },
    ...worksheetEntries,
  ]);
}

function coerceSpreadsheetValue(raw: string, formula?: string): SpreadsheetCellInput {
  if (formula) return formula.startsWith('=') ? formula : `=${formula}`;
  if (raw === '') return '';
  if (raw === 'TRUE') return true;
  if (raw === 'FALSE') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export function editXlsxDocument(
  buffer: Buffer,
  ops: {
    setCells?: Array<{ sheet?: string; cell: string; value: SpreadsheetCellInput }>;
    appendRows?: { sheet?: string; rows: SpreadsheetCellInput[][] };
    upsertSheet?: ExcelSheetInput;
    deleteSheet?: string;
  },
): { buffer: Buffer; sheetCount: number } {
  const parsed = parseXlsxWorkbook(buffer, { maxRows: 10_000, maxCols: 200 });
  const sheets: Array<{ name: string; rows: SpreadsheetCellInput[][] }> = parsed.map((s) => ({
    name: s.name,
    rows: s.rows.map((r, rIdx) =>
      r.map((val, cIdx) => {
        const ref = `${indexToColLetters(cIdx)}${rIdx + 1}`;
        return coerceSpreadsheetValue(val, s.formulas[ref]);
      }),
    ),
  }));

  const findSheet = (name?: string) => {
    if (!name) return sheets[0];
    const target = name.trim().toLowerCase();
    return sheets.find((s) => s.name.toLowerCase() === target);
  };

  if (ops.deleteSheet) {
    const target = ops.deleteSheet.trim().toLowerCase();
    const idx = sheets.findIndex((s) => s.name.toLowerCase() === target);
    if (idx >= 0) sheets.splice(idx, 1);
  }

  if (ops.upsertSheet) {
    const existing = findSheet(ops.upsertSheet.name);
    const nextRows: SpreadsheetCellInput[][] = [
      ...(ops.upsertSheet.headers && ops.upsertSheet.headers.length > 0
        ? [ops.upsertSheet.headers]
        : []),
      ...ops.upsertSheet.rows,
    ];
    if (existing) {
      existing.rows = nextRows;
    } else {
      sheets.push({ name: ops.upsertSheet.name, rows: nextRows });
    }
  }

  if (ops.appendRows && ops.appendRows.rows.length > 0) {
    let target = findSheet(ops.appendRows.sheet);
    if (!target) {
      target = { name: ops.appendRows.sheet || 'Sheet1', rows: [] };
      sheets.push(target);
    }
    target.rows.push(...ops.appendRows.rows);
  }

  if (ops.setCells) {
    for (const item of ops.setCells) {
      let sheetName = item.sheet;
      let cellRef = item.cell;
      if (!sheetName && cellRef.includes('!')) {
        const bang = cellRef.indexOf('!');
        sheetName = cellRef.slice(0, bang).replace(/^'|'$/g, '');
        cellRef = cellRef.slice(bang + 1);
      }
      let target = findSheet(sheetName);
      if (!target) {
        target = { name: sheetName || 'Sheet1', rows: [] };
        sheets.push(target);
      }
      const { col, row } = parseCellCoord(cellRef);
      while (target.rows.length <= row) target.rows.push([]);
      while (target.rows[row]!.length <= col) target.rows[row]!.push('');
      target.rows[row]![col] = item.value;
    }
  }

  const out = writeXlsxDocument({
    sheets: sheets.map((s) => ({ name: s.name, rows: s.rows })),
  });
  return { buffer: out, sheetCount: Math.max(1, sheets.length) };
}

/* -------------------------------------------------------------------------- */
/* PowerPoint (.pptx) Read / Write / Edit                                     */
/* -------------------------------------------------------------------------- */

function extractPptParagraphs(xmlChunk: string): string[] {
  const paras: string[] = [];
  for (const pm of xmlChunk.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)) {
    let text = '';
    for (const tm of pm[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)) {
      text += decodeXmlEntities(tm[1]!);
    }
    const cleaned = text.trim();
    if (cleaned) paras.push(cleaned);
  }
  return paras;
}

export function parsePptxPreview(buffer: Buffer): { slides: PptxPreviewSlide[] } {
  const zip = readZipEntries(buffer);
  const presXml = zip.get('ppt/presentation.xml')?.toString('utf8') ?? '';
  const presRelsXml = zip.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? '';

  const relMap = new Map<string, string>();
  for (const rm of presRelsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
    const attrs = rm[1] ?? '';
    const id = /\bId\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (id && target) {
      const clean = target.replace(/^\/+/, '');
      relMap.set(id, clean.startsWith('ppt/') ? clean : `ppt/${clean}`);
    }
  }

  const slidePaths: string[] = [];
  for (const sm of presXml.matchAll(/<p:sldId\b([^>]*?)\/?>/gi)) {
    const rId = /\br:id\s*=\s*"([^"]+)"/i.exec(sm[1] ?? '')?.[1];
    const targetPath = rId ? relMap.get(rId) : undefined;
    if (targetPath && zip.has(targetPath)) {
      slidePaths.push(targetPath);
    }
  }

  if (slidePaths.length === 0) {
    const fallback = [...zip.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number.parseInt(/slide(\d+)\.xml/i.exec(a)?.[1] ?? '0', 10);
        const nb = Number.parseInt(/slide(\d+)\.xml/i.exec(b)?.[1] ?? '0', 10);
        return na - nb;
      });
    slidePaths.push(...fallback);
  }

  const slides: PptxPreviewSlide[] = [];
  slidePaths.forEach((slidePath, idx) => {
    const slideXml = zip.get(slidePath)?.toString('utf8');
    if (!slideXml) return;

    let title = '';
    const bullets: string[] = [];
    const tables: string[][][] = [];

    // Extract tables first
    for (const tblMatch of slideXml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/gi)) {
      const rows: string[][] = [];
      for (const trMatch of tblMatch[1]!.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gi)) {
        const cells: string[] = [];
        for (const tcMatch of trMatch[1]!.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gi)) {
          cells.push(extractPptParagraphs(tcMatch[1]!).join(' '));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) tables.push(rows);
    }

    // Extract text shapes
    for (const spMatch of slideXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi)) {
      const spXml = spMatch[1]!;
      const phType = /<p:ph\b[^>]*\btype\s*=\s*"([^"]+)"/i.exec(spXml)?.[1]?.toLowerCase() ?? '';
      const shapeName = /<p:cNvPr\b[^>]*\bname\s*=\s*"([^"]+)"/i.exec(spXml)?.[1]?.toLowerCase() ?? '';
      if (phType === 'sldnum' || shapeName === 'slidenumber') continue;
      const paras = extractPptParagraphs(spXml);
      if (paras.length === 0) continue;

      if (!title && (phType === 'title' || phType === 'ctrtitle')) {
        title = paras[0]!;
        bullets.push(...paras.slice(1));
      } else {
        bullets.push(...paras);
      }
    }

    if (!title && bullets.length > 0) {
      title = bullets.shift()!;
    }

    // Speaker notes via slide rels
    let notes: string | undefined;
    const baseName = slidePath.split('/').pop()!;
    const slideRelsPath = `ppt/slides/_rels/${baseName}.rels`;
    const slideRelsXml = zip.get(slideRelsPath)?.toString('utf8') ?? '';
    for (const rm of slideRelsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)) {
      const attrs = rm[1] ?? '';
      const typeAttr = /\bType\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
      const target = /\bTarget\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? '';
      if (/notesSlide/i.test(typeAttr) && target) {
        const clean = target.replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
        const notesKey = clean.startsWith('ppt/') ? clean : `ppt/${clean}`;
        const notesXml = zip.get(notesKey)?.toString('utf8');
        if (notesXml) {
          const noteParas = extractPptParagraphs(notesXml).filter((p) => !/^\d+$/.test(p));
          if (noteParas.length > 0) notes = noteParas.join('\n');
        }
        break;
      }
    }

    slides.push({
      slideNumber: idx + 1,
      title: title || `Slide ${idx + 1}`,
      bullets,
      ...(tables.length > 0 ? { tables } : {}),
      ...(notes ? { notes } : {}),
    });
  });

  return { slides };
}

export function readPptxAsMarkdown(buffer: Buffer): {
  slides: PptxPreviewSlide[];
  markdown: string;
} {
  const { slides } = parsePptxPreview(buffer);
  const lines: string[] = [];
  for (const s of slides) {
    lines.push(`## Slide ${s.slideNumber}: ${s.title}`);
    for (const b of s.bullets) {
      lines.push(`- ${b}`);
    }
    if (s.tables) {
      for (const tbl of s.tables) {
        if (tbl.length === 0) continue;
        lines.push('');
        const cols = Math.max(...tbl.map((r) => r.length), 1);
        const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|'));
        lines.push(`| ${pad(tbl[0]!).join(' | ')} |`);
        lines.push(`| ${pad(tbl[0]!).map(() => '---').join(' | ')} |`);
        for (const r of tbl.slice(1)) {
          lines.push(`| ${pad(r).join(' | ')} |`);
        }
      }
    }
    if (s.notes) {
      lines.push('');
      lines.push(`> Speaker notes: ${s.notes.replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  }
  return { slides, markdown: lines.join('\n').trim() };
}

export interface PptxSlideInput {
  layout?: 'title' | 'section' | 'bullets' | 'two-column' | 'table';
  title: string;
  subtitle?: string;
  bullets?: string[];
  leftColumn?: string[];
  rightColumn?: string[];
  table?: string[][];
  notes?: string;
}

const PPTX_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Atelier">
  <a:themeElements>
    <a:clrScheme name="Atelier">
      <a:dk1><a:sysClr val="windowText" lastClr="111827"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2>
      <a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="3B82F6"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
      <a:accent6><a:srgbClr val="EC4899"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Atelier">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Atelier">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;

const PPTX_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

const PPTX_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

function makeTextBoxXml(opts: {
  id: number;
  name: string;
  phType?: 'title' | 'ctrTitle' | 'subTitle' | 'body' | 'sldNum';
  x: number;
  y: number;
  w: number;
  h: number;
  paragraphs: Array<{
    text: string;
    fontSizePt?: number;
    bold?: boolean;
    color?: string;
    align?: 'l' | 'ctr' | 'r';
    bullet?: boolean;
    spaceAfterPt?: number;
  }>;
}): string {
  const phXml = opts.phType ? `<p:nvPr><p:ph type="${opts.phType}"/></p:nvPr>` : '<p:nvPr/>';
  const pXml = opts.paragraphs
    .map((p) => {
      const sz = Math.round((p.fontSizePt ?? 18) * 100);
      const col = (p.color ?? '1F2937').replace(/^#/, '');
      const algn = p.align ?? 'l';
      const bu = p.bullet ? '<a:buChar char="•"/>' : '<a:buNone/>';
      const mar = p.bullet ? ' marL="274320" indent="-274320"' : '';
      const spcAft =
        p.spaceAfterPt !== undefined
          ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfterPt * 100)}"/></a:spcAft>`
          : '<a:spcAft><a:spcPts val="800"/></a:spcAft>';
      return `<a:p><a:pPr algn="${algn}"${mar}>${spcAft}${bu}</a:pPr><a:r><a:rPr lang="en-US" sz="${sz}"${p.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${escapeXml(p.text)}</a:t></a:r></a:p>`;
    })
    .join('');

  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${opts.id}" name="${escapeXml(opts.name)}"/><p:cNvSpPr txBox="1"/>${phXml}</p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.w}" cy="${opts.h}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:noFill/>
    </p:spPr>
    <p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${pXml}</p:txBody>
  </p:sp>`;
}

function makeAccentRectXml(id: number, x: number, y: number, w: number, h: number, hexColor: string): string {
  const col = hexColor.replace(/^#/, '');
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="AccentBar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="${col}"/></a:solidFill>
      <a:ln><a:noFill/></a:ln>
    </p:spPr>
  </p:sp>`;
}

function makePptxTableXml(opts: {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: string[][];
  accentColor: string;
}): string {
  const colCount = Math.max(...opts.rows.map((r) => r.length), 1);
  const colW = Math.floor(opts.w / colCount);
  const rowH = Math.max(360000, Math.floor(opts.h / Math.max(opts.rows.length, 1)));
  const gridCols = Array.from({ length: colCount }, () => `<a:gridCol w="${colW}"/>`).join('');
  const accent = opts.accentColor.replace(/^#/, '');

  const trXml = opts.rows
    .map((row, rIdx) => {
      const isHeader = rIdx === 0;
      const fill = isHeader ? accent : rIdx % 2 === 1 ? 'F9FAFB' : 'FFFFFF';
      const txtCol = isHeader ? 'FFFFFF' : '1F2937';
      const tcXml = Array.from({ length: colCount }, (_, cIdx) => {
        const val = row[cIdx] ?? '';
        return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"${isHeader ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${txtCol}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${escapeXml(val)}</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
      }).join('');
      return `<a:tr h="${rowH}">${tcXml}</a:tr>`;
    })
    .join('');

  return `<p:graphicFrame>
    <p:nvGraphicFramePr><p:cNvPr id="${opts.id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
    <p:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.w}" cy="${opts.h}"/></p:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridCols}</a:tblGrid>${trXml}</a:tbl></a:graphicData></a:graphic>
  </p:graphicFrame>`;
}

export function writePptxDocument(input: {
  title?: string;
  accentColor?: string;
  slides: PptxSlideInput[];
}): Buffer {
  const accent = (input.accentColor?.trim() || '2563EB').replace(/^#/, '');
  const slides: PptxSlideInput[] =
    input.slides.length > 0 ? input.slides : [{ layout: 'title', title: input.title || 'Presentation' }];

  const files: Array<{ name: string; data: string }> = [];
  const slideRels: Array<{ rId: string; id: number; path: string }> = [];
  const contentOverrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
  ];

  let notesCounter = 0;

  slides.forEach((slide, idx) => {
    const slideNum = idx + 1;
    const layout =
      slide.layout ??
      (slide.table && slide.table.length > 0
        ? 'table'
        : slide.leftColumn || slide.rightColumn
          ? 'two-column'
          : idx === 0 && !slide.bullets?.length
            ? 'title'
            : 'bullets');

    const shapes: string[] = [];
    let shapeId = 2;

    if (layout === 'title' || layout === 'section') {
      const bgHex = layout === 'section' ? accent : '0F172A';
      shapes.push(makeAccentRectXml(shapeId++, 0, 0, 12192000, 6858000, bgHex));
      shapes.push(makeAccentRectXml(shapeId++, 914400, 2100000, 1200000, 75000, layout === 'section' ? 'FFFFFF' : accent));
      shapes.push(
        makeTextBoxXml({
          id: shapeId++,
          name: 'Title',
          phType: 'ctrTitle',
          x: 914400,
          y: 2350000,
          w: 10363200,
          h: 1300000,
          paragraphs: [{ text: slide.title, fontSizePt: 40, bold: true, color: 'FFFFFF' }],
        }),
      );
      const sub = slide.subtitle ?? slide.bullets?.join(' · ');
      if (sub) {
        shapes.push(
          makeTextBoxXml({
            id: shapeId++,
            name: 'Subtitle',
            phType: 'subTitle',
            x: 914400,
            y: 3750000,
            w: 10363200,
            h: 900000,
            paragraphs: [{ text: sub, fontSizePt: 20, color: 'CBD5E1' }],
          }),
        );
      }
    } else {
      shapes.push(makeAccentRectXml(shapeId++, 0, 0, 12192000, 110000, accent));
      shapes.push(
        makeTextBoxXml({
          id: shapeId++,
          name: 'Title',
          phType: 'title',
          x: 731520,
          y: 420000,
          w: 10728960,
          h: 850000,
          paragraphs: [{ text: slide.title, fontSizePt: 28, bold: true, color: '0F172A' }],
        }),
      );

      if (layout === 'two-column') {
        const left = (slide.leftColumn ?? []).map((t) => ({
          text: t,
          fontSizePt: 18,
          bullet: true,
          color: '334155',
        }));
        const right = (slide.rightColumn ?? []).map((t) => ({
          text: t,
          fontSizePt: 18,
          bullet: true,
          color: '334155',
        }));
        if (left.length > 0) {
          shapes.push(
            makeTextBoxXml({
              id: shapeId++,
              name: 'LeftColumn',
              phType: 'body',
              x: 731520,
              y: 1450000,
              w: 5150000,
              h: 4600000,
              paragraphs: left,
            }),
          );
        }
        if (right.length > 0) {
          shapes.push(
            makeTextBoxXml({
              id: shapeId++,
              name: 'RightColumn',
              phType: 'body',
              x: 6310000,
              y: 1450000,
              w: 5150000,
              h: 4600000,
              paragraphs: right,
            }),
          );
        }
      } else if (layout === 'table' && slide.table && slide.table.length > 0) {
        shapes.push(
          makePptxTableXml({
            id: shapeId++,
            x: 731520,
            y: 1450000,
            w: 10728960,
            h: Math.min(4600000, Math.max(1200000, slide.table.length * 520000)),
            rows: slide.table,
            accentColor: accent,
          }),
        );
      } else {
        const items = slide.bullets ?? (slide.subtitle ? [slide.subtitle] : []);
        if (items.length > 0) {
          shapes.push(
            makeTextBoxXml({
              id: shapeId++,
              name: 'Body',
              phType: 'body',
              x: 731520,
              y: 1450000,
              w: 10728960,
              h: 4650000,
              paragraphs: items.map((t) => ({
                text: t,
                fontSizePt: 20,
                bullet: items.length > 1,
                color: '334155',
                spaceAfterPt: 12,
              })),
            }),
          );
        }
      }

      // Slide footer number
      shapes.push(
        makeTextBoxXml({
          id: shapeId++,
          name: 'SlideNumber',
          phType: 'sldNum',
          x: 10800000,
          y: 6350000,
          w: 700000,
          h: 350000,
          paragraphs: [{ text: String(slideNum), fontSizePt: 11, color: '94A3B8', align: 'r' }],
        }),
      );
    }

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes.join('\n      ')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

    files.push({ name: `ppt/slides/slide${slideNum}.xml`, data: slideXml });
    contentOverrides.push(
      `<Override PartName="/ppt/slides/slide${slideNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );

    const slideRelItems = [
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
    ];

    if (slide.notes?.trim()) {
      notesCounter += 1;
      const notesNum = notesCounter;
      const notesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${makeTextBoxXml({
        id: 2,
        name: 'Notes',
        phType: 'body',
        x: 685800,
        y: 4343400,
        w: 5486400,
        h: 4114800,
        paragraphs: slide.notes
          .trim()
          .split(/\r?\n/)
          .map((line) => ({ text: line, fontSizePt: 12, color: '1F2937' })),
      })}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:notes>`;

      files.push({ name: `ppt/notesSlides/notesSlide${notesNum}.xml`, data: notesXml });
      files.push({
        name: `ppt/notesSlides/_rels/notesSlide${notesNum}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNum}.xml"/>
</Relationships>`,
      });
      contentOverrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${notesNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      );
      slideRelItems.push(
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNum}.xml"/>`,
      );
    }

    files.push({
      name: `ppt/slides/_rels/slide${slideNum}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRelItems.join('\n  ')}
</Relationships>`,
    });

    slideRels.push({
      rId: `rId${slideNum}`,
      id: 255 + slideNum,
      path: `slides/slide${slideNum}.xml`,
    });
  });

  const masterRelId = `rId${slideRels.length + 1}`;
  const themeRelId = `rId${slideRels.length + 2}`;

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="${masterRelId}"/></p:sldMasterIdLst>
  <p:sldIdLst>
    ${slideRels.map((s) => `<p:sldId id="${s.id}" r:id="${s.rId}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

  const presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRels
    .map(
      (s) =>
        `<Relationship Id="${s.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${s.path}"/>`,
    )
    .join('\n  ')}
  <Relationship Id="${masterRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="${themeRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;

  files.push(
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${contentOverrides.join('\n  ')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${escapeXml(input.title?.trim() || 'Presentation')}</dc:title>
  <dc:creator>Atelier</dc:creator>
</cp:coreProperties>`,
    },
    { name: 'ppt/presentation.xml', data: presentationXml },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRelsXml },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: PPTX_MASTER_XML },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: PPTX_LAYOUT_XML },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    },
    { name: 'ppt/theme/theme1.xml', data: PPTX_THEME_XML },
  );

  return writeZipEntries(files);
}

export function editPptxDocument(
  buffer: Buffer,
  ops: {
    replacements?: Array<{ find: string; replace: string }>;
    appendSlides?: PptxSlideInput[];
  },
): { buffer: Buffer; slidesCount: number; replacementsApplied: number } {
  const entries = readZipEntries(buffer);
  const replacements = ops.replacements ?? [];
  let replacementsApplied = 0;

  if (!ops.appendSlides || ops.appendSlides.length === 0) {
    for (const [key, data] of entries) {
      if (/^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/i.test(key)) {
        const res = replaceTextInXmlParagraphs(data.toString('utf8'), 'a', replacements);
        if (res.count > 0) {
          entries.set(key, Buffer.from(res.xml, 'utf8'));
          replacementsApplied += res.count;
        }
      }
    }
    const slidesCount = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k)).length;
    return {
      buffer: writeZipEntries([...entries.entries()].map(([name, data]) => ({ name, data }))),
      slidesCount,
      replacementsApplied,
    };
  }

  const applyReplace = (text: string): string => {
    let out = text;
    for (const r of replacements) {
      if (r.find && out.includes(r.find)) {
        const parts = out.split(r.find);
        replacementsApplied += parts.length - 1;
        out = parts.join(r.replace);
      }
    }
    return out;
  };

  const existing = parsePptxPreview(buffer).slides;
  const mergedSlides: PptxSlideInput[] = [
    ...existing.map((s) => ({
      layout: s.tables && s.tables.length > 0 ? ('table' as const) : ('bullets' as const),
      title: applyReplace(s.title),
      bullets: s.bullets.map(applyReplace),
      ...(s.tables?.[0] ? { table: s.tables[0].map((r) => r.map(applyReplace)) } : {}),
      ...(s.notes ? { notes: applyReplace(s.notes) } : {}),
    })),
    ...ops.appendSlides,
  ];

  return {
    buffer: writePptxDocument({ slides: mergedSlides }),
    slidesCount: mergedSlides.length,
    replacementsApplied,
  };
}

/* -------------------------------------------------------------------------- */
/* PDF (.pdf) Read & Write                                                    */
/* -------------------------------------------------------------------------- */

function parseToUnicodeCMap(cmapText: string): Map<number, string> {
  const map = new Map<number, string>();
  const decodeHex = (hex: string): string => {
    const clean = hex.trim();
    let out = '';
    for (let i = 0; i + 3 < clean.length; i += 4) {
      out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 4), 16));
    }
    if (out === '' && clean.length === 2) {
      out = String.fromCharCode(Number.parseInt(clean, 16));
    }
    return out;
  };

  for (const bm of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of bm[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const code = Number.parseInt(pair[1]!, 16);
      map.set(code, decodeHex(pair[2]!));
    }
  }

  for (const rm of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of rm[1]!.split(/\r?\n/)) {
      const m = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(line);
      if (!m) continue;
      const start = Number.parseInt(m[1]!, 16);
      const end = Number.parseInt(m[2]!, 16);
      let dst = Number.parseInt(m[3]!, 16);
      for (let c = start; c <= end && c - start < 512; c += 1) {
        map.set(c, String.fromCodePoint(dst++));
      }
    }
  }
  return map;
}

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (next === '\r' || next === '\n') {
      if (next === '\r' && raw[i + 1] === '\n') i += 1;
    } else if (/[0-7]/.test(next)) {
      let oct = next;
      for (let k = 0; k < 2 && i + 1 < raw.length && /[0-7]/.test(raw[i + 1]!); k += 1) {
        oct += raw[++i]!;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexString(hexRaw: string, cmap?: Map<number, string>): string {
  const hex = hexRaw.replace(/\s+/g, '');
  if (!hex) return '';
  if (hex.startsWith('FEFF') && hex.length >= 8) {
    let out = '';
    for (let i = 4; i + 3 < hex.length; i += 4) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  }
  let out = '';
  const step = cmap && hex.length >= 4 ? 4 : 2;
  for (let i = 0; i + step <= hex.length; i += step) {
    const code = Number.parseInt(hex.slice(i, i + step), 16);
    if (cmap?.has(code)) {
      out += cmap.get(code)!;
    } else if (step === 4 && cmap && cmap.has(code >> 8)) {
      out += (cmap.get(code >> 8) ?? '') + (cmap.get(code & 0xff) ?? '');
    } else if (code >= 32 && code <= 126) {
      out += String.fromCharCode(code);
    } else if (code > 126 && code < 256) {
      out += Buffer.from([code]).toString('latin1');
    }
  }
  return out;
}

function extractTextFromPdfContentStream(content: string, cmap?: Map<number, string>): string {
  const chunks: string[] = [];
  for (const btMatch of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    const block = btMatch[1]!;
    const lines: string[] = [];
    let currentLine = '';

    // Tokenize literal strings (...), hex strings <...>, arrays [...], and text/move operators
    const opRe =
      /\[([^\]]*)\]\s*TJ|(\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>)\s*(Tj|'|")|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(Td|TD)|\b(T\*)\b/g;

    for (const m of block.matchAll(opRe)) {
      if (m[1] !== undefined) {
        for (const item of m[1].matchAll(/\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|-?\d+(?:\.\d+)?/g)) {
          const tok = item[0]!;
          if (tok.startsWith('(')) {
            currentLine += decodePdfLiteralString(tok.slice(1, -1));
          } else if (tok.startsWith('<')) {
            currentLine += decodePdfHexString(tok.slice(1, -1), cmap);
          } else {
            const kerning = Number(tok);
            if (Number.isFinite(kerning) && kerning < -180 && !currentLine.endsWith(' ')) {
              currentLine += ' ';
            }
          }
        }
      } else if (m[2] !== undefined) {
        if (m[3] === "'" || m[3] === '"') {
          if (currentLine.trim()) lines.push(currentLine.trimEnd());
          currentLine = '';
        }
        const raw = m[2];
        if (raw.startsWith('(')) {
          currentLine += decodePdfLiteralString(raw.slice(1, -1));
        } else if (raw.startsWith('<')) {
          currentLine += decodePdfHexString(raw.slice(1, -1), cmap);
        }
      } else if (m[6] === 'Td' || m[6] === 'TD') {
        const ty = Number(m[5]);
        if (Number.isFinite(ty) && Math.abs(ty) > 2 && currentLine.trim()) {
          lines.push(currentLine.trimEnd());
          currentLine = '';
        } else if (currentLine && !currentLine.endsWith(' ')) {
          currentLine += ' ';
        }
      } else if (m[7] === 'T*') {
        if (currentLine.trim()) lines.push(currentLine.trimEnd());
        currentLine = '';
      }
    }

    if (currentLine.trim()) lines.push(currentLine.trimEnd());
    if (lines.length > 0) chunks.push(lines.join('\n'));
  }
  return chunks.join('\n');
}

export function readPdfDocument(
  buffer: Buffer,
  maxChars = 40_000,
): { pageCount: number; text: string; truncated: boolean; warning?: string } {
  const latin = buffer.toString('latin1');
  if (!latin.startsWith('%PDF-')) {
    throw new Error('Invalid PDF file: missing %PDF- header.');
  }

  const pageMatches = latin.match(/\/Type\s*\/Page\b(?!s)/g);
  const pageCount = pageMatches ? pageMatches.length : 1;

  const decompressedStreams: string[] = [];
  const mergedCMap = new Map<number, string>();

  let searchPos = 0;
  while (searchPos < latin.length) {
    const streamIdx = latin.indexOf('stream', searchPos);
    if (streamIdx < 0) break;
    const dictStart = Math.max(0, latin.lastIndexOf('<<', streamIdx));
    const dictStr = latin.slice(dictStart, streamIdx);

    let dataStart = streamIdx + 6;
    if (latin[dataStart] === '\r' && latin[dataStart + 1] === '\n') dataStart += 2;
    else if (latin[dataStart] === '\n' || latin[dataStart] === '\r') dataStart += 1;

    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    searchPos = endIdx + 9;

    const rawBytes = buffer.subarray(dataStart, endIdx);
    const isFlate = /\/FlateDecode\b/.test(dictStr);
    let textStream = '';
    if (isFlate) {
      try {
        textStream = zlib.inflateSync(rawBytes).toString('latin1');
      } catch {
        try {
          textStream = zlib.inflateRawSync(rawBytes).toString('latin1');
        } catch {
          continue;
        }
      }
    } else if (!/\/Image\b|\/DCTDecode\b|\/JPXDecode\b/.test(dictStr)) {
      textStream = rawBytes.toString('latin1');
    }

    if (!textStream) continue;
    if (textStream.includes('beginbfchar') || textStream.includes('beginbfrange')) {
      for (const [k, v] of parseToUnicodeCMap(textStream)) {
        mergedCMap.set(k, v);
      }
    }
    if (/\bBT\b/.test(textStream) && /\bET\b/.test(textStream)) {
      decompressedStreams.push(textStream);
    }
  }

  const cmap = mergedCMap.size > 0 ? mergedCMap : undefined;
  const extracted = decompressedStreams
    .map((s) => extractTextFromPdfContentStream(s, cmap))
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = extracted.length > maxChars;
  const text = truncated ? `${extracted.slice(0, maxChars)}\n... [truncated]` : extracted;

  return {
    pageCount,
    text,
    truncated,
    ...(extracted.length === 0
      ? {
          warning:
            'No extractable text streams found. This PDF may contain scanned images or custom font encodings.',
        }
      : {}),
  };
}

function toPdfAsciiSafe(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/\u2013/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function escapePdfString(raw: string): string {
  return toPdfAsciiSafe(raw)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapTextToWidth(text: string, maxWidthPt: number, fontSize: number, mono = false): string[] {
  const avgChar = fontSize * (mono ? 0.6 : 0.52);
  const maxChars = Math.max(12, Math.floor(maxWidthPt / avgChar));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      if (word.length <= maxChars) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += maxChars) {
          lines.push(word.slice(i, i + maxChars));
        }
      }
      continue;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      if (word.length <= maxChars) {
        current = word;
      } else {
        current = '';
        for (let i = 0; i < word.length; i += maxChars) {
          const slice = word.slice(i, i + maxChars);
          if (i + maxChars >= word.length) current = slice;
          else lines.push(slice);
        }
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function writePdfDocument(input: {
  title?: string;
  markdown: string;
  pageSize?: 'A4' | 'LETTER';
}): { buffer: Buffer; pageCount: number } {
  const pageWidth = input.pageSize === 'LETTER' ? 612 : 595;
  const pageHeight = input.pageSize === 'LETTER' ? 792 : 842;
  const margin = 52;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = margin + 20;

  const pageOps: string[][] = [[]];
  let y = pageHeight - margin;

  const pushOp = (op: string) => {
    pageOps[pageOps.length - 1]!.push(op);
  };
  const nextPage = () => {
    pageOps.push([]);
    y = pageHeight - margin;
  };
  const ensureSpace = (neededPt: number) => {
    if (y - neededPt < bottomLimit) nextPage();
  };
  const drawTextLine = (
    text: string,
    x: number,
    yPos: number,
    font: 'F1' | 'F2' | 'F3' | 'F4',
    size: number,
    rgb = '0.12 0.16 0.22',
  ) => {
    pushOp(
      `BT /${font} ${size} Tf ${rgb} rg 1 0 0 1 ${x.toFixed(1)} ${yPos.toFixed(1)} Tm (${escapePdfString(text)}) Tj ET`,
    );
  };

  if (input.title?.trim()) {
    const titleLines = wrapTextToWidth(input.title.trim(), contentWidth, 20);
    for (const tl of titleLines) {
      ensureSpace(26);
      drawTextLine(tl, margin, y - 16, 'F2', 20, '0.07 0.09 0.15');
      y -= 24;
    }
    pushOp(
      `0.15 0.39 0.92 RG 1.5 w ${margin} ${(y + 4).toFixed(1)} m ${(pageWidth - margin).toFixed(1)} ${(y + 4).toFixed(1)} l S`,
    );
    y -= 14;
  }

  for (const block of parseMarkdownBlocks(input.markdown)) {
    if (block.type === 'heading') {
      const size = block.level === 1 ? 16 : block.level === 2 ? 13.5 : 11.5;
      const lineH = size + 6;
      y -= 4;
      for (const l of wrapTextToWidth(stripInlineMarkdown(block.text), contentWidth, size)) {
        ensureSpace(lineH);
        drawTextLine(l, margin, y - size, 'F2', size, '0.07 0.09 0.15');
        y -= lineH;
      }
      y -= 4;
    } else if (block.type === 'paragraph') {
      const lines = wrapTextToWidth(stripInlineMarkdown(block.text), contentWidth, 10.5);
      for (const l of lines) {
        ensureSpace(15);
        drawTextLine(l, margin, y - 10.5, 'F1', 10.5);
        y -= 15;
      }
      y -= 6;
    } else if (block.type === 'list-item') {
      const indentX = margin + 12 + block.level * 14;
      const bullet = block.ordered ? '-' : '*';
      const lines = wrapTextToWidth(
        stripInlineMarkdown(block.text),
        contentWidth - (indentX - margin) - 12,
        10.5,
      );
      lines.forEach((l, idx) => {
        ensureSpace(15);
        if (idx === 0) drawTextLine(bullet, indentX - 10, y - 10.5, 'F2', 10.5);
        drawTextLine(l, indentX, y - 10.5, 'F1', 10.5);
        y -= 15;
      });
      y -= 2;
    } else if (block.type === 'code') {
      const codeLines = block.text.split('\n');
      for (const cl of codeLines) {
        const wrapped = wrapTextToWidth(cl || ' ', contentWidth - 16, 9, true);
        for (const wl of wrapped) {
          ensureSpace(14);
          pushOp(
            `0.95 0.96 0.98 rg ${margin} ${(y - 13).toFixed(1)} ${contentWidth} 14 re f`,
          );
          drawTextLine(wl, margin + 8, y - 10, 'F4', 9, '0.15 0.20 0.28');
          y -= 14;
        }
      }
      y -= 6;
    } else if (block.type === 'table') {
      const colCount = Math.max(...block.rows.map((r) => r.length), 1);
      const colW = contentWidth / colCount;
      block.rows.forEach((row, rIdx) => {
        const isHeader = rIdx === 0;
        const rowH = 18;
        ensureSpace(rowH + 2);
        if (isHeader) {
          pushOp(
            `0.93 0.95 0.97 rg ${margin} ${(y - rowH).toFixed(1)} ${contentWidth} ${rowH} re f`,
          );
        }
        pushOp(
          `0.82 0.84 0.88 RG 0.5 w ${margin} ${(y - rowH).toFixed(1)} ${contentWidth} ${rowH} re S`,
        );
        for (let cIdx = 0; cIdx < colCount; cIdx += 1) {
          const x = margin + cIdx * colW;
          if (cIdx > 0) {
            pushOp(
              `0.82 0.84 0.88 RG 0.5 w ${x.toFixed(1)} ${y.toFixed(1)} m ${x.toFixed(1)} ${(y - rowH).toFixed(1)} l S`,
            );
          }
          const cellText = stripInlineMarkdown(row[cIdx] ?? '');
          const maxCellChars = Math.max(4, Math.floor((colW - 8) / 5));
          const clipped =
            cellText.length > maxCellChars ? `${cellText.slice(0, maxCellChars - 2)}..` : cellText;
          drawTextLine(clipped, x + 5, y - 12.5, isHeader ? 'F2' : 'F1', 9.5);
        }
        y -= rowH;
      });
      y -= 8;
    }
  }

  // Page numbers
  pageOps.forEach((ops, idx) => {
    const label = `${idx + 1} / ${pageOps.length}`;
    ops.push(
      `BT /F1 8.5 Tf 0.45 0.50 0.58 rg 1 0 0 1 ${(pageWidth - margin - 30).toFixed(1)} 26.0 Tm (${label}) Tj ET`,
    );
  });

  // Assemble PDF objects
  // 1: Catalog, 2: Pages, 3: Helvetica, 4: Helvetica-Bold, 5: Helvetica-Oblique, 6: Courier,
  // then pairs of (Page, ContentStream) starting at object 7
  const objects: string[] = [];
  const pageCount = pageOps.length;
  const pageObjNums = pageOps.map((_, idx) => 7 + idx * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';

  pageOps.forEach((ops, idx) => {
    const pageObj = 7 + idx * 2;
    const contentObj = pageObj + 1;
    const streamStr = ops.join('\n');
    const streamBytes = Buffer.byteLength(streamStr, 'latin1');
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${streamBytes} >>\nstream\n${streamStr}\nendstream`;
  });

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [0];
  let cursor = chunks[0]!.length;

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = cursor;
    const body = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'latin1');
    chunks.push(body);
    cursor += body.length;
  }

  const xrefOffset = cursor;
  const xrefLines = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`];
  for (let id = 1; id < objects.length; id += 1) {
    xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefLines.join('') + trailer, 'latin1'));

  return { buffer: Buffer.concat(chunks), pageCount };
}
