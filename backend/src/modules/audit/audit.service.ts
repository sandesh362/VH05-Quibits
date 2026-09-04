/**
 * Audit logging.
 *
 * Append-only by construction: this module exposes `record` and read helpers,
 * and there is no update or delete path anywhere in the codebase (Phase 0 X9).
 *
 * WHAT IS NEVER WRITTEN HERE: passwords, password hashes, tokens, refresh
 * tokens, connection strings, document contents. `changes` is built from a
 * per-entity ALLOWLIST rather than a blanket diff, because a blanket diff will
 * eventually pick up a sensitive field the day someone adds one.
 */
import type { Db, ObjectId } from 'mongodb';
import { collections, type AuditLogDoc } from '../../database/collections.js';
import { getLogger } from '../../core/logger.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditSeverity = 'info' | 'notice' | 'warning' | 'security';

export interface AuditActor {
  id?: ObjectId | null;
  username?: string | null;
  role?: string | null;
}

export interface AuditInput {
  action: string;
  actor?: AuditActor | null;
  entityType?: string;
  entityId?: ObjectId | null;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  requestId?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Fields safe to record in `changes`, per entity type.
 * Anything not listed is dropped, silently and deliberately.
 */
const CHANGE_ALLOWLIST: Record<string, readonly string[]> = {
  user: ['role', 'is_active', 'full_name', 'email', 'username', 'must_change_password'],
  machine_model: ['manufacturer', 'model_name', 'machine_type', 'default_language', 'notes', 'aliases'],
  machine: [
    'asset_tag', 'display_name', 'machine_model_id', 'serial_number', 'status',
    'criticality', 'location', 'notes',
  ],
  manual: [
    'title', 'description', 'manufacturer', 'document_type', 'document_number',
    'document_version', 'revision', 'language', 'machine_model_id', 'machine_id',
    'is_current_version', 'scope', 'is_active',
  ],
  incident: [
    'title', 'description', 'status', 'issue_status', 'severity', 'priority',
    'assigned_to', 'error_codes', 'root_cause', 'temporary_fix', 'permanent_fix',
    'resolution_summary', 'machine_id', 'machine_model_id', 'symptoms',
    'operating_conditions', 'tags', 'conversation_id', 'manual_id',
  ],
  incident_action: [
    'action_type', 'description', 'result', 'result_status', 'confirmed',
    'confirmed_by', 'performed_at', 'notes',
  ],
  maintenance_record: [
    'maintenance_type', 'title', 'performed_at', 'work_order_ref', 'next_due_at',
    'duration_minutes', 'downtime_minutes',
  ],
  conversation: [
    'title',
    'status',
    'machine_id',
    'machine_model_id',
    'manual_id',
    'manual_version',
    'issue_status',
    'issue_summary',
  ],
  conversation_action: ['action', 'result', 'status', 'performed_at'],
};

const MAX_VALUE_LENGTH = 200;

/** Truncate and flatten a value so one audit row cannot become unbounded. */
function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > MAX_VALUE_LENGTH ? `${json.slice(0, MAX_VALUE_LENGTH)}…` : json;
  }
  const asString = String(value);
  return asString.length > MAX_VALUE_LENGTH ? `${asString.slice(0, MAX_VALUE_LENGTH)}…` : asString;
}

/**
 * Build an allowlisted change set from a before/after pair.
 * Only fields that actually differ are recorded.
 */
export function buildChanges(
  entityType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const allowed = CHANGE_ALLOWLIST[entityType] ?? [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of allowed) {
    if (!(field in after)) continue;

    const from = before[field];
    const to = after[field];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;

    changes[field] = { from: safeValue(from), to: safeValue(to) };
  }

  return changes;
}

/**
 * Write an audit entry.
 *
 * Never throws. An audit failure must not roll back or 500 the business
 * operation that succeeded - it is logged loudly instead. The alternative
 * (failing the request) would make the audit system an availability risk.
 */
export async function record(db: Db, input: AuditInput): Promise<void> {
  const entry: Omit<AuditLogDoc, '_id'> = {
    at: new Date(),
    actor_id: input.actor?.id ?? null,
    actor_role: input.actor?.role ?? null,
    actor_username: input.actor?.username ?? null,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    outcome: input.outcome ?? 'success',
    severity: input.severity ?? 'info',
    request_id: input.requestId ?? null,
    changes: input.changes && Object.keys(input.changes).length > 0 ? input.changes : null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
  };

  try {
    await collections.auditLogs(db).insertOne(entry as AuditLogDoc);
  } catch (error) {
    getLogger().error(
      { err: error instanceof Error ? error.message : String(error), action: input.action },
      'Failed to write audit log entry',
    );
  }
}

/** Canonical action names. Constants prevent typo-driven audit gaps. */
export const AUDIT_ACTIONS = {
  loginSuccess: 'auth.login.success',
  loginFailure: 'auth.login.failure',
  loginLocked: 'auth.login.locked',
  logout: 'auth.logout',
  register: 'auth.register',
  userCreated: 'user.created',
  userRoleChanged: 'user.role_changed',
  userUpdated: 'user.updated',
  passwordChanged: 'user.password_changed',
  machineModelCreated: 'machine_model.created',
  machineModelUpdated: 'machine_model.updated',
  machineModelDeleted: 'machine_model.deleted',
  machineCreated: 'machine.created',
  machineUpdated: 'machine.updated',
  machineDeleted: 'machine.deleted',
  machineModelChanged: 'machine.model_changed',
  manualCreated: 'manual.created',
  manualUpdated: 'manual.updated',
  manualDeleted: 'manual.deleted',
  manualUploaded: 'manual.uploaded',
  manualProcessingStarted: 'manual.processing_started',
  manualProcessingCompleted: 'manual.processing_completed',
  manualProcessingFailed: 'manual.processing_failed',
  manualReprocessingRequested: 'manual.reprocessing_requested',
  manualProcessingRetried: 'manual.processing_retried',
  manualIndexDeleted: 'manual.index_deleted',
  incidentCreated: 'incident.created',
  incidentUpdated: 'incident.updated',
  incidentLinked: 'incident.linked',
  incidentDeleted: 'incident.deleted',
  incidentActionRecorded: 'incident.action_recorded',
  incidentActionUpdated: 'incident.action_updated',
  incidentActionConfirmed: 'incident.action_confirmed',
  incidentRootCauseUpdated: 'incident.root_cause_updated',
  incidentRootCauseConfirmed: 'incident.root_cause_confirmed',
  incidentRootCauseRejected: 'incident.root_cause_rejected',
  incidentTemporaryFixRecorded: 'incident.temporary_fix_recorded',
  incidentTemporaryFixConfirmed: 'incident.temporary_fix_confirmed',
  incidentPermanentFixRecorded: 'incident.permanent_fix_recorded',
  incidentPermanentFixConfirmed: 'incident.permanent_fix_confirmed',
  incidentStatusChanged: 'incident.status_changed',
  incidentIssueStatusChanged: 'incident.issue_status_changed',
  incidentAssigned: 'incident.assigned',
  incidentClosed: 'incident.closed',
  incidentReopened: 'incident.reopened',
  incidentCancelled: 'incident.cancelled',
  incidentSimilarSearch: 'incident.similar_search',
  incidentIndexed: 'incident.indexed',
  incidentReindexed: 'incident.reindexed',
  incidentIndexFailed: 'incident.index_failed',
  incidentIndexDeleted: 'incident.index_deleted',
  maintenanceCreated: 'maintenance.created',
  maintenanceUpdated: 'maintenance.updated',
  conversationCreated: 'conversation.created',
  conversationUpdated: 'conversation.updated',
  conversationClosed: 'conversation.closed',
  conversationReopened: 'conversation.reopened',
  conversationArchived: 'conversation.archived',
  messageSubmitted: 'conversation.message_submitted',
  assistantResponseGenerated: 'conversation.assistant_generated',
  assistantResponseRefused: 'conversation.assistant_refused',
  assistantResponseFailed: 'conversation.assistant_failed',
  issueStatusChanged: 'conversation.issue_status_changed',
  technicianActionRecorded: 'conversation.technician_action_recorded',
  ragQuerySubmitted: 'rag_query_submitted',
  retrievalCompleted: 'retrieval_completed',
  ragAnswerGenerated: 'rag_answer_generated',
  ragAnswerRefused: 'rag_answer_refused',
  ragGenerationFailed: 'rag_generation_failed',
  ragCitationValidationFailed: 'rag_citation_validation_failed',
} as const;
