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
import * as service from './maintenance.service.js';
import {
  createMaintenanceSchema,
  listMaintenanceSchema,
  updateMaintenanceSchema,
} from './maintenance.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(createMaintenanceSchema, req.body);
  const record = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ maintenanceRecord: record }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listMaintenanceSchema, req.query);
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
  const record = await service.getById(requireDb(), toObjectId(id));
  res.status(200).json(successEnvelope({ maintenanceRecord: record }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateMaintenanceSchema, req.body);
  const record = await service.update(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ maintenanceRecord: record }, req.requestId));
}
