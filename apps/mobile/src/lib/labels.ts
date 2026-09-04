/**
 * Canonical human labels + semantic tone for every status/severity enum.
 *
 * Mirrors the web app (frontend/src/lib/labels.ts): badges always render
 * icon + text + tone, and unknown values fall back to a neutral presentation
 * instead of crashing or hiding information.
 */
import type { Tone } from '@/theme/tokens';

export interface StatusPresentation {
  icon: string;
  label: string;
  tone: Tone;
}

const FALLBACK_PRESENTATION = {
  icon: '·',
  tone: 'neutral' as const,
};

function map(entries: Record<string, StatusPresentation>) {
  return (status: string | null | undefined): StatusPresentation =>
    (status ? entries[status] : undefined) ?? {
      ...FALLBACK_PRESENTATION,
      label: status ? status.replace(/_/g, ' ') : 'Unknown',
    };
}

export const incidentStatus = map({
  open: { icon: '◌', label: 'Open', tone: 'warn' },
  investigating: { icon: '▶', label: 'Investigating', tone: 'info' },
  waiting_for_information: { icon: '?', label: 'Waiting for info', tone: 'neutral' },
  waiting_for_parts: { icon: '▣', label: 'Waiting for parts', tone: 'neutral' },
  resolved: { icon: '✓', label: 'Resolved', tone: 'ok' },
  closed: { icon: '■', label: 'Closed', tone: 'ok' },
  reopened: { icon: '↻', label: 'Reopened', tone: 'warn' },
  cancelled: { icon: '✕', label: 'Cancelled', tone: 'error' },
});

export const issueStatus = map({
  unknown: { icon: '?', label: 'Unknown', tone: 'neutral' },
  investigating: { icon: '▶', label: 'Investigating', tone: 'info' },
  temporary_fix: { icon: '◐', label: 'Temp fix in place', tone: 'warn' },
  resolved: { icon: '✓', label: 'Resolved', tone: 'ok' },
  unresolved: { icon: '✕', label: 'Unresolved', tone: 'error' },
  recurring: { icon: '↻', label: 'Recurring', tone: 'error' },
  escalated: { icon: '▲', label: 'Escalated', tone: 'error' },
});

export const severity = map({
  low: { icon: '▽', label: 'Low', tone: 'neutral' },
  medium: { icon: '▷', label: 'Medium', tone: 'info' },
  high: { icon: '△', label: 'High', tone: 'warn' },
  critical: { icon: '⯅', label: 'Critical', tone: 'error' },
});

export const priority = map({
  low: { icon: '↓', label: 'Low', tone: 'neutral' },
  medium: { icon: '→', label: 'Medium', tone: 'info' },
  high: { icon: '↑', label: 'High', tone: 'warn' },
  urgent: { icon: '⇈', label: 'Urgent', tone: 'error' },
});

export const rootCauseStatus = map({
  unknown: { icon: '?', label: 'Unknown', tone: 'neutral' },
  suspected: { icon: '∼', label: 'Suspected', tone: 'warn' },
  confirmed: { icon: '✓', label: 'Confirmed', tone: 'ok' },
  rejected: { icon: '✕', label: 'Rejected', tone: 'error' },
});

export const fixStatus = map({
  recorded: { icon: '○', label: 'Recorded (unconfirmed)', tone: 'warn' },
  confirmed: { icon: '✓', label: 'Confirmed', tone: 'ok' },
  rejected: { icon: '✕', label: 'Rejected', tone: 'error' },
});

export const actionResultStatus = map({
  not_tested: { icon: '○', label: 'Not tested', tone: 'neutral' },
  successful: { icon: '✓', label: 'Successful', tone: 'ok' },
  unsuccessful: { icon: '✕', label: 'Unsuccessful', tone: 'error' },
  partially_successful: { icon: '◐', label: 'Partially successful', tone: 'warn' },
  inconclusive: { icon: '?', label: 'Inconclusive', tone: 'neutral' },
  temporary_improvement: { icon: '◐', label: 'Temporary improvement', tone: 'warn' },
  worsened_condition: { icon: '▲', label: 'Worsened', tone: 'error' },
});

export const actionSourceType = map({
  technician: { icon: '👤', label: 'Technician', tone: 'info' },
  assistant_suggestion: { icon: '✦', label: 'AI suggestion', tone: 'neutral' },
  manual: { icon: '▤', label: 'From manual', tone: 'neutral' },
  other: { icon: '·', label: 'Other', tone: 'neutral' },
});

export const machineStatus = map({
  operational: { icon: '✓', label: 'Operational', tone: 'ok' },
  down: { icon: '✕', label: 'Down', tone: 'error' },
  maintenance: { icon: '▣', label: 'In maintenance', tone: 'warn' },
  retired: { icon: '■', label: 'Retired', tone: 'neutral' },
});

export const processingStatus = map({
  uploaded: { icon: '○', label: 'Uploaded', tone: 'neutral' },
  queued: { icon: '○', label: 'Queued', tone: 'neutral' },
  processing: { icon: '◐', label: 'Processing', tone: 'info' },
  extracting_text: { icon: '◐', label: 'Extracting text', tone: 'info' },
  ocr_processing: { icon: '◐', label: 'OCR', tone: 'info' },
  cleaning_text: { icon: '◐', label: 'Cleaning text', tone: 'info' },
  chunking: { icon: '◐', label: 'Chunking', tone: 'info' },
  embedding: { icon: '◐', label: 'Embedding', tone: 'info' },
  indexing: { icon: '◐', label: 'Indexing', tone: 'info' },
  completed: { icon: '✓', label: 'Searchable', tone: 'ok' },
  failed: { icon: '✕', label: 'Failed', tone: 'error' },
  cancelled: { icon: '✕', label: 'Cancelled', tone: 'neutral' },
});

export const conversationStatus = map({
  active: { icon: '●', label: 'Active', tone: 'ok' },
  closed: { icon: '■', label: 'Closed', tone: 'neutral' },
  archived: { icon: '▣', label: 'Archived', tone: 'neutral' },
});

/** RAG answer status → presentation. Refusals are shown verbatim, never softened. */
export const ragStatus = map({
  answered: { icon: '✓', label: 'Answered', tone: 'ok' },
  retrieved: { icon: '▤', label: 'Retrieved', tone: 'info' },
  clarification_required: { icon: '?', label: 'Clarification needed', tone: 'warn' },
  insufficient_evidence: { icon: '✕', label: 'Insufficient evidence', tone: 'error' },
  conflicting_evidence: { icon: '▲', label: 'Conflicting evidence', tone: 'warn' },
  processing_unavailable: { icon: '⊘', label: 'Service unavailable', tone: 'error' },
  generation_failed: { icon: '✕', label: 'Generation failed', tone: 'error' },
});

export const syncOpStatus = map({
  pending: { icon: '○', label: 'Pending', tone: 'warn' },
  syncing: { icon: '◐', label: 'Syncing', tone: 'info' },
  completed: { icon: '✓', label: 'Synced', tone: 'ok' },
  failed: { icon: '✕', label: 'Failed', tone: 'error' },
  requires_review: { icon: '▲', label: 'Needs review', tone: 'error' },
});

export const outboxOpLabel: Record<string, string> = {
  create_incident: 'Create incident',
  update_incident: 'Update incident',
  create_action: 'Record action',
  confirm_action: 'Confirm action result',
  change_status: 'Change incident status',
  change_issue_status: 'Change issue status',
  update_root_cause: 'Update root cause (suspected)',
  confirm_root_cause: 'Confirm root cause',
  reject_root_cause: 'Reject root cause',
  record_temporary_fix: 'Record temporary fix',
  confirm_temporary_fix: 'Confirm temporary fix',
  record_permanent_fix: 'Record permanent fix',
  confirm_permanent_fix: 'Confirm permanent fix',
  close_incident: 'Close incident',
  reopen_incident: 'Reopen incident',
};
