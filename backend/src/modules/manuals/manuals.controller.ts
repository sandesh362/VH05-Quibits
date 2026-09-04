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
import { reprocessManual, requireLiveManual } from './manual-processing.service.js';
import { toJobView } from './manual-processing-jobs.service.js';
import {
  createManualSchema,
  listChunksSchema,
  listManualsSchema,
  listPagesSchema,
  reprocessManualSchema,
  updateManualSchema,
} from './manuals.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

/**
 * Pipeline-owned fields may not be set through the API. A manual can never be
 * marked processed by hand.
 */
function rejectPipelineOwnedFields(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const owned = [
    'processingStatus',
    'processing_status',
    'processingVersion',
    'extractionMethod',
    'ocrUsed',
    'indexedChunkCount',
    'indexedAt',
    'processedAt',
    'failedAt',
  ];
  const attempted = owned.filter((key) => key in (body as Record<string, unknown>));
  if (attempted.length > 0) {
    throw ApiError.validation(
      'Manual processing state is managed by the document pipeline and cannot be set through the API.',
      attempted.map((field) => ({ field, issue: 'Read-only pipeline field.' })),
    );
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  // req.body here is the parsed multipart fields; req.file is the upload.
  assertNoOperators(req.body);
  rejectPipelineOwnedFields(req.body);

  if (!req.file) {
    throw ApiError.validation('A PDF file is required.', [
      { field: 'file', issue: 'multipart field "file" is required.' },
    ]);
  }

  const input = parseOrThrow(createManualSchema, req.body);
  const result = await service.createUpload(
    requireDb(),
    {
      ...input,
      file: {
        buffer: req.file.buffer,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    },
    actorOf(req),
    req.requestId,
  );

  res.status(201).json(
    successEnvelope(
      { manual: result.manual, processingJob: result.processingJob },
      req.requestId,
    ),
  );
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
  const manual = await service.update(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ manual }, req.requestId));
}

export async function remove(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body ?? {});
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(deleteSchema, req.body ?? {});
  await service.remove(requireDb(), toObjectId(id), actorOf(req), reason, req.requestId);
  res.status(200).json(successEnvelope({ deleted: true }, req.requestId));
}

export async function reprocess(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(reprocessManualSchema, req.body ?? {});
  const result = await reprocessManual(requireDb(), toObjectId(id), actorOf(req), reason, req.requestId);
  res.status(202).json(successEnvelope({ jobId: result.jobId.toHexString() }, req.requestId));
}

export async function listPages(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listPagesSchema, req.query);
  const manualId = toObjectId(id);
  await requireLiveManual(requireDb(), manualId);
  const result = await service.listPages(requireDb(), manualId, query);
  res.status(200).json({
    success: true,
    data: result.items,
    meta: { requestId: req.requestId, timestamp: new Date().toISOString(), pagination: result.pagination },
  });
}

export async function listChunks(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const query = parseOrThrow(listChunksSchema, req.query);
  const manualId = toObjectId(id);
  await requireLiveManual(requireDb(), manualId);
  const result = await service.listChunks(requireDb(), manualId, query);
  res.status(200).json({
    success: true,
    data: result.items,
    meta: { requestId: req.requestId, timestamp: new Date().toISOString(), pagination: result.pagination },
  });
}

export async function processingStatus(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const manualId = toObjectId(id);
  const job = await service.getProcessingStatus(requireDb(), manualId);
  res.status(200).json(
    successEnvelope(
      { manualId: manualId.toHexString(), job: job ? toJobView(job) : null },
      req.requestId,
    ),
  );
}



