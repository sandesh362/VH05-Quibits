/**
 * Manual processing job read/query service.
 *
 * Jobs are created and mutated by manual-processing.service. This module is the
 * read side: listing with filters, single-job detail, and the API view mapper.
 */

import type { Db, Filter, ObjectId } from 'mongodb';
import { collections, type ManualProcessingJobDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { paginate } from '../../common/repository.js';
import { buildSort, toObjectId, type PaginationInput } from '../../common/validation.js';

export const JOB_SORTABLE = ['created_at', 'updated_at', 'started_at', 'completed_at'] as const;

/** Convert a stage record to its API view (dates to ISO). */
function toStageView(stage: Record<string, unknown>) {
  const date = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    name: stage.name,
    status: stage.status,
    startedAt: date(stage.started_at ?? null),
    endedAt: date(stage.ended_at ?? null),
    progress: stage.progress ?? null,
    warnings: stage.warnings ?? [],
  };
}

/** Convert a job document to the API view (dates to ISO, ids to hex). */
export function toJobView(job: ManualProcessingJobDoc & Record<string, unknown>) {
  return {
    id: job._id.toHexString(),
    manualId: job.manual_id.toHexString(),
    jobType: job.job_type,
    status: job.status,
    currentStage: job.current_stage ?? null,
    stages: (job.stages ?? []).map((s) => toStageView(s as unknown as Record<string, unknown>)),
    progressPercent: job.progress_percent ?? 0,
    attempt: job.attempt ?? 1,
    errorCode: job.error_code ?? null,
    errorMessage: job.error_message ?? null,
    triggeredBy: job.triggered_by ? job.triggered_by.toHexString() : null,
    machineModelId: job.machine_model_id ? job.machine_model_id.toHexString() : null,
    totalPages: job.total_pages ?? null,
    processedPages: job.processed_pages ?? 0,
    totalChunks: job.total_chunks ?? null,
    processedChunks: job.processed_chunks ?? 0,
    extractionMethod: job.extraction_method ?? null,
    ocrUsed: job.ocr_used ?? false,
    embeddingModel: job.embedding_model ?? null,
    embeddingDimension: job.embedding_dimension ?? null,
    retryCount: job.retry_count ?? 0,
    startedAt: job.started_at ? job.started_at.toISOString() : null,
    completedAt: job.completed_at ? job.completed_at.toISOString() : null,
    failedAt: job.failed_at ? job.failed_at.toISOString() : null,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
  };
}

export interface ListJobsQuery extends PaginationInput {
  sortBy?: string;
  manualId?: string;
  machineModelId?: string;
  status?: string;
  jobType?: string;
}

export async function listJobs(db: Db, query: ListJobsQuery) {
  const filter: Filter<ManualProcessingJobDoc> = {};
  if (query.manualId) filter.manual_id = toObjectId(query.manualId);
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.status) filter.status = query.status as ManualProcessingJobDoc['status'];
  if (query.jobType) filter.job_type = query.jobType as ManualProcessingJobDoc['job_type'];

  const result = await paginate(collections.manualProcessingJobs(db), filter, {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, JOB_SORTABLE, 'created_at'),
  });

  return {
    items: result.items.map((doc) => toJobView(doc as ManualProcessingJobDoc & Record<string, unknown>)),
    pagination: result.pagination,
  };
}

export async function getJobById(db: Db, jobId: ObjectId) {
  const job = await collections.manualProcessingJobs(db).findOne({ _id: jobId });
  if (!job) throw ApiError.notFound('Processing job not found.');
  return toJobView(job as ManualProcessingJobDoc & Record<string, unknown>);
}
