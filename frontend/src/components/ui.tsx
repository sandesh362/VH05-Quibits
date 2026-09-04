/**
 * Design-system UI kit.
 *
 * The standardized set of primitives every screen uses: buttons, fields,
 * cards, tabs, badges (semantic status tones), modal/drawer dialogs, dropdown
 * menu, tooltip, pagination, skeletons, progress bar, and a confirmation
 * dialog. All statuses are communicated with icon + text + tone, never colour
 * alone. Dialogs and menus implement the accessible dialog/menu pattern
 * (focus trap lite: focus moves to the dialog on open, Escape closes, focus
 * returns on close).
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { type StatusPresentation, type Tone } from '../lib/labels';
import { EmptyState, InlineSpinner } from './states';
import './ui.css';

// Re-exported so pages can pull the whole design system from one module.
export { EmptyState };

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      className={`btn btn--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <InlineSpinner label={typeof children === 'string' ? `${children}…` : 'Loading'} />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badge (semantic tone + icon + label)
// ---------------------------------------------------------------------------

export function Badge({
  presentation,
  size = 'md',
}: {
  presentation: StatusPresentation;
  size?: 'sm' | 'md';
}): JSX.Element {
  return (
    <span className={`badge badge--${presentation.tone} badge--${size}`}>
      <span className="badge__icon" aria-hidden="true">
        {presentation.icon}
      </span>
      <span>{presentation.label}</span>
    </span>
  );
}

export function ToneBadge({ tone, icon, label, size = 'md' }: { tone: Tone; icon: string; label: string; size?: 'sm' | 'md' }): JSX.Element {
  return <Badge presentation={{ tone, icon, label }} size={size} />;
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, required, error, hint, children, className = '' }: FieldProps): JSX.Element {
  const hintId = useId();
  const errorId = useId();
  const describedBy = error || hint ? `${error ? errorId : ''} ${hint && !error ? hintId : ''}`.trim() : undefined;

  let control = children;
  if (isValidElement(children)) {
    const injected: Record<string, unknown> = {};
    if (describedBy) injected['aria-describedby'] = describedBy;
    if (error) injected['aria-invalid'] = true;
    control = cloneElement(children as ReactElement<Record<string, unknown>>, injected);
  }

  return (
    <div className={`field ${error ? 'field--invalid' : ''} ${className}`.trim()}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {control}
      {hint && !error && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input {...props} className={`input ${props.className ?? ''}`.trim()} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select {...props} className={`input select ${props.className ?? ''}`.trim()} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`.trim()} />;
}

/** Password input with an accessible show/hide toggle. */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={visible ? 'text' : 'password'} className="input" />
      <button
        type="button"
        className="password-input__toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? '🙈' : '👁'}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card / stat tile / page header / breadcrumbs
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}): JSX.Element {
  return (
    <section className={`card ${className}`.trim()} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: string; to?: string }>;
}): JSX.Element {
  return (
    <header className="page-header">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <ol>
            {breadcrumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`}>
                {crumb.to && index < breadcrumbs.length - 1 ? (
                  <a href={crumb.to}>{crumb.label}</a>
                ) : (
                  <span aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>
                    {crumb.label}
                  </span>
                )}
                {index < breadcrumbs.length - 1 && (
                  <span className="breadcrumbs__sep" aria-hidden="true">
                    /
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="page-header__row">
        <div>
          <h1>{title}</h1>
          {description && <p className="page-header__desc">{description}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
    </header>
  );
}

export function StatTile({
  label,
  value,
  tone,
  icon,
  to,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  icon?: string;
  to?: string;
}): JSX.Element {
  const content = (
    <>
      <span className={`stat-tile__icon ${tone ? `stat-tile__icon--${tone}` : ''}`} aria-hidden="true">
        {icon ?? '·'}
      </span>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__label">{label}</span>
    </>
  );
  return to ? (
    <a className={`stat-tile ${tone ? `stat-tile--${tone}` : ''}`.trim()} href={to}>
      {content}
    </a>
  ) : (
    <div className={`stat-tile ${tone ? `stat-tile--${tone}` : ''}`.trim()}>{content}</div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; count?: number }>;
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  return (
    <div className="tabs" role="tablist" aria-label="Sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`tabpanel-${tab.id}`}
          className={`tabs__tab ${active === tab.id ? 'tabs__tab--active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tabs__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, active, children }: { id: string; active: string; children: ReactNode }): JSX.Element | null {
  if (active !== id) return null;
  return (
    <div role="tabpanel" id={`tabpanel-${id}`} aria-labelledby={`tab-${id}`} className="tab-panel">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal dialog (accessible: focus move, Escape, backdrop click, labelled)
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab' && node) {
        const focusables = node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('dialog-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('dialog-open');
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`dialog dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog__header">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          <button type="button" className="dialog__close" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Side drawer, same accessibility contract as Modal. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const node = drawerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('dialog-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('dialog-open');
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="drawer__header">
          <h2 id={titleId} className="drawer__title">
            {title}
          </h2>
          <button type="button" className="dialog__close" aria-label="Close panel" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__footer">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog (destructive / high-impact actions)
// ---------------------------------------------------------------------------

const CONFIRM_NOTE_ID = 'confirm-dialog-note';

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  requireNote = false,
  noteLabel = 'Reason / note',
  noteRequired = true,
  loading = false,
  irreversible = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void | Promise<void>;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  requireNote?: boolean;
  noteLabel?: string;
  noteRequired?: boolean;
  loading?: boolean;
  irreversible?: boolean;
}): JSX.Element {
  const [note, setNote] = useState('');
  const noteMissing = requireNote && noteRequired && note.trim().length < 3;

  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            disabled={noteMissing}
            onClick={() => void onConfirm(note.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-body">
        {children}
        {irreversible && (
          <p className="alert alert--warn" role="note">
            <span aria-hidden="true">▲</span> This action cannot be undone.
          </p>
        )}
        {requireNote && (
          <Field
            label={noteLabel}
            htmlFor={CONFIRM_NOTE_ID}
            required={noteRequired}
            error={noteMissing ? 'A note of at least 3 characters is required.' : null}
          >
            <TextArea id={CONFIRM_NOTE_ID} value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu (accessible: button trigger, Escape closes, click-away closes)
// ---------------------------------------------------------------------------

export function DropdownMenu({
  label,
  items,
  align = 'right',
}: {
  label: ReactNode;
  items: Array<{ node: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }>;
  align?: 'left' | 'right';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className="btn btn--ghost dropdown__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className={`dropdown__menu dropdown__menu--${align}`} role="menu">
          {items.map((item, index) => (
            <button
              key={index}
              type="button"
              role="menuitem"
              className={`dropdown__item ${item.danger ? 'dropdown__item--danger' : ''}`.trim()}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
            >
              {item.node}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip (title-attribute fallback plus a styled hint; accessible label via aria)
// ---------------------------------------------------------------------------

export function Tooltip({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  return (
    <span className="tooltip" tabIndex={0} aria-label={text} title={text}>
      {children}
      <span className="tooltip__body" role="tooltip">
        {text}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}): JSX.Element {
  if (total === 0) return <></>;
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination__summary">
        Page {page} of {Math.max(totalPages, 1)} · {total} total
      </span>
      <span className="pagination__controls">
        <Button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          ← Prev
        </Button>
        <Button onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="Next page">
          Next →
        </Button>
      </span>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Skeletons & progress
// ---------------------------------------------------------------------------

export function Skeleton({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton__line" style={{ width: `${100 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }): JSX.Element {
  return (
    <div className="skeleton-table" role="status" aria-label="Loading table">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="skeleton-table__row">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="skeleton-table__cell" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <div className="progress__bar" style={{ width: `${clamped}%` }} />
      <span className="progress__label">{label ?? `${clamped}%`}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function Alert({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  const icons: Record<Tone, string> = { ok: '✓', info: 'ℹ', warn: '▲', error: '✕', neutral: '·' };
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'note'}>
      <span aria-hidden="true">{icons[tone]}</span>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key-value description list
// ---------------------------------------------------------------------------

export function DescriptionList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}): JSX.Element {
  return (
    <dl className="desc-list">
      {items.map((item) => (
        <div className="desc-list__row" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
