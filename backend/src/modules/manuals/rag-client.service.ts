/**
 * FastAPI (RAG service) internal client.
 *
 * Express is the ONLY process that talks to the AI service, over the internal
 * Docker network, authenticated with the shared `INTERNAL_SERVICE_TOKEN`.
 * This module is the single place where the FastAPI wire contract lives so a
 * schema change is a one-file edit and cannot drift.
 */

import { getConfig } from '../../config/env.js';
import { ApiError } from '../../core/api-error.js';
import { getLogger } from '../../core/logger.js';

export interface RagProcessPage {
  page_number: number;
  raw_text: string;
  cleaned_text: string;
  character_count: number;
  word_count: number;
  has_text: boolean;
  extraction_method: string;
  ocr_used: boolean;
  ocr_confidence: number | null;
}

export interface RagProcessChunk {
  chunk_index: number;
  page_start: number;
  page_end: number;
  section_title: string | null;
  section_path: string[] | null;
  text: string;
  normalized_text: string;
  character_count: number;
  word_count: number;
  content_hash: string;
  embedding_model: string;
  embedding_dimension: number;
  qdrant_point_id: string;
  indexing_status: 'indexed';
}

export interface RagProcessResult {
  job_id: string;
  manual_id: string;
  page_count: number;
  chunk_count: number;
  pages: RagProcessPage[];
  chunks: RagProcessChunk[];
  extraction_method: 'native' | 'ocr' | 'mixed';
  ocr_used: boolean;
  embedding_model: string;
  embedding_dimension: number;
  qdrant_collection: string;
  qdrant_indexed_points: number;
  processing_version: string;
}

export interface RagManualMeta {
  title: string;
  document_version: string | null;
  document_type: string;
  manufacturer: string | null;
  language: string;
}

export interface RagProcessOptions {
  job_id: string;
  manual_id: string;
  storage_path: string;
  machine_model_id: string;
  machine_id: string | null;
  manual: RagManualMeta;
  force_ocr: boolean;
  ocr_enabled: boolean;
  ocr_language: string;
  ocr_min_text_characters_per_page: number;
  chunk_size: number;
  chunk_overlap: number;
  min_chunk_size: number;
  max_chunk_size: number;
  chunking_version: string;
  embedding_model: string;
  collection_name: string;
  delete_existing: boolean;
}

interface RagErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/**
 * Delete every Qdrant point belonging to a manual. Best-effort and idempotent:
 * deleting an already-empty set is a no-op. The Express-side soft delete is
 * performed FIRST so the manual is unsearchable even if Qdrant is down.
 */
export async function deleteManualVectors(manualId: string): Promise<void> {
  const config = getConfig();
  const url = `${config.ragService.url}${config.ragService.apiPrefix}/indexing/manual-chunks/delete`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': config.ragService.internalToken,
    },
    body: JSON.stringify({ manual_id: manualId }),
  }).catch(() => null);

  if (!response || !response.ok) {
    // Deleting vectors is a best-effort cleanup; the manual is already
    // soft-deleted, so a failure here is surfaced via logs and the reconciler.
    getLogger().warn(
      { manualId, status: response?.status },
      'Failed to delete manual vectors (Qdrant may be unavailable)',
    );
  }
}

/** Resolve an error from a non-ok response into an ApiError for the caller. */
function errorFromResponse(body: unknown, fallback: string): ApiError {
  const err = (body as RagErrorBody)?.error;
  return new ApiError('SERVICE_UNAVAILABLE', err?.message ?? fallback, {
    details: Array.isArray(err?.details)
      ? (err.details as { field: string; issue: string }[])
      : undefined,
  });
}

/**
 * Call the FastAPI document-processing pipeline synchronously and return the
 * structured result. The pipeline itself is long-running (extraction + OCR +
 * embeddings); because it runs inside the Express background worker, the
 * upload request is never held open for it.
 */
export interface RagInternalQuery {
  query: string;
  machine_id?: string | null;
  machine_model_id?: string | null;
  manual_id?: string | null;
  manual_version?: string | null;
  manual_type?: string | null;
  manufacturer?: string | null;
  include_inactive?: boolean;
  conversation_id?: string | null;
  debug?: boolean;
  top_k?: number;
}

async function callRagJson(
  path: string,
  body: unknown,
  timeoutMs: number,
  requestId?: string,
): Promise<unknown> {
  const config = getConfig();
  const url = `${config.ragService.url}${config.ragService.apiPrefix}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.ragService.internalToken,
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const abort = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(abort ? 'INTERNAL_SERVER_ERROR' : 'DEPENDENCY_UNAVAILABLE', abort
      ? `The retrieval service timed out after ${Math.round(timeoutMs / 1000)}s.`
      : 'The retrieval service is unreachable.', {
      cause: error,
      isOperational: true,
      internalContext: { dependency: 'rag-service', url: config.ragService.url },
    });
  }
  clearTimeout(timeout);

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw ApiError.dependencyUnavailable('rag-service');
  }

  if (!response.ok) {
    throw errorFromResponse(parsed, 'Retrieval service request failed.');
  }

  const data = (parsed as { data?: unknown })?.data;
  if (data === undefined) {
    throw ApiError.dependencyUnavailable('rag-service');
  }
  return data;
}

export async function searchRetrieval(
  payload: RagInternalQuery,
  requestId?: string,
): Promise<unknown> {
  const config = getConfig();
  return callRagJson('/retrieval/search', payload, config.rag.requestTimeoutMs, requestId);
}

export async function answerRag(
  payload: RagInternalQuery,
  requestId?: string,
): Promise<unknown> {
  const config = getConfig();
  return callRagJson('/rag/answer', payload, config.rag.requestTimeoutMs, requestId);
}

export async function processManual(options: RagProcessOptions): Promise<RagProcessResult> {
  const config = getConfig();
  const log = getLogger();
  const url = `${config.ragService.url}${config.ragService.apiPrefix}/documents/process`;

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.manualProcessingTimeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.ragService.internalToken,
        'X-Request-Id': options.job_id,
      },
      body: JSON.stringify(options),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const abort = error instanceof Error && error.name === 'AbortError';
    const message = abort
      ? `The document processing pipeline timed out after ${Math.round(config.manualProcessingTimeoutMs / 1000)}s.`
      : 'The document processing service is unreachable.';
    throw new ApiError(abort ? 'INTERNAL_SERVER_ERROR' : 'DEPENDENCY_UNAVAILABLE', message, {
      cause: error,
      isOperational: true,
      internalContext: { dependency: 'rag-service', url: config.ragService.url },
    });
  }
  clearTimeout(timeout);

  log.info(
    {
      jobId: options.job_id,
      manualId: options.manual_id,
      status: response.status,
      durationMs: Date.now() - started,
    },
    'Document processing service responded',
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw ApiError.dependencyUnavailable('rag-service');
  }

  if (!response.ok) {
    throw errorFromResponse(body, 'Document processing failed.');
  }

  const data = (body as { data?: RagProcessResult })?.data;
  if (!data) {
    throw ApiError.dependencyUnavailable('rag-service');
  }
  return data;
}
