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
import * as service from './machine-models.service.js';
import {
  createMachineModelSchema,
  deleteSchema,
  listMachineModelsSchema,
  updateMachineModelSchema,
} from './machine-models.validators.js';

/** Actor identity always comes from the verified token, never the body. */
function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(createMachineModelSchema, req.body);
  const model = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ machineModel: model }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listMachineModelsSchema, req.query);
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
  const model = await service.getById(requireDb(), toObjectId(id));
  res.status(200).json(successEnvelope({ machineModel: model }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateMachineModelSchema, req.body);
  const model = await service.update(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ machineModel: model }, req.requestId));
}

export async function remove(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(deleteSchema, req.body ?? {});
  await service.remove(requireDb(), toObjectId(id), actorOf(req), reason, req.requestId);
  res.status(200).json(successEnvelope({ deleted: true }, req.requestId));
}
