/**
 * Machines: physical assets on the floor.
 *
 * Two rules here are load-bearing and are enforced nowhere else:
 *  1. `asset_tag` is immutable. It is how the shop floor refers to the asset
 *     and how history stays attached to it.
 *  2. A machine with incidents or maintenance is never hard-deleted. Deleting
 *     it would destroy the failure history that Phase 4 retrieval depends on;
 *     `retired` is the correct end state.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { Criticality, MachineStatus } from '@itp/shared';
import { collections, type MachineDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
  creationStamps,
  deletionStamps,
  duplicateKeyToApiError,
  liveFilter,
  paginate,
  updateStamps,
} from '../../common/repository.js';
import {
  buildSort,
  containsMatcher,
  toObjectId,
  type PaginationInput,
} from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';

export const SORTABLE = [
  'created_at',
  'updated_at',
  'asset_tag',
  'status',
  'last_maintenance_at',
] as const;

export interface MachineView {
  id: string;
  assetTag: string;
  machineModelId: string;
  modelSnapshot: { manufacturer: string; modelName: string; machineType: string } | null;
  displayName: string | null;
  serialNumber: string | null;
  location: Record<string, unknown> | null;
  status: MachineStatus;
  installedAt: string | null;
  commissionedAt: string | null;
  criticality: Criticality | null;
  notes: string | null;
  lastMaintenanceAt: string | null;
  openIncidentCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: MachineDoc): MachineView {
  return {
    id: doc._id.toHexString(),
    assetTag: doc.asset_tag,
    machineModelId: doc.machine_model_id.toHexString(),
    // Snapshot is display-only; the id above is the source of truth.
    modelSnapshot: doc.model_snapshot
      ? {
          manufacturer: doc.model_snapshot.manufacturer,
          modelName: doc.model_snapshot.model_name,
          machineType: doc.model_snapshot.machine_type,
        }
      : null,
    displayName: doc.display_name ?? null,
    serialNumber: doc.serial_number ?? null,
    location: (doc.location as Record<string, unknown> | null) ?? null,
    status: doc.status,
    installedAt: doc.installed_at ? doc.installed_at.toISOString() : null,
    commissionedAt: doc.commissioned_at ? doc.commissioned_at.toISOString() : null,
    criticality: doc.criticality ?? null,
    notes: doc.notes ?? null,
    lastMaintenanceAt: doc.last_maintenance_at ? doc.last_maintenance_at.toISOString() : null,
    openIncidentCount: doc.open_incident_count ?? 0,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateInput {
  assetTag: string;
  machineModelId: string;
  displayName?: string;
  serialNumber?: string;
  location?: { site?: string; area?: string; line?: string; position?: string };
  status?: MachineStatus;
  installedAt?: Date;
  commissionedAt?: Date;
  criticality?: Criticality;
  notes?: string;
}

type Actor = { id: ObjectId; username: string; role: string };

export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<MachineView> {
  // Business rule 1: the referenced model must exist and be live.
  const modelId = toObjectId(input.machineModelId);
  const model = await requireLiveModel(db, modelId);

  const doc: Omit<MachineDoc, '_id'> = {
    asset_tag: input.assetTag,
    machine_model_id: model._id,
    // Denormalised for list rendering so the UI need not join on every row.
    model_snapshot: {
      manufacturer: model.manufacturer,
      model_name: model.model_name,
      machine_type: model.machine_type,
    },
    display_name: input.displayName ?? null,
    serial_number: input.serialNumber ?? null,
    location: input.location ?? null,
    status: input.status ?? 'operational',
    installed_at: input.installedAt ?? null,
    commissioned_at: input.commissionedAt ?? null,
    criticality: input.criticality ?? null,
    notes: input.notes ?? null,
    last_maintenance_at: null,
    open_incident_count: 0,
    is_deleted: false,
    ...creationStamps(actor.id),
  } as Omit<MachineDoc, '_id'>;

  let created: MachineDoc;
  try {
    const result = await collections.machines(db).insertOne(doc as MachineDoc);
    created = { ...(doc as MachineDoc), _id: result.insertedId };
  } catch (error) {
    throw duplicateKeyToApiError(error, `Asset tag "${input.assetTag}" is already in use.`);
  }

  // Keep the model's rollup counter honest.
  await collections
    .machineModels(db)
    .updateOne({ _id: model._id }, { $inc: { machine_count: 1 } });

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.machineCreated,
    actor,
    entityType: 'machine',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { asset_tag: created.asset_tag },
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  status?: MachineStatus;
  machineModelId?: string;
  criticality?: Criticality;
  site?: string;
  search?: string;
}

export async function list(db: Db, query: ListQuery) {
  const filter: Filter<MachineDoc> = {};

  if (query.status) filter.status = query.status;
  if (query.criticality) filter.criticality = query.criticality;
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.site) filter['location.site'] = query.site;

  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [
      { asset_tag: matcher },
      { display_name: matcher },
      { serial_number: matcher },
    ];
  }

  const result = await paginate(collections.machines(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, id: ObjectId): Promise<MachineView> {
  const doc = await collections.machines(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Machine not found.');
  return toView(doc);
}

export interface UpdateInput extends Partial<Omit<CreateInput, 'assetTag'>> {
  /** Required when machineModelId changes - the change is audited. */
  modelChangeReason?: string;
}

export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  requestId?: string,
): Promise<MachineView> {
  const existing = await collections.machines(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Machine not found.');

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  let modelChanged = false;

  if (input.machineModelId !== undefined) {
    const nextModelId = toObjectId(input.machineModelId);
    if (!nextModelId.equals(existing.machine_model_id)) {
      // Re-modelling an asset invalidates which manuals apply to it, so it is
      // treated as a significant, reason-bearing, separately-audited event.
      if (!input.modelChangeReason) {
        throw ApiError.validation('Changing the machine model requires a reason.', [
          {
            field: 'modelChangeReason',
            issue: 'Provide a reason when reassigning a machine to a different model.',
          },
        ]);
      }
      const model = await requireLiveModel(db, nextModelId);
      set.machine_model_id = model._id;
      set.model_snapshot = {
        manufacturer: model.manufacturer,
        model_name: model.model_name,
        machine_type: model.machine_type,
      };
      modelChanged = true;
    }
  }

  if (input.displayName !== undefined) set.display_name = input.displayName;
  if (input.serialNumber !== undefined) set.serial_number = input.serialNumber;
  if (input.location !== undefined) set.location = input.location;
  if (input.status !== undefined) set.status = input.status;
  if (input.installedAt !== undefined) set.installed_at = input.installedAt;
  if (input.commissionedAt !== undefined) set.commissioned_at = input.commissionedAt;
  if (input.criticality !== undefined) set.criticality = input.criticality;
  if (input.notes !== undefined) set.notes = input.notes;

  let updated: MachineDoc | null;
  try {
    updated = await collections
      .machines(db)
      .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  } catch (error) {
    throw duplicateKeyToApiError(error, 'That value is already in use by another machine.');
  }
  if (!updated) throw ApiError.notFound('Machine not found.');

  if (modelChanged) {
    await Promise.all([
      collections
        .machineModels(db)
        .updateOne({ _id: existing.machine_model_id }, { $inc: { machine_count: -1 } }),
      collections
        .machineModels(db)
        .updateOne({ _id: updated.machine_model_id }, { $inc: { machine_count: 1 } }),
    ]);

    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.machineModelChanged,
      actor,
      entityType: 'machine',
      entityId: id,
      severity: 'notice',
      reason: input.modelChangeReason ?? null,
      requestId: requestId ?? null,
      metadata: {
        from: existing.machine_model_id.toHexString(),
        to: updated.machine_model_id.toHexString(),
      },
    });
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.machineUpdated,
    actor,
    entityType: 'machine',
    entityId: id,
    requestId: requestId ?? null,
    changes: audit.buildChanges('machine', existing as unknown as Record<string, unknown>, set),
  });

  return toView(updated);
}

/**
 * Soft-delete a machine.
 *
 * Business rule: refused while incidents or maintenance records exist. The
 * error tells the operator to retire the machine instead, which is the
 * outcome they actually want.
 */
export async function remove(
  db: Db,
  id: ObjectId,
  actor: Actor,
  reason: string | undefined,
  requestId?: string,
): Promise<void> {
  const existing = await collections.machines(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Machine not found.');

  const [incidentCount, maintenanceCount] = await Promise.all([
    collections.incidents(db).countDocuments(liveFilter({ machine_id: id })),
    collections.maintenanceRecords(db).countDocuments(liveFilter({ machine_id: id })),
  ]);

  if (incidentCount > 0 || maintenanceCount > 0) {
    throw new ApiError(
      'CONFLICT',
      'This machine has recorded history and cannot be deleted. Set its status to "retired" instead.',
      {
        details: [
          ...(incidentCount > 0
            ? [{ field: 'incidents', issue: `${incidentCount} incident(s) reference this machine.` }]
            : []),
          ...(maintenanceCount > 0
            ? [
                {
                  field: 'maintenance',
                  issue: `${maintenanceCount} maintenance record(s) reference this machine.`,
                },
              ]
            : []),
        ],
      },
    );
  }

  await collections.machines(db).updateOne({ _id: id }, { $set: deletionStamps(actor.id, reason) });
  await collections
    .machineModels(db)
    .updateOne({ _id: existing.machine_model_id }, { $inc: { machine_count: -1 } });

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.machineDeleted,
    actor,
    entityType: 'machine',
    entityId: id,
    severity: 'notice',
    reason: reason ?? null,
    requestId: requestId ?? null,
  });
}

/** Resolve a machine that must exist and be live. Used by incidents/maintenance. */
export async function requireLiveMachine(db: Db, id: ObjectId): Promise<MachineDoc> {
  const doc = await collections.machines(db).findOne(liveFilter({ _id: id }));
  if (!doc) {
    throw ApiError.validation('The referenced machine does not exist.', [
      { field: 'machineId', issue: 'No live machine has this id.' },
    ]);
  }
  return doc;
}
