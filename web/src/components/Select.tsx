import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { inputStyle } from './modals/ModalShell';

export interface SelectOption {
  value: string;
  label: string;
  /** small secondary text shown on the right of the option */
  hint?: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

const PANEL_MAX_HEIGHT = 260;
const GAP = 6;

/**
 * Themed dropdown (replaces the native <select>).
 * - panel is portalled to <body> so modals with overflow:auto never clip it
 * - flips above the trigger when there is no room below
 * - keyboard: ↑ ↓ Home End Enter Space Esc Tab, plus type-ahead
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();

  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 12;
    const above = r.top - GAP - 12;
    const wanted = Math.min(PANEL_MAX_HEIGHT, options.length * 34 + 10);
    const flip = below < wanted && above > below;
    setPos(
      flip
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP }
        : { left: r.left, width: r.width, top: r.bottom + GAP },
    );
  }, [options.length]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt) return;
      onChange(opt.value);
      close();
    },
    [options, onChange, close],
  );

  const openPanel = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    place();
    setOpen(true);
  };

  // keep the panel attached to the trigger while open
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  // outside click closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // While open, handle keys at window level (capture) so it works wherever focus is,
  // and so Esc closes only the dropdown, not the modal behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const swallow = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case 'Escape':
          swallow();
          close();
          return;
        case 'ArrowDown':
          swallow();
          setActive((i) => Math.min(options.length - 1, i + 1));
          return;
        case 'ArrowUp':
          swallow();
          setActive((i) => Math.max(0, i - 1));
          return;
        case 'Home':
          swallow();
          setActive(0);
          return;
        case 'End':
          swallow();
          setActive(options.length - 1);
          return;
        case 'Enter':
        case ' ':
          swallow();
          choose(active);
          return;
        case 'Tab':
          close(false);
          return;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const now = Date.now();
            typed.current.text = now - typed.current.at > 600 ? e.key : typed.current.text + e.key;
            typed.current.at = now;
            const q = typed.current.text.toLowerCase();
            const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(q));
            if (hit >= 0) setActive(hit);
          }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, active, options, close, choose]);

  // keep the active option in view
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open, pos]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || open) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openPanel();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onKeyDown}
        className="select-trigger"
        data-open={open || undefined}
        style={{
          ...inputStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          textAlign: 'left',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          style={{
            flexShrink: 0,
            color: 'var(--text-tertiary)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 160ms var(--ease-atelier)',
          }}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            className="select-panel"
            style={{
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: PANEL_MAX_HEIGHT,
              transformOrigin: pos.bottom !== undefined ? 'bottom center' : 'top center',
            }}
          >
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              return (
                <div
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  data-index={i}
                  data-active={i === active || undefined}
                  className="select-option"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {opt.label}
                  </span>
                  {opt.hint && (
                    <span className="mono-num" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {opt.hint}
                    </span>
                  )}
                  {isSelected && (
                    <Check size={14} strokeWidth={2} style={{ color: 'var(--agent-green)', flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
