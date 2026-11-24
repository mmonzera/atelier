import { extractSvgBlocks } from '@atelier/contracts';
import { Check, Code, Copy, Download, Eye, FileImage } from 'lucide-react';
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useT } from '../i18n';

/**
 * Small, dependency-free markdown renderer for chat messages. It builds React elements only
 * (never innerHTML), so model output cannot inject markup. Supports headings, lists, tables,
 * blockquotes, rules, fenced code (with SQL/JS/Python highlighting and a Preview toggle for
 * markdown blocks) and inline bold / italic / code / links.
 */

type Align = 'left' | 'center' | 'right';
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; items: { indent: number; ordered: boolean; marker: string; text: string }[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'code'; lang: string; code: string }
  | { type: 'table'; header: string[]; align: Align[]; rows: string[][] };

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i]!.includes('|') &&
    TABLE_SEP.test(lines[i + 1]!) &&
    lines[i + 1]!.includes('-') &&
    splitRow(lines[i]!).length === splitRow(lines[i + 1]!).length
  );
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      // An unterminated fence (a streaming reply) renders as code up to the end.
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ type: 'code', lang: (fence[1] ?? '').toLowerCase(), code: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map<Align>((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i++]!);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: { indent: number; ordered: boolean; marker: string; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (m) {
          items.push({
            indent: Math.min(3, Math.floor(m[1]!.replace(/\t/g, '  ').length / 2)),
            ordered: /\d/.test(m[2]!),
            marker: m[2]!,
            text: m[3]!,
          });
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length && !isTableStart(lines, i)) {
          items[items.length - 1]!.text += ' ' + lines[i++]!.trim();
        } else break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !FENCE.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!) &&
      !isTableStart(lines, i)
    ) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)|(\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))/g;

const inlineCode: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.88em',
  padding: '1px 5px',
  borderRadius: 5,
  background: 'var(--surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
};

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--agent-blue)', textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      {children}
    </a>
  );
}

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;
    if (match[1]) {
      out.push(<code key={key} style={inlineCode}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      out.push(
        <strong key={key} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (match[3]) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push(<Link key={key} href={m[2]!}>{renderInline(m[1]!, key)}</Link>);
    } else if (match[4]) {
      const trimmed = token.replace(/[.,;:!?]+$/, '');
      out.push(<Link key={key} href={trimmed}>{trimmed}</Link>);
      if (trimmed.length < token.length) out.push(token.slice(trimmed.length));
    } else {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------- syntax highlighting ---------- */

const SQL_KEYWORDS = new Set(
  ('select from where and or not in is null like ilike between join left right inner outer full cross on as ' +
    'group by order having limit offset distinct union all insert into values update set delete create alter drop ' +
    'table index view database schema primary key foreign references default unique check constraint with case when ' +
    'then else end exists asc desc over partition returning begin commit rollback truncate if cascade using natural ' +
    'int integer bigint smallint text varchar char boolean bool date timestamp timestamptz numeric decimal float ' +
    'double serial uuid json jsonb count sum avg min max coalesce now cast').split(' '),
);
const JS_KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends import export ' +
    'from default async await try catch finally throw typeof instanceof in of this super null undefined true false ' +
    'interface type enum implements public private protected readonly void as').split(' '),
);
const PY_KEYWORDS = new Set(
  ('def class return if elif else for while in not and or is import from as with try except finally raise lambda ' +
    'None True False pass break continue yield async await self global nonlocal').split(' '),
);
const SH_KEYWORDS = new Set('if then else fi for do done while case esac function export echo cd ls cat npm git'.split(' '));

type TokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'plain';
const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  keyword: 'var(--agent-purple)',
  string: 'var(--agent-green)',
  comment: 'var(--text-muted)',
  number: 'var(--agent-amber)',
  plain: undefined,
};

function keywordsFor(lang: string): { set: Set<string>; fold: boolean; lineComment: string | null; block: boolean } {
  if (['sql', 'psql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'plsql'].includes(lang)) {
    return { set: SQL_KEYWORDS, fold: true, lineComment: '--', block: true };
  }
  if (['py', 'python'].includes(lang)) return { set: PY_KEYWORDS, fold: false, lineComment: '#', block: false };
  if (['sh', 'bash', 'shell', 'zsh', 'powershell', 'ps1'].includes(lang)) {
    return { set: SH_KEYWORDS, fold: false, lineComment: '#', block: false };
  }
  if (['json', 'jsonc'].includes(lang)) {
    return { set: new Set(['true', 'false', 'null']), fold: false, lineComment: null, block: false };
  }
  return { set: JS_KEYWORDS, fold: false, lineComment: '//', block: true };
}

export function tokenize(code: string, lang: string): { kind: TokenKind; text: string }[] {
  const { set, fold, lineComment, block } = keywordsFor(lang);
  const out: { kind: TokenKind; text: string }[] = [];
  const push = (kind: TokenKind, text: string) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (lineComment && rest.startsWith(lineComment)) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (block && rest.startsWith('/*')) {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && !(ch !== '`' && code[j] === '\n')) {
        if (code[j] === '\\') j++;
        j++;
      }
      push('string', code.slice(i, Math.min(j + 1, code.length)));
      i = Math.min(j + 1, code.length);
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(rest);
    if (num && !/\w/.test(code[i - 1] ?? '')) {
      push('number', num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w$]*/.exec(rest);
    if (word) {
      push(set.has(fold ? word[0].toLowerCase() : word[0]) ? 'keyword' : 'plain', word[0]);
      i += word[0].length;
      continue;
    }
    push('plain', ch);
    i++;
  }
  return out;
}

/* ---------- blocks ---------- */

const toolbarButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 11,
  cursor: 'pointer',
};

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="transition-atelier"
      style={toolbarButton}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} strokeWidth={1.75} /> : <Copy size={12} strokeWidth={1.75} />}
      {copied ? t('Copied') : t('Copy')}
    </button>
  );
}

const LANG_LABELS: Record<string, string> = {
  md: 'Markdown', markdown: 'Markdown', sql: 'SQL', psql: 'SQL', postgres: 'SQL', postgresql: 'SQL', mysql: 'SQL',
  js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', jsx: 'JSX',
  py: 'Python', python: 'Python', sh: 'Shell', bash: 'Shell', powershell: 'PowerShell', json: 'JSON',
};

function downloadSvg(name: string, svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** A finished SVG drawing: shown as the picture, with its file name, download and copy. */
function SvgBlock({ name, svg }: { name: string; svg: string }) {
  const t = useT();
  const [showCode, setShowCode] = useState(false);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
        overflow: 'hidden',
        margin: '4px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span
          title={name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          <FileImage size={13} strokeWidth={1.6} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          <button
            type="button"
            className="transition-atelier"
            aria-label={t('Download {name}', { name })}
            title={t('Download {name}', { name })}
            onClick={() => downloadSvg(name, svg)}
            style={{ ...toolbarButton, padding: '2px 6px', flexShrink: 0 }}
          >
            <Download size={13} strokeWidth={1.75} />
          </button>
        </span>
        <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
          <button type="button" className="transition-atelier" style={toolbarButton} onClick={() => setShowCode((v) => !v)}>
            {showCode ? <Eye size={12} strokeWidth={1.75} /> : <Code size={12} strokeWidth={1.75} />}
            {showCode ? t('Preview') : t('Code')}
          </button>
          <CopyButton text={svg} />
        </span>
      </div>
      {showCode ? (
        <pre
          style={{
            margin: 0,
            padding: '10px 14px',
            overflow: 'auto',
            maxHeight: 360,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--text-primary)',
          }}
        >
          <code>{svg}</code>
        </pre>
      ) : (
        <div style={{ padding: 14, display: 'flex', justifyContent: 'center', background: 'var(--surface-1)' }}>
          <img
            src={src}
            alt={name}
            style={{ display: 'block', maxWidth: '100%', maxHeight: 460, height: 'auto' }}
          />
        </div>
      )}
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT();
  const isMarkdown = lang === 'md' || lang === 'markdown';
  const [preview, setPreview] = useState(isMarkdown);
  const label = LANG_LABELS[lang] ?? (lang ? lang.toUpperCase() : 'Code');
  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
        overflow: 'hidden',
        margin: '4px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', letterSpacing: 0.3 }}>{label}</span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {isMarkdown && (
            <button type="button" className="transition-atelier" style={toolbarButton} onClick={() => setPreview((v) => !v)}>
              {preview ? <Code size={12} strokeWidth={1.75} /> : <Eye size={12} strokeWidth={1.75} />}
              {preview ? t('Source') : t('Preview')}
            </button>
          )}
          <CopyButton text={code} />
        </span>
      </div>
      {isMarkdown && preview ? (
        <div style={{ padding: '10px 14px' }}>
          <Markdown text={code} />
        </div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: '10px 14px',
            overflowX: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            lineHeight: '19px',
            color: 'var(--text-primary)',
            tabSize: 2,
          }}
        >
          <code>
            {tokenize(code, lang).map((token, index) => (
              <span key={index} style={{ color: TOKEN_COLORS[token.kind], fontStyle: token.kind === 'comment' ? 'italic' : undefined }}>
                {token.text}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}

const cell: CSSProperties = {
  padding: '7px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  verticalAlign: 'top',
  lineHeight: '19px',
};

function Table({ block }: { block: Extract<Block, { type: 'table' }> }) {
  return (
    <div
      style={{
        overflowX: 'auto',
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
        margin: '4px 0',
      }}
    >
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: 'var(--surface-2)' }}>
            {block.header.map((h, c) => (
              <th
                key={c}
                style={{ ...cell, textAlign: block.align[c], fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}
              >
                {renderInline(h, `th${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} style={{ background: r % 2 ? 'rgba(255,255,255,0.015)' : undefined }}>
              {row.map((value, c) => (
                <td
                  key={c}
                  style={{
                    ...cell,
                    textAlign: block.align[c],
                    color: 'var(--text-secondary)',
                    borderBottom: r === block.rows.length - 1 ? 'none' : cell.borderBottom,
                  }}
                >
                  {renderInline(value, `td${r}-${c}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADING_SIZES = [20, 17, 15, 14, 13.5, 13];

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  // complete SVG drawings are shown as pictures (matched to their code by content)
  const svgs = useMemo(() => (text.includes('<svg') ? extractSvgBlocks(text) : []), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, wordBreak: 'break-word', minWidth: 0 }}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={index}
                role="heading"
                aria-level={block.level}
                style={{
                  fontSize: HEADING_SIZES[block.level - 1],
                  fontWeight: 600,
                  lineHeight: 1.35,
                  color: 'var(--text-primary)',
                  marginTop: index ? 4 : 0,
                }}
              >
                {renderInline(block.text, `h${index}`)}
              </div>
            );
          case 'paragraph':
            return (
              <div key={index}>
                {block.lines.map((line, l) => (
                  <Fragment key={l}>
                    {l > 0 && <br />}
                    {renderInline(line, `p${index}-${l}`)}
                  </Fragment>
                ))}
              </div>
            );
          case 'list': {
            let counter = 0;
            return (
              <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {block.items.map((item, k) => {
                  counter = item.ordered ? counter + 1 : 0;
                  return (
                    <div key={k} style={{ display: 'flex', gap: 8, paddingLeft: item.indent * 18 }}>
                      <span style={{ color: 'var(--text-tertiary)', minWidth: 16, textAlign: 'right', flexShrink: 0 }}>
                        {item.ordered ? `${counter}.` : '•'}
                      </span>
                      <span style={{ minWidth: 0 }}>{renderInline(item.text, `l${index}-${k}`)}</span>
                    </div>
                  );
                })}
              </div>
            );
          }
          case 'quote':
            return (
              <div
                key={index}
                style={{
                  borderLeft: '3px solid var(--border-default)',
                  paddingLeft: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                <Markdown text={block.text} />
              </div>
            );
          case 'hr':
            return <hr key={index} style={{ border: 0, borderTop: '1px solid var(--border-subtle)', margin: '4px 0', width: '100%' }} />;
          case 'code':
            {
              const svg = svgs.find((b) => b.svg === block.code.trim());
              if (svg) return <SvgBlock key={index} name={svg.name} svg={svg.svg} />;
            }
            return <CodeBlock key={index} lang={block.lang} code={block.code} />;
          case 'table':
            return <Table key={index} block={block} />;
        }
      })}
    </div>
  );
}
