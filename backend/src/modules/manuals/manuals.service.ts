/**
 * Manuals - metadata + file upload + processing orchestration (Phase 3).
 *
 * Express owns the manual record, the file bytes on disk, the job lifecycle,
 * and Mongo as the source of truth. It delegates PDF parsing / OCR / chunking /
 * embedding / Qdrant indexing to FastAPI and persists the returned pages and
 * chunks here.
 *
 * A manual is NEVER manually marked `completed`; the pipeline does that after
 * every stage succeeds. The API keeps rejecting pipeline-owned fields.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import { ObjectId as BsonObjectId } from 'mongodb';
import type { DocumentType, ManualScope, ProcessingStatus } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type ManualChunkDoc,
  type ManualDoc,
  type ManualPageDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { getConfig } from '../../config/env.js';
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
import {
  manualStoragePath,
  removeManualStorageDir,
  storeManualPdf,
  validatePdfUpload,
  type UploadedFileInfo,
} from './manual-files.service.js';
import { deleteManualVectors } from './rag-client.service.js';
import {
  createProcessingJob,
  requireLiveManual,
  runManualPipeline,
} from './manual-processing.service.js';
import { enqueue } from './manual-processing-queue.js';

export const SORTABLE = ['created_at', 'updated_at', 'title', 'processing_status'] as const;

type Actor = { id: ObjectId; username: string; role: string };

export interface ManualView {
  id: string;
  title: string;
  description: string | null;
  manufacturer: string | null;
  scope: ManualScope;
  machineModelId: string | null;
  machineId: string | null;
  documentType: DocumentType;
  documentNumber: string | null;
  documentVersion: string | null;
  revision: string | null;
  isCurrentVersion: boolean;
  isActive: boolean;
  language: string;
  originalFilename: string;
  fileSizeBytes: number;
  sha256: string;
  mimeType: string;
  pageCount: number | null;
  processingStatus: ProcessingStatus;
  processingVersion: string | null;
  extractionMethod: string | null;
  ocrUsed: boolean;
  indexedChunkCount: number;
  indexedAt: string | null;
  processedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  /** Derived, never stored: a manual is only searchable once indexing succeeded. */
  isSearchable: boolean;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * NOTE what is NOT in the view: `storage_path`. Returning a server filesystem
 * path leaks deployment layout and invites path-traversal probing.
 */
export function toView(doc: ManualDoc): ManualView {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    description: doc.description ?? null,
    manufacturer: doc.manufacturer ?? null,
    scope: doc.scope,
    machineModelId: doc.machine_model_id ? doc.machine_model_id.toHexString() : null,
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    documentType: doc.document_type,
    documentNumber: doc.document_number ?? null,
    documentVersion: doc.document_version ?? null,
    revision: doc.revision ?? null,
    isCurrentVersion: doc.is_current_version,
    isActive: doc.is_active,
    language: doc.language,
    originalFilename: doc.original_filename,
    fileSizeBytes: doc.file_size_bytes,
    sha256: doc.sha256,
    mimeType: doc.mime_type,
    pageCount: doc.page_count ?? null,
    processingStatus: doc.processing_status,
    processingVersion: doc.processing_version ?? null,
    extractionMethod: doc.extraction_method ?? null,
    ocrUsed: doc.ocr_used ?? false,
    indexedChunkCount: doc.indexed_chunk_count ?? 0,
    indexedAt: doc.indexed_at ? doc.indexed_at.toISOString() : null,
    processedAt: doc.processed_at ? doc.processed_at.toISOString() : null,
    failedAt: doc.failed_at ? doc.failed_at.toISOString() : null,
    failureReason: doc.failure_reason ?? null,
    isSearchable:
      !doc.is_deleted && doc.processing_status === 'completed' && (doc.indexed_chunk_count ?? 0) > 0,
    uploadedBy: doc.uploaded_by.toHexString(),
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateUploadInput {
  title: string;
  description?: string;
  manufacturer?: string;
  scope: ManualScope;
  machineModelId?: string;
  machineId?: string;
  documentType: DocumentType;
  documentNumber?: string;
  documentVersion?: string;
  revision?: string;
  language?: string;
  supersedesManualId?: string;
  /** Raw upload; validation and sha256 are computed server-side. */
  file: UploadedFileInfo;
}

/**
 * Upload a manual PDF: validate, store, create the record + a processing job,
 * and enqueue the background pipeline. Returns the manual and the job.
 */
export async function createUpload(
  db: Db,
  input: CreateUploadInput,
  actor: Actor,
  requestId?: string,
): Promise<{ manual: ManualView; processingJob: Record<string, unknown> }> {
  const config = getConfig();
  const file = validatePdfUpload(
    {
      buffer: input.file.buffer,
      originalFilename: input.file.originalFilename,
      mimeType: input.file.mimeType,
      size: input.file.size,
    },
    config.manualMaxFileSizeMb * 1024 * 1024,
  );

  // Scope is an exclusive choice: model-wide or machine-specific.
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
    machineModelId = machine.machine_model_id;
  }

  // Duplicate detection: same file + same model must not create duplicate
  // indexing. A new revision (different file) is allowed even with a similar title.
  if (machineModelId) {
    const existing = await collections.manuals(
      db,
    ).findOne(liveFilter({ sha256: file.sha256, machine_model_id: machineModelId }));
    if (existing) {
      throw new ApiError('CONFLICT', 'This file has already been uploaded for this machine model.', {
        details: [
          { field: 'file', issue: 'A manual with this checksum already exists for this model.' },
        ],
        internalContext: { existingManualId: existing._id.toHexString() },
      });
    }
  }

  // Generate the id first so the storage path is fixed and unique.
  const manualId = new BsonObjectId();
  const storage = manualStoragePath(config.manualStoragePath, manualId.toHexString());

  // Store the file (server-generated path; `wx` refuses to overwrite).
  await storeManualPdf(config.storageRoot, config.manualStoragePath, manualId.toHexString(), file.buffer);

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
    _id: manualId,
    title: input.title,
    description: input.description ?? null,
    manufacturer: input.manufacturer ?? null,
    scope: input.scope,
    machine_model_id: machineModelId,
    machine_id: machineId,
    document_type: input.documentType,
    document_number: input.documentNumber ?? null,
    document_version: input.documentVersion ?? null,
    revision: input.revision ?? null,
    supersedes_manual_id: supersedes,
    is_current_version: true,
    language: input.language ?? 'en',
    original_filename: file.originalFilename,
    storage_path: storage,
    file_size_bytes: file.size,
    sha256: file.sha256,
    mime_type: 'application/pdf',
    page_count: null,
    processing_status: 'queued',
    processing_version: null,
    extraction_method: null,
    ocr_used: null,
    indexed_chunk_count: 0,
    indexed_at: null,
    processed_at: null,
    failed_at: null,
    failure_reason: null,
    is_active: true,
    uploaded_by: actor.id,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<ManualDoc, '_id'> & { _id: ObjectId };

  try {
    await collections.manuals(db).insertOne(doc as ManualDoc);
  } catch (error) {
    // Clean up the file we just wrote so a DB failure leaves no orphan bytes.
    await removeManualStorageDir(config.storageRoot, manualId.toHexString()).catch(() => undefined);
    throw duplicateKeyToApiError(
      error,
      'A manual with this checksum already exists for this machine model.',
    );
  }

  if (supersedes) {
    await collections
      .manuals(db)
      .updateOne({ _id: supersedes }, { $set: { is_current_version: false, updated_at: now } });
  }

  if (machineModelId) {
    await collections.machineModels(db).updateOne({ _id: machineModelId }, { $inc: { manual_count: 1 } });
  }

  // Create the job and enqueue the background pipeline.
  const jobId = await createProcessingJob(db, manualId, 'full_process', actor);

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualUploaded,
    actor,
    entityType: 'manual',
    entityId: manualId,
    requestId: requestId ?? null,
    metadata: {
      title: doc.title,
      scope: doc.scope,
      fileSizeBytes: doc.file_size_bytes,
      sha256: doc.sha256,
      jobId: jobId.toHexString(),
    },
  });

  // Enqueue asynchronously; the upload request returns now.
  enqueue(`manual:${manualId.toHexString()}`, () =>
    runManualPipeline(db, {
      jobId,
      manualId,
      storagePath: storage,
      machineModelId,
      machineId,
      actor,
    }),
  );

  const manual = toView(doc as ManualDoc);
  return { manual, processingJob: { id: jobId.toHexString(), status: 'queued' } };
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  scope?: ManualScope;
  machineModelId?: string;
  machineId?: string;
  documentType?: DocumentType;
  processingStatus?: ProcessingStatus;
  manufacturer?: string;
  documentVersion?: string;
  uploadedBy?: string;
  createdFrom?: Date;
  createdTo?: Date;
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
  if (query.manufacturer) filter.manufacturer = containsMatcher(query.manufacturer);
  if (query.documentVersion) filter.document_version = query.documentVersion;
  if (query.uploadedBy) filter.uploaded_by = toObjectId(query.uploadedBy);
  if (query.language) filter.language = query.language;
  if (query.isCurrentVersion !== undefined) filter.is_current_version = query.isCurrentVersion;
  if (query.createdFrom || query.createdTo) {
    filter.created_at = {};
    if (query.createdFrom) filter.created_at.$gte = query.createdFrom;
    if (query.createdTo) filter.created_at.$lte = query.createdTo;
  }
  if (query.search) {
    filter.$or = [
      { title: containsMatcher(query.search) },
      { description: containsMatcher(query.search) },
    ];
  }

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

export interface UpdateInput {
  title?: string;
  description?: string;
  manufacturer?: string;
  documentType?: DocumentType;
  documentNumber?: string;
  documentVersion?: string;
  revision?: string;
  language?: string;
  isCurrentVersion?: boolean;
  isActive?: boolean;
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
  if (input.description !== undefined) set.description = input.description;
  if (input.manufacturer !== undefined) set.manufacturer = input.manufacturer;
  if (input.documentType !== undefined) set.document_type = input.documentType;
  if (input.documentNumber !== undefined) set.document_number = input.documentNumber;
  if (input.documentVersion !== undefined) set.document_version = input.documentVersion;
  if (input.revision !== undefined) set.revision = input.revision;
  if (input.language !== undefined) set.language = input.language;
  if (input.isCurrentVersion !== undefined) set.is_current_version = input.isCurrentVersion;
  if (input.isActive !== undefined) set.is_active = input.isActive;

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

/**
 * Soft-delete a manual and purge its derived index.
 *
 * Order matters (fail-safe): soft-delete FIRST so the manual is immediately
 * excluded from reads even if Qdrant is down. Then remove Mongo pages/chunks
 * and (best-effort) purge the Qdrant vectors. The original file on disk is
 * KEPT so an accidental delete is recoverable (see docs/PHASE_3_IMPLEMENTATION).
 */
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

  // Remove the derived index and structured content.
  await collections.manualPages(db).deleteMany({ manual_id: id });
  await collections.manualChunks(db).deleteMany({ manual_id: id });
  await deleteManualVectors(id.toHexString());

  if (existing.machine_model_id) {
    await collections.machineModels(db).updateOne(
      { _id: existing.machine_model_id },
      { $inc: { manual_count: -1 } },
    );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualDeleted,
    actor,
    entityType: 'manual',
    entityId: id,
    severity: 'notice',
    reason: reason ?? null,
    requestId: requestId ?? null,
    metadata: { indexCleared: true },
  });
}

export interface PagesQuery extends PaginationInput {
  sortBy?: string;
}

export async function listPages(db: Db, manualId: ObjectId, query: PagesQuery) {
  await requireLiveManual(db, manualId);

  const filter: Filter<ManualPageDoc> = { manual_id: manualId };
  const result = await paginate(collections.manualPages(db), filter, {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, ['page_number', 'created_at'], 'page_number'),
  });

  return {
    items: result.items.map((doc) => toPageView(doc)),
    pagination: result.pagination,
  };
}

export interface ChunksQuery extends PaginationInput {
  sortBy?: string;
  search?: string;
  pageStart?: number;
  pageEnd?: number;
}

export async function listChunks(db: Db, manualId: ObjectId, query: ChunksQuery) {
  await requireLiveManual(db, manualId);

  const filter: Filter<ManualChunkDoc> = { manual_id: manualId };
  if (query.pageStart !== undefined || query.pageEnd !== undefined) {
    filter.page_start = {};
    if (query.pageStart !== undefined) filter.page_start.$gte = query.pageStart;
    if (query.pageEnd !== undefined) filter.page_start.$lte = query.pageEnd;
  }

  const result = await paginate(collections.manualChunks(db), filter, {
    page: query.page,
    limit: query.limit,
    sort: buildSort(
      query.sortBy,
      query.sortOrder,
      ['chunk_index', 'page_start', 'created_at'],
      'chunk_index',
    ),
  });

  return {
    items: result.items.map((doc) => toChunkView(doc)),
    pagination: result.pagination,
  };
}

function toPageView(doc: ManualPageDoc) {
  return {
    id: doc._id.toHexString(),
    manualId: doc.manual_id.toHexString(),
    pageNumber: doc.page_number,
    rawText: doc.raw_text,
    cleanedText: doc.cleaned_text,
    characterCount: doc.character_count,
    wordCount: doc.word_count,
    hasText: doc.has_text,
    extractionMethod: doc.extraction_method,
    ocrUsed: doc.ocr_used,
    ocrConfidence: doc.ocr_confidence ?? null,
  };
}

export function toChunkView(doc: ManualChunkDoc) {
  return {
    id: doc._id.toHexString(),
    manualId: doc.manual_id.toHexString(),
    machineModelId: doc.machine_model_id ? doc.machine_model_id.toHexString() : null,
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    chunkIndex: doc.chunk_index,
    pageStart: doc.page_start,
    pageEnd: doc.page_end,
    sectionTitle: doc.section_title ?? null,
    sectionPath: doc.section_path ?? null,
    text: doc.text,
    normalizedText: doc.normalized_text,
    characterCount: doc.character_count,
    wordCount: doc.word_count,
    contentHash: doc.content_hash,
    embeddingModel: doc.embedding_model ?? null,
    embeddingDimension: doc.embedding_dimension ?? null,
    qdrantPointId: doc.qdrant_point_id ?? null,
    indexingStatus: doc.indexing_status,
  };
}

/** A single chunk by id, for citation previews (Phase 8). Scoped to the manual. */
export async function getChunkById(db: Db, manualId: ObjectId, chunkId: ObjectId) {
  await requireLiveManual(db, manualId);
  const doc = await collections.manualChunks(db).findOne({
    _id: chunkId,
    manual_id: manualId,
  });
  if (!doc) throw ApiError.notFound('Chunk not found in this manual.');
  return toChunkView(doc);
}

/** Get the latest processing job status for a manual. */
export async function getProcessingStatus(db: Db, manualId: ObjectId) {
  await requireLiveManual(db, manualId);
  const job = await collections.manualProcessingJobs(db).findOne(
    { manual_id: manualId },
    { sort: { created_at: -1 } },
  );
  return job ?? null;
}
