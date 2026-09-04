/**
 * Incident action HTTP handlers.
 */
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
import { resolveActorOrg } from '../organizations/organizations.service.js';
import * as service from './incident-actions.service.js';
import {
  confirmActionSchema,
  createActionSchema,
  listActionsSchema,
  updateActionSchema,
} from './incident-actions.validators.js';

async function actorOf(req: Request) {
  const auth = requireAuth(req);
  return resolveActorOrg(requireDb(), auth.userId, auth.username, auth.role);
}

export async function list(req: Request, res: Response): Promise<void> {
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listActionsSchema, req.query);
  const actor = await actorOf(req);
  const result = await service.list(requireDb(), toObjectId(incidentId), query, actor);
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

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(createActionSchema, req.body);
  const actor = await actorOf(req);
  const action = await service.recordForApi(
    requireDb(),
    toObjectId(incidentId),
    input,
    actor,
    req.requestId,
  );
  res.status(201).json(successEnvelope({ action }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const actionId = parseOrThrow(objectIdSchema, req.params.actionId);
  const input = parseOrThrow(updateActionSchema, req.body);
  const actor = await actorOf(req);
  const action = await service.update(
    requireDb(),
    toObjectId(incidentId),
    toObjectId(actionId),
    input,
    actor,
    req.requestId,
  );
  res.status(200).json(successEnvelope({ action }, req.requestId));
}

export async function confirm(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const actionId = parseOrThrow(objectIdSchema, req.params.actionId);
  const { note } = parseOrThrow(confirmActionSchema, req.body);
  const actor = await actorOf(req);
  const action = await service.confirm(
    requireDb(),
    toObjectId(incidentId),
    toObjectId(actionId),
    note,
    actor,
    req.requestId,
  );
  res.status(200).json(successEnvelope({ action }, req.requestId));
}

export async function history(req: Request, res: Response): Promise<void> {
  const incidentId = parseOrThrow(objectIdSchema, req.params.id);
  const actionId = parseOrThrow(objectIdSchema, req.params.actionId);
  const actor = await actorOf(req);
  const history = await service.history(
    requireDb(),
    toObjectId(incidentId),
    toObjectId(actionId),
    actor,
  );
  res.status(200).json(successEnvelope({ history }, req.requestId));
}
