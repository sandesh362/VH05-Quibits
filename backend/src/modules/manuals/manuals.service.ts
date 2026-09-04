/**
 * Manuals - METADATA ONLY in Phase 2.
 *
 * Read this before extending the module: there is no file upload, no PDF
 * parsing, no OCR, no chunking, and no embedding here. A manual record
 * describes a document that exists somewhere; turning it into searchable
 * content is Phase 3's job.
 *
 * The consequence, enforced below: `processing_status` is owned by the
 * pipeline. This module writes it exactly once, as `queued`, at creation. Any
 * attempt to set it through the API is rejected - a manual marked `ready`
 * without a pipeline run would claim searchable content that does not exist,
 * which is precisely the kind of fake completeness this project forbids.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { DocumentType, ManualScope, ProcessingStatus } from '@itp/shared';
import { collections, SCHEMA_VERSION, type ManualDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
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
import { requireLiveMachine } from '../machines/machines.service.js';

export const SORTABLE = ['created_at', 'updated_at', 'title', 'processing_status'] as const;

type Actor = { id: ObjectId; username: string; role: string };

export interface ManualView {
  id: string;
  title: string;
  scope: ManualScope;
  machineModelId: string | null;
  machineId: string | null;
  documentType: DocumentType;
  documentVersion: string | null;
  isCurrentVersion: boolean;
  language: string;
  originalFilename: string;
  fileSizeBytes: number;
  sha256: string;
  mimeType: string;
  pageCount: number | null;
  processingStatus: ProcessingStatus;
  indexedChunkCount: number;
  indexedAt: string | null;
  /** Derived, never stored: a manual is only searchable once Phase 3 ran. */
  isSearchable: boolean;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Note what is NOT in the view: `storage_path`. Returning a server filesystem
 * path leaks deployment layout and invites path-traversal probing.
 */
export function toView(doc: ManualDoc): ManualView {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    scope: doc.scope,
    machineModelId: doc.machine_model_id ? doc.machine_model_id.toHexString() : null,
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    documentType: doc.document_type,
    documentVersion: doc.document_version ?? null,
    isCurrentVersion: doc.is_current_version,
    language: doc.language,
    originalFilename: doc.original_filename,
    fileSizeBytes: doc.file_size_bytes,
    sha256: doc.sha256,
    mimeType: doc.mime_type,
    pageCount: doc.page_count ?? null,
    processingStatus: doc.processing_status,
    indexedChunkCount: doc.indexed_chunk_count ?? 0,
    indexedAt: doc.indexed_at ? doc.indexed_at.toISOString() : null,
    isSearchable:
      !doc.is_deleted && doc.processing_status === 'ready' && (doc.indexed_chunk_count ?? 0) > 0,
    uploadedBy: doc.uploaded_by.toHexString(),
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateInput {
  title: string;
  scope: ManualScope;
  machineModelId?: string;
  machineId?: string;
  documentType: DocumentType;
  documentVersion?: string;
  language?: string;
  originalFilename: string;
  fileSizeBytes: number;
  sha256: string;
  mimeType: string;
  pageCount?: number;
  supersedesManualId?: string;
}

export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<ManualView> {
  // Scope is an exclusive choice: a manual is either model-wide or specific to
  // one machine. Both, or neither, makes retrieval scoping ambiguous later.
  let machineModelId: ObjectId | null = null;
  let machineId: ObjectId | null = null;

  if (input.scope === 'model') {
    if (!input.machineModelId || input.machineId) {
      throw ApiError.validation('A model-scoped manual requires machineModelId and no machineId.', [
        { field: 'machineModelId', issue: 'Required when scope is "model".' },
      ]);
    }
    machineModelId = (await requireLiveModel(db, toObjectId(input.machineModelId)))._id;
  } else {
    if (!input.machineId || input.machineModelId) {
      throw ApiError.validation('A machine-scoped manual requires machineId and no machineModelId.', [
        { field: 'machineId', issue: 'Required when scope is "machine".' },
      ]);
    }
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    machineId = machine._id;
    // Kept so model-scoped retrieval can still reach machine-scoped manuals.
    machineModelId = machine.machine_model_id;
  }

  let supersedes: ObjectId | null = null;
  if (input.supersedesManualId) {
    const previous = await collections
      .manuals(db)
      .findOne(liveFilter({ _id: toObjectId(input.supersedesManualId) }));
    if (!previous) {
      throw ApiError.validation('The superseded manual does not exist.', [
        { field: 'supersedesManualId', issue: 'No live manual has this id.' },
      ]);
    }
    supersedes = previous._id;
  }

  const now = new Date();
  const doc: Omit<ManualDoc, '_id'> = {
    title: input.title,
    scope: input.scope,
    machine_model_id: machineModelId,
    machine_id: machineId,
    document_type: input.documentType,
    document_version: input.documentVersion ?? null,
    supersedes_manual_id: supersedes,
    is_current_version: true,
    language: input.language ?? 'en',
    original_filename: input.originalFilename,
    /**
     * Server-generated and never derived from the client filename, which is
     * the classic path-traversal vector. Phase 3 owns the actual bytes; this
     * is the slot they will occupy.
     */
    storage_path: `manuals/${now.getUTCFullYear()}/${input.sha256}.pdf`,
    file_size_bytes: input.fileSizeBytes,
    sha256: input.sha256,
    mime_type: input.mimeType,
    page_count: input.pageCount ?? null,
    // ALWAYS queued. Phase 3 moves it forward; nothing here does.
    processing_status: 'queued',
    indexed_chunk_count: 0,
    indexed_at: null,
    uploaded_by: actor.id,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<ManualDoc, '_id'>;

  let created: ManualDoc;
  try {
    const result = await collections.manuals(db).insertOne(doc as ManualDoc);
    created = { ...(doc as ManualDoc), _id: result.insertedId };
  } catch (error) {
    throw duplicateKeyToApiError(
      error,
      'A manual with this checksum already exists for this machine model.',
    );
  }

  // Supersession is explicit, so the old version stops being "current".
  if (supersedes) {
    await collections
      .manuals(db)
      .updateOne({ _id: supersedes }, { $set: { is_current_version: false, updated_at: now } });
  }

  if (machineModelId) {
    await collections
      .machineModels(db)
      .updateOne({ _id: machineModelId }, { $inc: { manual_count: 1 } });
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualCreated,
    actor,
    entityType: 'manual',
    entityId: created._id,
    requestId: requestId ?? null,
    metadata: { title: created.title, scope: created.scope },
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  scope?: ManualScope;
  machineModelId?: string;
  machineId?: string;
  documentType?: DocumentType;
  processingStatus?: ProcessingStatus;
  language?: string;
  isCurrentVersion?: boolean;
  search?: string;
}

export async function list(db: Db, query: ListQuery) {
  const filter: Filter<ManualDoc> = {};

  if (query.scope) filter.scope = query.scope;
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.machineId) filter.machine_id = toObjectId(query.machineId);
  if (query.documentType) filter.document_type = query.documentType;
  if (query.processingStatus) filter.processing_status = query.processingStatus;
  if (query.language) filter.language = query.language;
  if (query.isCurrentVersion !== undefined) filter.is_current_version = query.isCurrentVersion;
  if (query.search) filter.title = containsMatcher(query.search);

  const result = await paginate(collections.manuals(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function getById(db: Db, id: ObjectId): Promise<ManualView> {
  const doc = await collections.manuals(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Manual not found.');
  return toView(doc);
}

/** Editable metadata only. Checksum, size, filename and status are not here. */
export interface UpdateInput {
  title?: string;
  documentType?: DocumentType;
  documentVersion?: string;
  language?: string;
  isCurrentVersion?: boolean;
  pageCount?: number;
}

export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  requestId?: string,
): Promise<ManualView> {
  const existing = await collections.manuals(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Manual not found.');

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  if (input.title !== undefined) set.title = input.title;
  if (input.documentType !== undefined) set.document_type = input.documentType;
  if (input.documentVersion !== undefined) set.document_version = input.documentVersion;
  if (input.language !== undefined) set.language = input.language;
  if (input.isCurrentVersion !== undefined) set.is_current_version = input.isCurrentVersion;
  if (input.pageCount !== undefined) set.page_count = input.pageCount;

  const updated = await collections
    .manuals(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Manual not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualUpdated,
    actor,
    entityType: 'manual',
    entityId: id,
    requestId: requestId ?? null,
    changes: audit.buildChanges('manual', existing as unknown as Record<string, unknown>, set),
  });

  return toView(updated);
}

export async function remove(
  db: Db,
  id: ObjectId,
  actor: Actor,
  reason: string | undefined,
  requestId?: string,
): Promise<void> {
  const existing = await collections.manuals(db).findOne(liveFilter({ _id: id }));
  if (!existing) throw ApiError.notFound('Manual not found.');

  await collections.manuals(db).updateOne({ _id: id }, { $set: deletionStamps(actor.id, reason) });

  if (existing.machine_model_id) {
    await collections
      .machineModels(db)
      .updateOne({ _id: existing.machine_model_id }, { $inc: { manual_count: -1 } });
  }

  /**
   * Phase 3+ will also need to remove this manual's vectors from Qdrant.
   * There are no vectors in Phase 2, so there is nothing to clean up - the
   * reconciliation hook belongs with the code that creates them, not here.
   */
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualDeleted,
    actor,
    entityType: 'manual',
    entityId: id,
    severity: 'notice',
    reason: reason ?? null,
    requestId: requestId ?? null,
  });
}
