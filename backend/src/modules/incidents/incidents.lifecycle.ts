/**
 * Incident lifecycle: explicit, validated status transitions.
 *
 * Arbitrary status changes are rejected. Every transition must appear in one
 * of the maps below, and every transition records previous status, new status,
 * actor, note and timestamp on the incident timeline (plus an audit entry).
 *
 * See docs/INCIDENT_LIFECYCLE.md for the reasoning behind each allowed edge.
 */
import type { IncidentStatus, IssueStatus } from '@itp/shared';

/** Allowed workflow status transitions. */
export const INCIDENT_STATUS_TRANSITIONS: Readonly<Record<IncidentStatus, ReadonlySet<IncidentStatus>>> =
  Object.freeze({
    open: new Set<IncidentStatus>(['investigating', 'cancelled']),
    investigating: new Set<IncidentStatus>([
      'waiting_for_information',
      'waiting_for_parts',
      'resolved',
      'cancelled',
    ]),
    waiting_for_information: new Set<IncidentStatus>(['investigating', 'cancelled']),
    waiting_for_parts: new Set<IncidentStatus>(['investigating', 'resolved', 'cancelled']),
    resolved: new Set<IncidentStatus>(['closed', 'reopened']),
    closed: new Set<IncidentStatus>(['reopened']),
    reopened: new Set<IncidentStatus>(['investigating', 'cancelled']),
    cancelled: new Set<IncidentStatus>([]),
  });

/**
 * Allowed issue-status transitions. Issue status is a second axis to workflow
 * status: a resolved issue on a cancelled incident is still a fact.
 */
export const ISSUE_STATUS_TRANSITIONS: Readonly<Record<IssueStatus, ReadonlySet<IssueStatus>>> =
  Object.freeze({
    unknown: new Set<IssueStatus>(['investigating']),
    investigating: new Set<IssueStatus>([
      'temporary_fix',
      'resolved',
      'unresolved',
      'escalated',
    ]),
    temporary_fix: new Set<IssueStatus>(['investigating', 'resolved', 'unresolved', 'recurring']),
    resolved: new Set<IssueStatus>(['recurring', 'unresolved']),
    unresolved: new Set<IssueStatus>(['investigating', 'escalated', 'temporary_fix']),
    recurring: new Set<IssueStatus>(['investigating', 'temporary_fix', 'resolved']),
    escalated: new Set<IssueStatus>(['investigating', 'resolved', 'unresolved']),
  });

export function canTransitionStatus(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_STATUS_TRANSITIONS[from]?.has(to) ?? false;
}

export function canTransitionIssueStatus(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_STATUS_TRANSITIONS[from]?.has(to) ?? false;
}

/** Statuses in which the incident is considered active work. */
export const ACTIVE_STATUSES: readonly IncidentStatus[] = [
  'open',
  'investigating',
  'waiting_for_information',
  'waiting_for_parts',
  'reopened',
];

/** Statuses after which new technician work is finished. */
export const SETTLED_STATUSES: readonly IncidentStatus[] = ['resolved', 'closed'];

export function isActiveStatus(status: IncidentStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isSettledStatus(status: IncidentStatus): boolean {
  return (SETTLED_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that set `resolved_at`. Only these release the "open incident"
 * state on the machine.
 */
export const RESOLVING_STATUSES: readonly IncidentStatus[] = ['resolved', 'closed'];
