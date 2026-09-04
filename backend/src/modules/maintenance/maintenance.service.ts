/**
 * Maintenance records: planned and corrective work performed on a machine.
 *
 * Phase 2 keeps this strictly structured - types, dates, parts, measurements.
 * No free-text similarity search and no "recommendations": those are Phase 4+
 * and would require retrieval this phase deliberately does not build.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { MaintenanceType } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type MaintenanceRecordDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { liveFilter, paginate, updateStamps } from '../../common/repository.js';
import {
  buildSort,
  containsMatcher,
  normalisePartNumber,
  toObjectId,
  type PaginationInput,
} from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';

export const SORTABLE = ['performed_at', 'created_at', 'updated_at', 'next_due_at'] as const;

/** Author edit window, matching incident actions for consistency. */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

type Actor = { id: ObjectId; username: string; role: string };

export interface MaintenanceView {
  id: string;
  machineId: string;
  machineModelId: string;
  maintenanceType: MaintenanceType;
  title: string;
  description: string | null;
  performedAt: string;
  performedBy: string | null;
  performedByExternal: string | null;
  workOrderRef: string | null;
  partsReplaced: { partNumber: string; name: string | null; quantity: number }[];
  componentsServiced: string[];
  measurements: { name: string; value: number; unit: string | null; inSpec: boolean | null }[];
  durationMinutes: number | null;
  downtimeMinutes: number | null;
  nextDueAt: string | null;
  relatedIncidentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: MaintenanceRecordDoc): MaintenanceView {
  return {
    id: doc._id.toHexString(),
    machineId: doc.machine_id.toHexString(),
    machineModelId: doc.machine_model_id.toHexString(),
    maintenanceType: doc.maintenance_type,
    title: doc.title,
    description: doc.description ?? null,
    performedAt: doc.performed_at.toISOString(),
    performedBy: doc.performed_by ? doc.performed_by.toHexString() : null,
    performedByExternal: doc.performed_by_external ?? null,
    workOrderRef: doc.work_order_ref ?? null,
    partsReplaced: (doc.parts_replaced ?? []).map((part) => ({
      partNumber: part.part_number,
      name: part.name ?? null,
      quantity: part.quantity ?? 1,
    })),
    componentsServiced: doc.components_serviced ?? [],
    measurements: (doc.measurements ?? []).map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit ?? null,
      inSpec: m.in_spec ?? null,
    })),
    durationMinutes: doc.duration_minutes ?? null,
    downtimeMinutes: doc.downtime_minutes ?? null,
    nextDueAt: doc.next_due_at ? doc.next_due_at.toISOString() : null,
    relatedIncidentId: doc.related_incident_id ? doc.related_incident_id.toHexString() : null,
    notes: doc.notes ?? null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateInput {
  machineId: string;
  maintenanceType: MaintenanceType;
  title: string;
  description?: string;
  performedAt: Date;
  performedByExternal?: string;
  workOrderRef?: string;
  partsReplaced?: { partNumber: string; name?: string; quantity?: number }[];
  componentsServiced?: string[];
  measurements?: { name: string; value: number; unit?: string; inSpec?: boolean }[];
  durationMinutes?: number;
  downtimeMinutes?: number;
  nextDueAt?: Date;
  relatedIncidentId?: string;
  notes?: string;
}

export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<MaintenanceView> {
  const machine = await requireLiveMachine(db, toObjectId(input.machineId));

  let relatedIncidentId: ObjectId | null = null;
  if (input.relatedIncidentId) {
    const incident = await collections
      .incidents(db)
      .findOne(liveFilter({ _id: toObjectId(input.relatedIncidentId) }));
    if (!incident) {
      throw ApiError.validation('The related incident does not exist.', [
        { field: 'relatedIncidentId', issue: 'No live incident has this id.' },
      ]);
    }
    // Cross-entity consistency: linking maintenance on machine A to an
    // incident on machine B would corrupt the machine history view.
    if (incident.machine_id && !incident.machine_id.equals(machine._id)) {
      throw ApiError.validation('The related incident belongs to a different machine.', [
        { field: 'relatedIncidentId', issue: 'Incident and maintenance must share a machine.' },
      ]);
    }
    relatedIncidentId = incident._id;
  }

  const now = new Date();
  const doc: Omit<MaintenanceRecordDoc, '_id'> = {
    machine_id: machine._id,
    // Derived from the machine, never from the request body.
    machine_model_id: machine.machine_model_id,
    maintenance_type: input.maintenanceType,
    title: input.title,
    description: input.description ?? null,
    performed_at: input.performedAt,
    performed_by: actor.id,
    performed_by_external: input.performedByExternal ?? null,
    work_order_ref: input.workOrderRef ?? null,
    parts_replaced: (input.partsReplaced ?? []).map((part) => ({
      part_number: normalisePartNumber(part.partNumber),
      name: part.name ?? null,
      quantity: part.quantity ?? 1,
      serial: null,
    })),
    components_serviced: input.componentsServiced ?? [],
    measurements: (input.measurements ?? []).map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit ?? null,
      in_spec: m.inSpec ?? null,
    })),
    duration_minutes: input.durationMinutes ?? null,
    downtime_minutes: input.downtimeMinutes ?? null,
    next_due_at: input.nextDueAt ?? null,
    related_incident_id: relatedIncidentId,
    notes: input.notes ?? null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    created_by: actor.id,
    updated_by: actor.id,
    schema_version: SCHEMA_VERSION,
  } as Omit<MaintenanceRecordDoc, '_id'>;

  const result = await collections.maintenanceRecords(db).insertOne(doc as MaintenanceRecordDoc);
  const created = { ...(doc as MaintenanceRecordDoc), _id: result.insertedId };

  await refreshMachineLastMaintenance(db, machine._id);

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.maintenanceCreated,
    actor,
    entityType: 'maintenance_record',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { machine_id: machine._id.toHexString(), type: created.maintenance_type },
  });

  return toView(created);
}

/**
 * Recompute `machines.last_maintenance_at` from the records themselves.
 *
 * Reading the max back out is slightly more work than `$max` on write, but it
 * stays correct when a record is back-dated or soft-deleted.
 */
async function refreshMachineLastMaintenance(db: Db, machineId: ObjectId): Promise<void> {
  const latest = await collections
    .maintenanceRecords(db)
    .find(liveFilter({ machine_id: machineId }))
    .sort({ performed_at: -1 })
    .limit(1)
    .next();

  await collections.machines(db).updateOne(
    { _id: machineId },
    { $set: { last_maintenance_at: latest ? latest.performed_at : null } },
  );
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  machineId?: string;
  machineModelId?: string;
  maintenanceType?: MaintenanceType;
  performedFrom?: Date;
  performedTo?: Date;
  partNumber?: string;
  dueBefore?: Date;
  search?: string;
}

export async function list(db: Db, query: ListQuery) {
  const filter: Filter<MaintenanceRecordDoc> = {};

  if (query.machineId) filter.machine_id = toObjectId(query.machineId);
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.maintenanceType) filter.maintenance_type = query.maintenanceType;
  // Normalised the same way as on write, so the lookup actually matches.
  if (query.partNumber) {
    filter['parts_replaced.part_number'] = normalisePartNumber(query.partNumber);
  }
  if (query.dueBefore) filter.next_due_at = { $ne: null, $lte: query.dueBefore };

  if (query.performedFrom || query.performedTo) {
    filter.performed_at = {
      ...(query.performedFrom ? { $gte: query.performedFrom } : {}),
      ...(query.performedTo ? { $lte: query.performedTo } : {}),
    };
  }

  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [{ title: matcher }, { work_order_ref: matcher }];
  }

  const result = await paginate(collections.maintenanceRecords(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'performed_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, id: ObjectId): Promise<MaintenanceView> {
  const doc = await collections.maintenanceRecords(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Maintenance record not found.');
  return toView(doc);
}

export type UpdateInput = Partial<Omit<CreateInput, 'machineId' | 'relatedIncidentId'>>;

/**
 * Update a maintenance record.
 *
 * `machineId` is immutable: moving a record between machines would rewrite two
 * machines' histories at once. Delete and re-create if it was logged against
 * the wrong asset.
 */
export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  requestId?: string,
): Promise<MaintenanceView> {
  const existing = await collections.maintenanceRecords(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Maintenance record not found.');

  const isAuthor = existing.performed_by?.equals(actor.id) ?? false;
  const isManager = actor.role === 'admin' || actor.role === 'manager';

  if (!isManager) {
    if (!isAuthor) {
      throw new ApiError('FORBIDDEN', 'You can only edit maintenance records that you logged.');
    }
    if (Date.now() - existing.created_at.getTime() > EDIT_WINDOW_MS) {
      throw new ApiError(
        'FORBIDDEN',
        'The 24-hour edit window for this record has passed. Ask a manager to amend it.',
      );
    }
  }

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  if (input.maintenanceType !== undefined) set.maintenance_type = input.maintenanceType;
  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.performedAt !== undefined) set.performed_at = input.performedAt;
  if (input.performedByExternal !== undefined) {
    set.performed_by_external = input.performedByExternal;
  }
  if (input.workOrderRef !== undefined) set.work_order_ref = input.workOrderRef;
  if (input.partsReplaced !== undefined) {
    set.parts_replaced = input.partsReplaced.map((part) => ({
      part_number: normalisePartNumber(part.partNumber),
      name: part.name ?? null,
      quantity: part.quantity ?? 1,
      serial: null,
    }));
  }
  if (input.componentsServiced !== undefined) set.components_serviced = input.componentsServiced;
  if (input.measurements !== undefined) {
    set.measurements = input.measurements.map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit ?? null,
      in_spec: m.inSpec ?? null,
    }));
  }
  if (input.durationMinutes !== undefined) set.duration_minutes = input.durationMinutes;
  if (input.downtimeMinutes !== undefined) set.downtime_minutes = input.downtimeMinutes;
  if (input.nextDueAt !== undefined) set.next_due_at = input.nextDueAt;
  if (input.notes !== undefined) set.notes = input.notes;

  const updated = await collections
    .maintenanceRecords(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Maintenance record not found.');

  if (input.performedAt !== undefined) {
    await refreshMachineLastMaintenance(db, existing.machine_id);
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.maintenanceUpdated,
    actor,
    entityType: 'maintenance_record',
    entityId: id,
    requestId: requestId ?? null,
    changes: audit.buildChanges(
      'maintenance_record',
      existing as unknown as Record<string, unknown>,
      set,
    ),
  });

  return toView(updated);
}
