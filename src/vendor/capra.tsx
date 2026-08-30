/**
 * Local stand-in for @capra/core's Button and Modal — the only pieces
 * the vendored investigator shell uses. Styled with the app's CDS
 * tokens so the shell matches the rest of the app without pulling a
 * second component library through esm.sh.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'tertiary';
type Size = 'sm' | 'md';
type Appearance = 'default' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  appearance?: Appearance;
  /** Escape hatch the investigator shell uses to add its own class. */
  FORCE__className?: string;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'background:var(--cds-color-accent,#0190ff);color:#fff;border:1px solid transparent;',
  secondary: 'background:var(--cds-color-bg,#fff);color:var(--cds-color-fg,#1a1a2e);border:1px solid var(--cds-color-border,#d4d6db);',
  tertiary: 'background:transparent;color:var(--cds-color-accent,#0190ff);border:1px solid transparent;text-decoration:underline;text-underline-offset:3px;',
};

const DANGER = 'color:#b3403c;border-color:#e3b6b3;';
const SIZES: Record<Size, string> = {
  sm: 'height:26px;padding:0 10px;font-size:12px;',
  md: 'height:32px;padding:0 14px;font-size:13px;',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  appearance = 'default',
  FORCE__className,
  style,
  ...rest
}: ButtonProps) {
  const css = `${VARIANTS[variant]}${SIZES[size]}${appearance === 'danger' ? DANGER : ''}`
    + 'border-radius:4px;font-weight:500;cursor:pointer;font-family:inherit;'
    + 'display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;';
  return (
    <button
      type="button"
      className={FORCE__className}
      style={{ ...cssToStyle(css), ...(style ?? {}) }}
      {...rest}
    />
  );
}

function cssToStyle(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[prop] = decl.slice(i + 1).trim();
  }
  return out;
}

export interface ModalProps {
  isOpen: boolean;
  onIsOpenChange: (open: boolean) => void;
  title: string;
  size?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
  children?: ReactNode;
}

const WIDTHS = { sm: 360, md: 520, lg: 900 } as const;

export function Modal({ isOpen, onIsOpenChange, title, size = 'md', footer, children }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div
      role="presentation"
      onClick={() => onIsOpenChange(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(27,31,59,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--cds-color-bg,#fff)', borderRadius: 8, width: WIDTHS[size],
          maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 40px rgba(16,18,35,.25)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--cds-color-border-subtle,#e8eaed)',
        }}>
          <strong style={{ fontSize: 14, color: 'var(--cds-color-fg,#1a1a2e)' }}>{title}</strong>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onIsOpenChange(false)}
            style={{
              border: 0, background: 'transparent', cursor: 'pointer', fontSize: 16,
              lineHeight: 1, color: 'var(--cds-color-fg-subtle,#8b8d98)', padding: 4,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 16, overflow: 'auto' }}>{children}</div>
        {footer != null && (
          <div style={{
            padding: '12px 16px', borderTop: '1px solid var(--cds-color-border-subtle,#e8eaed)',
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
