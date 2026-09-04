/**
 * Incident Qdrant indexing client (Express -> FastAPI).
 *
 * FastAPI owns incident text normalisation, embedding, Qdrant point
 * management and similar-incident retrieval, exactly like it owns manual
 * chunk vectors. Express is the ONLY process that talks to the AI service.
 *
 * Mongo remains authoritative for incident data and for indexing state;
 * Qdrant is a derived index. Every write to Qdrant goes through the queue
 * with bounded retries so a temporary Ollama/Qdrant outage cannot silently
 * strand stale incident vectors.
 */
import type { Db, ObjectId } from 'mongodb';
import { getConfig } from '../../config/env.js';
import { getLogger } from '../../core/logger.js';
import { collections, type IncidentDoc } from '../../database/collections.js';
import * as audit from '../audit/audit.service.js';
import { enqueue } from '../manuals/manual-processing-queue.js';

const log = getLogger();

export interface IndexActor {
  id?: ObjectId | null;
  userId?: ObjectId | null;
  username: string | null;
  role: string | null;
}

function toAuditActor(actor: IndexActor | null) {
  if (!actor) return null;
  return {
    id: actor.id ?? actor.userId ?? null,
    username: actor.username ?? null,
    role: actor.role ?? null,
  };
}

export interface IncidentIndexPayload {
  incident_id: string;
  organization_id: string;
  machine_id: string;
  machine_model_id: string;
  incident_number: string;
  title: string;
  source: string;
  status: string;
  issue_status: string;
  severity: string;
  priority: string;
  error_codes: string[];
  symptoms: string[];
  operating_conditions: string[];
  root_cause_status: string;
  confirmed_root_cause: string | null;
  confirmed_fix: string | null;
  resolution_summary: string | null;
  resolved_at: string | null;
  created_at: string;
  tags: string[];
}

export interface IndexIncidentResponse {
  qdrant_point_id: string;
  embedding_model: string;
  status: 'indexed' | 'noop';
}

export interface SimilarIncidentMatch {
  incident_id: string;
  qdrant_point_id: string | null;
  similarity_score: number;
  reasons: string[];
}

export interface SimilarIncidentResponse {
  similar: SimilarIncidentMatch[];
  warnings: string[];
}

export function toIndexPayload(doc: IncidentDoc): IncidentIndexPayload {
  return {
    incident_id: doc._id.toHexString(),
    organization_id: doc.organization_id.toHexString(),
    machine_id: doc.machine_id.toHexString(),
    machine_model_id: doc.machine_model_id.toHexString(),
    incident_number: doc.incident_number,
    title: doc.title,
    source: doc.source,
    status: doc.status,
    issue_status: doc.issue_status,
    severity: doc.severity,
    priority: doc.priority,
    error_codes: doc.error_codes ?? [],
    symptoms: doc.symptoms ?? [],
    operating_conditions: doc.operating_conditions ?? [],
    root_cause_status: doc.root_cause.status,
    confirmed_root_cause:
      doc.root_cause.status === 'confirmed' ? doc.root_cause.text : null,
    confirmed_fix:
      doc.permanent_fix?.status === 'confirmed'
        ? doc.permanent_fix.description
        : doc.temporary_fix?.status === 'confirmed'
          ? doc.temporary_fix.description
          : null,
    resolution_summary: doc.resolution_summary ?? null,
    resolved_at: doc.resolved_at ? doc.resolved_at.toISOString() : null,
    created_at: doc.created_at.toISOString(),
    tags: doc.tags ?? [],
  };
}

async function internalFetch(
  path: string,
  body: unknown,
  requestId?: string,
): Promise<Response> {
  const config = getConfig();
  const url = `${config.ragService.url}${config.ragService.apiPrefix}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': config.ragService.internalToken,
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.rag.requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `FastAPI ${path} failed with HTTP ${response.status}`,
    );
  }
  return response;
}

/** Index (or re-index) one incident in Qdrant. Called through the queue. */
export async function indexIncidentInQdrant(
  db: Db,
  incidentId: ObjectId,
  actor: IndexActor | null,
  requestId?: string,
): Promise<IndexIncidentResponse> {
  const incident = await collections.incidents(db).findOne({ _id: incidentId });
  if (!incident || incident.is_deleted) {
    throw new Error(`Incident ${incidentId.toHexString()} not found for indexing.`);
  }

  const response = await internalFetch('/incidents/index', toIndexPayload(incident), requestId);
  const body = (await response.json()) as {
    success?: boolean;
    data?: IndexIncidentResponse;
  };
  if (body.success !== true || !body.data) {
    throw new Error('FastAPI returned an unexpected incident index response.');
  }

  await collections.incidents(db).updateOne(
    { _id: incidentId },
    {
      $set: {
        embedding_status: 'indexed',
        qdrant_point_id: body.data.qdrant_point_id,
        embedding_error: null,
        embedding_updated_at: new Date(),
        updated_at: new Date(),
      },
    },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentIndexed,
    actor: toAuditActor(actor),
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
    metadata: { qdrant_point_id: body.data.qdrant_point_id },
  });
  return body.data;
}

/** Delete an incident's Qdrant point (idempotent). Called through the queue. */
export async function deleteIncidentFromQdrant(
  db: Db,
  incidentId: ObjectId,
  actor: IndexActor | null,
  requestId?: string,
): Promise<void> {
  await internalFetch('/incidents/delete', { incident_id: incidentId.toHexString() }, requestId);
  await collections.incidents(db).updateOne(
    { _id: incidentId },
    {
      $set: {
        embedding_status: 'not_indexed',
        qdrant_point_id: null,
        embedding_error: null,
        embedding_updated_at: new Date(),
        updated_at: new Date(),
      },
    },
  );
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentIndexDeleted,
    actor: toAuditActor(actor),
    entityType: 'incident',
    entityId: incidentId,
    requestId: requestId ?? null,
  });
}

interface PendingIndexJob {
  incidentId: ObjectId;
  actor: IndexActor | null;
  requestId?: string;
  attempt: number;
  isReindex: boolean;
}

function runIndexJob(db: Db, job: PendingIndexJob): void {
  const config = getConfig();
  const retryLimit = config.incidentMemory.indexRetryLimit;
  const retryDelayMs = config.incidentMemory.indexRetryDelayMs;
  enqueue(`incident_index:${job.incidentId.toHexString()}`, async () => {
    try {
      await indexIncidentInQdrant(db, job.incidentId, job.actor, job.requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = job.attempt + 1;
      log.warn(
        { incidentId: job.incidentId.toHexString(), attempt, err: message },
        'incident_index_failed',
      );
      if (attempt < retryLimit) {
        // Persist state and retry later.
        await collections.incidents(db).updateOne(
          { _id: job.incidentId },
          { $set: { embedding_status: 'failed', embedding_error: message, updated_at: new Date() } },
        );
        await audit.record(db, {
          action: audit.AUDIT_ACTIONS.incidentIndexFailed,
          actor: toAuditActor(job.actor),
          entityType: 'incident',
          entityId: job.incidentId,
          severity: 'warning',
          metadata: { attempt, error: message },
        });
        setTimeout(() => runIndexJob(db, { ...job, attempt }), retryDelayMs);
      } else {
        await collections.incidents(db).updateOne(
          { _id: job.incidentId },
          { $set: { embedding_status: 'failed', embedding_error: message, updated_at: new Date() } },
        );
        await audit.record(db, {
          action: audit.AUDIT_ACTIONS.incidentIndexFailed,
          actor: toAuditActor(job.actor),
          entityType: 'incident',
          entityId: job.incidentId,
          severity: 'warning',
          metadata: { attempt, error: message, exhausted: true },
        });
      }
    }
  });
}

/** Queue indexing for a newly created or updated incident. */
export function scheduleIncidentIndex(db: Db, incidentId: ObjectId, actor: IndexActor | null = null, requestId?: string): void {
  void collections
    .incidents(db)
    .updateOne({ _id: incidentId }, { $set: { embedding_status: 'pending', updated_at: new Date() } })
    .then(() => runIndexJob(db, { incidentId, actor, requestId, attempt: 0, isReindex: false }));
}

/** Queue re-indexing (manual retry or data repair). */
export function scheduleIncidentReindex(db: Db, incidentId: ObjectId, actor: IndexActor | null = null, requestId?: string): void {
  void collections
    .incidents(db)
    .updateOne({ _id: incidentId }, { $set: { embedding_status: 'pending', embedding_error: null, updated_at: new Date() } })
    .then(() => runIndexJob(db, { incidentId, actor, requestId, attempt: 0, isReindex: true }));
}

/** Queue Qdrant deletion for a cancelled/deleted incident. */
export function scheduleIncidentDelete(db: Db, incidentId: ObjectId, actor: IndexActor | null = null, requestId?: string): void {
  enqueue(`incident_index_delete:${incidentId.toHexString()}`, async () => {
    try {
      await deleteIncidentFromQdrant(db, incidentId, actor, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ incidentId: incidentId.toHexString(), err: message }, 'incident_index_delete_failed');
      await collections.incidents(db).updateOne(
        { _id: incidentId },
        { $set: { embedding_status: 'not_indexed', embedding_error: message, updated_at: new Date() } },
      );
    }
  });
}

/** Call FastAPI similar-incident retrieval. Returns ranked candidate ids. */
export async function fetchSimilarIncidents(
  incident: IncidentDoc,
  limit: number,
  requestId?: string,
): Promise<SimilarIncidentResponse> {
  const response = await internalFetch(
    '/incidents/similar',
    {
      incident: {
        incident_id: incident._id.toHexString(),
        machine_model_id: incident.machine_model_id.toHexString(),
        machine_id: incident.machine_id.toHexString(),
        error_codes: incident.error_codes ?? [],
        symptoms: incident.symptoms ?? [],
        operating_conditions: incident.operating_conditions ?? [],
        title: incident.title,
        severity: incident.severity,
      },
      organization_id: incident.organization_id.toHexString(),
      limit,
    },
    requestId,
  );
  const body = (await response.json()) as { success?: boolean; data?: SimilarIncidentResponse };
  if (body.success !== true || !body.data) {
    throw new Error('FastAPI returned an unexpected similar-incident response.');
  }
  return body.data;
}
