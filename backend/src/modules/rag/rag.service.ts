/**
 * Retrieval / RAG façade.
 *
 * Express authenticates, authorises, resolves machine/manual scope and audits.
 * FastAPI owns retrieval, ranking, generation and citation validation. This
 * module must not reimplement those.
 */
import { createHash } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import { ApiError } from '../../core/api-error.js';
import { getConfig } from '../../config/env.js';
import { toObjectId } from '../../common/validation.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { requireLiveManual } from '../manuals/manual-processing.service.js';
import { answerRag, searchRetrieval } from '../manuals/rag-client.service.js';
import * as audit from '../audit/audit.service.js';
import type { RagQueryInput } from './rag.validators.js';

type Actor = { id: ObjectId; username: string; role: string };

export interface ResolvedScope {
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  manualType: string | null;
  manufacturer: string | null;
}

export function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex');
}

function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[snakeToCamelKey(key)] = toCamel(nested);
    }
    return out;
  }
  return value;
}

export async function resolveScope(db: Db, input: RagQueryInput): Promise<ResolvedScope> {
  let machineId = input.machineId ?? null;
  let machineModelId = input.machineModelId ?? null;
  let manualId = input.manualId ?? null;
  let manualVersion = input.manualVersion ?? null;
  const manualType = input.manualType ?? null;
  let manufacturer = input.manufacturer ?? null;

  if (machineId) {
    const machine = await requireLiveMachine(db, toObjectId(machineId));
    const resolvedModel = machine.machine_model_id.toHexString();
    if (machineModelId && machineModelId !== resolvedModel) {
      throw ApiError.validation('The machine does not belong to the specified machine model.', [
        {
          field: 'machineModelId',
          issue: 'Does not match the machine’s model.',
        },
      ]);
    }
    machineModelId = resolvedModel;
  }

  if (machineModelId) {
    const model = await requireLiveModel(db, toObjectId(machineModelId));
    if (!manufacturer) manufacturer = model.manufacturer;
  }

  if (manualId) {
    const manual = await requireLiveManual(db, toObjectId(manualId));
    const manualModel = manual.machine_model_id ? manual.machine_model_id.toHexString() : null;
    if (machineModelId && manualModel && manualModel !== machineModelId) {
      throw ApiError.validation('The selected manual does not belong to the specified machine model.', [
        { field: 'manualId', issue: 'Manual is scoped to a different machine model.' },
      ]);
    }
    if (!machineModelId && manualModel) machineModelId = manualModel;
    if (!manualVersion) manualVersion = manual.document_version ?? null;
    if (!manufacturer) manufacturer = manual.manufacturer ?? null;
  }

  return {
    machineId,
    machineModelId,
    manualId,
    manualVersion,
    manualType,
    manufacturer,
  };
}

function internalPayload(input: RagQueryInput, scope: ResolvedScope, debug: boolean) {
  return {
    query: input.query,
    machine_id: scope.machineId,
    machine_model_id: scope.machineModelId,
    manual_id: scope.manualId,
    manual_version: scope.manualVersion,
    manual_type: scope.manualType,
    manufacturer: scope.manufacturer,
    include_inactive: input.includeInactive ?? false,
    conversation_id: input.conversationId ?? null,
    debug,
  };
}

function auditForStatus(
  status: string | undefined,
): { action: string; outcome: 'success' | 'failure'; severity: 'info' | 'warning' } {
  if (status === 'answered' || status === 'retrieved' || status === 'conflicting_evidence') {
    return { action: audit.AUDIT_ACTIONS.ragAnswerGenerated, outcome: 'success', severity: 'info' };
  }
  if (status === 'insufficient_evidence' || status === 'clarification_required') {
    return { action: audit.AUDIT_ACTIONS.ragAnswerRefused, outcome: 'success', severity: 'info' };
  }
  if (status === 'generation_failed') {
    return { action: audit.AUDIT_ACTIONS.ragGenerationFailed, outcome: 'failure', severity: 'warning' };
  }
  return { action: audit.AUDIT_ACTIONS.retrievalCompleted, outcome: 'success', severity: 'info' };
}

async function recordRagAudit(
  db: Db,
  actor: Actor,
  requestId: string | undefined,
  input: RagQueryInput,
  scope: ResolvedScope,
  result: Record<string, unknown>,
  durationMs: number,
  kind: 'search' | 'answer',
): Promise<void> {
  const status = typeof result.status === 'string' ? result.status : undefined;
  const retrieval = (result.retrieval as Record<string, unknown> | undefined) ?? {};
  const { action, outcome, severity } = kind === 'search'
    ? {
        action: audit.AUDIT_ACTIONS.retrievalCompleted,
        outcome: 'success' as const,
        severity: 'info' as const,
      }
    : auditForStatus(status);

  const config = getConfig();
  const metadata: Record<string, unknown> = {
    queryHash: hashQuery(input.query),
    status: status ?? null,
    machineModelId: scope.machineModelId,
    manualId: scope.manualId,
    retrievedChunkCount: retrieval.exact_matches ?? retrieval.exactMatches ?? null,
    selectedChunkCount: retrieval.final_context_chunks ?? retrieval.finalContextChunks ?? null,
    durationMs,
    kind,
  };
  if (config.rag.logQueryText) {
    metadata.queryPreview = input.query.slice(0, 80);
  }

  await audit.record(db, {
    action,
    actor,
    entityType: scope.machineModelId ? 'machine_model' : 'manual',
    entityId: scope.machineModelId
      ? toObjectId(scope.machineModelId)
      : scope.manualId
        ? toObjectId(scope.manualId)
        : null,
    requestId: requestId ?? null,
    outcome,
    severity,
    metadata,
  });
}

export async function search(
  db: Db,
  input: RagQueryInput,
  actor: Actor,
  requestId?: string,
  debug = false,
): Promise<unknown> {
  const started = Date.now();
  const scope = await resolveScope(db, input);
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.ragQuerySubmitted,
    actor,
    requestId: requestId ?? null,
    metadata: {
      queryHash: hashQuery(input.query),
      machineModelId: scope.machineModelId,
      manualId: scope.manualId,
      kind: 'search',
    },
  });
  const raw = (await searchRetrieval(internalPayload(input, scope, debug), requestId)) as Record<
    string,
    unknown
  >;
  await recordRagAudit(db, actor, requestId, input, scope, raw, Date.now() - started, 'search');
  return toCamel(raw);
}

export async function answer(
  db: Db,
  input: RagQueryInput,
  actor: Actor,
  requestId?: string,
  debug = false,
): Promise<unknown> {
  const started = Date.now();
  const scope = await resolveScope(db, input);
  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.ragQuerySubmitted,
    actor,
    requestId: requestId ?? null,
    metadata: {
      queryHash: hashQuery(input.query),
      machineModelId: scope.machineModelId,
      manualId: scope.manualId,
      kind: 'answer',
    },
  });
  const raw = (await answerRag(internalPayload(input, scope, debug), requestId)) as Record<
    string,
    unknown
  >;
  if (raw.status === 'generation_failed' && Array.isArray(raw.warnings)) {
    const citationFail = (raw.warnings as unknown[]).some(
      (w) => typeof w === 'string' && /citation/i.test(w),
    );
    if (citationFail) {
      await audit.record(db, {
        action: audit.AUDIT_ACTIONS.ragCitationValidationFailed,
        actor,
        requestId: requestId ?? null,
        outcome: 'failure',
        severity: 'warning',
        metadata: { queryHash: hashQuery(input.query), machineModelId: scope.machineModelId },
      });
    }
  }
  await recordRagAudit(db, actor, requestId, input, scope, raw, Date.now() - started, 'answer');
  return toCamel(raw);
}
