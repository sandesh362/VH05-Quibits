/**
 * Machine models: the product/type definition (an "EC180SX"), not a physical
 * asset on the floor.
 *
 * This collection is the retrieval filter key for Phase 4+, which makes
 * duplicate prevention a correctness concern rather than a tidiness one: two
 * near-identical model rows silently split the manual corpus in half and the
 * assistant starts missing evidence it should have found.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { MachineType } from '@itp/shared';
import {
  collections,
  type MachineModelDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
  creationStamps,
  deletionStamps,
  duplicateKeyToApiError,
  liveFilter,
  paginate,
  updateStamps,
} from '../../common/repository.js';
import { buildSort, containsMatcher } from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import type { PaginationInput } from '../../common/validation.js';

const CI_COLLATION = { locale: 'en', strength: 2 } as const;

/** Sortable fields. Anything else falls back - see buildSort. */
export const SORTABLE = ['created_at', 'updated_at', 'manufacturer', 'model_name'] as const;

export interface MachineModelView {
  id: string;
  manufacturer: string;
  modelName: string;
  machineType: MachineType;
  aliases: string[];
  modelYear: number | null;
  specifications: Record<string, unknown> | null;
  defaultLanguage: string;
  notes: string | null;
  machineCount: number;
  manualCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: MachineModelDoc): MachineModelView {
  return {
    id: doc._id.toHexString(),
    manufacturer: doc.manufacturer,
    modelName: doc.model_name,
    machineType: doc.machine_type,
    aliases: doc.aliases ?? [],
    modelYear: doc.model_year ?? null,
    specifications: doc.specifications ?? null,
    defaultLanguage: doc.default_language,
    notes: doc.notes ?? null,
    machineCount: doc.machine_count ?? 0,
    manualCount: doc.manual_count ?? 0,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateInput {
  manufacturer: string;
  modelName: string;
  machineType: MachineType;
  aliases?: string[];
  modelYear?: number;
  specifications?: Record<string, unknown>;
  defaultLanguage?: string;
  notes?: string;
}

export async function create(
  db: Db,
  input: CreateInput,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
): Promise<MachineModelView> {
  const doc: Omit<MachineModelDoc, '_id'> = {
    manufacturer: input.manufacturer,
    model_name: input.modelName,
    machine_type: input.machineType,
    aliases: input.aliases ?? [],
    model_year: input.modelYear ?? null,
    specifications: input.specifications ?? null,
    default_language: input.defaultLanguage ?? 'en',
    notes: input.notes ?? null,
    manual_count: 0,
    machine_count: 0,
    indexed_chunk_count: 0,
    is_deleted: false,
    ...creationStamps(actor.id),
  } as Omit<MachineModelDoc, '_id'>;

  try {
    const result = await collections.machineModels(db).insertOne(doc as MachineModelDoc);
    const created = { ...(doc as MachineModelDoc), _id: result.insertedId };

    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.machineModelCreated,
      actor: { id: actor.id, username: actor.username, role: actor.role },
      entityType: 'machine_model',
      entityId: created._id,
      requestId: requestId ?? null,
      metadata: { manufacturer: created.manufacturer, model_name: created.model_name },
    });

    return toView(created);
  } catch (error) {
    // The unique index is the arbiter, not a pre-check: two concurrent creates
    // would both pass a "does it exist?" query.
    throw duplicateKeyToApiError(
      error,
      `A machine model "${input.manufacturer} ${input.modelName}" already exists.`,
    );
  }
}

export interface ListQuery extends PaginationInput {
  manufacturer?: string;
  machineType?: MachineType;
  search?: string;
  sortBy?: string;
}

export async function list(db: Db, query: ListQuery) {
  const filter: Filter<MachineModelDoc> = {};

  if (query.manufacturer) filter.manufacturer = containsMatcher(query.manufacturer);
  if (query.machineType) filter.machine_type = query.machineType;

  // Search spans the human-meaningful identifiers, including aliases so
  // "EC-180SX" finds a model stored as "EC180SX".
  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [{ manufacturer: matcher }, { model_name: matcher }, { aliases: matcher }];
  }

  const result = await paginate(collections.machineModels(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, id: ObjectId): Promise<MachineModelView> {
  const doc = await collections.machineModels(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Machine model not found.');
  return toView(doc);
}

export type UpdateInput = Partial<CreateInput>;

export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: { id: ObjectId; username: string; role: string },
  requestId?: string,
): Promise<MachineModelView> {
  const existing = await collections.machineModels(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Machine model not found.');

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  if (input.manufacturer !== undefined) set.manufacturer = input.manufacturer;
  if (input.modelName !== undefined) set.model_name = input.modelName;
  if (input.machineType !== undefined) set.machine_type = input.machineType;
  if (input.aliases !== undefined) set.aliases = input.aliases;
  if (input.modelYear !== undefined) set.model_year = input.modelYear;
  if (input.specifications !== undefined) set.specifications = input.specifications;
  if (input.defaultLanguage !== undefined) set.default_language = input.defaultLanguage;
  if (input.notes !== undefined) set.notes = input.notes;

  let updated: MachineModelDoc | null;
  try {
    updated = await collections
      .machineModels(db)
      .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  } catch (error) {
    throw duplicateKeyToApiError(error, 'Another machine model already uses that name.');
  }

  if (!updated) throw ApiError.notFound('Machine model not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.machineModelUpdated,
    actor: { id: actor.id, username: actor.username, role: actor.role },
    entityType: 'machine_model',
    entityId: id,
    requestId: requestId ?? null,
    changes: audit.buildChanges(
      'machine_model',
      existing as unknown as Record<string, unknown>,
      set,
    ),
  });

  return toView(updated);
}

/**
 * Soft-delete a model.
 *
 * REFUSED when live machines or manuals still reference it. Cascading would
 * silently orphan a machine's entire history; the 409 names the dependents so
 * the operator can decide what to do. Phase 0 machine_models rule 2.
 */
export async function remove(
  db: Db,
  id: ObjectId,
  actor: { id: ObjectId; username: string; role: string },
  reason: string | undefined,
  requestId?: string,
): Promise<void> {
  const existing = await collections.machineModels(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Machine model not found.');

  const [machineCount, manualCount] = await Promise.all([
    collections.machines(db).countDocuments(liveFilter({ machine_model_id: id })),
    collections.manuals(db).countDocuments(liveFilter({ machine_model_id: id })),
  ]);

  if (machineCount > 0 || manualCount > 0) {
    throw new ApiError(
      'CONFLICT',
      'This machine model is still in use and cannot be deleted.',
      {
        details: [
          ...(machineCount > 0
            ? [{ field: 'machines', issue: `${machineCount} machine(s) reference this model.` }]
            : []),
          ...(manualCount > 0
            ? [{ field: 'manuals', issue: `${manualCount} manual(s) reference this model.` }]
            : []),
        ],
      },
    );
  }

  await collections
    .machineModels(db)
    .updateOne({ _id: id }, { $set: deletionStamps(actor.id, reason) });

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.machineModelDeleted,
    actor: { id: actor.id, username: actor.username, role: actor.role },
    entityType: 'machine_model',
    entityId: id,
    severity: 'notice',
    reason: reason ?? null,
    requestId: requestId ?? null,
  });
}

/** Resolve a model that must exist and be live. Used by machines/manuals. */
export async function requireLiveModel(db: Db, id: ObjectId): Promise<MachineModelDoc> {
  const doc = await collections.machineModels(db).findOne(liveFilter({ _id: id }));
  if (!doc) {
    throw ApiError.validation('The referenced machine model does not exist.', [
      { field: 'machineModelId', issue: 'No live machine model has this id.' },
    ]);
  }
  return doc;
}

export { CI_COLLATION };
