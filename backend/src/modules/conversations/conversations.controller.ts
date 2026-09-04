import type { Request, Response } from 'express';
import { ApiError, successEnvelope } from '../../core/api-error.js';
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
import {
  createConversationSchema,
  listConversationsSchema,
  listMessagesSchema,
  updateConversationSchema,
} from './conversations.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

/** Managers and admins may read any conversation; everyone else, their own. */
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

/**
 * Posting a message would mean generating an assistant reply, which requires
 * retrieval and an LLM - neither of which exists in Phase 2.
 *
 * This returns an explicit 501 instead of storing the user message and
 * pretending. A stored question with no possible answer is worse than a clear
 * "not yet": it looks like a bug, and it quietly builds a backlog of orphaned
 * messages the Phase 5 code would have to reason about.
 */
export async function postMessage(_req: Request, _res: Response): Promise<void> {
  // Phrased as a full sentence rather than via ApiError.notImplemented(), whose
  // "<feature> is not implemented yet" template reads badly for a clause.
  throw new ApiError(
    'NOT_IMPLEMENTED',
    'Sending conversation messages requires the retrieval and answering pipeline, which arrives in Phase 5. No message was stored.',
  );
}
