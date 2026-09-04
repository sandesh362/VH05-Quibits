/**
 * Canonical human labels + semantic tone for every status/severity enum used
 * in the app. Badges always render icon + text (never colour alone), and
 * unknown values fall back to a neutral presentation instead of crashing.
 */

export type Tone = 'ok' | 'info' | 'warn' | 'error' | 'neutral';

export interface StatusPresentation {
  icon: string;
  label: string;
  tone: Tone;
}

function map(entries: Record<string, StatusPresentation>, fallbackLabel?: (key: string) => string) {
  return (status: string): StatusPresentation =>
    entries[status] ?? {
      icon: '·',
      label: fallbackLabel ? fallbackLabel(status) : status.replace(/_/g, ' '),
      tone: 'neutral',
    };
}

export const incidentStatus = map({
  open: { icon: '◌', label: 'Open', tone: 'warn' },
  investigating: { icon: '▶', label: 'Investigating', tone: 'info' },
  waiting_for_information: { icon: '?', label: 'Waiting for information', tone: 'neutral' },
  waiting_for_parts: { icon: '▣', label: 'Waiting for parts', tone: 'neutral' },
  resolved: { icon: '✓', label: 'Resolved', tone: 'ok' },
  closed: { icon: '■', label: 'Closed', tone: 'ok' },
  reopened: { icon: '↻', label: 'Reopened', tone: 'warn' },
  cancelled: { icon: '✕', label: 'Cancelled', tone: 'error' },
});

export const issueStatus = map({
  unknown: { icon: '?', label: 'Unknown', tone: 'neutral' },
  investigating: { icon: '▶', label: 'Investigating', tone: 'info' },
  temporary_fix: { icon: '◐', label: 'Temporary fix in place', tone: 'warn' },
  resolved: { icon: '✓', label: 'Resolved', tone: 'ok' },
  unresolved: { icon: '✕', label: 'Unresolved', tone: 'error' },
  recurring: { icon: '↻', label: 'Recurring', tone: 'warn' },
  escalated: { icon: '↑', label: 'Escalated', tone: 'error' },
});

export const severity = map({
  low: { icon: '▁', label: 'Low', tone: 'ok' },
  medium: { icon: '▂', label: 'Medium', tone: 'info' },
  high: { icon: '▅', label: 'High', tone: 'warn' },
  critical: { icon: '▇', label: 'Critical', tone: 'error' },
});

export const priority = map({
  low: { icon: '▁', label: 'Low', tone: 'ok' },
  medium: { icon: '▂', label: 'Medium', tone: 'info' },
  high: { icon: '▅', label: 'High', tone: 'warn' },
  urgent: { icon: '▇', label: 'Urgent', tone: 'error' },
});

export const rootCauseStatus = map({
  unknown: { icon: '?', label: 'Unknown', tone: 'neutral' },
  suspected: { icon: '◐', label: 'Suspected', tone: 'warn' },
  confirmed: { icon: '✓', label: 'Confirmed', tone: 'ok' },
  rejected: { icon: '✕', label: 'Rejected', tone: 'error' },
});

export const fixStatus = map({
  recorded: { icon: '◌', label: 'Recorded', tone: 'info' },
  confirmed: { icon: '✓', label: 'Confirmed', tone: 'ok' },
  rejected: { icon: '✕', label: 'Rejected', tone: 'error' },
});

export const actionResultStatus = map({
  not_tested: { icon: '?', label: 'Not tested', tone: 'neutral' },
  successful: { icon: '✓', label: 'Successful', tone: 'ok' },
  unsuccessful: { icon: '✕', label: 'Unsuccessful', tone: 'error' },
  partially_successful: { icon: '◐', label: 'Partially successful', tone: 'warn' },
  inconclusive: { icon: '?', label: 'Inconclusive', tone: 'neutral' },
  temporary_improvement: { icon: '◐', label: 'Temporary improvement', tone: 'warn' },
  worsened_condition: { icon: '▲', label: 'Worsened condition', tone: 'error' },
});

export const processingStatus = map({
  queued: { icon: '◷', label: 'Queued', tone: 'neutral' },
  processing: { icon: '▶', label: 'Processing', tone: 'info' },
  extraction_failed: { icon: '✕', label: 'Extraction failed', tone: 'error' },
  ocr_failed: { icon: '✕', label: 'OCR failed', tone: 'error' },
  chunking_failed: { icon: '✕', label: 'Chunking failed', tone: 'error' },
  embedding_failed: { icon: '✕', label: 'Embedding failed', tone: 'error' },
  failed: { icon: '✕', label: 'Failed', tone: 'error' },
  completed: { icon: '✓', label: 'Completed — searchable', tone: 'ok' },
});

export const jobStatus = map({
  queued: { icon: '◷', label: 'Queued', tone: 'neutral' },
  running: { icon: '▶', label: 'Running', tone: 'info' },
  succeeded: { icon: '✓', label: 'Succeeded', tone: 'ok' },
  completed: { icon: '✓', label: 'Completed', tone: 'ok' },
  failed: { icon: '✕', label: 'Failed', tone: 'error' },
  cancelled: { icon: '✕', label: 'Cancelled', tone: 'neutral' },
  retrying: { icon: '↻', label: 'Retrying', tone: 'warn' },
});

export const machineStatus = map({
  operational: { icon: '●', label: 'Operational', tone: 'ok' },
  down: { icon: '■', label: 'Down', tone: 'error' },
  maintenance: { icon: '⚙', label: 'In maintenance', tone: 'warn' },
  retired: { icon: '○', label: 'Retired', tone: 'neutral' },
});

export const maintenanceType = map(
  {},
  (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
);

export const conversationStatus = map({
  active: { icon: '▶', label: 'Active', tone: 'info' },
  closed: { icon: '■', label: 'Closed', tone: 'neutral' },
  archived: { icon: '▤', label: 'Archived', tone: 'neutral' },
});

export const techActionStatus = map({
  planned: { icon: '◷', label: 'Planned', tone: 'neutral' },
  attempted: { icon: '▶', label: 'Attempted', tone: 'info' },
  completed: { icon: '✓', label: 'Completed', tone: 'ok' },
  failed: { icon: '✕', label: 'Failed', tone: 'error' },
  not_applicable: { icon: '—', label: 'Not applicable', tone: 'neutral' },
});

/** "Confirmed" / "Unconfirmed" pair used for historical evidence. */
export function confirmedPresentation(confirmed: boolean): StatusPresentation {
  return confirmed
    ? { icon: '✓', label: 'Confirmed', tone: 'ok' }
    : { icon: '◌', label: 'Unconfirmed', tone: 'neutral' };
}
