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
import { deleteSchema } from '../machine-models/machine-models.validators.js';
import * as service from './manuals.service.js';
import {
  createManualSchema,
  listManualsSchema,
  updateManualSchema,
} from './manuals.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

/**
 * Business rule 8, stated explicitly rather than relying on `.strict()` alone.
 *
 * A bare "unrecognised key" error would leave an operator guessing. This says
 * plainly that processing state belongs to the pipeline, and that the pipeline
 * does not exist yet.
 */
function rejectPipelineOwnedFields(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const owned = ['processingStatus', 'processing_status', 'indexedChunkCount', 'indexedAt'];
  const attempted = owned.filter((key) => key in (body as Record<string, unknown>));
  if (attempted.length > 0) {
    throw ApiError.validation(
      'Manual processing state is managed by the document pipeline and cannot be set through the API.',
      attempted.map((field) => ({
        field,
        issue: 'Read-only. Document processing is not available until Phase 3.',
      })),
    );
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  rejectPipelineOwnedFields(req.body);
  const input = parseOrThrow(createManualSchema, req.body);
  const manual = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ manual }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listManualsSchema, req.query);
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
  const manual = await service.getById(requireDb(), toObjectId(id));
  res.status(200).json(successEnvelope({ manual }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  rejectPipelineOwnedFields(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateManualSchema, req.body);
  const manual = await service.update(
    requireDb(),
    toObjectId(id),
    input,
    actorOf(req),
    req.requestId,
  );
  res.status(200).json(successEnvelope({ manual }, req.requestId));
}

export async function remove(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(deleteSchema, req.body ?? {});
  await service.remove(requireDb(), toObjectId(id), actorOf(req), reason, req.requestId);
  res.status(200).json(successEnvelope({ deleted: true }, req.requestId));
}
