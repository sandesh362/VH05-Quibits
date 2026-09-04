/**
 * Incident actions: the append-only log of what a technician actually did.
 *
 * This collection is the highest-value data the platform produces. In Phase 4
 * it becomes the evidence behind "this worked last time". Two design choices
 * follow from that:
 *
 *  - No soft delete and no hard delete. History is not editable away. A
 *    mistake is corrected by appending a correction, not by erasing.
 *  - Edits are allowed for 24 hours, and every edit preserves the previous
 *    text in `edit_history`. Technicians fix typos; nobody rewrites the past.
 */
import type { Db, ObjectId } from 'mongodb';
import type { ActionOutcome, ActionType } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type IncidentActionDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { liveFilter, paginate } from '../../common/repository.js';
import {
  buildSort,
  normalisePartNumber,
  type PaginationInput,
} from '../../common/validation.js';
import { nextChildSequence } from '../../common/sequences.js';
import * as audit from '../audit/audit.service.js';

export const SORTABLE = ['sequence', 'performed_at', 'created_at'] as const;

/** How long after creation an author may still correct their own entry. */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

type Actor = { id: ObjectId; username: string; role: string };

export interface IncidentActionView {
  id: string;
  incidentId: string;
  machineId: string | null;
  sequence: number;
  actionText: string;
  actionType: ActionType | null;
  partsReplaced: { partNumber: string; name: string | null; quantity: number; serial: string | null }[];
  toolsUsed: string[];
  outcome: ActionOutcome;
  outcomeNote: string | null;
  durationMinutes: number | null;
  performedBy: string;
  performedAt: string;
  followedAiSuggestion: boolean | null;
  sourceType: 'technician_action';
  edited: boolean;
  createdAt: string;
}

export function toView(doc: IncidentActionDoc): IncidentActionView {
  return {
    id: doc._id.toHexString(),
    incidentId: doc.incident_id.toHexString(),
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    sequence: doc.sequence,
    actionText: doc.action_text,
    actionType: doc.action_type ?? null,
    partsReplaced: (doc.parts_replaced ?? []).map((part) => ({
      partNumber: part.part_number,
      name: part.name ?? null,
      quantity: part.quantity ?? 1,
      serial: part.serial ?? null,
    })),
    toolsUsed: doc.tools_used ?? [],
    outcome: doc.outcome,
    outcomeNote: doc.outcome_note ?? null,
    durationMinutes: doc.duration_minutes ?? null,
    performedBy: doc.performed_by.toHexString(),
    performedAt: doc.performed_at.toISOString(),
    followedAiSuggestion: doc.followed_ai_suggestion ?? null,
    sourceType: doc.source_type,
    edited: doc.edited,
    createdAt: doc.created_at.toISOString(),
  };
}

export interface CreateInput {
  actionText: string;
  actionType?: ActionType;
  partsReplaced?: { partNumber: string; name?: string; quantity?: number; serial?: string }[];
  toolsUsed?: string[];
  outcome: ActionOutcome;
  outcomeNote?: string;
  durationMinutes?: number;
  performedAt?: Date;
  followedAiSuggestion?: boolean;
  deviationReason?: string;
}

export async function create(
  db: Db,
  incidentId: ObjectId,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<IncidentActionView> {
  const incident = await collections.incidents(db).findOne(liveFilter({ _id: incidentId }));
  if (!incident) throw ApiError.notFound('Incident not found.');

  // Appending to a closed or cancelled incident is almost always a mistake -
  // usually the wrong incident id. Reopen it deliberately instead.
  if (incident.status === 'closed' || incident.status === 'cancelled') {
    throw new ApiError(
      'CONFLICT',
      `This incident is ${incident.status}; reopen it before recording further actions.`,
    );
  }

  const now = new Date();
  const doc: Omit<IncidentActionDoc, '_id'> = {
    incident_id: incidentId,
    machine_id: incident.machine_id ?? null,
    sequence: await nextChildSequence(db, 'incident_action', incidentId.toHexString()),
    action_text: input.actionText,
    action_type: input.actionType ?? null,
    // Part numbers are normalised on write so "abc-123 " and "ABC-123" match
    // in the structured part-usage queries.
    parts_replaced: (input.partsReplaced ?? []).map((part) => ({
      part_number: normalisePartNumber(part.partNumber),
      name: part.name ?? null,
      quantity: part.quantity ?? 1,
      serial: part.serial ?? null,
    })),
    tools_used: input.toolsUsed ?? [],
    outcome: input.outcome,
    outcome_note: input.outcomeNote ?? null,
    duration_minutes: input.durationMinutes ?? null,
    // Always the authenticated user. A technician cannot log work "as"
    // someone else, which keeps the audit trail meaningful.
    performed_by: actor.id,
    performed_at: input.performedAt ?? now,
    followed_ai_suggestion: input.followedAiSuggestion ?? null,
    deviation_reason: input.deviationReason ?? null,
    source_type: 'technician_action',
    edited: false,
    edit_history: [],
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<IncidentActionDoc, '_id'>;

  const result = await collections.incidentActions(db).insertOne(doc as IncidentActionDoc);
  const created = { ...(doc as IncidentActionDoc), _id: result.insertedId };

  // Recording work implies the incident is being worked on.
  if (incident.status === 'open') {
    await collections
      .incidents(db)
      .updateOne({ _id: incidentId }, { $set: { status: 'in_progress', updated_at: now } });
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentActionCreated,
    actor,
    entityType: 'incident_action',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { incident_id: incidentId.toHexString(), outcome: created.outcome },
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
}

export async function listForIncident(db: Db, incidentId: ObjectId, query: ListQuery) {
  const incident = await collections.incidents(db).findOne(liveFilter({ _id: incidentId }));
  if (!incident) throw ApiError.notFound('Incident not found.');

  const result = await paginate(
    collections.incidentActions(db),
    { incident_id: incidentId },
    {
      page: query.page,
      limit: query.limit,
      // Ascending sequence by default: an action log reads forwards.
      sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'sequence'),
    },
  );

  return { items: result.items.map(toView), pagination: result.pagination };
}

export interface UpdateInput {
  actionText?: string;
  outcome?: ActionOutcome;
  outcomeNote?: string;
  actionType?: ActionType;
  durationMinutes?: number;
}

/**
 * Correct an action within the edit window.
 *
 * Only the author may edit, and only for 24 hours. The previous text is
 * appended to `edit_history` so the original statement is always recoverable.
 */
export async function update(
  db: Db,
  incidentId: ObjectId,
  actionId: ObjectId,
  input: UpdateInput,
  actor: Actor,
  requestId?: string,
): Promise<IncidentActionView> {
  const existing = await collections
    .incidentActions(db)
    .findOne({ _id: actionId, incident_id: incidentId });
  if (!existing) throw ApiError.notFound('Incident action not found.');

  const isAuthor = existing.performed_by.equals(actor.id);
  const isManager = actor.role === 'admin' || actor.role === 'manager';

  if (!isAuthor && !isManager) {
    throw new ApiError('FORBIDDEN', 'You can only edit actions that you recorded.');
  }

  if (isAuthor && !isManager) {
    const age = Date.now() - existing.created_at.getTime();
    if (age > EDIT_WINDOW_MS) {
      throw new ApiError(
        'FORBIDDEN',
        'The 24-hour edit window for this action has passed. Record a follow-up action instead.',
      );
    }
  }

  const set: Record<string, unknown> = { updated_at: new Date(), edited: true };
  if (input.actionText !== undefined) set.action_text = input.actionText;
  if (input.outcome !== undefined) set.outcome = input.outcome;
  if (input.outcomeNote !== undefined) set.outcome_note = input.outcomeNote;
  if (input.actionType !== undefined) set.action_type = input.actionType;
  if (input.durationMinutes !== undefined) set.duration_minutes = input.durationMinutes;

  const update: Record<string, unknown> = { $set: set };
  if (input.actionText !== undefined && input.actionText !== existing.action_text) {
    update.$push = {
      edit_history: { at: new Date(), by: actor.id, previous_text: existing.action_text },
    };
  }

  const updated = await collections
    .incidentActions(db)
    .findOneAndUpdate({ _id: actionId }, update, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Incident action not found.');

  /**
   * If the confirmed effective action is downgraded from "worked", the
   * incident's confirmation no longer rests on anything. Flag it rather than
   * silently leaving a confirmed incident with no working fix.
   */
  if (input.outcome !== undefined && input.outcome !== 'worked') {
    const incident = await collections.incidents(db).findOne({ _id: incidentId });
    if (incident?.effective_action_id?.equals(actionId) && incident.resolution_confirmed) {
      await collections.incidents(db).updateOne(
        { _id: incidentId },
        { $set: { resolution_status: 'recurring', updated_at: new Date() } },
      );
      await audit.record(db, {
        action: 'incident.resolution_invalidated',
        actor,
        entityType: 'incident',
        entityId: incidentId,
        severity: 'warning',
        requestId: requestId ?? null,
        metadata: { reason: 'effective_action_outcome_downgraded' },
      });
    }
  }

  await audit.record(db, {
    action: 'incident_action.updated',
    actor,
    entityType: 'incident_action',
    entityId: actionId,
    requestId: requestId ?? null,
    changes: audit.buildChanges(
      'incident_action',
      existing as unknown as Record<string, unknown>,
      set,
    ),
  });

  return toView(updated);
}
