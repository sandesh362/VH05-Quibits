/**
 * Message persistence + RAG orchestration.
 *
 * Express authenticates, stores the user turn, assembles bounded context and
 * calls FastAPI. The frontend never talks to Ollama, Qdrant or FastAPI.
 */
import { createHash } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import type { RagStatus } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type ConversationDoc,
  type MessageDoc,
  type MessageSource,
  type SuggestedAction,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { getConfig } from '../../config/env.js';
import { toObjectId } from '../../common/validation.js';
import { answerRag } from '../manuals/rag-client.service.js';
import { collectMaintenanceContext } from '../maintenance/maintenance-context.js';
import { resolveActorOrg } from '../organizations/organizations.service.js';
import * as audit from '../audit/audit.service.js';
import {
  assembleContext,
  contextToInternalPayload,
  detectAmbiguousFollowUp,
  fingerprintContent,
  messageStatusForRag,
  ragStatusToMessageType,
} from './conversation-context.js';
import {
  assertConversationActive,
  requireAccessible,
  toMessageView,
  toView,
  type ConversationView,
  type MessageView,
} from './conversations.service.js';

type Actor = { id: ObjectId; username: string; role: string };

export interface SendMessageInput {
  content: string;
  clientRequestId?: string;
}

export interface SendMessageResult {
  message: MessageView;
  userMessage: MessageView;
  rag: {
    status: RagStatus;
    confidence: string | null;
    evidenceSufficient: boolean;
    sources: MessageView['sources'];
    warnings: string[];
    clarification: string | null;
    refusalReason: string | null;
  };
  conversation: ConversationView;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashFingerprint(content: string): string {
  return createHash('sha256').update(fingerprintContent(content), 'utf8').digest('hex');
}

async function nextSequence(db: Db, conversationId: ObjectId): Promise<number> {
  const last = await collections
    .messages(db)
    .find({ conversation_id: conversationId })
    .sort({ sequence: -1 })
    .limit(1)
    .next();
  return (last?.sequence ?? 0) + 1;
}

async function insertMessage(db: Db, doc: Omit<MessageDoc, '_id'>): Promise<MessageDoc> {
  try {
    const result = await collections.messages(db).insertOne(doc as MessageDoc);
    return { ...(doc as MessageDoc), _id: result.insertedId };
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 11000 && doc.idempotency_key) {
      const existing = await collections.messages(db).findOne({
        conversation_id: doc.conversation_id,
        idempotency_key: doc.idempotency_key,
      });
      if (existing) return existing;
    }
    throw error;
  }
}

async function bumpConversation(
  db: Db,
  conversationId: ObjectId,
  actorId: ObjectId,
  extra?: Record<string, unknown>,
): Promise<ConversationDoc | null> {
  const now = new Date();
  return collections.conversations(db).findOneAndUpdate(
    { _id: conversationId },
    {
      $set: {
        last_message_at: now,
        updated_at: now,
        updated_by: actorId,
        ...(extra ?? {}),
      },
      $inc: { message_count: 1, turn_count: 1 },
    },
    { returnDocument: 'after' },
  );
}

function mapSources(raw: unknown): MessageSource[] {
  if (!Array.isArray(raw)) return [];
  const sources: MessageSource[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    const sourceId = String(row.source_id ?? row.sourceId ?? '');
    const chunkId = String(row.chunk_id ?? row.chunkId ?? '');
    const manualId = String(row.manual_id ?? row.manualId ?? '');
    if (!sourceId || !manualId) continue;
    const pageStart = Number(row.page_start ?? row.pageStart ?? 0);
    const pageEnd = Number(row.page_end ?? row.pageEnd ?? pageStart);
    sources.push({
      source_id: sourceId,
      chunk_id: chunkId,
      manual_id: manualId,
      manual_title: String(row.manual_title ?? row.manualTitle ?? 'Manual'),
      manual_version: (row.manual_version ?? row.manualVersion ?? null) as string | null,
      page_start: Number.isFinite(pageStart) ? pageStart : 0,
      page_end: Number.isFinite(pageEnd) ? pageEnd : 0,
      section_title: (row.section_title ?? row.sectionTitle ?? null) as string | null,
      machine_model_id: (row.machine_model_id ?? row.machineModelId ?? null) as string | null,
      excerpt: (row.excerpt ?? null) as string | null,
    });
  }
  return sources;
}

function mapSuggestedActions(raw: unknown, sources: MessageSource[]): SuggestedAction[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const actions: SuggestedAction[] = [];
  raw.forEach((item, index) => {
    const row = asRecord(item);
    const description = String(row.description ?? row.text ?? '').trim();
    if (!description) return;
    const sourceIds = Array.isArray(row.source_ids ?? row.sourceIds)
      ? ((row.source_ids ?? row.sourceIds) as unknown[]).map((id) => String(id))
      : sources.map((s) => s.source_id);
    actions.push({
      id: String(row.id ?? `suggestion-${index + 1}`),
      description,
      source_ids: sourceIds,
      status: 'suggested',
    });
  });
  return actions;
}

function stripPaths(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/\/home\/|\\Users\\|storage\/|manuals\//i.test(value) && /\.(pdf|png|jpg)$/i.test(value)) {
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(stripPaths).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/path|filename|storage/i.test(key) && typeof nested === 'string') continue;
      const cleaned = stripPaths(nested);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function publicRag(raw: Record<string, unknown>, sources: MessageSource[]) {
  const status = (typeof raw.status === 'string' ? raw.status : 'generation_failed') as RagStatus;
  const warnings = Array.isArray(raw.warnings) ? (raw.warnings as unknown[]).map(String) : [];
  return {
    status,
    confidence: typeof raw.confidence === 'string' ? raw.confidence : null,
    evidenceSufficient: raw.evidence_sufficient === true || raw.evidenceSufficient === true,
    sources: sources.map((source) => ({
      sourceId: source.source_id,
      chunkId: source.chunk_id,
      manualId: source.manual_id,
      manualTitle: source.manual_title,
      manualVersion: source.manual_version,
      pageStart: source.page_start,
      pageEnd: source.page_end,
      sectionTitle: source.section_title,
      machineModelId: source.machine_model_id,
      excerpt: source.excerpt ?? null,
    })),
    warnings,
    clarification:
      status === 'clarification_required'
        ? String(raw.message ?? raw.reason ?? 'Additional information is required.')
        : null,
    refusalReason:
      status === 'insufficient_evidence' || status === 'conflicting_evidence'
        ? String(raw.reason ?? raw.message ?? status)
        : null,
  };
}

async function loadRecentMessages(db: Db, conversationId: ObjectId, limit: number): Promise<MessageDoc[]> {
  return collections
    .messages(db)
    .find({ conversation_id: conversationId })
    .sort({ sequence: -1 })
    .limit(limit)
    .toArray()
    .then((rows) => rows.reverse());
}

export async function sendMessage(
  db: Db,
  conversationId: ObjectId,
  input: SendMessageInput,
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<SendMessageResult> {
  const conversation = await requireAccessible(db, conversationId, actor, canReadAny);
  await assertConversationActive(conversation);
  if (!conversation.user_id.equals(actor.id) && actor.role !== 'admin' && actor.role !== 'manager') {
    throw new ApiError('FORBIDDEN', 'You cannot submit messages to another user’s conversation.');
  }

  const config = getConfig();
  const fingerprint = hashFingerprint(input.content);
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.conversation.duplicateWindowSeconds * 1000);

  if (input.clientRequestId) {
    const prior = await collections.messages(db).findOne({
      conversation_id: conversationId,
      idempotency_key: input.clientRequestId,
    });
    if (prior) {
      const assistant = await collections.messages(db).findOne({
        conversation_id: conversationId,
        sequence: prior.sequence + 1,
        role: 'assistant',
      });
      if (assistant && assistant.status === 'completed') {
        const latest = await collections.conversations(db).findOne({ _id: conversationId });
        return {
          message: toMessageView(assistant),
          userMessage: toMessageView(prior),
          rag: publicRag(
            (assistant.structured_response as Record<string, unknown> | undefined) ?? {
              status: assistant.answer_status,
            },
            assistant.sources ?? [],
          ),
          conversation: toView(latest ?? conversation),
        };
      }
    }
  }

  const duplicate = await collections.messages(db).findOne({
    conversation_id: conversationId,
    created_by: actor.id,
    content_fingerprint: fingerprint,
    created_at: { $gte: windowStart },
    role: 'user',
  });
  if (duplicate) {
    const assistant = await collections.messages(db).findOne({
      conversation_id: conversationId,
      sequence: duplicate.sequence + 1,
    });
    if (assistant && assistant.status === 'completed') {
      throw new ApiError('CONFLICT', 'Duplicate message prevented. The previous reply is still valid.', {
        details: [{ field: 'content', issue: 'An identical question was just submitted.' }],
      });
    }
  }

  const historyLimit = config.conversation.historyMessageLimit;
  const priorMessages = await loadRecentMessages(db, conversationId, historyLimit + 2);
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === 'assistant') ?? null;
  const ambiguity = detectAmbiguousFollowUp(input.content, lastAssistant);

  const userSequence = await nextSequence(db, conversationId);
  const userDoc: Omit<MessageDoc, '_id'> = {
    conversation_id: conversationId,
    role: 'user',
    message_type: 'question',
    sequence: userSequence,
    content_text: input.content,
    original_query: input.content,
    normalized_query: fingerprintContent(input.content),
    status: 'completed',
    sources: [],
    suggested_actions: [],
    created_by: actor.id,
    idempotency_key: input.clientRequestId ?? null,
    content_fingerprint: fingerprint,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };

  const userMessage = await insertMessage(db, userDoc);
  await bumpConversation(db, conversationId, actor.id, {
    ...(conversation.issue_status === 'unknown' ? { issue_status: 'investigating' } : {}),
  });

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.messageSubmitted,
    actor,
    entityType: 'conversation',
    entityId: conversationId,
    requestId: requestId ?? null,
    metadata: { messageId: userMessage._id.toHexString(), queryHash: fingerprint },
  });

  if (ambiguity.ambiguous) {
    return persistAssistantFromRag(db, {
      conversationId,
      actor,
      requestId,
      userMessage,
      rag: {
        status: 'clarification_required',
        answer: null,
        confidence: null,
        evidence_sufficient: false,
        sources: [],
        warnings: [],
        reason: 'AMBIGUOUS_FOLLOW_UP',
        message: ambiguity.message,
      },
    });
  }

  const refreshed = (await collections.conversations(db).findOne({ _id: conversationId })) ?? conversation;
  const history = [...priorMessages, userMessage];
  const assembled = assembleContext(refreshed, history);

  // Phase 7 maintenance lane: bounded, org-scoped maintenance history for
  // the conversation's machine. The AI service renders it strictly
  // separately from manual evidence (AC-13).
  let maintenanceContext: unknown = null;
  if (assembled.machineId) {
    const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
    maintenanceContext = await collectMaintenanceContext(
      db,
      org.orgId,
      toObjectId(assembled.machineId),
      now,
    );
  }

  const payload = {
    query: input.content,
    machine_id: assembled.machineId,
    machine_model_id: assembled.machineModelId,
    manual_id: assembled.manualId,
    manual_version: assembled.manualVersion,
    conversation_id: conversationId.toHexString(),
    conversation_context: contextToInternalPayload(assembled),
    maintenance_context: maintenanceContext,
    query_at: now.toISOString(),
    debug: false,
  };

  let ragRaw: Record<string, unknown>;
  try {
    ragRaw = (await answerRag(payload, requestId)) as Record<string, unknown>;
  } catch (error) {
    const failureMessage =
      error instanceof ApiError
        ? error.message
        : 'The retrieval service is unavailable.';
    await persistAssistantFromRag(db, {
      conversationId,
      actor,
      requestId,
      userMessage,
      rag: {
        status: 'processing_unavailable',
        answer: null,
        confidence: null,
        evidence_sufficient: false,
        sources: [],
        warnings: [failureMessage],
        reason: 'RAG_SERVICE_UNAVAILABLE',
        message: 'The answering service is unavailable. Your question was saved; you can retry.',
      },
      failed: true,
    });
    throw new ApiError('DEPENDENCY_UNAVAILABLE', failureMessage, {
      isOperational: true,
      internalContext: { conversationId: conversationId.toHexString(), userMessageId: userMessage._id.toHexString() },
      details: [{ field: 'rag', issue: 'Retryable. The user message was stored.' }],
      cause: error,
    });
  }

  return persistAssistantFromRag(db, {
    conversationId,
    actor,
    requestId,
    userMessage,
    rag: ragRaw,
  });
}

async function persistAssistantFromRag(
  db: Db,
  args: {
    conversationId: ObjectId;
    actor: Actor;
    requestId?: string;
    userMessage: MessageDoc;
    rag: Record<string, unknown>;
    failed?: boolean;
  },
): Promise<SendMessageResult> {
  const status = (typeof args.rag.status === 'string' ? args.rag.status : 'generation_failed') as RagStatus;
  const sources = mapSources(args.rag.sources);
  const suggested = mapSuggestedActions(args.rag.suggested_actions ?? args.rag.suggestedActions, sources);
  const content =
    (typeof args.rag.answer === 'string' && args.rag.answer.trim()
      ? args.rag.answer
      : typeof args.rag.message === 'string'
        ? args.rag.message
        : null) ??
    (status === 'clarification_required'
      ? 'Additional information is required before a grounded answer can be given.'
      : status === 'insufficient_evidence'
        ? 'The manuals in scope do not contain enough evidence to answer reliably.'
        : status === 'conflicting_evidence'
          ? 'Retrieved sources disagree. Review the cited manuals before acting.'
          : 'The answering service could not produce a grounded reply. Your question was saved.');

  const now = new Date();
  const sequence = await nextSequence(db, args.conversationId);
  const messageType = ragStatusToMessageType(status);
  const structured = stripPaths(toCamel(args.rag)) as Record<string, unknown>;

  const assistantDoc: Omit<MessageDoc, '_id'> = {
    conversation_id: args.conversationId,
    role: 'assistant',
    message_type: messageType,
    sequence,
    content_text: content,
    original_query: args.userMessage.content_text ?? null,
    normalized_query: args.userMessage.normalized_query ?? null,
    status: args.failed ? 'failed' : messageStatusForRag(status),
    sources,
    retrieval_metadata: asRecord(stripPaths(args.rag.retrieval)),
    machine_context: asRecord(stripPaths(args.rag.scope)),
    suggested_actions: suggested,
    clarification: status === 'clarification_required' ? String(args.rag.message ?? content) : null,
    refusal_reason:
      status === 'insufficient_evidence' || status === 'conflicting_evidence'
        ? String(args.rag.reason ?? status)
        : null,
    structured_response: structured,
    answer_status: status,
    confidence: typeof args.rag.confidence === 'string' ? args.rag.confidence : null,
    created_by: null,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };

  const assistant = await insertMessage(db, assistantDoc);
  const conversation = await bumpConversation(db, args.conversationId, args.actor.id);

  const auditAction =
    status === 'answered' || status === 'conflicting_evidence'
      ? audit.AUDIT_ACTIONS.assistantResponseGenerated
      : status === 'generation_failed' || status === 'processing_unavailable'
        ? audit.AUDIT_ACTIONS.assistantResponseFailed
        : audit.AUDIT_ACTIONS.assistantResponseRefused;

  await audit.record(db, {
    action: auditAction,
    actor: args.actor,
    entityType: 'conversation',
    entityId: args.conversationId,
    requestId: args.requestId ?? null,
    outcome: status === 'generation_failed' || status === 'processing_unavailable' ? 'failure' : 'success',
    severity: status === 'generation_failed' || status === 'processing_unavailable' ? 'warning' : 'info',
    metadata: {
      messageId: assistant._id.toHexString(),
      ragStatus: status,
      sourceCount: sources.length,
    },
  });

  const latest =
    conversation ??
    (await collections.conversations(db).findOne({ _id: args.conversationId })) ??
    ({} as ConversationDoc);

  return {
    message: toMessageView(assistant),
    userMessage: toMessageView(args.userMessage),
    rag: publicRag(args.rag, sources),
    conversation: toView(latest),
  };
}

export { toObjectId };
