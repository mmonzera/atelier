import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACTION_TAG_RE } from '../agents/atelier-actions.js';
import type { TurnCallbacks } from '../agents/runner.js';
import { resolveInsideWorkspace } from '../agents/visual-tools.js';
import { AttachmentStore, isAttachmentId } from '../attachments.js';
import type { AppConfig } from '../config.js';
import {
  getAllowedFileRoots,
  listWorkspacePreviewFiles,
  resolvePreviewTarget,
} from '../file-preview.js';
import type { AtelierStore } from '../store.js';
import {
  editDocxDocument,
  editPptxDocument,
  editXlsxDocument,
  readDocxAsMarkdown,
  readPdfDocument,
  readPptxAsMarkdown,
  readSpreadsheetAsMarkdown,
  writeDelimitedText,
  writeDocxDocument,
  writePdfDocument,
  writePptxDocument,
  writeXlsxDocument,
} from './documents.js';

export interface OfficeToolContext {
  agentId: string;
  projectId: string | null;
  cwd: string;
  allowShell: boolean;
}

export interface OfficeToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  jsonSchema: Record<string, unknown>;
}

const OFFICE_EXT_SET = new Set(['docx', 'xlsx', 'csv', 'tsv', 'pptx', 'pdf', 'md', 'markdown', 'txt']);
const WRITE_OFFICE_EXT_SET = new Set(['docx', 'xlsx', 'csv', 'tsv', 'pptx', 'pdf']);

const ListFilesSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

const ReadOfficeSchema = z.object({
  path: z.string().trim().min(1).describe('File path (workspace-relative, absolute, or attachment ID att_...)'),
  sheet: z.string().trim().optional().describe('Optional Excel sheet name to filter'),
  maxRows: z.number().int().min(1).max(2000).optional().describe('Max spreadsheet rows (default 200)'),
  maxChars: z.number().int().min(500).max(80_000).optional().describe('Max characters returned (default 40000)'),
});

const WriteWordSchema = z.object({
  path: z.string().trim().min(1).describe('Output .docx path (relative to workspace or absolute)'),
  title: z.string().trim().optional().describe('Optional document title heading'),
  subtitle: z.string().trim().optional().describe('Optional subtitle below title'),
  markdown: z.string().min(1).describe('Document body in Markdown (supports headings, bold/italic, links, lists, tables, code blocks)'),
});

const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const WriteExcelSchema = z.object({
  path: z.string().trim().min(1).describe('Output .xlsx, .csv, or .tsv path'),
  sheets: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        headers: z.array(z.string()).optional(),
        rows: z.array(z.array(CellValueSchema)),
      }),
    )
    .min(1)
    .describe('One or more worksheets; cell strings starting with "=" are stored as Excel formulas'),
});

const PptSlideSchema = z.object({
  layout: z.enum(['title', 'section', 'bullets', 'two-column', 'table']).optional(),
  title: z.string().trim().min(1),
  subtitle: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  leftColumn: z.array(z.string()).optional(),
  rightColumn: z.array(z.string()).optional(),
  table: z.array(z.array(z.string())).optional(),
  notes: z.string().optional(),
});

const WritePowerPointSchema = z.object({
  path: z.string().trim().min(1).describe('Output .pptx path'),
  title: z.string().trim().optional().describe('Presentation metadata title'),
  accentColor: z.string().trim().optional().describe('Hex accent color, e.g. "#2563EB"'),
  slides: z.array(PptSlideSchema).min(1).describe('Ordered list of 16:9 slides'),
});

const WritePdfSchema = z.object({
  path: z.string().trim().min(1).describe('Output .pdf path'),
  title: z.string().trim().optional().describe('Optional document title'),
  markdown: z.string().min(1).describe('Document content in Markdown (headings, paragraphs, lists, tables, code)'),
  pageSize: z.enum(['A4', 'LETTER']).optional().default('A4'),
});

const EditOfficeSchema = z.object({
  path: z.string().trim().min(1).describe('Existing .docx, .xlsx, or .pptx file path'),
  replacements: z
    .array(z.object({ find: z.string().min(1), replace: z.string() }))
    .optional()
    .describe('Word/PowerPoint: find-and-replace pairs'),
  appendMarkdown: z
    .string()
    .optional()
    .describe('Word (.docx): Markdown content to append at the end of the document'),
  setCells: z
    .array(
      z.object({
        sheet: z.string().optional(),
        cell: z.string().min(2),
        value: CellValueSchema,
      }),
    )
    .optional()
    .describe('Excel (.xlsx): cell updates in A1 notation (e.g. "B4" or "Sheet2!C10")'),
  appendRows: z
    .object({
      sheet: z.string().optional(),
      rows: z.array(z.array(CellValueSchema)),
    })
    .optional()
    .describe('Excel (.xlsx): rows to append to a sheet'),
  upsertSheet: z
    .object({
      name: z.string().min(1),
      headers: z.array(z.string()).optional(),
      rows: z.array(z.array(CellValueSchema)),
    })
    .optional()
    .describe('Excel (.xlsx): create or replace a named sheet'),
  deleteSheet: z.string().optional().describe('Excel (.xlsx): sheet name to remove'),
  appendSlides: z.array(PptSlideSchema).optional().describe('PowerPoint (.pptx): slides to append'),
});

export const OFFICE_TOOL_DEFS: OfficeToolDefinition[] = [
  {
    name: 'office_list_files',
    description:
      'List local Office and document files (.docx, .xlsx, .csv, .pptx, .pdf, .md) in the workspace and chat attachments.',
    schema: ListFilesSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum files to return (default 60)' },
      },
    },
  },
  {
    name: 'office_read',
    description:
      'Read a local Word (.docx), Excel (.xlsx/.csv/.tsv), PowerPoint (.pptx), or PDF (.pdf) file into clean structured Markdown/text.',
    schema: ReadOfficeSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, absolute path, or attachment ID (att_...)' },
        sheet: { type: 'string', description: 'Optional Excel sheet name' },
        maxRows: { type: 'number', description: 'Maximum spreadsheet rows to read (default 200)' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 40000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'office_write_word',
    description:
      'Create or overwrite a formatted Word (.docx) document from Markdown (headings, bold/italic, links, bullet/numbered lists, tables, code).',
    schema: WriteWordSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .docx path' },
        title: { type: 'string', description: 'Optional document title' },
        subtitle: { type: 'string', description: 'Optional subtitle' },
        markdown: { type: 'string', description: 'Markdown body content' },
      },
      required: ['path', 'markdown'],
    },
  },
  {
    name: 'office_write_excel',
    description:
      'Create or overwrite an Excel (.xlsx, .csv, or .tsv) workbook with one or more sheets, styled headers, numbers, booleans, and =FORMULA cells.',
    schema: WriteExcelSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .xlsx, .csv, or .tsv path' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              headers: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: {} } },
            },
            required: ['name', 'rows'],
          },
        },
      },
      required: ['path', 'sheets'],
    },
  },
  {
    name: 'office_write_powerpoint',
    description:
      'Create or overwrite a 16:9 PowerPoint (.pptx) deck with title/section/bullets/two-column/table layouts and speaker notes.',
    schema: WritePowerPointSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .pptx path' },
        title: { type: 'string', description: 'Presentation title' },
        accentColor: { type: 'string', description: 'Hex accent color (e.g. "#2563EB")' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              layout: { type: 'string', enum: ['title', 'section', 'bullets', 'two-column', 'table'] },
              title: { type: 'string' },
              subtitle: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              leftColumn: { type: 'array', items: { type: 'string' } },
              rightColumn: { type: 'array', items: { type: 'string' } },
              table: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              notes: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['path', 'slides'],
    },
  },
  {
    name: 'office_write_pdf',
    description:
      'Create or overwrite a clean paginated PDF (.pdf) document from Markdown (headings, paragraphs, lists, tables, code).',
    schema: WritePdfSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .pdf path' },
        title: { type: 'string', description: 'Optional document title' },
        markdown: { type: 'string', description: 'Markdown content' },
        pageSize: { type: 'string', enum: ['A4', 'LETTER'] },
      },
      required: ['path', 'markdown'],
    },
  },
  {
    name: 'office_edit',
    description:
      'Edit an existing Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) file: replace text, append Markdown/slides, update cells, or add/remove sheets.',
    schema: EditOfficeSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing .docx, .xlsx, or .pptx path' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
          },
        },
        appendMarkdown: { type: 'string', description: 'Markdown to append to a .docx' },
        setCells: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' },
              cell: { type: 'string' },
              value: {},
            },
            required: ['cell', 'value'],
          },
        },
        appendRows: {
          type: 'object',
          properties: {
            sheet: { type: 'string' },
            rows: { type: 'array', items: { type: 'array', items: {} } },
          },
          required: ['rows'],
        },
        upsertSheet: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: {} } },
          },
          required: ['name', 'rows'],
        },
        deleteSheet: { type: 'string' },
        appendSlides: { type: 'array', items: { type: 'object' } },
      },
      required: ['path'],
    },
  },
];

export const OFFICE_TOOL_NAMES = OFFICE_TOOL_DEFS.map((t) => t.name);
export const OFFICE_TOOL_NAME_SET = new Set(OFFICE_TOOL_NAMES);

export function officeToolsForMcpList() {
  return OFFICE_TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  }));
}

export function officeToolsAsOpenAiFunctions() {
  return OFFICE_TOOL_DEFS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    },
  }));
}

function isInsideDir(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveReadablePath(
  rawPath: string,
  deps: { store: AtelierStore; config: AppConfig },
  ctx: OfficeToolContext,
): string {
  const clean = rawPath.trim();
  if (isAttachmentId(clean)) {
    const found = new AttachmentStore(deps.config.dataDir).get(clean);
    if (!found) throw new Error(`Attachment not found: ${clean}`);
    return path.resolve(found.filePath);
  }

  if (!path.isAbsolute(clean)) {
    const inCwd = path.resolve(ctx.cwd, clean);
    if (fs.existsSync(inCwd) && fs.statSync(inCwd).isFile()) {
      return inCwd;
    }
    const target = resolvePreviewTarget(
      { path: clean, scope: ctx.projectId ?? 'direct', agentId: ctx.agentId },
      deps.store,
      deps.config,
    );
    if (target) return target.filePath;
    throw new Error(`File not found: ${clean}`);
  }

  const resolved = path.resolve(clean);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`File not found: ${resolved}`);
  }
  const allowedRoots = [ctx.cwd, ...getAllowedFileRoots(deps.store, deps.config)];
  if (allowedRoots.some((r) => isInsideDir(resolved, r))) {
    return resolved;
  }
  const ext = path.extname(resolved).replace(/^\./, '').toLowerCase();
  if (ctx.allowShell && OFFICE_EXT_SET.has(ext)) {
    return resolved;
  }
  throw new Error(`Access denied outside workspace for path: ${resolved}`);
}

function resolveWritablePath(
  rawPath: string,
  expectedExts: string[],
  deps: { store: AtelierStore; config: AppConfig },
  ctx: OfficeToolContext,
  mustExist = false,
): string {
  let clean = rawPath.trim();
  if (!clean) throw new Error('File path is required.');

  const currentExt = path.extname(clean).replace(/^\./, '').toLowerCase();
  if (!currentExt && expectedExts.length === 1) {
    clean = `${clean}.${expectedExts[0]}`;
  }
  const finalExt = path.extname(clean).replace(/^\./, '').toLowerCase();
  if (!expectedExts.includes(finalExt)) {
    throw new Error(`Expected ${expectedExts.map((e) => `.${e}`).join('/')} file, got "${clean}".`);
  }

  let resolved: string;
  if (!path.isAbsolute(clean)) {
    resolved = resolveInsideWorkspace(ctx.cwd, clean);
  } else {
    resolved = path.resolve(clean);
    const allowedRoots = [ctx.cwd, ...getAllowedFileRoots(deps.store, deps.config)];
    const insideAllowed = allowedRoots.some((r) => isInsideDir(resolved, r));
    if (!insideAllowed && !(ctx.allowShell && WRITE_OFFICE_EXT_SET.has(finalExt))) {
      throw new Error(`Path must stay inside workspace (${ctx.cwd}): ${clean}`);
    }
  }

  if (mustExist) {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Target file does not exist: ${resolved}`);
    }
  } else {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  return resolved;
}

export async function executeOfficeTool(
  deps: { store: AtelierStore; config: AppConfig },
  name: string,
  rawArgs: unknown,
  ctx: OfficeToolContext,
): Promise<{ text: string; isError?: boolean }> {
  try {
    if (name === 'office_list_files') {
      const args = ListFilesSchema.parse(rawArgs ?? {});
      const limit = args.limit ?? 60;
      const wsFiles = listWorkspacePreviewFiles(
        ctx.projectId,
        ctx.agentId,
        deps.store,
        deps.config,
        limit,
      ).filter((f) => OFFICE_EXT_SET.has(path.extname(f.name).replace(/^\./, '').toLowerCase()));

      const attachments: Array<{ id: string; name: string; sizeBytes: number; path: string }> = [];
      const attachStore = new AttachmentStore(deps.config.dataDir);
      for (const msg of deps.store.listMessagesWithAttachments(ctx.projectId, ctx.agentId)) {
        for (const att of msg.metadata?.attachments ?? []) {
          const ext = path.extname(att.name).replace(/^\./, '').toLowerCase();
          if (!OFFICE_EXT_SET.has(ext)) continue;
          const found = attachStore.get(att.id);
          if (found) {
            attachments.push({
              id: att.id,
              name: att.name,
              sizeBytes: att.size,
              path: path.resolve(found.filePath),
            });
          }
        }
      }

      return {
        text: JSON.stringify(
          {
            workspaceDir: ctx.cwd,
            workspaceFiles: wsFiles.map((f) => ({
              name: f.name,
              relativePath: f.relativePath,
              filePath: f.filePath,
              kind: f.kind,
              sizeBytes: f.sizeBytes,
            })),
            attachments: attachments.slice(0, 30),
          },
          null,
          2,
        ),
      };
    }

    if (name === 'office_read') {
      const args = ReadOfficeSchema.parse(rawArgs);
      const filePath = resolveReadablePath(args.path, deps, ctx);
      const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
      const buf = fs.readFileSync(filePath);
      const maxChars = args.maxChars ?? 40_000;

      if (ext === 'docx') {
        const res = readDocxAsMarkdown(buf);
        const text =
          res.markdown.length > maxChars
            ? `${res.markdown.slice(0, maxChars)}\n... [truncated]`
            : res.markdown;
        return {
          text: JSON.stringify(
            { ok: true, kind: 'word', filePath, blockCount: res.blockCount, tableCount: res.tableCount, content: text },
            null,
            2,
          ),
        };
      }
      if (ext === 'xlsx' || ext === 'csv' || ext === 'tsv') {
        const res = readSpreadsheetAsMarkdown(buf, ext, {
          sheet: args.sheet,
          maxRows: args.maxRows ?? 200,
        });
        const text =
          res.markdown.length > maxChars
            ? `${res.markdown.slice(0, maxChars)}\n... [truncated]`
            : res.markdown;
        return {
          text: JSON.stringify(
            {
              ok: true,
              kind: 'excel',
              filePath,
              sheetNames: res.sheets.map((s) => s.name),
              content: text,
            },
            null,
            2,
          ),
        };
      }
      if (ext === 'pptx') {
        const res = readPptxAsMarkdown(buf);
        const text =
          res.markdown.length > maxChars
            ? `${res.markdown.slice(0, maxChars)}\n... [truncated]`
            : res.markdown;
        return {
          text: JSON.stringify(
            { ok: true, kind: 'powerpoint', filePath, slideCount: res.slides.length, content: text },
            null,
            2,
          ),
        };
      }
      if (ext === 'pdf') {
        const res = readPdfDocument(buf, maxChars);
        return {
          text: JSON.stringify(
            {
              ok: true,
              kind: 'pdf',
              filePath,
              pageCount: res.pageCount,
              truncated: res.truncated,
              ...(res.warning ? { warning: res.warning } : {}),
              content: res.text,
            },
            null,
            2,
          ),
        };
      }
      if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
        const raw = buf.toString('utf8');
        const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw;
        return {
          text: JSON.stringify({ ok: true, kind: 'text', filePath, content: text }, null, 2),
        };
      }
      return {
        text: JSON.stringify({ ok: false, error: `Unsupported file extension ".${ext}".` }),
        isError: true,
      };
    }

    if (name === 'office_write_word') {
      const args = WriteWordSchema.parse(rawArgs);
      const filePath = resolveWritablePath(args.path, ['docx'], deps, ctx);
      const buf = writeDocxDocument({
        title: args.title,
        subtitle: args.subtitle,
        markdown: args.markdown,
      });
      fs.writeFileSync(filePath, buf);
      deps.store.addActivity({
        projectId: ctx.projectId,
        agentId: ctx.agentId,
        kind: 'tool',
        label: `Created Word document ${path.basename(filePath)}`,
        detail: filePath,
      });
      return {
        text: JSON.stringify({
          ok: true,
          kind: 'word',
          filePath,
          sizeBytes: buf.length,
          summary: `Wrote ${path.basename(filePath)} (${buf.length} bytes).`,
        }),
      };
    }

    if (name === 'office_write_excel') {
      const args = WriteExcelSchema.parse(rawArgs);
      const filePath = resolveWritablePath(args.path, ['xlsx', 'csv', 'tsv'], deps, ctx);
      const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
      let buf: Buffer;
      if (ext === 'csv' || ext === 'tsv') {
        const first = args.sheets[0]!;
        const rows = [
          ...(first.headers && first.headers.length > 0 ? [first.headers] : []),
          ...first.rows,
        ];
        buf = Buffer.from(writeDelimitedText(rows, ext === 'tsv' ? '\t' : ','), 'utf8');
      } else {
        buf = writeXlsxDocument({ sheets: args.sheets });
      }
      fs.writeFileSync(filePath, buf);
      deps.store.addActivity({
        projectId: ctx.projectId,
        agentId: ctx.agentId,
        kind: 'tool',
        label: `Created spreadsheet ${path.basename(filePath)}`,
        detail: filePath,
      });
      return {
        text: JSON.stringify({
          ok: true,
          kind: 'excel',
          filePath,
          sizeBytes: buf.length,
          sheetCount: args.sheets.length,
          summary: `Wrote ${path.basename(filePath)} (${args.sheets.length} sheet(s), ${buf.length} bytes).`,
        }),
      };
    }

    if (name === 'office_write_powerpoint') {
      const args = WritePowerPointSchema.parse(rawArgs);
      const filePath = resolveWritablePath(args.path, ['pptx'], deps, ctx);
      const buf = writePptxDocument({
        title: args.title,
        accentColor: args.accentColor,
        slides: args.slides,
      });
      fs.writeFileSync(filePath, buf);
      deps.store.addActivity({
        projectId: ctx.projectId,
        agentId: ctx.agentId,
        kind: 'tool',
        label: `Created PowerPoint deck ${path.basename(filePath)}`,
        detail: filePath,
      });
      return {
        text: JSON.stringify({
          ok: true,
          kind: 'powerpoint',
          filePath,
          sizeBytes: buf.length,
          slideCount: args.slides.length,
          summary: `Wrote ${path.basename(filePath)} (${args.slides.length} slide(s), ${buf.length} bytes).`,
        }),
      };
    }

    if (name === 'office_write_pdf') {
      const args = WritePdfSchema.parse(rawArgs);
      const filePath = resolveWritablePath(args.path, ['pdf'], deps, ctx);
      const res = writePdfDocument({
        title: args.title,
        markdown: args.markdown,
        pageSize: args.pageSize,
      });
      fs.writeFileSync(filePath, res.buffer);
      deps.store.addActivity({
        projectId: ctx.projectId,
        agentId: ctx.agentId,
        kind: 'tool',
        label: `Created PDF ${path.basename(filePath)}`,
        detail: filePath,
      });
      return {
        text: JSON.stringify({
          ok: true,
          kind: 'pdf',
          filePath,
          sizeBytes: res.buffer.length,
          pageCount: res.pageCount,
          summary: `Wrote ${path.basename(filePath)} (${res.pageCount} page(s), ${res.buffer.length} bytes).`,
        }),
      };
    }

    if (name === 'office_edit') {
      const args = EditOfficeSchema.parse(rawArgs);
      const filePath = resolveWritablePath(args.path, ['docx', 'xlsx', 'pptx'], deps, ctx, true);
      const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
      const inputBuf = fs.readFileSync(filePath);

      if (ext === 'docx') {
        const res = editDocxDocument(inputBuf, {
          replacements: args.replacements,
          appendMarkdown: args.appendMarkdown,
        });
        fs.writeFileSync(filePath, res.buffer);
        deps.store.addActivity({
          projectId: ctx.projectId,
          agentId: ctx.agentId,
          kind: 'tool',
          label: `Edited Word document ${path.basename(filePath)}`,
          detail: filePath,
        });
        return {
          text: JSON.stringify({
            ok: true,
            kind: 'word',
            filePath,
            sizeBytes: res.buffer.length,
            replacementsApplied: res.replacementsApplied,
          }),
        };
      }

      if (ext === 'xlsx') {
        const res = editXlsxDocument(inputBuf, {
          setCells: args.setCells,
          appendRows: args.appendRows,
          upsertSheet: args.upsertSheet,
          deleteSheet: args.deleteSheet,
        });
        fs.writeFileSync(filePath, res.buffer);
        deps.store.addActivity({
          projectId: ctx.projectId,
          agentId: ctx.agentId,
          kind: 'tool',
          label: `Edited spreadsheet ${path.basename(filePath)}`,
          detail: filePath,
        });
        return {
          text: JSON.stringify({
            ok: true,
            kind: 'excel',
            filePath,
            sizeBytes: res.buffer.length,
            sheetCount: res.sheetCount,
          }),
        };
      }

      if (ext === 'pptx') {
        const res = editPptxDocument(inputBuf, {
          replacements: args.replacements,
          appendSlides: args.appendSlides,
        });
        fs.writeFileSync(filePath, res.buffer);
        deps.store.addActivity({
          projectId: ctx.projectId,
          agentId: ctx.agentId,
          kind: 'tool',
          label: `Edited PowerPoint deck ${path.basename(filePath)}`,
          detail: filePath,
        });
        return {
          text: JSON.stringify({
            ok: true,
            kind: 'powerpoint',
            filePath,
            sizeBytes: res.buffer.length,
            slidesCount: res.slidesCount,
            replacementsApplied: res.replacementsApplied,
          }),
        };
      }
    }

    return {
      text: JSON.stringify({ ok: false, error: `Unknown office tool: ${name}` }),
      isError: true,
    };
  } catch (err) {
    return {
      text: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      isError: true,
    };
  }
}

export async function applyOfficeAtelierActions(
  rawText: string,
  deps: { store: AtelierStore; config: AppConfig },
  ctx: OfficeToolContext,
  cb: Pick<TurnCallbacks, 'onTool'>,
): Promise<{ cleanText: string; results: Array<{ tool: string; result: string }> }> {
  const matches: Array<{ full: string; toolName: string; args: Record<string, unknown> }> = [];
  rawText.replace(ACTION_TAG_RE, (full, jsonPayload: string) => {
    try {
      const obj = JSON.parse(jsonPayload) as Record<string, unknown>;
      const toolName = typeof obj.tool === 'string' ? obj.tool : '';
      if (OFFICE_TOOL_NAME_SET.has(toolName)) {
        const { tool: _ignored, ...args } = obj;
        matches.push({ full, toolName, args });
      }
    } catch {
      // ignore malformed block
    }
    return full;
  });

  if (matches.length === 0) {
    return { cleanText: rawText, results: [] };
  }

  let cleanText = rawText;
  const results: Array<{ tool: string; result: string }> = [];
  for (const m of matches.slice(0, 6)) {
    cleanText = cleanText.replace(m.full, '');
    cb.onTool(m.toolName, m.args);
    const execRes = await executeOfficeTool(deps, m.toolName, m.args, ctx);
    results.push({ tool: m.toolName, result: execRes.text });
  }
  return { cleanText: cleanText.trim(), results };
}
