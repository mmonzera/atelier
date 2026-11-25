import type { Message } from '@atelier/contracts';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';

/**
 * In-chat search. Matches message text (case-insensitive), highlights the hits in the thread via
 * `data-search-hit` / `data-search-active` on elements carrying `data-msg-id`, and scrolls to the
 * active one. Messages that are not loaded or not rendered cannot match, so callers load older
 * history first (see RoomView).
 */
export function useChatSearch(messages: Message[], rootRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // -1 means "newest match"; reset whenever the query changes.
  const [index, setIndex] = useState(-1);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!open || !q) return [];
    return messages.filter((m) => m.text && m.text.toLowerCase().includes(q));
  }, [open, query, messages]);

  const active = matches.length === 0 ? -1 : index < 0 ? matches.length - 1 : Math.min(index, matches.length - 1);
  const activeId = active >= 0 ? matches[active]!.id : null;

  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    setIndex(-1);
  }, []);
  const step = useCallback(
    (delta: 1 | -1) => {
      if (matches.length === 0) return;
      setIndex((((active + delta) % matches.length) + matches.length) % matches.length);
    },
    [matches.length, active],
  );
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setIndex(-1);
  }, []);

  // Ctrl/Cmd+F opens the in-chat search instead of the browser's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mark hits in the DOM. Re-run when messages change so new/streamed nodes keep their marks.
  const hitKey = matches.map((m) => m.id).join(',');
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const hits = new Set(hitKey ? hitKey.split(',') : []);
    const marked: HTMLElement[] = [];
    root.querySelectorAll<HTMLElement>('[data-msg-id]').forEach((node) => {
      const id = node.dataset.msgId ?? '';
      if (!hits.has(id)) return;
      node.setAttribute('data-search-hit', '');
      if (id === activeId) node.setAttribute('data-search-active', '');
      marked.push(node);
    });
    return () => {
      for (const node of marked) {
        node.removeAttribute('data-search-hit');
        node.removeAttribute('data-search-active');
      }
    };
  }, [hitKey, activeId, messages, rootRef]);

  // Scroll only when the active hit changes, not on every streamed token.
  useEffect(() => {
    if (!activeId) return;
    const node = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-msg-id]') ?? []).find(
      (n) => n.dataset.msgId === activeId,
    );
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeId, rootRef]);

  return {
    open,
    openSearch: () => setOpen(true),
    close,
    query,
    setQuery: updateQuery,
    count: matches.length,
    position: active + 1,
    next: () => step(1),
    prev: () => step(-1),
  };
}

export type ChatSearch = ReturnType<typeof useChatSearch>;

/** Icon button that opens the search bar. Same height as the session pill beside it. */
export function ChatSearchButton({ search }: { search: ChatSearch }) {
  const tr = useT();
  return (
    <button
      type="button"
      onClick={() => (search.open ? search.close() : search.openSearch())}
      title={tr('Search in chat')}
      aria-label={tr('Search in chat')}
      className="transition-atelier"
      style={{
        width: 36,
        height: 36,
        borderRadius: 'var(--radius-md)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-tertiary)',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <Search size={15} strokeWidth={1.7} />
    </button>
  );
}

export function ChatSearchBar({ search, hint }: { search: ChatSearch; hint?: string }) {
  const tr = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (search.open) inputRef.current?.focus();
  }, [search.open]);
  if (!search.open) return null;

  const hasQuery = Boolean(search.query.trim());
  const navBtn = (enabled: boolean) =>
    ({
      width: 28,
      height: 26,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--text-secondary)',
      opacity: enabled ? 1 : 0.35,
    }) as const;

  return (
    <div
      role="search"
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px 0 12px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-default)',
      }}
    >
      <Search size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type="text"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') search.close();
          else if (e.key === 'Enter') (e.shiftKey ? search.prev : search.next)();
        }}
        placeholder={tr('Search in chat')}
        aria-label={tr('Search in chat')}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          boxShadow: 'none',
          fontSize: 13.5,
          color: 'var(--text-primary)',
        }}
      />
      {hasQuery && (
        <span
          className="mono-num"
          style={{
            padding: '2px 8px',
            borderRadius: 7,
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            color: search.count === 0 ? 'var(--text-tertiary)' : 'var(--agent-amber)',
            background: search.count === 0 ? 'var(--surface-2)' : 'rgba(244, 188, 46, 0.14)',
            border: `1px solid ${search.count === 0 ? 'var(--border-subtle)' : 'rgba(244, 188, 46, 0.28)'}`,
          }}
        >
          {search.count === 0 ? tr('No results') : `${search.position} / ${search.count}`}
        </span>
      )}
      {hint && !hasQuery && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{hint}</span>
      )}
      <div
        style={{
          display: 'inline-flex',
          overflow: 'hidden',
          borderRadius: 8,
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-2)',
        }}
      >
        <button type="button" onClick={search.prev} disabled={search.count === 0} title={tr('Previous match')} style={navBtn(search.count > 0)}>
          <ChevronUp size={14} />
        </button>
        <span style={{ width: 1, background: 'var(--border-subtle)' }} />
        <button type="button" onClick={search.next} disabled={search.count === 0} title={tr('Next match')} style={navBtn(search.count > 0)}>
          <ChevronDown size={14} />
        </button>
      </div>
      <span style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />
      <button
        type="button"
        onClick={search.close}
        title={tr('Close search')}
        style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
