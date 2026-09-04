/**
 * Technician-confirmed actions. Never inferred from chat text or AI output.
 */
import type { Db, ObjectId } from 'mongodb';
import type { SuggestedActionStatus, TechnicianActionStatus } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type ConversationActionDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { paginate, updateStamps } from '../../common/repository.js';
import { toObjectId, type PaginationInput } from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import {
  assertConversationActive,
  requireAccessible,
  requireWritable,
} from './conversations.service.js';

type Actor = { id: ObjectId; username: string; role: string };

export interface ActionView {
  id: string;
  conversationId: string;
  createdBy: string;
  action: string;
  result: string | null;
  status: TechnicianActionStatus;
  performedAt: string;
  notes: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toActionView(doc: ConversationActionDoc): ActionView {
  return {
    id: doc._id.toHexString(),
    conversationId: doc.conversation_id.toHexString(),
    createdBy: doc.created_by.toHexString(),
    action: doc.action,
    result: doc.result ?? null,
    status: doc.status,
    performedAt: doc.performed_at.toISOString(),
    notes: doc.notes ?? null,
    sourceMessageId: doc.source_message_id ? doc.source_message_id.toHexString() : null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface CreateActionInput {
  action: string;
  result?: string;
  status: TechnicianActionStatus;
  performedAt?: Date;
  notes?: string;
  sourceMessageId?: string;
  suggestionId?: string;
}

export async function recordAction(
  db: Db,
  conversationId: ObjectId,
  input: CreateActionInput,
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<ActionView> {
  const conversation = await requireWritable(db, conversationId, actor, canReadAny);
  await assertConversationActive(conversation);

  let sourceMessageId: ObjectId | null = null;
  if (input.sourceMessageId) {
    sourceMessageId = toObjectId(input.sourceMessageId);
    const source = await collections.messages(db).findOne({
      _id: sourceMessageId,
      conversation_id: conversationId,
    });
    if (!source) {
      throw ApiError.validation('sourceMessageId does not belong to this conversation.', [
        { field: 'sourceMessageId', issue: 'No matching message.' },
      ]);
    }
    if (input.suggestionId) {
      const suggestions = source.suggested_actions ?? [];
      const match = suggestions.find((item) => item.id === input.suggestionId);
      if (match) {
        const nextStatus: SuggestedActionStatus =
          input.status === 'completed'
            ? 'completed'
            : input.status === 'failed'
              ? 'failed'
              : input.status === 'attempted'
                ? 'attempted'
                : 'accepted';
        await collections.messages(db).updateOne(
          { _id: source._id, 'suggested_actions.id': input.suggestionId },
          { $set: { 'suggested_actions.$.status': nextStatus, updated_at: new Date() } },
        );
      }
    }
  }

  const now = new Date();
  const doc: Omit<ConversationActionDoc, '_id'> = {
    conversation_id: conversationId,
    created_by: actor.id,
    action: input.action,
    result: input.result ?? null,
    status: input.status,
    performed_at: input.performedAt ?? now,
    notes: input.notes ?? null,
    source_message_id: sourceMessageId,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };

  const result = await collections.conversationActions(db).insertOne(doc as ConversationActionDoc);
  const created = { ...(doc as ConversationActionDoc), _id: result.insertedId };

  const attempted = [...(conversation.attempted_actions ?? [])];
  if (!attempted.includes(input.action)) attempted.push(input.action);
  const findings = [...(conversation.confirmed_findings ?? [])];
  if (input.result && !findings.includes(input.result)) findings.push(input.result);

  await collections.conversations(db).updateOne(
    { _id: conversationId },
    {
      $set: {
        attempted_actions: attempted,
        confirmed_findings: findings,
        ...updateStamps(actor.id),
      },
    },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.technicianActionRecorded,
    actor,
    entityType: 'conversation',
    entityId: conversationId,
    requestId: requestId ?? null,
    metadata: {
      actionId: created._id.toHexString(),
      status: input.status,
      sourceMessageId: sourceMessageId ? sourceMessageId.toHexString() : null,
    },
  });

  return toActionView(created);
}

export async function listActions(
  db: Db,
  conversationId: ObjectId,
  query: PaginationInput,
  actor: Actor,
  canReadAny: boolean,
) {
  await requireAccessible(db, conversationId, actor, canReadAny);
  const result = await paginate(
    collections.conversationActions(db),
    { conversation_id: conversationId },
    { page: query.page, limit: query.limit, sort: { performed_at: 1, created_at: 1 } },
  );
  return { items: result.items.map(toActionView), pagination: result.pagination };
}

export async function updateSuggestionStatus(
  db: Db,
  conversationId: ObjectId,
  messageId: ObjectId,
  suggestionId: string,
  status: SuggestedActionStatus,
  actor: Actor,
  canReadAny: boolean,
): Promise<void> {
  const conversation = await requireWritable(db, conversationId, actor, canReadAny);
  await assertConversationActive(conversation);
  const message = await collections.messages(db).findOne({
    _id: messageId,
    conversation_id: conversationId,
  });
  if (!message) throw ApiError.notFound('Message not found.');
  const match = (message.suggested_actions ?? []).find((item) => item.id === suggestionId);
  if (!match) throw ApiError.notFound('Suggested action not found.');
  await collections.messages(db).updateOne(
    { _id: messageId, 'suggested_actions.id': suggestionId },
    { $set: { 'suggested_actions.$.status': status, updated_at: new Date() } },
  );
}
