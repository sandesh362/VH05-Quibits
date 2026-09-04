/**
 * Incidents: a reported machine problem and its full resolution history.
 *
 * Phase 6 turns the Phase 5 minimal incident record into the full
 * incident-management + historical-memory module:
 *
 *   - incidents are org-scoped and machine-scoped (machine REQUIRED)
 *   - lifecycle status changes go through a validated transition map
 *   - root causes, fixes and action results require explicit human
 *     confirmation - no heuristic, no timer, and never AI output
 *   - every step appends to an immutable timeline and an audit record
 *   - changes queue a Qdrant re-index so historical memory never goes stale
 *
 * The critical rule, unchanged from Phase 5: nothing here can mark a root
 * cause confirmed, a fix confirmed, or an incident resolved without an
 * explicit authorized human act. Historical evidence is only as trustworthy
 * as this gate.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type {
  IncidentSource,
  IncidentStatus,
  IssueStatus,
  Priority,
  RootCauseStatus,
  Severity,
} from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type IncidentDoc,
  type IncidentFix,
  type IncidentRootCause,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
  deletionStamps,
  liveFilter,
  paginate,
  updateStamps,
} from '../../common/repository.js';
import {
  buildSort,
  containsMatcher,
  normaliseErrorCode,
  toObjectId,
} from '../../common/validation.js';
import { nextIncidentNumber } from '../../common/sequences.js';
import { getConfig } from '../../config/env.js';
import * as audit from '../audit/audit.service.js';
import {
  resolveActorOrg,
  type OrgActor,
} from '../organizations/organizations.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';
import { requireLiveManual } from '../manuals/manual-processing.service.js';
import {
  canTransitionIssueStatus,
  canTransitionStatus,
  isActiveStatus,
} from './incidents.lifecycle.js';
import {
  appendTimelineEvent,
  getTimeline,
  timelineEvent,
} from './incidents.timeline.js';
import {
  fetchSimilarIncidents,
  scheduleIncidentDelete,
  scheduleIncidentIndex,
  scheduleIncidentReindex,
  type SimilarIncidentMatch,
} from './incidents.indexing.js';
import type {
  CreateIncidentInput,
  ListIncidentsQuery,
  UpdateIncidentInput,
} from './incidents.validators.js';

export const SORTABLE = [
  'created_at',
  'updated_at',
  'first_observed_at',
  'severity',
  'priority',
  'status',
  'incident_number',
] as const;

/** Max events returned by GET /incidents/:id/timeline. */
const TIMELINE_LIMIT = 200;

export function buildSearchText(doc: {
  title: string;
  description: string;
  symptoms: string[];
  error_codes: string[];
  operating_conditions: string[];
  tags: string[];
}): string {
  return [
    doc.title,
    doc.description,
    ...(doc.symptoms ?? []),
    ...(doc.error_codes ?? []),
    ...(doc.operating_conditions ?? []),
    ...(doc.tags ?? []),
  ]
    .join(' ')
    .slice(0, 60_000);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function toView(doc: IncidentDoc) {
  return {
    id: doc._id.toHexString(),
    incidentNumber: doc.incident_number,
    organizationId: doc.organization_id.toHexString(),
    title: doc.title,
    description: doc.description,
    source: doc.source,
    machineId: doc.machine_id.toHexString(),
    machineModelId: doc.machine_model_id.toHexString(),
    conversationId: doc.conversation_id ? doc.conversation_id.toHexString() : null,
    manualId: doc.manual_id ? doc.manual_id.toHexString() : null,
    manualVersion: doc.manual_version ?? null,
    reportedBy: doc.reported_by.toHexString(),
    assignedTo: doc.assigned_to ? doc.assigned_to.toHexString() : null,
    severity: doc.severity,
    priority: doc.priority,
    status: doc.status,
    issueStatus: doc.issue_status,
    symptoms: doc.symptoms ?? [],
    errorCodes: doc.error_codes ?? [],
    operatingConditions: doc.operating_conditions ?? [],
    firstObservedAt: doc.first_observed_at.toISOString(),
    lastObservedAt: doc.last_observed_at ? doc.last_observed_at.toISOString() : null,
    rootCause: {
      text: doc.root_cause?.text ?? null,
      status: doc.root_cause?.status ?? 'unknown',
      confirmationNote: doc.root_cause?.confirmation_note ?? null,
      confirmedBy: doc.root_cause?.confirmed_by ? doc.root_cause.confirmed_by.toHexString() : null,
      confirmedAt: doc.root_cause?.confirmed_at ? doc.root_cause.confirmed_at.toISOString() : null,
      rejectedBy: doc.root_cause?.rejected_by ? doc.root_cause.rejected_by.toHexString() : null,
      rejectedAt: doc.root_cause?.rejected_at ? doc.root_cause.rejected_at.toISOString() : null,
      rejectionReason: doc.root_cause?.rejection_reason ?? null,
    },
    temporaryFix: doc.temporary_fix ? fixToView(doc.temporary_fix) : null,
    permanentFix: doc.permanent_fix ? fixToView(doc.permanent_fix) : null,
    resolutionSummary: doc.resolution_summary ?? null,
    resolvedBy: doc.resolved_by ? doc.resolved_by.toHexString() : null,
    resolvedAt: doc.resolved_at ? doc.resolved_at.toISOString() : null,
    closedBy: doc.closed_by ? doc.closed_by.toHexString() : null,
    closedAt: doc.closed_at ? doc.closed_at.toISOString() : null,
    reopenedBy: doc.reopened_by ? doc.reopened_by.toHexString() : null,
    reopenedAt: doc.reopened_at ? doc.reopened_at.toISOString() : null,
    tags: doc.tags ?? [],
    attachments: (doc.attachments ?? []).map((a) => ({
      id: a.id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      uploadedBy: a.uploaded_by.toHexString(),
      uploadedAt: a.uploaded_at.toISOString(),
    })),
    embeddingStatus: doc.embedding_status ?? 'not_indexed',
    embeddingError: doc.embedding_error ?? null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

function fixToView(fix: IncidentFix) {
  return {
    description: fix.description,
    result: fix.result ?? null,
    status: fix.status,
    confirmedBy: fix.confirmed_by ? fix.confirmed_by.toHexString() : null,
    confirmedAt: fix.confirmed_at ? fix.confirmed_at.toISOString() : null,
    notes: fix.notes ?? null,
    recordedBy: fix.recorded_by.toHexString(),
    recordedAt: fix.recorded_at.toISOString(),
  };
}

export type IncidentView = ReturnType<typeof toView>;

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Load an incident scoped to the actor's organization. Organization ids are
 * never trusted from the request - they always come from the authenticated
 * user, so a cross-organization incident id can only ever 404 here.
 */
export async function requireOrgIncident(
  db: Db,
  actor: OrgActor,
  incidentId: ObjectId,
): Promise<IncidentDoc> {
  const doc = await collections.incidents(db).findOne(
    liveFilter({ _id: incidentId, organization_id: actor.orgId }),
  );
  if (!doc) throw ApiError.notFound('Incident not found.');
  return doc;
}

/** A technician may manage incidents they reported or are assigned to. */
function ownsIncident(doc: IncidentDoc, actor: OrgActor): boolean {
  return (
    doc.reported_by.equals(actor.userId) ||
    (doc.assigned_to?.equals(actor.userId) ?? false)
  );
}

function canManage(doc: IncidentDoc, actor: OrgActor): boolean {
  return actor.role === 'admin' || actor.role === 'manager' || ownsIncident(doc, actor);
}

function requireManage(doc: IncidentDoc, actor: OrgActor): void {
  if (!canManage(doc, actor)) {
    throw new ApiError(
      'FORBIDDEN',
      'You can only manage incidents that you reported or that are assigned to you.',
    );
  }
}

function assertNotSettled(doc: IncidentDoc, verb: string): void {
  if (doc.status === 'closed' || doc.status === 'cancelled') {
    throw new ApiError(
      'CONFLICT',
      `This incident is ${doc.status} and cannot be ${verb}. Reopen it first.`,
    );
  }
}

/** Validate a user reference exists, is active, and belongs to the org. */
async function resolveOrgUser(db: Db, actor: OrgActor, userId: string | null): Promise<ObjectId | null> {
  if (userId === null) return null;
  const user = await collections
    .users(db)
    .findOne({ _id: toObjectId(userId), is_deleted: false, is_active: true });
  if (!user) {
    throw ApiError.validation('The user does not exist or is inactive.', [
      { field: 'userId', issue: 'No active user has this id.' },
    ]);
  }
  const userOrg = user.organization_id ?? (await resolveActorOrg(db, user._id, user.username, user.role)).orgId;
  if (!userOrg.equals(actor.orgId)) {
    throw ApiError.validation('The user does not belong to your organization.', [
      { field: 'userId', issue: 'Cross-organization user references are not allowed.' },
    ]);
  }
  return user._id;
}

function rebuildSearchText(doc: IncidentDoc): string {
  return buildSearchText({
    title: doc.title,
    description: doc.description,
    symptoms: doc.symptoms,
    error_codes: doc.error_codes,
    operating_conditions: doc.operating_conditions,
    tags: doc.tags,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function create(
  db: Db,
  input: CreateIncidentInput,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);

  // A physical machine is REQUIRED in Phase 6 (Phase 5 allowed model-only
  // incidents for the chat flow; the incident module is stricter).
  const machine = await requireLiveMachine(db, toObjectId(input.machineId));
  if (machine.organization_id && !machine.organization_id.equals(org.orgId)) {
    throw ApiError.notFound('Machine not found.');
  }

  const machineModelId = machine.machine_model_id;
  if (input.machineModelId && !toObjectId(input.machineModelId).equals(machineModelId)) {
    throw ApiError.validation(
      'The machine model does not belong to the selected machine.',
      [{ field: 'machineModelId', issue: 'Does not match the machine’s model.' }],
    );
  }
  const model = await requireLiveModel(db, machineModelId);

  // Optional links are validated against live, org-scoped records.
  let conversationId: ObjectId | null = null;
  if (input.conversationId) {
    const conversation = await collections
      .conversations(db)
      .findOne({ _id: toObjectId(input.conversationId), is_deleted: false });
    if (!conversation) {
      throw ApiError.validation('The linked conversation does not exist.', [
        { field: 'conversationId', issue: 'No conversation has this id.' },
      ]);
    }
    conversationId = conversation._id;
  }

  let manualId: ObjectId | null = null;
  if (input.manualId) {
    const manual = await requireLiveManual(db, toObjectId(input.manualId));
    manualId = manual._id;
  }

  const assignedTo = await resolveOrgUser(db, org, input.assignedTo ?? null);

  const now = new Date();
  const firstObservedAt = input.firstObservedAt ?? now;
  const lastObservedAt = input.lastObservedAt ?? null;
  if (lastObservedAt && lastObservedAt < firstObservedAt) {
    throw ApiError.validation('lastObservedAt must not be before firstObservedAt.', [
      { field: 'lastObservedAt', issue: 'Invalid date range.' },
    ]);
  }

  const errorCodes = (input.errorCodes ?? []).map(normaliseErrorCode).filter((v, i, a) => a.indexOf(v) === i);

  const incidentNumber = await nextIncidentNumber(db, org.orgId, now);

  const rootCause: IncidentRootCause = {
    text: null,
    status: 'unknown',
    history: [],
  };

  const doc: Omit<IncidentDoc, '_id'> = {
    incident_number: incidentNumber,
    organization_id: org.orgId,
    title: input.title,
    description: input.description,
    source: input.source as IncidentSource,
    machine_id: machine._id,
    machine_model_id: machineModelId,
    conversation_id: conversationId,
    manual_id: manualId,
    manual_version: input.manualVersion ?? null,
    reported_by: actor.id,
    assigned_to: assignedTo,
    severity: input.severity as Severity,
    priority: input.priority as Priority,
    status: 'open',
    issue_status: input.issueStatus as IssueStatus,
    symptoms: input.symptoms ?? [],
    error_codes: errorCodes,
    operating_conditions: input.operatingConditions ?? [],
    first_observed_at: firstObservedAt,
    last_observed_at: lastObservedAt,
    root_cause: rootCause,
    temporary_fix: null,
    permanent_fix: null,
    resolution_summary: null,
    resolved_by: null,
    resolved_at: null,
    closed_by: null,
    closed_at: null,
    reopened_by: null,
    reopened_at: null,
    tags: input.tags ?? [],
    attachments: (input.attachments ?? []).map((a) => ({
      id: a.id,
      file_name: a.fileName,
      mime_type: a.mimeType,
      size_bytes: a.sizeBytes,
      uploaded_by: actor.id,
      uploaded_at: now,
    })),
    search_text: '',
    embedding_status: 'not_indexed',
    qdrant_point_id: null,
    embedding_error: null,
    timeline: [],
    is_deleted: false,
    created_at: now,
    updated_at: now,
    created_by: actor.id,
    updated_by: actor.id,
    schema_version: SCHEMA_VERSION,
  } as Omit<IncidentDoc, '_id'>;
  doc.search_text = buildSearchText(doc);

  const result = await collections.incidents(db).insertOne(doc as IncidentDoc);
  const inserted = { ...(doc as IncidentDoc), _id: result.insertedId };

  await appendTimelineEvent(db, inserted._id, timelineEvent('incident_created', { id: actor.id, username: actor.username }, {
    note: `Incident ${incidentNumber} created for machine ${machine.asset_tag} (${model.manufacturer} ${model.model_name}).`,
  }));

  if (conversationId) {
    await collections.conversations(db).updateOne(
      { _id: conversationId },
      { $addToSet: { incident_ids: inserted._id } },
    );
  }

  await collections.machines(db).updateOne(
    { _id: machine._id },
    { $inc: { open_incident_count: 1 } },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentCreated,
    actor,
    entityType: 'incident',
    entityId: inserted._id,
    requestId: requestId ?? null,
    metadata: {
      incident_number: incidentNumber,
      severity: inserted.severity,
      machine_id: machine._id.toHexString(),
    },
  });

  scheduleIncidentIndex(db, inserted._id, actor, requestId);
  return toView(inserted);
}

// ---------------------------------------------------------------------------
// List / search
// ---------------------------------------------------------------------------

export async function list(
  db: Db,
  query: ListIncidentsQuery,
  actor: { id: ObjectId; username: string; role: string },
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const filter: Filter<IncidentDoc> = { organization_id: org.orgId } as Filter<IncidentDoc>;

  if (query.status) filter.status = query.status;
  if (query.issueStatus) filter.issue_status = query.issueStatus;
  if (query.severity) filter.severity = query.severity;
  if (query.priority) filter.priority = query.priority;
  if (query.rootCauseStatus) filter['root_cause.status'] = query.rootCauseStatus;
  if (query.machineId) filter.machine_id = toObjectId(query.machineId);
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.reportedBy) filter.reported_by = toObjectId(query.reportedBy);
  if (query.assignedTo) filter.assigned_to = toObjectId(query.assignedTo);
  if (query.source) filter.source = query.source;
  if (query.tag) filter.tags = query.tag.toLowerCase();
  if (query.errorCode) filter.error_codes = normaliseErrorCode(query.errorCode);

  if (query.createdFrom || query.createdTo) {
    filter.created_at = {
      ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
      ...(query.createdTo ? { $lte: query.createdTo } : {}),
    };
  }
  if (query.resolvedFrom || query.resolvedTo) {
    filter.resolved_at = {
      ...(query.resolvedFrom ? { $gte: query.resolvedFrom } : {}),
      ...(query.resolvedTo ? { $lte: query.resolvedTo } : {}),
    };
  }

  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [
      { title: matcher },
      { description: matcher },
      { incident_number: matcher },
      { error_codes: { $in: [normaliseErrorCode(query.search)] } },
      { symptoms: { $elemMatch: { $regex: matcher.source, $options: 'i' } } },
      { operating_conditions: { $elemMatch: { $regex: matcher.source, $options: 'i' } } },
      { tags: { $elemMatch: { $regex: matcher.source, $options: 'i' } } },
    ];
  }

  const result = await paginate(collections.incidents(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, incidentId: ObjectId, actor: { id: ObjectId; username: string; role: string }) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const doc = await requireOrgIncident(db, org, incidentId);
  return enrichView(db, toView(doc));
}

/** Attach display labels for the detail page. Lists skip this to stay cheap. */
export async function enrichView(db: Db, view: IncidentView) {
  const [machine, model, manual, reporter, assignee] = await Promise.all([
    collections.machines(db).findOne({ _id: toObjectId(view.machineId) }, { projection: { asset_tag: 1, display_name: 1 } }),
    collections.machineModels(db).findOne({ _id: toObjectId(view.machineModelId) }, { projection: { manufacturer: 1, model_name: 1 } }),
    view.manualId
      ? collections.manuals(db).findOne({ _id: toObjectId(view.manualId) }, { projection: { title: 1 } })
      : Promise.resolve(null),
    collections.users(db).findOne({ _id: toObjectId(view.reportedBy) }, { projection: { username: 1, full_name: 1 } }),
    view.assignedTo
      ? collections.users(db).findOne({ _id: toObjectId(view.assignedTo) }, { projection: { username: 1, full_name: 1 } })
      : Promise.resolve(null),
  ]);
  return {
    ...view,
    machineLabel: machine ? (machine.display_name || machine.asset_tag) : null,
    machineModelLabel: model ? `${model.manufacturer} ${model.model_name}` : null,
    manualTitle: manual?.title ?? null,
    reportedByName: reporter?.full_name || reporter?.username || null,
    assignedToName: assignee?.full_name || assignee?.username || null,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function update(
  db: Db,
  incidentId: ObjectId,
  input: UpdateIncidentInput,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  const changed: string[] = [];

  if (input.title !== undefined) { set.title = input.title; changed.push('title'); }
  if (input.description !== undefined) { set.description = input.description; changed.push('description'); }
  if (input.severity !== undefined) { set.severity = input.severity; changed.push('severity'); }
  if (input.priority !== undefined) { set.priority = input.priority; changed.push('priority'); }
  if (input.symptoms !== undefined) { set.symptoms = input.symptoms; changed.push('symptoms'); }
  if (input.errorCodes !== undefined) {
    set.error_codes = input.errorCodes.map(normaliseErrorCode);
    changed.push('error_codes');
  }
  if (input.operatingConditions !== undefined) {
    set.operating_conditions = input.operatingConditions;
    changed.push('operating_conditions');
  }
  if (input.tags !== undefined) { set.tags = input.tags; changed.push('tags'); }
  if (input.attachments !== undefined) {
    set.attachments = input.attachments.map((a) => ({
      id: a.id,
      file_name: a.fileName,
      mime_type: a.mimeType,
      size_bytes: a.sizeBytes,
      uploaded_by: actor.id,
      uploaded_at: new Date(),
    }));
    changed.push('attachments');
  }

  if (input.firstObservedAt !== undefined) {
    set.first_observed_at = input.firstObservedAt;
    changed.push('first_observed_at');
  }
  if (input.lastObservedAt !== undefined) {
    set.last_observed_at = input.lastObservedAt;
    changed.push('last_observed_at');
  }

  // Machine re-linking: the model is always derived from the machine.
  if (input.machineId !== undefined) {
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    if (machine.organization_id && !machine.organization_id.equals(org.orgId)) {
      throw ApiError.notFound('Machine not found.');
    }
    if (input.machineModelId && !toObjectId(input.machineModelId).equals(machine.machine_model_id)) {
      throw ApiError.validation(
        'The machine model does not belong to the selected machine.',
        [{ field: 'machineModelId', issue: 'Does not match the machine’s model.' }],
      );
    }
    if (!machine._id.equals(existing.machine_id)) {
      // Move the open-incident counter.
      await collections.machines(db).updateOne(
        { _id: existing.machine_id },
        { $inc: { open_incident_count: -1 } },
      );
      await collections.machines(db).updateOne(
        { _id: machine._id },
        { $inc: { open_incident_count: 1 } },
      );
      set.machine_id = machine._id;
      set.machine_model_id = machine.machine_model_id;
      changed.push('machine_id');
    }
  }

  // Conversation / manual links.
  if (input.conversationId !== undefined) {
    if (input.conversationId === null) {
      set.conversation_id = null;
      if (existing.conversation_id) {
        await collections.conversations(db).updateOne(
          { _id: existing.conversation_id },
          { $pull: { incident_ids: incidentId } },
        );
      }
    } else {
      const conversation = await collections
        .conversations(db)
        .findOne({ _id: toObjectId(input.conversationId), is_deleted: false });
      if (!conversation) {
        throw ApiError.validation('The linked conversation does not exist.', [
          { field: 'conversationId', issue: 'No conversation has this id.' },
        ]);
      }
      set.conversation_id = conversation._id;
      await collections.conversations(db).updateOne(
        { _id: conversation._id },
        { $addToSet: { incident_ids: incidentId } },
      );
    }
    changed.push('conversation_id');
  }

  if (input.manualId !== undefined) {
    if (input.manualId === null) {
      set.manual_id = null;
      set.manual_version = null;
    } else {
      const manual = await requireLiveManual(db, toObjectId(input.manualId));
      set.manual_id = manual._id;
      set.manual_version = input.manualVersion ?? manual.document_version ?? null;
    }
    changed.push('manual_id');
  }

  // Assignment has its own endpoint-level rules but may also flow through here
  // for managers; the audit event is dedicated either way.
  if (input.assignedTo !== undefined) {
    const resolved = await resolveOrgUser(db, org, input.assignedTo);
    set.assigned_to = resolved;
    const previousAssignee = existing.assigned_to ? existing.assigned_to.toHexString() : null;
    const nextAssignee = resolved ? resolved.toHexString() : null;
    if (previousAssignee !== nextAssignee) {
      changed.push('assigned_to');
      await audit.record(db, {
        action: audit.AUDIT_ACTIONS.incidentAssigned,
        actor,
        entityType: 'incident',
        entityId: incidentId,
        requestId: requestId ?? null,
        changes: {
          assigned_to: { from: previousAssignee, to: nextAssignee },
        },
      });
      await appendTimelineEvent(db, incidentId, timelineEvent('assignment_changed', { id: actor.id, username: actor.username }, {
        previous: previousAssignee,
        next: nextAssignee,
        note: 'Assignee changed.',
      }));
    }
  }

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (changed.length > 0) {
    // Rebuild the search text whenever any indexed field changes.
    await collections.incidents(db).updateOne(
      { _id: incidentId },
      { $set: { search_text: rebuildSearchText(updated) } },
    );
    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.incidentUpdated,
      actor,
      entityType: 'incident',
      entityId: incidentId,
      requestId: requestId ?? null,
      metadata: { changed_fields: changed },
    });
    await appendTimelineEvent(db, incidentId, timelineEvent('incident_updated', { id: actor.id, username: actor.username }, {
      metadata: { changed_fields: changed },
      note: 'Incident details updated.',
    }));
    scheduleIncidentIndex(db, incidentId, actor, requestId);
  }

  const refreshed = await requireOrgIncident(db, org, incidentId);
  return toView(refreshed);
}

// ---------------------------------------------------------------------------
// Status / issue status
// ---------------------------------------------------------------------------

export async function changeStatus(
  db: Db,
  incidentId: ObjectId,
  status: IncidentStatus,
  reason: string | undefined,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);

  if (status === existing.status) {
    return toView(existing);
  }
  if (!canTransitionStatus(existing.status, status)) {
    throw ApiError.validation(`The transition ${existing.status} -> ${status} is not allowed.`, [
      { field: 'status', issue: 'Invalid status transition.' },
    ]);
  }
  // The dedicated endpoints own resolved/closed/cancelled semantics.
  if (status === 'resolved') {
    throw ApiError.validation(
      'Use the root-cause and fix workflows, then close the incident - status "resolved" is only reachable via those flows.',
      [{ field: 'status', issue: 'resolved must come from the workflow endpoints.' }],
    );
  }
  if (status === 'cancelled') {
    throw ApiError.validation('Use DELETE /api/incidents/:id to cancel an incident.', [
      { field: 'status', issue: 'Cancellation has its own endpoint.' },
    ]);
  }

  const wasActive = isActiveStatus(existing.status);
  const nowActive = isActiveStatus(status);

  const set: Record<string, unknown> = {
    status,
    ...updateStamps(actor.id),
  };
  if (status === 'reopened') {
    set.reopened_at = new Date();
    set.reopened_by = actor.id;
  }

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (wasActive !== nowActive && existing.machine_id) {
    await collections
      .machines(db)
      .updateOne(
        { _id: existing.machine_id },
        { $inc: { open_incident_count: nowActive ? 1 : -1 } },
      );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentStatusChanged,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
    changes: { status: { from: existing.status, to: status } },
    reason: reason ?? null,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('status_changed', { id: actor.id, username: actor.username }, {
    previous: existing.status,
    next: status,
    note: reason ?? null,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

export async function changeIssueStatus(
  db: Db,
  incidentId: ObjectId,
  issueStatus: IssueStatus,
  note: string | undefined,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  if (issueStatus === existing.issue_status) return toView(existing);
  if (!canTransitionIssueStatus(existing.issue_status, issueStatus)) {
    throw ApiError.validation(
      `The issue-status transition ${existing.issue_status} -> ${issueStatus} is not allowed.`,
      [{ field: 'issueStatus', issue: 'Invalid issue-status transition.' }],
    );
  }

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    {
      $set: {
        issue_status: issueStatus,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentIssueStatusChanged,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
    changes: { issue_status: { from: existing.issue_status, to: issueStatus } },
    reason: note ?? null,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('issue_status_changed', { id: actor.id, username: actor.username }, {
    previous: existing.issue_status,
    next: issueStatus,
    note: note ?? null,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

// ---------------------------------------------------------------------------
// Root cause workflow
// ---------------------------------------------------------------------------

/**
 * Update root-cause text/status. Reachable statuses from here:
 * `unknown`, `suspected`, `rejected`. `confirmed` is ONLY reachable through
 * the dedicated confirm endpoint.
 */
export async function updateRootCause(
  db: Db,
  incidentId: ObjectId,
  input: { text?: string; status?: RootCauseStatus; note?: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const current = existing.root_cause;
  const nextStatus = input.status ?? current.status;
  if (nextStatus === 'confirmed') {
    throw new ApiError(
      'FORBIDDEN',
      'A root cause can only be confirmed through POST /incidents/:id/root-cause/confirm.',
    );
  }
  if (current.status === 'confirmed') {
    throw new ApiError(
      'CONFLICT',
      'A confirmed root cause cannot be changed. The incident must be reopened and the cause re-investigated.',
    );
  }

  const nextText = input.text ?? current.text;
  const history = [
    ...(current.history ?? []),
    {
      at: new Date(),
      by: actor.id,
      by_username: actor.username,
      from: current.status,
      to: nextStatus,
      note: input.note ?? null,
      text: nextText,
    },
  ];

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    {
      $set: {
        'root_cause.text': nextText,
        'root_cause.status': nextStatus,
        'root_cause.history': history,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentRootCauseUpdated,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
    changes: { root_cause: { from: current.status, to: nextStatus } },
    reason: input.note ?? null,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('root_cause_changed', { id: actor.id, username: actor.username }, {
    previous: current.status,
    next: nextStatus,
    note: input.note ?? null,
    metadata: { root_cause_text: nextText },
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

/**
 * Confirm a root cause. Only an authorized human may do this, and a
 * confirmation note is mandatory. Every change is audited.
 */
export async function confirmRootCause(
  db: Db,
  incidentId: ObjectId,
  input: { note: string; text?: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const current = existing.root_cause;
  if (current.status === 'confirmed') {
    throw new ApiError('CONFLICT', 'This root cause is already confirmed.');
  }
  const text = input.text ?? current.text;
  if (!text) {
    throw ApiError.validation('A root cause text must exist before it can be confirmed.', [
      { field: 'text', issue: 'Record the suspected root cause first.' },
    ]);
  }

  const history = [
    ...(current.history ?? []),
    {
      at: new Date(),
      by: actor.id,
      by_username: actor.username,
      from: current.status,
      to: 'confirmed' as const,
      note: input.note,
      text,
    },
  ];

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    {
      $set: {
        'root_cause.text': text,
        'root_cause.status': 'confirmed',
        'root_cause.confirmation_note': input.note,
        'root_cause.confirmed_by': actor.id,
        'root_cause.confirmed_at': new Date(),
        'root_cause.history': history,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentRootCauseConfirmed,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { root_cause: { from: current.status, to: 'confirmed' } },
    reason: input.note,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('root_cause_confirmed', { id: actor.id, username: actor.username }, {
    previous: current.status,
    next: 'confirmed',
    note: input.note,
    metadata: { root_cause_text: text },
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

/** Reject a root cause. Requires an explicit reason and is audited. */
export async function rejectRootCause(
  db: Db,
  incidentId: ObjectId,
  input: { reason: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const current = existing.root_cause;
  if (current.status === 'confirmed') {
    throw new ApiError(
      'CONFLICT',
      'This root cause is confirmed. Rejecting a confirmed root cause is not supported - record the actual cause instead.',
    );
  }

  const history = [
    ...(current.history ?? []),
    {
      at: new Date(),
      by: actor.id,
      by_username: actor.username,
      from: current.status,
      to: 'rejected' as const,
      note: input.reason,
      text: current.text,
    },
  ];

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    {
      $set: {
        'root_cause.status': 'rejected',
        'root_cause.rejected_by': actor.id,
        'root_cause.rejected_at': new Date(),
        'root_cause.rejection_reason': input.reason,
        'root_cause.history': history,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentRootCauseRejected,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { root_cause: { from: current.status, to: 'rejected' } },
    reason: input.reason,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('root_cause_rejected', { id: actor.id, username: actor.username }, {
    previous: current.status,
    next: 'rejected',
    note: input.reason,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

export async function getRootCauseHistory(db: Db, incidentId: ObjectId, actor: { id: ObjectId; username: string; role: string }) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const doc = await requireOrgIncident(db, org, incidentId);
  return (doc.root_cause?.history ?? []).map((entry) => ({
    at: entry.at.toISOString(),
    by: entry.by.toHexString(),
    byUsername: entry.by_username ?? null,
    from: entry.from,
    to: entry.to,
    note: entry.note,
    text: entry.text ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Temporary / permanent fix workflows
// ---------------------------------------------------------------------------

async function recordFix(
  db: Db,
  incidentId: ObjectId,
  kind: 'temporary' | 'permanent',
  input: { description: string; result?: string; notes?: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const field = kind === 'temporary' ? 'temporary_fix' : 'permanent_fix';
  const current = existing[field] as IncidentFix | null | undefined;
  if (current?.status === 'confirmed') {
    throw new ApiError(
      'CONFLICT',
      `This incident already has a confirmed ${kind} fix. Reopen the incident before recording a new one.`,
    );
  }

  const fix: IncidentFix = {
    description: input.description,
    result: input.result ?? null,
    status: 'recorded',
    recorded_by: actor.id,
    recorded_at: new Date(),
    confirmed_by: null,
    confirmed_at: null,
    notes: input.notes ?? null,
    history: [
      {
        at: new Date(),
        by: actor.id,
        by_username: actor.username,
        from: 'not_recorded' as const,
        to: 'recorded' as const,
        note: input.notes ?? null,
      },
    ],
  };

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: { [field]: fix, ...updateStamps(actor.id) } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  const auditAction =
    kind === 'temporary'
      ? audit.AUDIT_ACTIONS.incidentTemporaryFixRecorded
      : audit.AUDIT_ACTIONS.incidentPermanentFixRecorded;
  await audit.record(db, {
    action: auditAction,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent(`${kind}_fix_recorded`, { id: actor.id, username: actor.username }, {
    metadata: { description: input.description },
    note: input.notes ?? null,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

export function recordTemporaryFix(db: Db, incidentId: ObjectId, input: { description: string; result?: string; notes?: string }, actor: { id: ObjectId; username: string; role: string }, requestId?: string) {
  return recordFix(db, incidentId, 'temporary', input, actor, requestId);
}

export function recordPermanentFix(db: Db, incidentId: ObjectId, input: { description: string; result?: string; notes?: string }, actor: { id: ObjectId; username: string; role: string }, requestId?: string) {
  return recordFix(db, incidentId, 'permanent', input, actor, requestId);
}

async function confirmFix(
  db: Db,
  incidentId: ObjectId,
  kind: 'temporary' | 'permanent',
  input: { note: string; result?: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);

  const field = kind === 'temporary' ? 'temporary_fix' : 'permanent_fix';
  const fix = existing[field] as IncidentFix | null | undefined;
  if (!fix) {
    throw ApiError.validation(`No ${kind} fix has been recorded for this incident.`, [
      { field, issue: 'Record the fix first.' },
    ]);
  }
  if (fix.status === 'confirmed') {
    throw new ApiError('CONFLICT', `The ${kind} fix is already confirmed.`);
  }
  requireManage(existing, org);
  assertNotSettled(existing, 'updated');

  const updatedFix: IncidentFix = {
    ...fix,
    result: input.result ?? fix.result,
    status: 'confirmed',
    confirmed_by: actor.id,
    confirmed_at: new Date(),
    history: [
      ...(fix.history ?? []),
      {
        at: new Date(),
        by: actor.id,
        by_username: actor.username,
        from: fix.status,
        to: 'confirmed' as const,
        note: input.note,
      },
    ],
  };

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: { [field]: updatedFix, ...updateStamps(actor.id) } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  const auditAction =
    kind === 'temporary'
      ? audit.AUDIT_ACTIONS.incidentTemporaryFixConfirmed
      : audit.AUDIT_ACTIONS.incidentPermanentFixConfirmed;
  await audit.record(db, {
    action: auditAction,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { [field]: { from: fix.status, to: 'confirmed' } },
    reason: input.note,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent(`${kind}_fix_confirmed`, { id: actor.id, username: actor.username }, {
    previous: fix.status,
    next: 'confirmed',
    note: input.note,
    metadata: { result: updatedFix.result },
  }));

  // Deterministic consequences of the explicit human confirmation above -
  // never inferred from AI output or timers.
  await applyFixConfirmationEffects(db, incidentId, kind, actor, requestId);

  const refreshed = await requireOrgIncident(db, org, incidentId);
  scheduleIncidentIndex(db, incidentId, actor, requestId);
  return toView(refreshed);
}

/**
 * Consequences of a confirmed fix, applied only through the explicit
 * confirmation endpoints:
 *
 *  - confirming a TEMPORARY fix moves the issue status to `temporary_fix`
 *    (when the current issue status permits it)
 *  - confirming a PERMANENT fix with a confirmed root cause moves the
 *    incident to `resolved` (when the workflow status permits it)
 *
 * `resolved` is NOT closure; the incident still needs POST /close.
 */
async function applyFixConfirmationEffects(
  db: Db,
  incidentId: ObjectId,
  kind: 'temporary' | 'permanent',
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
): Promise<void> {
  const doc = await collections.incidents(db).findOne({ _id: incidentId });
  if (!doc || doc.is_deleted) return;

  if (kind === 'temporary' && canTransitionIssueStatus(doc.issue_status, 'temporary_fix')) {
    await changeIssueStatus(db, incidentId, 'temporary_fix', 'A temporary fix was confirmed.', actor, requestId);
    return;
  }

  if (
    kind === 'permanent' &&
    doc.root_cause?.status === 'confirmed' &&
    canTransitionStatus(doc.status, 'resolved')
  ) {
    const now = new Date();
    await collections.incidents(db).updateOne(
      { _id: incidentId },
      {
        $set: {
          status: 'resolved',
          resolved_by: actor.id,
          resolved_at: now,
          issue_status: canTransitionIssueStatus(doc.issue_status, 'resolved') ? 'resolved' : doc.issue_status,
          ...updateStamps(actor.id),
        },
      },
    );
    if (isActiveStatus(doc.status)) {
      await collections
        .machines(db)
        .updateOne({ _id: doc.machine_id }, { $inc: { open_incident_count: -1 } });
    }
    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.incidentStatusChanged,
      actor,
      entityType: 'incident',
      entityId: incidentId,
      requestId: requestId ?? null,
      changes: { status: { from: doc.status, to: 'resolved' } },
      reason: 'Permanent fix and root cause confirmed by an authorized user.',
    });
    await appendTimelineEvent(db, incidentId, timelineEvent('status_changed', { id: actor.id, username: actor.username }, {
      previous: doc.status,
      next: 'resolved',
      note: 'Resolved after permanent-fix confirmation.',
    }));
  }
}

export function confirmTemporaryFix(db: Db, incidentId: ObjectId, input: { note: string; result?: string }, actor: { id: ObjectId; username: string; role: string }, requestId?: string) {
  return confirmFix(db, incidentId, 'temporary', input, actor, requestId);
}

export function confirmPermanentFix(db: Db, incidentId: ObjectId, input: { note: string; result?: string }, actor: { id: ObjectId; username: string; role: string }, requestId?: string) {
  return confirmFix(db, incidentId, 'permanent', input, actor, requestId);
}

export async function getFixHistory(db: Db, incidentId: ObjectId, actor: { id: ObjectId; username: string; role: string }) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const doc = await requireOrgIncident(db, org, incidentId);
  const out: Record<string, unknown> = {};
  for (const kind of ['temporary_fix', 'permanent_fix'] as const) {
    const fix = doc[kind];
    out[kind] = fix
      ? {
          description: fix.description,
          result: fix.result ?? null,
          status: fix.status,
          confirmedBy: fix.confirmed_by ? fix.confirmed_by.toHexString() : null,
          confirmedAt: fix.confirmed_at ? fix.confirmed_at.toISOString() : null,
          notes: fix.notes ?? null,
          recordedBy: fix.recorded_by.toHexString(),
          recordedAt: fix.recorded_at.toISOString(),
          history: (fix.history ?? []).map((entry) => ({
            at: entry.at.toISOString(),
            by: entry.by.toHexString(),
            byUsername: entry.by_username ?? null,
            from: entry.from,
            to: entry.to,
            note: entry.note,
          })),
        }
      : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Close / reopen / delete
// ---------------------------------------------------------------------------

/**
 * Close a resolved incident. Requires a resolution summary and an explicit
 * authorized user confirmation.
 */
export async function close(
  db: Db,
  incidentId: ObjectId,
  input: { resolutionSummary: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);

  if (existing.status !== 'resolved') {
    throw new ApiError(
      'CONFLICT',
      'Only a resolved incident can be closed. Confirm the root cause and a fix first.',
    );
  }

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    {
      $set: {
        status: 'closed',
        resolution_summary: input.resolutionSummary,
        closed_by: actor.id,
        closed_at: new Date(),
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentClosed,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { status: { from: 'resolved', to: 'closed' } },
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('incident_closed', { id: actor.id, username: actor.username }, {
    previous: 'resolved',
    next: 'closed',
    note: input.resolutionSummary,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

/** Reopen a resolved or closed incident. Requires a reason and an audit entry. */
export async function reopen(
  db: Db,
  incidentId: ObjectId,
  input: { reason: string },
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);

  // Technicians may reopen incidents they own; managers/admins any incident.
  if (actor.role === 'technician' && !ownsIncident(existing, org)) {
    throw new ApiError('FORBIDDEN', 'Only a manager or the assigned technician may reopen this incident.');
  }
  if (!['resolved', 'closed', 'reopened'].includes(existing.status)) {
    throw new ApiError('CONFLICT', 'Only resolved, closed, or reopened incidents can be reopened.');
  }
  if (existing.status === 'reopened') return toView(existing);

  const wasActive = isActiveStatus(existing.status);
  const set: Record<string, unknown> = {
    status: 'reopened',
    reopened_by: actor.id,
    reopened_at: new Date(),
    ...updateStamps(actor.id),
  };

  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (!wasActive && existing.machine_id) {
    await collections
      .machines(db)
      .updateOne({ _id: existing.machine_id }, { $inc: { open_incident_count: 1 } });
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentReopened,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { status: { from: existing.status, to: 'reopened' } },
    reason: input.reason,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('incident_reopened', { id: actor.id, username: actor.username }, {
    previous: existing.status,
    next: 'reopened',
    note: input.reason,
  }));
  scheduleIncidentIndex(db, incidentId, actor, requestId);

  return toView(updated);
}

/**
 * Cancel (soft delete) an incident. The incident number is never reused, the
 * Qdrant point is deleted, and the machine's open-incident counter is released.
 */
export async function cancel(
  db: Db,
  incidentId: ObjectId,
  reason: string,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  requireManage(existing, org);

  if (existing.status === 'cancelled') {
    throw new ApiError('CONFLICT', 'This incident is already cancelled.');
  }

  const wasActive = isActiveStatus(existing.status);
  const stamps = deletionStamps(actor.id, reason);
  const updated = await collections.incidents(db).findOneAndUpdate(
    { _id: incidentId },
    { $set: { status: 'cancelled', ...stamps } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Incident not found.');

  if (wasActive && existing.machine_id) {
    await collections
      .machines(db)
      .updateOne({ _id: existing.machine_id }, { $inc: { open_incident_count: -1 } });
  }
  if (existing.conversation_id) {
    await collections.conversations(db).updateOne(
      { _id: existing.conversation_id },
      { $pull: { incident_ids: incidentId } },
    );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentCancelled,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    severity: 'notice',
    requestId: requestId ?? null,
    changes: { status: { from: existing.status, to: 'cancelled' } },
    reason,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('incident_cancelled', { id: actor.id, username: actor.username }, {
    previous: existing.status,
    next: 'cancelled',
    note: reason,
  }));

  scheduleIncidentDelete(db, incidentId, actor, requestId);
  return { id: incidentId.toHexString(), incidentNumber: existing.incident_number, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export async function timeline(
  db: Db,
  incidentId: ObjectId,
  actor: { id: ObjectId; username: string; role: string },
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const doc = await requireOrgIncident(db, org, incidentId);
  const events = await getTimeline(db, doc);
  return events.slice(-TIMELINE_LIMIT).map((event) => ({
    id: event._id.toHexString(),
    sequence: event.sequence,
    type: event.type,
    at: event.at.toISOString(),
    actorId: event.actor_id ? event.actor_id.toHexString() : null,
    actorUsername: event.actor_username ?? null,
    previous: event.previous,
    next: event.next,
    note: event.note,
    metadata: event.metadata ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Similar incidents
// ---------------------------------------------------------------------------

export interface SimilarIncidentResult {
  incidentId: string;
  incidentNumber: string;
  title: string;
  machineId: string | null;
  machineModelId: string;
  status: string;
  issueStatus: string;
  severity: string;
  errorCodes: string[];
  symptoms: string[];
  rootCauseStatus: string;
  confirmedRootCause: string | null;
  confirmedFix: string | null;
  resolutionSummary: string | null;
  resolvedAt: string | null;
  createdAt: string;
  similarityScore: number;
  similarityReasons: string[];
  confirmed: boolean;
}

/**
 * Similar historical incidents via FastAPI (Qdrant semantic + Mongo exact
 * matching). Confirmed incidents rank above speculative ones, and the
 * response always carries similarity REASONS plus a `confirmed` flag so the
 * UI can render the "historical evidence, not proof" disclaimer.
 */
export async function similar(
  db: Db,
  incidentId: ObjectId,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
): Promise<SimilarIncidentResult[]> {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);

  let matches: SimilarIncidentMatch[] = [];
  let warnings: string[] = [];
  try {
    const response = await fetchSimilarIncidents(existing, getConfig().incidentMemory.similarLimit, requestId);
    matches = response.similar;
    warnings = response.warnings;
  } catch (error) {
    // Semantic retrieval is supplementary. If the AI service is down we fall
    // back to Mongo-only structured matches instead of failing the request.
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Semantic similar-incident retrieval unavailable: ${message}`);
  }

  // Mongo fallback: exact error-code matches in the same organization, same
  // or any model (model match ranks higher, enforced by FastAPI when up).
  if (matches.length === 0 && existing.error_codes.length > 0) {
    const fallback = await collections
      .incidents(db)
      .find(
        liveFilter({
          organization_id: org.orgId,
          _id: { $ne: incidentId },
          error_codes: { $in: existing.error_codes },
        }),
        { projection: { _id: 1, machine_id: 1, machine_model_id: 1, root_cause: 1, permanent_fix: 1, temporary_fix: 1, resolved_at: 1 } },
      )
      .sort({ machine_model_id: 1, resolved_at: -1 })
      .limit(getConfig().incidentMemory.similarLimit)
      .toArray();

    for (const hit of fallback) {
      const sameModel = hit.machine_model_id.equals(existing.machine_model_id);
      const sameMachine = hit.machine_id?.equals(existing.machine_id) ?? false;
      const reasons: string[] = [];
      reasons.push('Exact error-code match');
      if (sameMachine) reasons.push('Same machine');
      if (sameModel) reasons.push('Same machine model');
      const confirmed =
        hit.root_cause?.status === 'confirmed' &&
        (hit.permanent_fix?.status === 'confirmed' || hit.temporary_fix?.status === 'confirmed');
      if (confirmed) reasons.push('Has confirmed root cause and confirmed fix');
      matches.push({
        incident_id: hit._id.toHexString(),
        qdrant_point_id: null,
        similarity_score: Math.round((0.55 + (sameModel ? 0.15 : 0) + (confirmed ? 0.1 : 0)) * 1000) / 1000,
        reasons,
      });
    }
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentSimilarSearch,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
    metadata: { match_count: matches.length, warnings },
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('similar_incident_search', { id: actor.id, username: actor.username }, {
    metadata: { match_count: matches.length, semantic_available: warnings.length === 0 },
  }));

  const seen = new Set<string>();
  const out: SimilarIncidentResult[] = [];
  for (const match of matches) {
    if (seen.has(match.incident_id)) continue;
    seen.add(match.incident_id);
    const doc = await collections
      .incidents(db)
      .findOne(liveFilter({ _id: toObjectId(match.incident_id), organization_id: org.orgId }));
    if (!doc || doc._id.equals(incidentId)) continue;

    const confirmedRootCause = doc.root_cause?.status === 'confirmed' ? doc.root_cause.text : null;
    const confirmedFix =
      doc.permanent_fix?.status === 'confirmed'
        ? doc.permanent_fix.description
        : doc.temporary_fix?.status === 'confirmed'
          ? doc.temporary_fix.description
          : null;

    out.push({
      incidentId: doc._id.toHexString(),
      incidentNumber: doc.incident_number,
      title: doc.title,
      machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
      machineModelId: doc.machine_model_id.toHexString(),
      status: doc.status,
      issueStatus: doc.issue_status,
      severity: doc.severity,
      errorCodes: doc.error_codes ?? [],
      symptoms: (doc.symptoms ?? []).slice(0, 5),
      rootCauseStatus: doc.root_cause?.status ?? 'unknown',
      confirmedRootCause,
      confirmedFix,
      resolutionSummary: doc.resolution_summary ?? null,
      resolvedAt: doc.resolved_at ? doc.resolved_at.toISOString() : null,
      createdAt: doc.created_at.toISOString(),
      similarityScore: match.similarity_score,
      similarityReasons: match.reasons,
      confirmed: Boolean(confirmedRootCause && confirmedFix),
    });
  }
  out.sort((a, b) => b.similarityScore - a.similarityScore);
  return out;
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

export async function reindex(
  db: Db,
  incidentId: ObjectId,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
) {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const existing = await requireOrgIncident(db, org, incidentId);
  if (existing.is_deleted) throw ApiError.notFound('Incident not found.');

  scheduleIncidentReindex(db, incidentId, actor, requestId);
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentReindexed,
    actor,
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
  });
  await appendTimelineEvent(db, incidentId, timelineEvent('qdrant_reindex_queued', { id: actor.id, username: actor.username }, {
    note: 'Incident re-index queued.',
  }));
  return { id: incidentId.toHexString(), embeddingStatus: 'pending' };
}
