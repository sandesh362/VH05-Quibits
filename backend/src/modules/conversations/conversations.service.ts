/**
 * Conversations: troubleshooting threads with machine/manual scope.
 *
 * AI output never marks an issue resolved. Scope is validated against live
 * machine, model and manual records so retrieval cannot be pointed at the
 * wrong corpus.
 */
import type { Db, Filter, ObjectId } from 'mongodb';
import type { ConversationStatus, IssueStatus } from '@itp/shared';
import { CONFIRMED_ISSUE_STATUSES } from '@itp/shared';
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
import {
  buildSort,
  containsMatcher,
  normaliseErrorCode,
  toObjectId,
  type PaginationInput,
} from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { requireLiveModel } from '../machine-models/machine-models.service.js';
import { hex } from './conversation-context.js';

export const SORTABLE = ['created_at', 'updated_at', 'last_message_at'] as const;

type Actor = { id: ObjectId; username: string; role: string };

export interface ConversationView {
  id: string;
  title: string | null;
  createdBy: string;
  userId: string;
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  machineLabel: string | null;
  machineModelLabel: string | null;
  manualTitle: string | null;
  scopeSource: string | null;
  status: ConversationStatus;
  issueStatus: IssueStatus;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  operatingConditions: string[];
  attemptedActions: string[];
  confirmedFindings: string[];
  turnCount: number;
  messageCount: number;
  lastMessageAt: string | null;
  startedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
  incidentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export function toView(doc: ConversationDoc): ConversationView {
  const machineLabel =
    doc.machine_snapshot?.display_name ||
    doc.machine_snapshot?.asset_tag ||
    null;
  const modelLabel = doc.model_snapshot
    ? [doc.model_snapshot.manufacturer, doc.model_snapshot.model_name].filter(Boolean).join(' ')
    : null;
  return {
    id: doc._id.toHexString(),
    title: doc.title ?? null,
    createdBy: (doc.created_by ?? doc.user_id).toHexString(),
    userId: doc.user_id.toHexString(),
    machineId: hex(doc.machine_id),
    machineModelId: hex(doc.machine_model_id),
    manualId: hex(doc.manual_id),
    manualVersion: doc.manual_version ?? null,
    machineLabel,
    machineModelLabel: modelLabel || null,
    manualTitle: doc.manual_snapshot?.title ?? null,
    scopeSource: doc.scope_source ?? null,
    status: doc.status,
    issueStatus: doc.issue_status ?? 'unknown',
    issueSummary: doc.issue_summary ?? null,
    errorCodes: doc.error_codes ?? [],
    symptoms: doc.symptoms ?? [],
    operatingConditions: doc.operating_conditions ?? [],
    attemptedActions: doc.attempted_actions ?? [],
    confirmedFindings: doc.confirmed_findings ?? [],
    turnCount: doc.turn_count ?? 0,
    messageCount: doc.message_count ?? 0,
    lastMessageAt: doc.last_message_at ? doc.last_message_at.toISOString() : null,
    startedAt: (doc.started_at ?? doc.created_at).toISOString(),
    closedAt: doc.closed_at ? doc.closed_at.toISOString() : null,
    archivedAt: doc.archived_at ? doc.archived_at.toISOString() : null,
    incidentIds: (doc.incident_ids ?? []).map((id) => id.toHexString()),
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: string;
  messageType: string;
  sequence: number;
  content: string;
  contentText: string | null;
  originalQuery: string | null;
  normalizedQuery: string | null;
  status: string;
  sources: Array<{
    sourceId: string;
    chunkId: string;
    manualId: string;
    manualTitle: string;
    manualVersion: string | null;
    pageStart: number;
    pageEnd: number;
    sectionTitle: string | null;
    machineModelId: string | null;
    excerpt: string | null;
  }>;
  retrievalMetadata: Record<string, unknown> | null;
  machineContext: Record<string, unknown> | null;
  suggestedActions: Array<{
    id: string;
    description: string;
    sourceIds: string[];
    status: string;
  }>;
  clarification: string | null;
  refusalReason: string | null;
  ragStatus: string | null;
  answerStatus: string | null;
  confidence: string | null;
  structuredResponse: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toMessageView(doc: MessageDoc): MessageView {
  return {
    id: doc._id.toHexString(),
    conversationId: doc.conversation_id.toHexString(),
    role: doc.role,
    messageType: doc.message_type ?? (doc.role === 'user' ? 'question' : 'answer'),
    sequence: doc.sequence,
    content: doc.content_text ?? '',
    contentText: doc.content_text ?? null,
    originalQuery: doc.original_query ?? null,
    normalizedQuery: doc.normalized_query ?? null,
    status: doc.status ?? 'completed',
    sources: (doc.sources ?? []).map((source) => ({
      sourceId: source.source_id,
      chunkId: source.chunk_id,
      manualId: source.manual_id,
      manualTitle: source.manual_title,
      manualVersion: source.manual_version ?? null,
      pageStart: source.page_start,
      pageEnd: source.page_end,
      sectionTitle: source.section_title ?? null,
      machineModelId: source.machine_model_id ?? null,
      excerpt: source.excerpt ?? null,
    })),
    retrievalMetadata: doc.retrieval_metadata ?? null,
    machineContext: doc.machine_context ?? null,
    suggestedActions: (doc.suggested_actions ?? []).map((item) => ({
      id: item.id,
      description: item.description,
      sourceIds: item.source_ids ?? [],
      status: item.status,
    })),
    clarification: doc.clarification ?? null,
    refusalReason: doc.refusal_reason ?? null,
    ragStatus: doc.answer_status ?? null,
    answerStatus: doc.answer_status ?? null,
    confidence: doc.confidence ?? null,
    structuredResponse: doc.structured_response ?? null,
    createdBy: doc.created_by ? doc.created_by.toHexString() : null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: (doc.updated_at ?? doc.created_at).toISOString(),
  };
}

export interface CreateInput {
  title?: string;
  machineId?: string;
  machineModelId?: string;
  manualId?: string;
  manualVersion?: string;
  issueSummary?: string;
  errorCodes?: string[];
  symptoms?: string[];
  operatingConditions?: string[];
}

interface ResolvedScope {
  machineId: ObjectId | null;
  machineModelId: ObjectId | null;
  manualId: ObjectId | null;
  manualVersion: string | null;
  scopeSource: string | null;
  machineSnapshot: ConversationDoc['machine_snapshot'];
  modelSnapshot: ConversationDoc['model_snapshot'];
  manualSnapshot: ConversationDoc['manual_snapshot'];
}

export async function resolveConversationScope(db: Db, input: CreateInput): Promise<ResolvedScope> {
  let machineId: ObjectId | null = null;
  let machineModelId: ObjectId | null = null;
  let manualId: ObjectId | null = null;
  let manualVersion: string | null = input.manualVersion ?? null;
  let scopeSource: string | null = null;
  let machineSnapshot: ConversationDoc['machine_snapshot'] = null;
  let modelSnapshot: ConversationDoc['model_snapshot'] = null;
  let manualSnapshot: ConversationDoc['manual_snapshot'] = null;

  if (input.machineId) {
    const machine = await requireLiveMachine(db, toObjectId(input.machineId));
    machineId = machine._id;
    machineModelId = machine.machine_model_id;
    scopeSource = 'user_selected_machine';
    machineSnapshot = {
      asset_tag: machine.asset_tag,
      display_name: machine.display_name ?? null,
      manufacturer: machine.model_snapshot?.manufacturer ?? null,
      model_name: machine.model_snapshot?.model_name ?? null,
      machine_type: machine.model_snapshot?.machine_type ?? null,
    };
    if (input.machineModelId && input.machineModelId !== machine.machine_model_id.toHexString()) {
      throw ApiError.validation('The machine does not belong to the specified machine model.', [
        { field: 'machineModelId', issue: 'Does not match the machine’s model.' },
      ]);
    }
  } else if (input.machineModelId) {
    const model = await requireLiveModel(db, toObjectId(input.machineModelId));
    machineModelId = model._id;
    scopeSource = 'user_selected_model';
  }

  if (machineModelId) {
    const model = await requireLiveModel(db, machineModelId);
    modelSnapshot = {
      manufacturer: model.manufacturer,
      model_name: model.model_name,
      machine_type: model.machine_type,
    };
  }

  if (input.manualId) {
    const manual = await collections.manuals(db).findOne(liveFilter({ _id: toObjectId(input.manualId) }));
    if (!manual) {
      throw ApiError.validation('The selected manual does not exist.', [
        { field: 'manualId', issue: 'No live manual has this id.' },
      ]);
    }
    const manualModel = manual.machine_model_id ? manual.machine_model_id.toHexString() : null;
    if (machineModelId && manualModel && manualModel !== machineModelId.toHexString()) {
      throw ApiError.validation('The selected manual does not belong to the specified machine model.', [
        { field: 'manualId', issue: 'Manual is scoped to a different machine model.' },
      ]);
    }
    if (input.machineId && manual.machine_id && !manual.machine_id.equals(toObjectId(input.machineId))) {
      throw ApiError.validation('The selected manual does not belong to the specified machine.', [
        { field: 'manualId', issue: 'Manual is scoped to a different machine.' },
      ]);
    }
    if (!machineModelId && manual.machine_model_id) {
      machineModelId = manual.machine_model_id;
      const model = await requireLiveModel(db, machineModelId);
      modelSnapshot = {
        manufacturer: model.manufacturer,
        model_name: model.model_name,
        machine_type: model.machine_type,
      };
      if (!scopeSource) scopeSource = 'user_selected_manual';
    }
    if (input.manualVersion && manual.document_version && input.manualVersion !== manual.document_version) {
      throw ApiError.validation('The selected manual version does not match the stored manual.', [
        { field: 'manualVersion', issue: `This manual is version ${manual.document_version}.` },
      ]);
    }
    if (!manualVersion) manualVersion = manual.document_version ?? null;
    manualId = manual._id;
    manualSnapshot = { title: manual.title, document_version: manual.document_version ?? null };
  }

  return {
    machineId,
    machineModelId,
    manualId,
    manualVersion,
    scopeSource,
    machineSnapshot,
    modelSnapshot,
    manualSnapshot,
  };
}

export async function create(
  db: Db,
  input: CreateInput,
  actor: Actor,
  requestId?: string,
): Promise<ConversationView> {
  const scope = await resolveConversationScope(db, input);
  const now = new Date();
  const errorCodes = (input.errorCodes ?? []).map(normaliseErrorCode);

  const doc: Omit<ConversationDoc, '_id'> = {
    user_id: actor.id,
    created_by: actor.id,
    title: input.title ?? null,
    machine_id: scope.machineId,
    machine_model_id: scope.machineModelId,
    manual_id: scope.manualId,
    manual_version: scope.manualVersion,
    scope_source: scope.scopeSource,
    machine_snapshot: scope.machineSnapshot,
    model_snapshot: scope.modelSnapshot,
    manual_snapshot: scope.manualSnapshot,
    status: 'active',
    issue_status: 'unknown',
    issue_summary: input.issueSummary ?? null,
    error_codes: errorCodes,
    symptoms: input.symptoms ?? [],
    operating_conditions: input.operatingConditions ?? [],
    attempted_actions: [],
    confirmed_findings: [],
    turn_count: 0,
    message_count: 0,
    last_message_at: null,
    started_at: now,
    closed_at: null,
    archived_at: null,
    issue_status_history: [],
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
    metadata: {
      machineId: hex(scope.machineId),
      machineModelId: hex(scope.machineModelId),
      manualId: hex(scope.manualId),
    },
  });

  return toView(created);
}

export interface ListQuery extends PaginationInput {
  sortBy?: string;
  status?: ConversationStatus;
  issueStatus?: IssueStatus;
  machineId?: string;
  machineModelId?: string;
  createdBy?: string;
  createdFrom?: Date;
  createdTo?: Date;
  search?: string;
}

export async function list(
  db: Db,
  query: ListQuery,
  actor: Actor,
  canReadAny: boolean,
) {
  const filter: Filter<ConversationDoc> = {};
  if (!canReadAny) filter.user_id = actor.id;
  else if (query.createdBy) filter.user_id = toObjectId(query.createdBy);
  if (query.status) filter.status = query.status;
  if (query.issueStatus) filter.issue_status = query.issueStatus;
  if (query.machineId) filter.machine_id = toObjectId(query.machineId);
  if (query.machineModelId) filter.machine_model_id = toObjectId(query.machineModelId);
  if (query.createdFrom || query.createdTo) {
    filter.created_at = {};
    if (query.createdFrom) filter.created_at.$gte = query.createdFrom;
    if (query.createdTo) filter.created_at.$lte = query.createdTo;
  }
  if (query.search) {
    const matcher = containsMatcher(query.search);
    filter.$or = [{ title: matcher }, { issue_summary: matcher }];
  }

  const result = await paginate(collections.conversations(db), liveFilter(filter), {
    page: query.page,
    limit: query.limit,
    sort: buildSort(query.sortBy, query.sortOrder, SORTABLE, 'last_message_at'),
  });

  return { items: result.items.map(toView), pagination: result.pagination };
}

export async function requireAccessible(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
): Promise<ConversationDoc> {
  const doc = await collections.conversations(db).findOne(liveFilter({ _id: id }));
  if (!doc) throw ApiError.notFound('Conversation not found.');
  if (!canReadAny && !doc.user_id.equals(actor.id)) {
    throw ApiError.notFound('Conversation not found.');
  }
  return doc;
}

export async function requireWritable(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
): Promise<ConversationDoc> {
  const existing = await requireAccessible(db, id, actor, canReadAny);
  if (!existing.user_id.equals(actor.id) && actor.role !== 'admin' && actor.role !== 'manager') {
    throw new ApiError('FORBIDDEN', 'You can only modify your own conversations.');
  }
  return existing;
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
  issueSummary?: string;
  errorCodes?: string[];
  symptoms?: string[];
  operatingConditions?: string[];
}

export async function update(
  db: Db,
  id: ObjectId,
  input: UpdateInput,
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireWritable(db, id, actor, canReadAny);

  const set: Record<string, unknown> = { ...updateStamps(actor.id) };
  if (input.title !== undefined) set.title = input.title;
  if (input.issueSummary !== undefined) set.issue_summary = input.issueSummary;
  if (input.errorCodes !== undefined) set.error_codes = input.errorCodes.map(normaliseErrorCode);
  if (input.symptoms !== undefined) set.symptoms = input.symptoms;
  if (input.operatingConditions !== undefined) set.operating_conditions = input.operatingConditions;

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
    changes: audit.buildChanges('conversation', existing as unknown as Record<string, unknown>, set),
  });

  return toView(updated);
}

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

  await collections.conversations(db).updateOne({ _id: id }, { $set: deletionStamps(actor.id, undefined) });

  await audit.record(db, {
    action: 'conversation.deleted',
    actor,
    entityType: 'conversation',
    entityId: id,
    severity: 'info',
    requestId: requestId ?? null,
  });
}

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

function requireOwnerOrManager(existing: ConversationDoc, actor: Actor): void {
  if (!existing.user_id.equals(actor.id) && actor.role !== 'admin' && actor.role !== 'manager') {
    throw new ApiError('FORBIDDEN', 'You can only change your own conversations.');
  }
}

export async function close(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
  confirmationNote: string | undefined,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireAccessible(db, id, actor, canReadAny);
  requireOwnerOrManager(existing, actor);
  if (existing.status === 'closed') {
    return toView(existing);
  }
  if (existing.status === 'archived') {
    throw ApiError.validation('Archived conversations cannot be closed. Reopen them first.', [
      { field: 'status', issue: 'Conversation is archived.' },
    ]);
  }

  const concluding = (CONFIRMED_ISSUE_STATUSES as readonly string[]).includes(existing.issue_status);
  if (!concluding && !confirmationNote) {
    throw ApiError.validation(
      'Closing an open investigation requires a confirmation note describing how the issue was concluded.',
      [{ field: 'confirmationNote', issue: 'Required when the issue is still unknown or investigating.' }],
    );
  }

  const now = new Date();
  const updated = await collections.conversations(db).findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status: 'closed',
        closed_at: now,
        closed_by: actor.id,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Conversation not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.conversationClosed,
    actor,
    entityType: 'conversation',
    entityId: id,
    requestId: requestId ?? null,
    reason: confirmationNote ?? null,
    metadata: { issueStatus: existing.issue_status },
  });

  return toView(updated);
}

export async function reopen(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
  note: string | undefined,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireAccessible(db, id, actor, canReadAny);
  requireOwnerOrManager(existing, actor);
  if (existing.status === 'active') return toView(existing);

  const now = new Date();
  const updated = await collections.conversations(db).findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status: 'active',
        closed_at: null,
        archived_at: null,
        reopened_at: now,
        reopened_by: actor.id,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Conversation not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.conversationReopened,
    actor,
    entityType: 'conversation',
    entityId: id,
    requestId: requestId ?? null,
    reason: note ?? null,
  });

  return toView(updated);
}

export async function archive(
  db: Db,
  id: ObjectId,
  actor: Actor,
  canReadAny: boolean,
  note: string | undefined,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireAccessible(db, id, actor, canReadAny);
  requireOwnerOrManager(existing, actor);

  const now = new Date();
  const updated = await collections.conversations(db).findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status: 'archived',
        archived_at: now,
        archived_by: actor.id,
        ...updateStamps(actor.id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Conversation not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.conversationArchived,
    actor,
    entityType: 'conversation',
    entityId: id,
    requestId: requestId ?? null,
    reason: note ?? null,
  });

  return toView(updated);
}

export async function updateIssueStatus(
  db: Db,
  id: ObjectId,
  input: { issueStatus: IssueStatus; confirmationNote?: string },
  actor: Actor,
  canReadAny: boolean,
  requestId?: string,
): Promise<ConversationView> {
  const existing = await requireWritable(db, id, actor, canReadAny);
  if (existing.status !== 'active') {
    throw ApiError.validation('Issue status can only be changed on an active conversation.', [
      { field: 'status', issue: `Conversation is ${existing.status}.` },
    ]);
  }

  const previous = existing.issue_status ?? 'unknown';
  if (previous === input.issueStatus) return toView(existing);

  const now = new Date();
  const historyEntry = {
    from: previous,
    to: input.issueStatus,
    changed_by: actor.id,
    confirmation_note: input.confirmationNote ?? null,
    at: now,
  };

  const updated = await collections.conversations(db).findOneAndUpdate(
    { _id: id },
    {
      $set: {
        issue_status: input.issueStatus,
        ...updateStamps(actor.id),
      },
      $push: { issue_status_history: historyEntry },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('Conversation not found.');

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.issueStatusChanged,
    actor,
    entityType: 'conversation',
    entityId: id,
    requestId: requestId ?? null,
    reason: input.confirmationNote ?? null,
    metadata: { from: previous, to: input.issueStatus },
    changes: {
      issue_status: { from: previous, to: input.issueStatus },
    },
  });

  return toView(updated);
}

export async function assertConversationActive(conversation: ConversationDoc): Promise<void> {
  if (conversation.status !== 'active') {
    throw ApiError.validation('This conversation is not active.', [
      { field: 'status', issue: `Messages cannot be sent while the conversation is ${conversation.status}.` },
    ]);
  }
}
