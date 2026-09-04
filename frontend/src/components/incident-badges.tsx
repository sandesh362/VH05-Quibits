/**
 * Incident-specific badges.
 *
 * Same convention as StatusBadge: colour + icon + text label together, never
 * colour alone. Unknown values fall back to a neutral presentation rather
 * than crashing the list.
 */
import './incidents.css';

const NEUTRAL = { icon: '·', label: 'Unknown', className: 'neutral' };

function present(
  status: string,
  map: Record<string, { icon: string; label: string; className: string }>,
): { icon: string; label: string; className: string } {
  return map[status] ?? { ...NEUTRAL, label: status.replace(/_/g, ' ') };
}

const INCIDENT_STATUS: Record<string, { icon: string; label: string; className: string }> = {
  open: { icon: '◌', label: 'Open', className: 'warn' },
  investigating: { icon: '▶', label: 'Investigating', className: 'info' },
  waiting_for_information: { icon: '?', label: 'Waiting for information', className: 'neutral' },
  waiting_for_parts: { icon: '▣', label: 'Waiting for parts', className: 'neutral' },
  resolved: { icon: '✓', label: 'Resolved', className: 'ok' },
  closed: { icon: '■', label: 'Closed', className: 'ok' },
  reopened: { icon: '↻', label: 'Reopened', className: 'warn' },
  cancelled: { icon: '✕', label: 'Cancelled', className: 'error' },
};

const ISSUE_STATUS: Record<string, { icon: string; label: string; className: string }> = {
  unknown: { icon: '?', label: 'Unknown', className: 'neutral' },
  investigating: { icon: '▶', label: 'Investigating', className: 'info' },
  temporary_fix: { icon: '◐', label: 'Temporary fix', className: 'warn' },
  resolved: { icon: '✓', label: 'Resolved', className: 'ok' },
  unresolved: { icon: '✕', label: 'Unresolved', className: 'error' },
  recurring: { icon: '↻', label: 'Recurring', className: 'warn' },
  escalated: { icon: '↑', label: 'Escalated', className: 'error' },
};

const SEVERITY: Record<string, { icon: string; label: string; className: string }> = {
  low: { icon: '▁', label: 'Low', className: 'ok' },
  medium: { icon: '▂', label: 'Medium', className: 'info' },
  high: { icon: '▅', label: 'High', className: 'warn' },
  critical: { icon: '▇', label: 'Critical', className: 'error' },
};

const PRIORITY: Record<string, { icon: string; label: string; className: string }> = {
  low: { icon: '▁', label: 'Low', className: 'ok' },
  medium: { icon: '▂', label: 'Medium', className: 'info' },
  high: { icon: '▅', label: 'High', className: 'warn' },
  urgent: { icon: '▇', label: 'Urgent', className: 'error' },
};

const ROOT_CAUSE: Record<string, { icon: string; label: string; className: string }> = {
  unknown: { icon: '?', label: 'Unknown', className: 'neutral' },
  suspected: { icon: '◐', label: 'Suspected', className: 'warn' },
  confirmed: { icon: '✓', label: 'Confirmed', className: 'ok' },
  rejected: { icon: '✕', label: 'Rejected', className: 'error' },
};

interface BadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

function Badge({
  status,
  presentation,
  size = 'md',
}: BadgeProps & { presentation: { icon: string; label: string; className: string } }) {
  return (
    <span
      className={`ibadge ibadge--${presentation.className} ibadge--${size}`}
      data-status={status}
    >
      <span className="ibadge__icon" aria-hidden="true">
        {presentation.icon}
      </span>
      {presentation.label}
    </span>
  );
}

export function IncidentStatusBadge({ status, size }: BadgeProps): JSX.Element {
  return <Badge status={status} presentation={present(status, INCIDENT_STATUS)} size={size} />;
}

export function IssueStatusBadge({ status, size }: BadgeProps): JSX.Element {
  return <Badge status={status} presentation={present(status, ISSUE_STATUS)} size={size} />;
}

export function SeverityBadge({ status, size }: BadgeProps): JSX.Element {
  return <Badge status={status} presentation={present(status, SEVERITY)} size={size} />;
}

export function PriorityBadge({ status, size }: BadgeProps): JSX.Element {
  return <Badge status={status} presentation={present(status, PRIORITY)} size={size} />;
}

export function RootCauseStatusBadge({ status, size }: BadgeProps): JSX.Element {
  return <Badge status={status} presentation={present(status, ROOT_CAUSE)} size={size} />;
}

export function ConfirmedBadge({ confirmed, size = 'sm' }: { confirmed: boolean; size?: 'sm' | 'md' }): JSX.Element {
  return confirmed ? (
    <Badge status="confirmed" presentation={present('confirmed', ROOT_CAUSE)} size={size} />
  ) : (
    <span
      className={`ibadge ibadge--neutral ibadge--${size}`}
      data-status="unconfirmed"
    >
      <span className="ibadge__icon" aria-hidden="true">
        ◌
      </span>
      Unconfirmed
    </span>
  );
}
