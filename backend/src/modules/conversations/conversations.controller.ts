import type { Request, Response } from 'express';
import { successEnvelope } from '../../core/api-error.js';
import {
  assertNoOperators,
  objectIdSchema,
  parseOrThrow,
  toObjectId,
} from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { roleHasCapability } from '../../common/policy.js';
import * as service from './conversations.service.js';
import * as messages from './conversation-messages.service.js';
import * as actions from './conversation-actions.service.js';
import {
  archiveConversationSchema,
  closeConversationSchema,
  createConversationSchema,
  issueStatusSchema,
  listActionsSchema,
  listConversationsSchema,
  listMessagesSchema,
  postMessageSchema,
  reopenConversationSchema,
  suggestionStatusSchema,
  technicianActionSchema,
  updateConversationSchema,
} from './conversations.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

function canReadAny(req: Request): boolean {
  return roleHasCapability(requireAuth(req).role, 'conversation.read_any');
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(createConversationSchema, req.body ?? {});
  const conversation = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ conversation }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listConversationsSchema, req.query);
  const result = await service.list(requireDb(), query, actorOf(req), canReadAny(req));
  res.status(200).json({
    success: true,
    data: result.items,
    meta: {
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      pagination: result.pagination,
    },
  });
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const conversation = await service.getById(
    requireDb(),
    toObjectId(id),
    actorOf(req),
    canReadAny(req),
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateConversationSchema, req.body);
  const conversation = await service.update(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    canReadAny(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  await service.remove(requireDb(), toObjectId(id), actorOf(req), canReadAny(req), req.requestId);
  res.status(200).json(successEnvelope({ deleted: true }, req.requestId));
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listMessagesSchema, req.query);
  const result = await service.listMessages(
    requireDb(),
    toObjectId(id),
    query,
    actorOf(req),
    canReadAny(req),
  );
  res.status(200).json({
    success: true,
    data: result.items,
    meta: {
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      pagination: result.pagination,
    },
  });
}

export async function postMessage(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(postMessageSchema, req.body ?? {});
  const headerKey = req.header('idempotency-key');
  const result = await messages.sendMessage(
    requireDb(),
    toObjectId(id),
    { ...input, clientRequestId: input.clientRequestId ?? headerKey ?? undefined },
    actorOf(req),
    canReadAny(req),
    req.requestId,
  );
  res.status(200).json(
    successEnvelope(
      {
        message: result.message,
        userMessage: result.userMessage,
        rag: result.rag,
        conversation: {
          id: result.conversation.id,
          issueStatus: result.conversation.issueStatus,
          status: result.conversation.status,
          messageCount: result.conversation.messageCount,
        },
      },
      req.requestId,
    ),
  );
}

export async function close(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(closeConversationSchema, req.body ?? {});
  const conversation = await service.close(
    requireDb(),
    toObjectId(id),
    actorOf(req),
    canReadAny(req),
    input.confirmationNote,
    req.requestId,
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function reopen(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(reopenConversationSchema, req.body ?? {});
  const conversation = await service.reopen(
    requireDb(),
    toObjectId(id),
    actorOf(req),
    canReadAny(req),
    input.note,
    req.requestId,
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function archive(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(archiveConversationSchema, req.body ?? {});
  const conversation = await service.archive(
    requireDb(),
    toObjectId(id),
    actorOf(req),
    canReadAny(req),
    input.note,
    req.requestId,
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function patchIssueStatus(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(issueStatusSchema, req.body);
  const conversation = await service.updateIssueStatus(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    canReadAny(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ conversation }, req.requestId));
}

export async function createAction(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(technicianActionSchema, req.body);
  const action = await actions.recordAction(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    canReadAny(req),
    req.requestId,
  );
  res.status(201).json(successEnvelope({ action }, req.requestId));
}

export async function listActions(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listActionsSchema, req.query);
  const result = await actions.listActions(
    requireDb(),
    toObjectId(id),
    query,
    actorOf(req),
    canReadAny(req),
  );
  res.status(200).json({
    success: true,
    data: result.items,
    meta: {
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      pagination: result.pagination,
    },
  });
}

export async function patchSuggestion(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const conversationId = parseOrThrow(objectIdSchema, req.params.id);
  const messageId = parseOrThrow(objectIdSchema, req.params.messageId);
  const suggestionId = String(req.params.suggestionId ?? '');
  const input = parseOrThrow(suggestionStatusSchema, req.body);
  await actions.updateSuggestionStatus(
    requireDb(),
    toObjectId(conversationId),
    toObjectId(messageId),
    suggestionId,
    input.status,
    actorOf(req),
    canReadAny(req),
  );
  res.status(200).json(successEnvelope({ updated: true }, req.requestId));
}
