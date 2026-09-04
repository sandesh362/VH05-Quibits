import type { Request, Response } from 'express';
import { successEnvelope } from '../../core/api-error.js';
import { assertNoOperators, parseOrThrow, toObjectId } from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { ragQuerySchema } from './rag.validators.js';
import * as service from './rag.service.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function search(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(ragQuerySchema, req.body);
  const data = await service.search(requireDb(), input, actorOf(req), req.requestId, false);
  res.status(200).json(successEnvelope(data, req.requestId));
}

export async function answer(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(ragQuerySchema, req.body);
  const data = await service.answer(requireDb(), input, actorOf(req), req.requestId, false);
  res.status(200).json(successEnvelope(data, req.requestId));
}

export async function debug(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(ragQuerySchema, req.body);
  const data = await service.answer(requireDb(), input, actorOf(req), req.requestId, true);
  res.status(200).json(successEnvelope(data, req.requestId));
}
