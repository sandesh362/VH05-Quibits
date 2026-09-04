/**
 * Manual processing orchestration (Express side).
 *
 * Express owns the job lifecycle record and the terminal status transition.
 * It does NOT do any PDF parsing / OCR / embedding (that is FastAPI). This
 * module:
 *   - creates and tracks `manual_processing_jobs`
 *   - calls the FastAPI pipeline (via the RAG client)
 *   - persists resulting pages and chunks into MongoDB (the source of truth)
 *   - advances the manual's `processing_status`
 *   - records audit events and structured diagnostics
 *
 * The heavy work runs in a bounded in-process worker (see manual-processing-queue),
 * so the upload request returns before extraction/OCR finish.
 *
 * Progress reporting is delegated to FastAPI: while the pipeline runs it writes
 * stage/progress updates to `manual_processing_jobs` (the architecture's single
 * permitted FastAPI->Mongo write). Express only performs the TERMINAL
 * transition to `completed`/`failed` once the pipeline returns.
 */

import type { Db, ObjectId } from 'mongodb';
import { collections, type ManualChunkDoc, type ManualPageDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { getLogger } from '../../core/logger.js';
import { getConfig } from '../../config/env.js';
import { isDuplicateKeyError, liveFilter } from '../../common/repository.js';
import * as audit from '../audit/audit.service.js';
import type { JobType } from '@itp/shared';
import { processManual, type RagProcessResult } from './rag-client.service.js';
import { enqueue } from './manual-processing-queue.js';

export type Actor = { id: ObjectId; username: string; role: string };

/** Pipeline stages reported through the job so the UI can show progress. */
export const PROCESSING_STAGES = [
  'validation',
  'file_storage',
  'pdf_extraction',
  'ocr',
  'text_cleaning',
  'chunking',
  'embedding',
  'qdrant_indexing',
  'mongodb_persistence',
  'cleanup',
] as const;

/**
 * Create a processing job for a manual, returning the new job id.
 * The unique partial index on {manual_id} where status in (queued,running)
 * guarantees only one live job per manual, which is the duplicate-job protectant.
 */
export async function createProcessingJob(
  db: Db,
  manualId: ObjectId,
  jobType: JobType,
  actor: Actor | null,
): Promise<ObjectId> {
  const now = new Date();
  const doc = {
    manual_id: manualId,
    job_type: jobType,
    status: 'queued',
    current_stage: 'validation',
    stages: PROCESSING_STAGES.map((name) => ({
      name,
      status: 'pending',
      started_at: null,
      ended_at: null,
      progress: null,
      warnings: [],
    })),
    progress_percent: 0,
    attempt: 1,
    triggered_by: actor?.id ?? null,
    retry_count: 0,
    processed_pages: 0,
    processed_chunks: 0,
    extraction_method: null,
    ocr_used: null,
    embedding_model: null,
    embedding_dimension: null,
    created_by: actor?.id ?? null,
    created_at: now,
    updated_at: now,
    schema_version: 1,
  };

  try {
    const result = await collections.manualProcessingJobs(db).insertOne(doc as never);
    return result.insertedId;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError('CONFLICT', 'A processing job is already active for this manual.', {
        details: [{ field: 'manualId', issue: 'This manual already has a queued or running job.' }],
      });
    }
    throw error;
  }
}

function enqueueManualPipeline(
  db: Db,
  jobId: ObjectId,
  manualId: ObjectId,
  storagePath: string,
  machineModelId: ObjectId | null,
  machineId: ObjectId | null,
  actor: Actor | null,
): void {
  enqueue(`manual:${manualId.toHexString()}`, () =>
    runManualPipeline(db, {
      jobId,
      manualId,
      storagePath,
      machineModelId,
      machineId,
      actor,
    }),
  );
}

/** Persist the pages and chunks returned by FastAPI into MongoDB. */
export async function persistPagesAndChunks(
  db: Db,
  manualId: ObjectId,
  result: RagProcessResult,
  scope?: { machineModelId?: ObjectId | null; machineId?: ObjectId | null },
): Promise<number> {
  const now = new Date();
  const pages: Omit<ManualPageDoc, '_id'>[] = result.pages.map((p) => ({
    manual_id: manualId,
    page_number: p.page_number,
    raw_text: p.raw_text,
    cleaned_text: p.cleaned_text,
    character_count: p.character_count,
    word_count: p.word_count,
    has_text: p.has_text,
    extraction_method: p.extraction_method,
    ocr_used: p.ocr_used,
    ocr_confidence: p.ocr_confidence ?? null,
    created_at: now,
    updated_at: now,
    schema_version: 1,
  }));

  const chunks: Omit<ManualChunkDoc, '_id'>[] = result.chunks.map((c) => ({
    manual_id: manualId,
    machine_model_id: scope?.machineModelId ?? null,
    machine_id: scope?.machineId ?? null,
    chunk_index: c.chunk_index,
    page_start: c.page_start,
    page_end: c.page_end,
    section_title: c.section_title,
    section_path: c.section_path,
    text: c.text,
    normalized_text: c.normalized_text,
    character_count: c.character_count,
    word_count: c.word_count,
    content_hash: c.content_hash,
    embedding_model: c.embedding_model,
    embedding_dimension: c.embedding_dimension,
    qdrant_point_id: c.qdrant_point_id,
    indexing_status: 'indexed',
    created_at: now,
    updated_at: now,
    schema_version: 1,
  }));

  // Idempotent write: delete any previous pages/chunks for this manual, then
  // insert the fresh set. On retry this is what prevents duplicate rows.
  if (pages.length > 0) {
    await collections.manualPages(db).deleteMany({ manual_id: manualId });
    await collections.manualPages(db).insertMany(pages as never[]);
  }
  if (chunks.length > 0) {
    await collections.manualChunks(db).deleteMany({ manual_id: manualId });
    await collections.manualChunks(db).insertMany(chunks as never[]);
  }
  return chunks.length;
}

/**
 * Run the full pipeline for one job: call FastAPI, persist results, and advance
 * the manual. On failure the manual and job are marked `failed` (never
 * `completed`), so a broken index can never look healthy.
 */
export async function runManualPipeline(
  db: Db,
  options: {
    jobId: ObjectId;
    manualId: ObjectId;
    storagePath: string;
    machineModelId: ObjectId | null;
    machineId: ObjectId | null;
    actor: Actor | null;
  },
): Promise<void> {
  const log = getLogger();
  const config = getConfig();
  const { jobId, manualId } = options;
  const start = Date.now();

  // Move the job out of `queued` into `running` so clients see it is live.
  await collections
    .manualProcessingJobs(db)
    .updateOne({ _id: jobId }, { $set: { status: 'running', current_stage: 'processing', progress_percent: 1, updated_at: new Date() } });
  await collections
    .manuals(db)
    .updateOne({ _id: manualId }, { $set: { processing_status: 'processing', updated_at: new Date() } });

  try {
    const manual = await collections.manuals(db).findOne({ _id: manualId });
    if (!manual) throw new Error(`Manual ${manualId.toHexString()} not found during processing.`);

    const result = await processManual({
      job_id: jobId.toHexString(),
      manual_id: manualId.toHexString(),
      storage_path: options.storagePath,
      machine_model_id: options.machineModelId?.toHexString() ?? '',
      machine_id: options.machineId?.toHexString() ?? null,
      manual: {
        title: manual.title,
        document_version: manual.document_version ?? null,
        document_type: manual.document_type,
        manufacturer: manual.manufacturer ?? null,
        language: manual.language,
      },
      force_ocr: false,
      ocr_enabled: config.ocr.enabled,
      ocr_language: config.ocr.language,
      ocr_min_text_characters_per_page: config.ocr.minTextCharactersPerPage,
      chunk_size: config.chunking.chunkSize,
      chunk_overlap: config.chunking.chunkOverlap,
      min_chunk_size: config.chunking.minChunkSize,
      max_chunk_size: config.chunking.maxChunkSize,
      chunking_version: 'cv1',
      embedding_model: config.ollama.embeddingModel,
      collection_name: config.qdrantManualCollection,
      delete_existing: true,
    });

    // Persist pages + chunks (the source of truth). machine_model_id on each
    // chunk is required for Phase 4 isolation — Phase 3 left it null.
    const chunkCount = await persistPagesAndChunks(db, manualId, result, {
      machineModelId: options.machineModelId ?? manual.machine_model_id ?? null,
      machineId: options.machineId ?? manual.machine_id ?? null,
    });

    const now = new Date();
    await collections.manualProcessingJobs(db).updateOne(
      { _id: jobId },
      {
        $set: {
          current_stage: 'cleanup',
          progress_percent: 100,
          total_pages: result.page_count,
          processed_pages: result.page_count,
          total_chunks: result.chunk_count,
          processed_chunks: chunkCount,
          extraction_method: result.extraction_method,
          ocr_used: result.ocr_used,
          embedding_model: result.embedding_model,
          embedding_dimension: result.embedding_dimension,
          updated_at: now,
        },
      },
    );

    // Terminal success transition. Only after EVERY stage succeeded.
    await collections.manuals(db).updateOne(
      { _id: manualId },
      {
        $set: {
          processing_status: 'completed',
          processing_version: result.processing_version,
          extraction_method: result.extraction_method,
          ocr_used: result.ocr_used,
          page_count: result.page_count,
          indexed_chunk_count: result.chunk_count,
          indexed_at: now,
          processed_at: now,
          failed_at: null,
          failure_reason: null,
          is_active: true,
          updated_at: now,
        },
      },
    );

    await collections.manualProcessingJobs(db).updateOne(
      { _id: jobId },
      { $set: { status: 'completed', completed_at: now, updated_at: now } },
    );

    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.manualProcessingCompleted,
      actor: options.actor,
      entityType: 'manual',
      entityId: manualId,
      metadata: { chunkCount: result.chunk_count, pageCount: result.page_count, ocrUsed: result.ocr_used },
    });

    log.info(
      {
        jobId: jobId.toHexString(),
        manualId: manualId.toHexString(),
        pageCount: result.page_count,
        chunkCount: result.chunk_count,
        extractionMethod: result.extraction_method,
        ocrUsed: result.ocr_used,
        durationMs: Date.now() - start,
      },
      'manual_processing_completed',
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const safeMessage = err.message.slice(0, 500);
    const now = new Date();

    await collections.manuals(db).updateOne(
      { _id: manualId },
      { $set: { processing_status: 'failed', failed_at: now, failure_reason: safeMessage, updated_at: now } },
    );
    await collections.manualProcessingJobs(db).updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'failed',
          failed_at: now,
          current_stage: 'processing',
          error_code: errorCodeFor(err),
          error_message: safeMessage,
          error_details: safeMessage,
          updated_at: now,
        },
      },
    );

    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.manualProcessingFailed,
      actor: options.actor,
      entityType: 'manual',
      entityId: manualId,
      outcome: 'failure',
      severity: 'warning',
      metadata: { jobId: jobId.toHexString(), errorCode: errorCodeFor(err) },
    });

    log.error(
      { jobId: jobId.toHexString(), manualId: manualId.toHexString(), err: err.message, code: errorCodeFor(err) },
      'manual_processing_failed',
    );
  }
}

function errorCodeFor(err: Error): string {
  if (err instanceof ApiError && err.code) return err.code;
  return 'MANUAL_PROCESSING_FAILED';
}

/**
 * Verify state and start a reprocess. Reprocessing is a new job; it never
 * mutates the old job history. The original file is preserved.
 */
export async function reprocessManual(
  db: Db,
  manualId: ObjectId,
  actor: Actor,
  reason: string | undefined,
  requestId: string | undefined,
): Promise<{ jobId: ObjectId }> {
  const manual = await collections.manuals(db).findOne(liveFilter({ _id: manualId }));
  if (!manual) throw ApiError.notFound('Manual not found.');

  if (!manual.storage_path) {
    throw ApiError.internal('The manual has no stored file; it cannot be reprocessed.');
  }

  const jobId = await createProcessingJob(db, manualId, 'reindex_full', actor);

  // Reset the manual to a non-searchable state until the re-run succeeds.
  await collections.manuals(db).updateOne(
    { _id: manualId },
    { $set: { processing_status: 'queued', indexed_chunk_count: 0, indexed_at: null, updated_at: new Date() } },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualReprocessingRequested,
    actor,
    entityType: 'manual',
    entityId: manualId,
    reason: reason ?? null,
    requestId: requestId ?? null,
    metadata: { jobId: jobId.toHexString() },
  });

  enqueueManualPipeline(
    db,
    jobId,
    manualId,
    manual.storage_path,
    manual.machine_model_id ?? null,
    manual.machine_id ?? null,
    actor,
  );

  return { jobId };
}

/**
 * Retry a FAILED job by creating a fresh job of the same type for the manual.
 * Deterministic failures that will never succeed (e.g. PDF corrupt) are not
 * auto-retried, but an explicit human retry is always allowed.
 */
export async function retryJob(
  db: Db,
  jobId: ObjectId,
  actor: Actor,
  requestId: string | undefined,
): Promise<{ jobId: ObjectId }> {
  const job = await collections.manualProcessingJobs(db).findOne({ _id: jobId });
  if (!job) throw ApiError.notFound('Processing job not found.');
  if (job.status !== 'failed') {
    throw ApiError.validation('Only a failed processing job can be retried.', [
      { field: 'jobId', issue: `Current job status is "${job.status}".` },
    ]);
  }

  const manual = await collections.manuals(db).findOne(liveFilter({ _id: job.manual_id }));
  if (!manual) throw ApiError.notFound('Manual not found.');

  const newJobId = await createProcessingJob(db, job.manual_id, job.job_type, actor);

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.manualProcessingRetried,
    actor,
    entityType: 'manual',
    entityId: job.manual_id,
    requestId: requestId ?? null,
    metadata: { previousJobId: job._id.toHexString(), newJobId: newJobId.toHexString() },
  });

  await collections.manuals(db).updateOne(
    { _id: job.manual_id },
    { $set: { processing_status: 'queued', indexed_chunk_count: 0, indexed_at: null, updated_at: new Date() } },
  );
  enqueueManualPipeline(
    db,
    newJobId,
    job.manual_id,
    manual.storage_path,
    manual.machine_model_id ?? null,
    manual.machine_id ?? null,
    actor,
  );

  return { jobId: newJobId };
}

/** Get a live job by id or throw 404. */
export async function getJob(db: Db, jobId: ObjectId) {
  const job = await collections.manualProcessingJobs(db).findOne({ _id: jobId });
  if (!job) throw ApiError.notFound('Processing job not found.');
  return job;
}

/** Assert a manual exists and is live; otherwise throw 404. */
export async function requireLiveManual(db: Db, manualId: ObjectId) {
  const manual = await collections.manuals(db).findOne(liveFilter({ _id: manualId }));
  if (!manual) throw ApiError.notFound('Manual not found.');
  return manual;
}
