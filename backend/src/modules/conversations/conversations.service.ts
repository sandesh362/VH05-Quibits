/**
 * Conversations - CONTAINER ONLY in Phase 2.
 *
 * A conversation groups messages about a machine problem. In Phase 5 posting a
 * user message triggers retrieval and an Ollama call that appends an assistant
 * reply. None of that exists yet, and this module deliberately does not fake
 * it: there is no endpoint here that creates an assistant message, because any
 * such message would be invented rather than generated.
 *
 * `POST /conversations/:id/messages` therefore returns 501 NOT_IMPLEMENTED
 * rather than echoing a canned reply. An honest 501 tells the truth about the
 * system's state; a stubbed "I'm still learning!" would not.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { ConversationStatus } from '@itp/shared';
import {
  collections,
  SCHEMA_VERSION,
  type ConversationDoc,
  type MessageDoc,
} from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import {
  deletionStamps,
  liveFilter,
  paginate,
  updateStamps,
} from '../../common/repository.js';
import { buildSort, toObjectId, type PaginationInput } from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';

export const SORTABLE = ['created_at', 'updated_at', 'last_message_at'] as const;

type Actor = { id: ObjectId; username: string; role: string };

export interface ConversationView {
  id: string;
  userId: string;
  title: string | null;
  machineId: string | null;
  machineModelId: string | null;
  scopeSource: string | null;
  status: ConversationStatus;
  turnCount: number;
  lastMessageAt: string | null;
  incidentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: ConversationDoc): ConversationView {
  return {
    id: doc._id.toHexString(),
    userId: doc.user_id.toHexString(),
    title: doc.title ?? null,
    machineId: doc.machine_id ? doc.machine_id.toHexString() : null,
    machineModelId: doc.machine_model_id ? doc.machine_model_id.toHexString() : null,
    scopeSource: doc.scope_source ?? null,
    status: doc.status,
    turnCount: doc.turn_count ?? 0,
    lastMessageAt: doc.last_message_at ? doc.last_message_at.toISOString() : null,
    incidentIds: (doc.incident_ids ?? []).map((id) => id.toHexString()),
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: string;
  sequence: number;
  contentText: string | null;
  structuredResponse: Record<string, unknown> | null;
  answerStatus: string | null;
  confidence: string | null;
  createdAt: string;
}

export function toMessageView(doc: MessageDoc): MessageView {
  return {
    id: doc._id.toHexString(),
    conversationId: doc.conversation_id.toHexString(),
    role: doc.role,
    sequence: doc.sequence,
    contentText: doc.content_text ?? null,
    structuredResponse: doc.structured_response ?? null,
    answerStatus: doc.answer_status ?? null,
    confidence: doc.confidence ?? null,
    createdAt: doc.created_at.toISOString(),
  };
}

export interface CreateInput {
  title?: string;
  machineId?: string;
  machineModelId?: string;
}

export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<ConversationView> {
  let machineId: ObjectId | null = null;
  let machineModelId: ObjectId | null = null;
  let scopeSource: string | null = null;

  /**
   * `scope_source` records HOW the scope was determined. Once Phase 4 can
   * infer scope from the question text, telling an inferred scope apart from
   * one the user picked is what makes bad retrieval debuggable.
   */
  if (input.machineId) {
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    machineId = machine._id;
    machineModelId = machine.machine_model_id;
    scopeSource = 'user_selected_machine';
  } else if (input.machineModelId) {
    const model = await requireLiveModel(db, toObjectId(input.machineModelId));
    machineModelId = model._id;
    scopeSource = 'user_selected_model';
  }

  const now = new Date();
  const doc: Omit<ConversationDoc, '_id'> = {
    user_id: actor.id,
    title: input.title ?? null,
    machine_id: machineId,
    machine_model_id: machineModelId,
    scope_source: scopeSource,
    status: 'active',
    turn_count: 0,
    last_message_at: null,
    incident_ids: [],
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<ConversationDoc, '_id'>;

  const result = await collections.conversations(db).insertOne(doc as ConversationDoc);
  const created = { ...(doc as ConversationDoc), _id: result.insertedId };

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.conversationCreated,
    actor,
    entityType: 'conversation',
    entityId: created._id,
    severity: 'info',
    requestId: requestId ?? null,
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  status?: ConversationStatus;
  machineId?: string;
}

/**
 * List conversations.
 *
 * Scoped to the caller unless they hold `conversation.read_any`. A
 * conversation can contain a technician thinking out loud, so it is treated as
 * personal by default.
 */
export async function list(
  db: Db,
  query: ListQuery,
  actor: Actor,
  canReadAny: boolean,
) {
  const filter: Filter<ConversationDoc> = {};
  if (!canReadAny) filter.user_id = actor.id;
  if (query.status) filter.status = query.status;
  if (query.machineId) filter.machine_id = toObjectId(query.machineId);

  const result = await paginate(collections.conversations(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'created_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

/** Load a conversation the actor is allowed to see, or 404. */
async function requireAccessible(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
): Promise<ConversationDoc> {
  const doc = await collections.conversations(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Conversation not found.');

  // 404 rather than 403: revealing that someone else's conversation exists at
  // this id is itself a small information leak.
  if (!canReadAny && !doc.user_id.equals(actor.id)) {
    throw ApiError.notFound('Conversation not found.');
  }
  return doc;
}

export async function getById(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
): Promise<ConversationView> {
  return toView(await requireAccessible(db, id, actor, canReadAny));
}

export interface UpdateInput {
  title?: string;
  status?: ConversationStatus;
}

export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireAccessible(db, id, actor, canReadAny);

  // Only the owner may edit, whatever their read scope.
  if (!existing.user_id.equals(actor.id)) {
    throw new ApiError('FORBIDDEN', 'You can only modify your own conversations.');
  }

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  if (input.title !== undefined) set.title = input.title;
  if (input.status !== undefined) set.status = input.status;

  const updated = await collections
    .conversations(db)
    .findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  if (!updated) throw ApiError.notFound('Conversation not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.conversationUpdated,
    actor,
    entityType: 'conversation',
    entityId: id,
    severity: 'info',
    requestId: requestId ?? null,
    changes: audit.buildChanges(
      'conversation',
      existing as unknown as Record<string, unknown>,
      set,
    ),
  });

  return toView(updated);
}

/**
 * Soft-delete a conversation.
 *
 * Any incidents raised from it survive: the conversation is a working notepad,
 * the incident is the record of a real machine failure.
 */
export async function remove(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<void> {
  const existing = await requireAccessible(db, id, actor, canReadAny);
  if (!existing.user_id.equals(actor.id) && actor.role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'You can only delete your own conversations.');
  }

  await collections
    .conversations(db)
    .updateOne({ _id: id }, { $set: deletionStamps(actor.id, undefined) });

  await audit.record(db, {
    action: 'conversation.deleted',
    actor,
    entityType: 'conversation',
    entityId: id,
    severity: 'info',
    requestId: requestId ?? null,
  });
}

/** Messages in a conversation, oldest first. Read-only in Phase 2. */
export async function listMessages(
  db: Db,
  conversationId: ObjectId,
  query: PaginationInput,
  actor: Actor,
  canReadAny: boolean,
) {
  await requireAccessible(db, conversationId, actor, canReadAny);

  const result = await paginate(
    collections.messages(db),
    { conversation_id: conversationId },
    { page: query.page, limit: query.limit, sort: { sequence: 1 } },
  );

  return { items: result.items.map(toMessageView), pagination: result.pagination };
}
