interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** Small pill toggle (Claude-style). */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      style={{
        position: 'relative',
        width: 30,
        height: 18,
        borderRadius: 'var(--radius-full)',
        flexShrink: 0,
        background: checked ? 'var(--agent-blue)' : 'var(--surface-3)',
        border: checked ? '1px solid transparent' : '1px solid var(--border-default)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 160ms var(--ease-atelier)',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 1,
          left: 1,
          width: 14,
          height: 14,
          borderRadius: '9999px',
          background: '#fff',
          transform: `translateX(${checked ? 12 : 0}px)`,
          transition: 'transform 160ms var(--ease-atelier)',
        }}
      />
    </button>
  );
}
