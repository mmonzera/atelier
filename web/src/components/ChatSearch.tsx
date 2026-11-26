import type { Message } from '@atelier/contracts';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SEARCH_SHORTCUT = IS_MAC ? '⌘F' : 'Ctrl F';

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
  const [focusTick, setFocusTick] = useState(0);

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
        setFocusTick((n) => n + 1);
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
    focusTick,
    openSearch: () => {
      setOpen(true);
      setFocusTick((n) => n + 1);
    },
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

/** Button that opens the in-chat search bar. */
export function ChatSearchButton({ search, compact = false }: { search: ChatSearch; compact?: boolean }) {
  const tr = useT();
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => (search.open ? search.close() : search.openSearch())}
        title={tr('Search in chat')}
        aria-label={tr('Search in chat')}
        className="chat-search-btn transition-atelier"
        style={{
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-full)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <Search size={13.5} strokeWidth={1.7} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (search.open ? search.close() : search.openSearch())}
      title={tr('Search in chat')}
      aria-label={tr('Search in chat')}
      className="chat-search-btn transition-atelier"
      style={{
        height: 30,
        padding: '0 7px 0 10px',
        borderRadius: 'var(--radius-full)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--text-secondary)',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        fontSize: 12,
      }}
    >
      <Search size={13} strokeWidth={1.7} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <span>{tr('Search')}</span>
      <kbd
        style={{
          fontSize: 10.5,
          lineHeight: '16px',
          padding: '0 5px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {SEARCH_SHORTCUT}
      </kbd>
    </button>
  );
}

export function ChatSearchBar({ search, hint }: { search: ChatSearch; hint?: string }) {
  const tr = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (search.open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [search.open, search.focusTick]);
  if (!search.open) return null;

  const hasQuery = Boolean(search.query.trim());
  const iconBtn = {
    width: 22,
    height: 22,
    borderRadius: 'var(--radius-full)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-secondary)',
    flexShrink: 0,
  } as const;

  return (
    <div
      role="search"
      className="chat-search-bar transition-atelier"
      style={{
        height: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 5px 0 11px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-default)',
      }}
    >
      <Search size={13} strokeWidth={1.7} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type="text"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            search.close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            (e.shiftKey ? search.prev : search.next)();
          }
        }}
        placeholder={tr('Search in chat')}
        aria-label={tr('Search in chat')}
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          boxShadow: 'none',
          fontSize: 12.5,
          color: 'var(--text-primary)',
        }}
      />
      {hasQuery && (
        <span
          className="mono-num"
          style={{
            padding: '1px 7px',
            borderRadius: 'var(--radius-full)',
            fontSize: 11,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            color: search.count === 0 ? 'var(--text-tertiary)' : 'var(--agent-amber)',
            background: search.count === 0 ? 'var(--surface-2)' : 'rgba(244, 188, 46, 0.13)',
            border: `1px solid ${search.count === 0 ? 'var(--border-subtle)' : 'rgba(244, 188, 46, 0.28)'}`,
          }}
        >
          {search.count === 0 ? tr('No results') : `${search.position}/${search.count}`}
        </span>
      )}
      {hint && !hasQuery && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{hint}</span>
      )}
      <button
        type="button"
        onClick={search.prev}
        disabled={search.count === 0}
        title={tr('Previous match')}
        className="chat-search-icon-btn transition-atelier"
        style={{ ...iconBtn, opacity: search.count ? 1 : 0.32 }}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={search.next}
        disabled={search.count === 0}
        title={tr('Next match')}
        className="chat-search-icon-btn transition-atelier"
        style={{ ...iconBtn, opacity: search.count ? 1 : 0.32 }}
      >
        <ChevronDown size={14} />
      </button>
      <span style={{ width: 1, height: 14, background: 'var(--border-subtle)', flexShrink: 0 }} />
      <button
        type="button"
        onClick={search.close}
        title={tr('Close search')}
        className="chat-search-icon-btn transition-atelier"
        style={iconBtn}
      >
        <X size={13.5} />
      </button>
    </div>
  );
}
