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
import * as service from './incident-actions.service.js';
import {
  createActionSchema,
  listActionsSchema,
  updateActionSchema,
} from './incident-actions.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(createActionSchema, req.body);
  const action = await service.create(
    requireDb(),
    toObjectId(incidentId),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(201).json(successEnvelope({ action }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listActionsSchema, req.query);
  const result = await service.listForIncident(requireDb(), toObjectId(incidentId), query);
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

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const actionId = parseOrThrow(objectIdSchema, req.params.actionId);
  const input = parseOrThrow(updateActionSchema, req.body);
  const action = await service.update(
    requireDb(),
    toObjectId(incidentId),
    toObjectId(actionId),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ action }, req.requestId));
}
