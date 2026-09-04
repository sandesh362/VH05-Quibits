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
import * as service from './incidents.service.js';
import {
  confirmResolutionSchema,
  createIncidentSchema,
  listIncidentsSchema,
  reopenSchema,
  updateIncidentSchema,
} from './incidents.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(createIncidentSchema, req.body);
  const incident = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ incident }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listIncidentsSchema, req.query);
  const result = await service.list(requireDb(), query);
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
  const incident = await service.getById(requireDb(), toObjectId(id));
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateIncidentSchema, req.body);
  const incident = await service.update(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function confirmResolution(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(confirmResolutionSchema, req.body);
  const incident = await service.confirmResolution(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function reopen(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(reopenSchema, req.body);
  const incident = await service.reopen(
    requireDb(),
    toObjectId(id),
    reason,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}
