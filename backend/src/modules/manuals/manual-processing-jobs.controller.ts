import type { Request, Response } from 'express';
import { successEnvelope } from '../../core/api-error.js';
import { objectIdSchema, parseOrThrow, toObjectId } from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { retryJob } from './manual-processing.service.js';
import { getJobById, listJobs } from './manual-processing-jobs.service.js';
import { listJobsSchema } from './manuals.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listJobsSchema, req.query);
  const result = await listJobs(requireDb(), query);
  res.status(200).json({
    success: true,
    data: result.items,
    meta: { requestId: req.requestId, timestamp: new Date().toISOString(), pagination: result.pagination },
  });
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const job = await getJobById(requireDb(), toObjectId(id));
  res.status(200).json(successEnvelope({ job }, req.requestId));
}

export async function retry(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const result = await retryJob(requireDb(), toObjectId(id), actorOf(req), req.requestId);
  res.status(202).json(successEnvelope({ jobId: result.jobId.toHexString() }, req.requestId));
}
