/**
 * Incidents: a reported machine problem and its resolution history.
 *
 * The critical rule in this file, and arguably in the whole platform:
 *
 *   `resolution_status = 'resolved_confirmed'` is reachable ONLY through an
 *   explicit human confirmation that supplies a root cause and points at an
 *   action that actually worked.
 *
 * No timer, no heuristic, and (from Phase 4 on) no model output may set it.
 * Phase 4 retrieval treats confirmed incidents as ground truth; if this gate
 * leaks, the assistant starts recommending fixes that were never verified.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { IncidentStatus, ResolutionStatus, Severity } from '@itp/shared';
import { collections, SCHEMA_VERSION, type IncidentDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
  liveFilter,
  paginate,
  updateStamps,
} from '../../common/repository.js';
import {
  buildSort,
  containsMatcher,
  normaliseErrorCode,
  toObjectId,
  type PaginationInput,
} from '../../common/validation.js';
import { nextIncidentNumber } from '../../common/sequences.js';
import { canConfirmResolution } from '../../common/policy.js';
import { getConfig } from '../../config/env.js';
import * as audit from '../audit/audit.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';

export const SORTABLE = [
  'created_at',
  'updated_at',
  'observed_at',
  'severity',
  'status',
  'incident_number',
] as const;

/** Statuses at which a technician may still edit their own incident. */
const TECHNICIAN_EDITABLE_STATUSES: IncidentStatus[] = ['open', 'in_progress'];

type Actor = { id: ObjectId; username: string; role: string };

export interface IncidentView {
  id: string;
  incidentNumber: string;
  machineId: string | null;
  machineModelId: string;
  needsLinking: boolean;
  title: string;
  errorCode: string | null;
  symptomText: string;
  observedAt: string;
  reportedBy: string;
  assignedTo: string | null;
  severity: Severity;
  downtimeMinutes: number | null;
  status: IncidentStatus;
  resolutionStatus: ResolutionStatus;
  resolutionConfirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmationMethod: string | null;
  confirmationNote: string | null;
  rootCauseText: string | null;
  effectiveActionId: string | null;
  resolvedAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: IncidentDoc): IncidentView {
  return {
    id: doc._id.toHexString(),
    incidentNumber: doc.incident_number,
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    machineModelId: doc.machine_model_id.toHexString(),
    needsLinking: doc.needs_linking,
    title: doc.title,
    errorCode: doc.error_code ?? null,
    symptomText: doc.symptom_text,
    observedAt: doc.observed_at.toISOString(),
    reportedBy: doc.reported_by.toHexString(),
    assignedTo: doc.assigned_to ? doc.assigned_to.toHexString() : null,
    severity: doc.severity,
    downtimeMinutes: doc.downtime_minutes ?? null,
    status: doc.status,
    resolutionStatus: doc.resolution_status,
    resolutionConfirmed: doc.resolution_confirmed,
    confirmedBy: doc.confirmed_by ? doc.confirmed_by.toHexString() : null,
    confirmedAt: doc.confirmed_at ? doc.confirmed_at.toISOString() : null,
    confirmationMethod: doc.confirmation_method ?? null,
    confirmationNote: doc.confirmation_note ?? null,
    rootCauseText: doc.root_cause_text ?? null,
    effectiveActionId: doc.effective_action_id ? doc.effective_action_id.toHexString() : null,
    resolvedAt: doc.resolved_at ? doc.resolved_at.toISOString() : null,
    tags: doc.tags ?? [],
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateInput {
  machineId?: string;
  machineModelId?: string;
  title: string;
  errorCode?: string;
  symptomText: string;
  observedAt?: Date;
  severity: Severity;
  assignedTo?: string;
  downtimeMinutes?: number;
  tags?: string[];
}

/**
 * Create an incident.
 *
 * A machine reference is preferred. When only a model is given the incident is
 * flagged `needs_linking` rather than rejected: a technician mid-breakdown
 * should never be blocked because the asset was not yet registered. Phase 4
 * excludes unlinked incidents from retrieval, so the flag has teeth.
 */
export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<IncidentView> {
  if (!input.machineId && !input.machineModelId) {
    throw ApiError.validation('An incident must reference a machine or a machine model.', [
      { field: 'machineId', issue: 'Provide either machineId or machineModelId.' },
    ]);
  }

  let machineId: ObjectId | null = null;
  let machineModelId: ObjectId;

  if (input.machineId) {
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    machineId = machine._id;
    // The model is derived from the machine, never trusted from the body:
    // a mismatched pair would corrupt model-scoped retrieval later.
    machineModelId = machine.machine_model_id;
  } else {
    const model = await requireLiveModel(db, toObjectId(input.machineModelId as string));
    machineModelId = model._id;
  }

  let assignedTo: ObjectId | null = null;
  if (input.assignedTo) {
    const assignee = await collections
      .users(db)
      .findOne({ _id: toObjectId(input.assignedTo), is_deleted: false, is_active: true });
    if (!assignee) {
      throw ApiError.validation('The assigned user does not exist or is inactive.', [
        { field: 'assignedTo', issue: 'No active user has this id.' },
      ]);
    }
    assignedTo = assignee._id;
  }

  const now = new Date();
  const doc: Omit<IncidentDoc, '_id'> = {
    incident_number: await nextIncidentNumber(db, now),
    machine_id: machineId,
    machine_model_id: machineModelId,
    needs_linking: machineId === null,
    title: input.title,
    // Keep both forms: the normalised code powers exact-match search, the raw
    // one preserves exactly what the operator saw on the HMI.
    error_code: input.errorCode ? normaliseErrorCode(input.errorCode) : null,
    error_code_raw: input.errorCode ?? null,
    symptom_text: input.symptomText,
    observed_at: input.observedAt ?? now,
    reported_by: actor.id,
    assigned_to: assignedTo,
    severity: input.severity,
    downtime_minutes: input.downtimeMinutes ?? null,
    status: 'open',
    resolution_status: 'unresolved',
    resolution_confirmed: false,
    confirmed_by: null,
    confirmed_at: null,
    confirmation_method: null,
    confirmation_note: null,
    verified_by_test: null,
    root_cause_text: null,
    effective_action_id: null,
    resolved_at: null,
    ai_suggestions: [],
    conversation_ids: [],
    related_incident_ids: [],
    tags: input.tags ?? [],
    vector_indexed: false,
    revisions: [],
    is_deleted: false,
    created_at: now,
    updated_at: now,
    created_by: actor.id,
    updated_by: actor.id,
    schema_version: SCHEMA_VERSION,
  } as Omit<IncidentDoc, '_id'>;

  const result = await collections.incidents(db).insertOne(doc as IncidentDoc);
  const created = { ...(doc as IncidentDoc), _id: result.insertedId };

  if (machineId) {
    await collections.machines(db).updateOne(
      { _id: machineId },
      { $inc: { open_incident_count: 1 } },
    );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentCreated,
    actor,
    entityType: 'incident',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { incident_number: created.incident_number, severity: created.severity },
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  status?: IncidentStatus;
  resolutionStatus?: ResolutionStatus;
  severity?: Severity;
  machineId?: string;
  machineModelId?: string;
  errorCode?: string;
  assignedTo?: string;
  reportedBy?: string;
  needsLinking?: boolean;
  observedFrom?: Date;
  observedTo?: Date;
  search?: string;
}

export async function list(db: Db, query: ListQuery) {
  const filter: Filter<IncidentDoc> = {};

  if (query.status) filter.status = query.status;
  if (query.resolutionStatus) filter.resolution_status = query.resolutionStatus;
  if (query.severity) filter.severity = query.severity;
  if (query.machineId) filter.machine_id = toObjectId(query.machineId);
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.errorCode) filter.error_code = normaliseErrorCode(query.errorCode);
  if (query.assignedTo) filter.assigned_to = toObjectId(query.assignedTo);
  if (query.reportedBy) filter.reported_by = toObjectId(query.reportedBy);
  if (query.needsLinking !== undefined) filter.needs_linking = query.needsLinking;

  if (query.observedFrom || query.observedTo) {
    filter.observed_at = {
      ...(query.observedFrom ? { $gte: query.observedFrom } : {}),
      ...(query.observedTo ? { $lte: query.observedTo } : {}),
    };
  }

  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [
      { title: matcher },
      { symptom_text: matcher },
      { incident_number: matcher },
    ];
  }

  const result = await paginate(collections.incidents(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, id: ObjectId): Promise<IncidentView> {
  const doc = await collections.incidents(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Incident not found.');
  return toView(doc);
}

export interface UpdateInput {
  title?: string;
  symptomText?: string;
  errorCode?: string | null;
  severity?: Severity;
  status?: IncidentStatus;
  assignedTo?: string | null;
  downtimeMinutes?: number;
  machineId?: string;
  tags?: string[];
  rootCauseText?: string;
}

/**
 * Update an incident.
 *
 * Ownership: a technician may edit an incident they reported, and only while
 * it is still open or in progress. Managers and admins may edit any incident.
 * Note what is NOT settable here - `resolutionStatus`, `resolutionConfirmed`,
 * `confirmedBy`. Those live behind `confirmResolution` alone.
 */
export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  requestId?: string,
): Promise<IncidentView> {
  const existing = await collections.incidents(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Incident not found.');

  const isOwner = existing.reported_by.equals(actor.id);
  const canUpdateAny = actor.role === 'admin' || actor.role === 'manager';

  if (!canUpdateAny) {
    if (!isOwner) {
      throw new ApiError('FORBIDDEN', 'You can only edit incidents that you reported.');
    }
    if (!TECHNICIAN_EDITABLE_STATUSES.includes(existing.status)) {
      throw new ApiError(
        'FORBIDDEN',
        'This incident is no longer open, so it can only be edited by a manager.',
      );
    }
  }

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };

  if (input.title !== undefined) set.title = input.title;
  if (input.symptomText !== undefined) set.symptom_text = input.symptomText;
  if (input.errorCode !== undefined) {
    set.error_code = input.errorCode ? normaliseErrorCode(input.errorCode) : null;
    set.error_code_raw = input.errorCode;
  }
  if (input.severity !== undefined) set.severity = input.severity;
  if (input.downtimeMinutes !== undefined) set.downtime_minutes = input.downtimeMinutes;
  if (input.tags !== undefined) set.tags = input.tags;
  if (input.rootCauseText !== undefined) set.root_cause_text = input.rootCauseText;

  if (input.assignedTo !== undefined) {
    if (input.assignedTo === null) {
      set.assigned_to = null;
    } else {
      const assignee = await collections
        .users(db)
        .findOne({ _id: toObjectId(input.assignedTo), is_deleted: false, is_active: true });
      if (!assignee) {
        throw ApiError.validation('The assigned user does not exist or is inactive.', [
          { field: 'assignedTo', issue: 'No active user has this id.' },
        ]);
      }
      set.assigned_to = assignee._id;
    }
  }

  // Linking a previously-unlinked incident to a real machine.
  if (input.machineId !== undefined) {
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    set.machine_id = machine._id;
    set.machine_model_id = machine.machine_model_id;
    set.needs_linking = false;
  }

  /**
   * Status may move freely EXCEPT into `resolved`. Marking an incident
   * resolved is the confirmation flow, and routing it through here would
   * bypass the root-cause and effective-action requirements.
   */
  if (input.status !== undefined) {
    if (input.status === 'resolved' && existing.status !== 'resolved') {
      throw ApiError.validation(
        'An incident cannot be marked resolved directly. Use the resolution confirmation endpoint.',
        [
          {
            field: 'status',
            issue: 'POST /incidents/:id/confirm-resolution records a verified resolution.',
          },
        ],
      );
    }
    set.status = input.status;

    // Closing or cancelling releases the machine's open-incident counter.
    const wasOpen = ['open', 'in_progress'].includes(existing.status);
    const nowClosed = ['closed', 'cancelled'].includes(input.status);
    if (wasOpen && nowClosed && existing.machine_id) {
      await collections
        .machines(db)
        .updateOne({ _id: existing.machine_id }, { $inc: { open_incident_count: -1 } });
    }
  }

  const updated = await collections
    .incidents(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentUpdated,
    actor,
    entityType: 'incident',
    entityId: id,
    requestId: requestId ?? null,
    changes: audit.buildChanges('incident', existing as unknown as Record<string, unknown>, set),
  });

  return toView(updated);
}

export interface ConfirmResolutionInput {
  rootCauseText: string;
  effectiveActionId: string;
  confirmationNote?: string;
  verifiedByTest?: boolean;
}

/**
 * Confirm that an incident is genuinely resolved.
 *
 * Requirements, all enforced here:
 *  - the caller is permitted to confirm (policy + INCIDENT_CONFIRMATION_MODE);
 *  - a root cause is written down;
 *  - the nominated action belongs to this incident and had outcome `worked`.
 *
 * The last one is what stops "resolved" from being a shrug. An incident is
 * only ground truth if someone can point at the thing that fixed it.
 */
export async function confirmResolution(
  db: Db,
  id: ObjectId,
  input: ConfirmResolutionInput,
  actor: Actor,
  requestId?: string,
): Promise<IncidentView> {
  const config = getConfig();
  const existing = await collections.incidents(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Incident not found.');

  if (existing.resolution_confirmed) {
    throw new ApiError('CONFLICT', 'This incident has already been confirmed as resolved.');
  }

  const isOwn =
    existing.reported_by.equals(actor.id) ||
    (existing.assigned_to?.equals(actor.id) ?? false);

  if (!canConfirmResolution(config.incidentConfirmationMode, actor.role as never, isOwn)) {
    throw new ApiError(
      'FORBIDDEN',
      config.incidentConfirmationMode === 'supervisor'
        ? 'Only a manager or admin may confirm a resolution in supervisor mode.'
        : 'You are not permitted to confirm this resolution.',
    );
  }

  const action = await collections
    .incidentActions(db)
    .findOne({ _id: toObjectId(input.effectiveActionId), incident_id: id });

  if (!action) {
    throw ApiError.validation('The nominated effective action does not belong to this incident.', [
      { field: 'effectiveActionId', issue: 'No action with this id exists on this incident.' },
    ]);
  }

  if (action.outcome !== 'worked') {
    throw ApiError.validation(
      'The effective action must be one whose outcome was recorded as "worked".',
      [
        {
          field: 'effectiveActionId',
          issue: `This action's outcome is "${action.outcome}".`,
        },
      ],
    );
  }

  const now = new Date();
  const set = {
    status: 'resolved' as IncidentStatus,
    resolution_status: 'resolved_confirmed' as ResolutionStatus,
    resolution_confirmed: true,
    confirmed_by: actor.id,
    confirmed_at: now,
    confirmation_method:
      config.incidentConfirmationMode === 'supervisor'
        ? ('supervisor' as const)
        : ('self' as const),
    confirmation_note: input.confirmationNote ?? null,
    verified_by_test: input.verifiedByTest ?? null,
    root_cause_text: input.rootCauseText,
    effective_action_id: action._id,
    resolved_at: now,
    ...updateStamps(actor.id),
  };

  const updated = await collections
    .incidents(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (existing.machine_id && ['open', 'in_progress'].includes(existing.status)) {
    await collections
      .machines(db)
      .updateOne({ _id: existing.machine_id }, { $inc: { open_incident_count: -1 } });
  }

  // Security-severity: this is the event that turns an incident into training
  // material for Phase 4 retrieval.
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentResolutionConfirmed,
    actor,
    entityType: 'incident',
    entityId: id,
    severity: 'notice',
    requestId: requestId ?? null,
    metadata: {
      effective_action_id: action._id.toHexString(),
      confirmation_method: set.confirmation_method,
    },
  });

  return toView(updated);
}

/** Reopen a confirmed incident. Manager/admin only - see the policy map. */
export async function reopen(
  db: Db,
  id: ObjectId,
  reason: string,
  actor: Actor,
  requestId?: string,
): Promise<IncidentView> {
  const existing = await collections.incidents(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Incident not found.');

  if (!existing.resolution_confirmed && existing.status === 'open') {
    throw new ApiError('CONFLICT', 'This incident is already open.');
  }

  const set = {
    status: 'in_progress' as IncidentStatus,
    // `recurring` rather than `unresolved`: the distinction is what makes
    // repeat failures visible in reporting.
    resolution_status: 'recurring' as ResolutionStatus,
    resolution_confirmed: false,
    confirmed_by: null,
    confirmed_at: null,
    confirmation_method: null,
    resolved_at: null,
    ...updateStamps(actor.id),
  };

  const updated = await collections
    .incidents(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (existing.machine_id) {
    await collections
      .machines(db)
      .updateOne({ _id: existing.machine_id }, { $inc: { open_incident_count: 1 } });
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentReopened,
    actor,
    entityType: 'incident',
    entityId: id,
    severity: 'notice',
    reason,
    requestId: requestId ?? null,
  });

  return toView(updated);
}
