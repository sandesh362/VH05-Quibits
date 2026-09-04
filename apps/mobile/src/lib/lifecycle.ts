/**
 * Lifecycle transition mirrors of backend/src/modules/incidents/incidents.lifecycle.ts.
 * The API validates transitions itself; this mirror only shapes the UI
 * (which buttons are offered).
 */
import type { IncidentStatus, IssueStatus } from '@itp/shared';

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

export const ISSUE_STATUS_TRANSITIONS: Readonly<Record<IssueStatus, ReadonlySet<IssueStatus>>> =
  Object.freeze({
    unknown: new Set<IssueStatus>(['investigating']),
    investigating: new Set<IssueStatus>(['temporary_fix', 'resolved', 'unresolved', 'escalated']),
    temporary_fix: new Set<IssueStatus>(['investigating', 'resolved', 'unresolved', 'recurring']),
    resolved: new Set<IssueStatus>(['recurring', 'unresolved']),
    unresolved: new Set<IssueStatus>(['investigating', 'escalated', 'temporary_fix']),
    recurring: new Set<IssueStatus>(['investigating', 'temporary_fix', 'resolved']),
    escalated: new Set<IssueStatus>(['investigating', 'resolved', 'unresolved']),
  });
