/**
 * Incident actions.
 *
 * The one rule that defines this module:
 *
 *   an AI suggestion is NOT a technician action, and it can never become
 *   confirmed. Only `action_type: 'technician'` entries represent work a
 *   human actually performed, and only those can carry results or be
 *   confirmed. Confirmation is a separate explicit human act - a recorded
 *   result of `successful` is NOT a confirmation.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import {
  collections,
  SCHEMA_VERSION,
  type IncidentActionDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { paginate, updateStamps } from '../../common/repository.js';
import { buildSort, toObjectId } from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import type { OrgActor } from '../organizations/organizations.service.js';
import { requireOrgIncident } from '../incidents/incidents.service.js';
import { appendTimelineEvent, timelineEvent } from '../incidents/incidents.timeline.js';
import { scheduleIncidentIndex } from '../incidents/incidents.indexing.js';
import type {
  CreateActionInput,
  ListActionsQuery,
  UpdateActionInput,
} from './incident-actions.validators.js';

export const SORTABLE = ['created_at', 'performed_at', 'action_type'] as const;

export function toView(doc: IncidentActionDoc) {
  return {
    id: doc._id.toHexString(),
    incidentId: doc.incident_id.toHexString(),
    organizationId: doc.organization_id.toHexString(),
    actionType: doc.action_type,
    description: doc.description,
    performedBy: doc.performed_by ? doc.performed_by.toHexString() : null,
    sourceMessageId: doc.source_message_id ? doc.source_message_id.toHexString() : null,
    sourceSuggestionId: doc.source_suggestion_id ?? null,
    sourceManualId: doc.source_manual_id ? doc.source_manual_id.toHexString() : null,
    sourceManualVersion: doc.source_manual_version ?? null,
    result: doc.result ?? null,
    resultStatus: doc.result_status,
    confirmed: doc.confirmed,
    confirmedBy: doc.confirmed_by ? doc.confirmed_by.toHexString() : null,
    confirmedAt: doc.confirmed_at ? doc.confirmed_at.toISOString() : null,
    notes: doc.notes ?? null,
    performedAt: doc.performed_at.toISOString(),
    edited: doc.edited,
    editHistory: (doc.edit_history ?? []).map((entry) => ({
      at: entry.at.toISOString(),
      by: entry.by.toHexString(),
      previousDescription: entry.previous_description,
    })),
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export type IncidentActionView = ReturnType<typeof toView>;

export interface InternalActionInput {
  actionType: 'technician' | 'assistant_suggestion' | 'manual' | 'other';
  description: string;
  performedBy?: ObjectId | null;
  sourceMessageId?: ObjectId | null;
  sourceSuggestionId?: string | null;
  sourceManualId?: ObjectId | null;
  sourceManualVersion?: string | null;
  result?: string | null;
  resultStatus?: 'not_tested' | 'successful' | 'unsuccessful' | 'partially_successful' | 'inconclusive' | 'temporary_improvement' | 'worsened_condition';
  notes?: string | null;
  performedAt?: Date;
  /** Internal imports may suppress timeline noise; always false for API calls. */
  timeline?: boolean;
}

/**
 * Record an action on an incident.
 *
 * - `assistant_suggestion` rows are suggestions: they can never be confirmed
 *   and can never carry a result.
 * - technician rows need a performer and a performed date.
 */
export async function record(
  db: Db,
  incidentId: ObjectId,
  input: InternalActionInput,
  actor: OrgActor,
  requestId?: string,
): Promise<IncidentActionView> {
  const incident = await requireOrgIncident(db, actor, incidentId);
  if (incident.is_deleted) throw ApiError.notFound('Incident not found.');

  const performedBy = input.performedBy ?? (input.actionType === 'technician' ? actor.userId : null);
  if (input.actionType === 'technician' && !performedBy) {
    throw ApiError.validation('A technician action must have a performer.', [
      { field: 'performedBy', issue: 'Required for technician actions.' },
    ]);
  }
  if (input.actionType !== 'technician' && input.resultStatus !== 'not_tested') {
    throw ApiError.validation('Only technician actions may record an observed result.', [
      { field: 'resultStatus', issue: 'Suggestions and manual references cannot have results.' },
    ]);
  }

  const now = new Date();
  const doc: Omit<IncidentActionDoc, '_id'> = {
    incident_id: incidentId,
    organization_id: actor.orgId,
    action_type: input.actionType,
    description: input.description,
    performed_by: performedBy,
    source_message_id: input.sourceMessageId ?? null,
    source_suggestion_id: input.sourceSuggestionId ?? null,
    source_manual_id: input.sourceManualId ?? null,
    source_manual_version: input.sourceManualVersion ?? null,
    result: input.result ?? null,
    result_status: input.resultStatus ?? 'not_tested',
    confirmed: false,
    confirmed_by: null,
    confirmed_at: null,
    notes: input.notes ?? null,
    performed_at: input.performedAt ?? now,
    edited: false,
    edit_history: [],
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<IncidentActionDoc, '_id'>;

  const result = await collections.incidentActions(db).insertOne(doc as IncidentActionDoc);
  const created = { ...(doc as IncidentActionDoc), _id: result.insertedId };

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentActionRecorded,
    actor,
    entityType: 'incident_action',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { incident_id: incidentId.toHexString(), action_type: created.action_type },
  });

  if (input.timeline !== false) {
    await appendTimelineEvent(db, incidentId, timelineEvent(
      created.action_type === 'assistant_suggestion' ? 'ai_suggestion_recorded' : 'technician_action_recorded',
      { id: actor.userId, username: actor.username },
      {
        metadata: { action_id: created._id.toHexString(), description: created.description },
        note: created.action_type === 'assistant_suggestion'
          ? 'AI suggestion recorded (suggestion only - not a technician action).'
          : null,
      },
    ));
  }

  return toView(created);
}

/** API-facing record with role checks. */
export async function recordForApi(
  db: Db,
  incidentId: ObjectId,
  input: CreateActionInput,
  actor: OrgActor,
  requestId?: string,
): Promise<IncidentActionView> {
  const incident = await requireOrgIncident(db, actor, incidentId);
  const isManager = actor.role === 'admin' || actor.role === 'manager';
  const owns =
    incident.reported_by.equals(actor.userId) || (incident.assigned_to?.equals(actor.userId) ?? false);
  if (!isManager && !owns) {
    throw new ApiError('FORBIDDEN', 'You can only record actions on incidents you reported or are assigned to.');
  }
  if (['closed', 'cancelled'].includes(incident.status)) {
    throw new ApiError('CONFLICT', `This incident is ${incident.status}. Reopen it before recording actions.`);
  }
  return record(
    db,
    incidentId,
    {
      ...input,
      performedBy: input.performedBy ? toObjectId(input.performedBy) : undefined,
      sourceMessageId: input.sourceMessageId ? toObjectId(input.sourceMessageId) : undefined,
      sourceManualId: input.sourceManualId ? toObjectId(input.sourceManualId) : undefined,
    },
    actor,
    requestId,
  );
}

export async function list(
  db: Db,
  incidentId: ObjectId,
  query: ListActionsQuery,
  actor: OrgActor,
) {
  await requireOrgIncident(db, actor, incidentId);
  const filter: Filter<IncidentActionDoc> = {
    incident_id: incidentId,
    organization_id: actor.orgId,
  };
  if (query.actionType) filter.action_type = query.actionType;
  if (query.confirmed !== undefined) filter.confirmed = query.confirmed;

  const result = await paginate(collections.incidentActions(db), filter, {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'performed_at'),
  });
  return { items: result.items.map(toView), pagination: result.pagination };
}

async function requireOrgAction(db: Db, actor: OrgActor, actionId: ObjectId) {
  const action = await collections.incidentActions(db).findOne({ _id: actionId, organization_id: actor.orgId });
  if (!action) throw ApiError.notFound('Action not found.');
  return action;
}

export async function update(
  db: Db,
  incidentId: ObjectId,
  actionId: ObjectId,
  input: UpdateActionInput,
  actor: OrgActor,
  requestId?: string,
) {
  await requireOrgIncident(db, actor, incidentId);
  const existing = await requireOrgAction(db, actor, actionId);
  if (!existing.incident_id.equals(incidentId)) {
    throw ApiError.notFound('Action not found.');
  }
  if (existing.action_type === 'assistant_suggestion') {
    throw new ApiError(
      'CONFLICT',
      'AI suggestions cannot be edited. Record a technician action instead.',
    );
  }
  if (existing.confirmed) {
    throw new ApiError('CONFLICT', 'A confirmed action cannot be edited.');
  }

  const isManager = actor.role === 'admin' || actor.role === 'manager';
  const owns = existing.performed_by?.equals(actor.userId) ?? false;
  if (!isManager && !owns) {
    throw new ApiError('FORBIDDEN', 'Only the performer or a manager may edit this action.');
  }

  const set: Record<string, unknown> = { ...updateStamps(actor.userId) };
  if (input.description !== undefined) set.description = input.description;
  if (input.result !== undefined) set.result = input.result;
  if (input.resultStatus !== undefined) set.result_status = input.resultStatus;
  if (input.notes !== undefined) set.notes = input.notes;
  if (input.performedAt !== undefined) set.performed_at = input.performedAt;

  if (input.description !== undefined && input.description !== existing.description) {
    set.edited = true;
    set.edit_history = [
      ...(existing.edit_history ?? []),
      { at: new Date(), by: actor.userId, previous_description: existing.description },
    ];
  }

  const updated = await collections.incidentActions(db).findOneAndUpdate(
    { _id: actionId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Action not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentActionUpdated,
    actor,
    entityType: 'incident_action',
    entityId: actionId,
    requestId: requestId ?? null,
    metadata: { incident_id: incidentId.toHexString() },
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('technician_action_updated', { id: actor.userId, username: actor.username }, {
    metadata: { action_id: actionId.toHexString() },
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

/**
 * Confirm an action result.
 *
 * Only a technician action can be confirmed, the confirmation requires a
 * note, and the system never infers success from a message: the technician
 * must press this button with an explicit note.
 */
export async function confirm(
  db: Db,
  incidentId: ObjectId,
  actionId: ObjectId,
  note: string,
  actor: OrgActor,
  requestId?: string,
) {
  const incident = await requireOrgIncident(db, actor, incidentId);
  const existing = await requireOrgAction(db, actor, actionId);
  if (!existing.incident_id.equals(incidentId)) {
    throw ApiError.notFound('Action not found.');
  }
  if (existing.action_type !== 'technician') {
    throw new ApiError(
      'FORBIDDEN',
      'Only technician actions can be confirmed. AI suggestions can never be confirmed.',
    );
  }
  if (existing.confirmed) {
    throw new ApiError('CONFLICT', 'This action result is already confirmed.');
  }

  const isManager = actor.role === 'admin' || actor.role === 'manager';
  const owns =
    incident.reported_by.equals(actor.userId) || (incident.assigned_to?.equals(actor.userId) ?? false);
  if (!isManager && !owns) {
    throw new ApiError('FORBIDDEN', 'Only the incident owner or a manager may confirm an action result.');
  }

  const updated = await collections.incidentActions(db).findOneAndUpdate(
    { _id: actionId },
    {
      $set: {
        confirmed: true,
        confirmed_by: actor.userId,
        confirmed_at: new Date(),
        ...updateStamps(actor.userId),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Action not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentActionConfirmed,
    actor,
    entityType: 'incident_action',
    entityId: actionId,
    severity: 'notice',
    requestId: requestId ?? null,
    reason: note,
    metadata: {
      incident_id: incidentId.toHexString(),
      result_status: existing.result_status,
    },
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('technician_action_confirmed', { id: actor.userId, username: actor.username }, {
    metadata: { action_id: actionId.toHexString(), result_status: existing.result_status },
    note,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

export async function history(db: Db, incidentId: ObjectId, actionId: ObjectId, actor: OrgActor) {
  await requireOrgIncident(db, actor, incidentId);
  const action = await requireOrgAction(db, actor, actionId);
  if (!action.incident_id.equals(incidentId)) throw ApiError.notFound('Action not found.');
  return (action.edit_history ?? []).map((entry) => ({
    at: entry.at.toISOString(),
    by: entry.by.toHexString(),
    previousDescription: entry.previous_description,
  }));
}
