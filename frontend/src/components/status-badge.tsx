/**
 * Dependency status badge.
 *
 * Uses colour + icon + text label together, never colour alone: shop-floor
 * screens wash out, and ~8% of male technicians have a colour vision
 * deficiency.
 */
import type { DependencyStatus, ServiceStatus } from '@itp/shared';
import './status-badge.css';

type AnyStatus = DependencyStatus | ServiceStatus;

const PRESENTATION: Record<AnyStatus, { icon: string; label: string; className: string }> = {
  ok: { icon: '●', label: 'Operational', className: 'ok' },
  degraded: { icon: '▲', label: 'Degraded', className: 'warn' },
  down: { icon: '■', label: 'Unavailable', className: 'error' },
  disabled: { icon: '○', label: 'Not configured', className: 'neutral' },
  unknown: { icon: '?', label: 'Unknown', className: 'neutral' },
};

interface Props {
  status: AnyStatus;
  /** Override the default label text. */
  label?: string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, label, size = 'md' }: Props): JSX.Element {
  const presentation = PRESENTATION[status] ?? PRESENTATION.unknown;

  return (
    <span
      className={`badge badge--${presentation.className} badge--${size}`}
      data-status={status}
    >
      <span className="badge__icon" aria-hidden="true">
        {presentation.icon}
      </span>
      {label ?? presentation.label}
    </span>
  );
}
