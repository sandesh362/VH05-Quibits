/**
 * Machine timeline routes (Phase 7).
 *
 * `GET /machines/:id/timeline` merges the machine's maintenance records and
 * incident events into one chronological view. Read-only; `machine.read`
 * capability (every authenticated role).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { dateSchema, objectIdSchema, parseOrThrow, toObjectId } from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { successEnvelope } from '../../core/api-error.js';
import * as service from './timeline.service.js';

const timelineQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    kind: z.enum(['all', 'maintenance', 'incident']).default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export function timelineRoutes(): Router {
  const router = Router();

  router.get(
    '/machines/:id/timeline',
    authenticate(),
    authorize('machine.read'),
    asyncHandler(async (req, res) => {
      const id = parseOrThrow(objectIdSchema, req.params.id);
      const query = parseOrThrow(timelineQuerySchema, req.query);
      const auth = requireAuth(req);
      const result = await service.machineTimeline(
        requireDb(),
        toObjectId(id),
        query,
        { id: toObjectId(auth.userId), username: auth.username, role: auth.role },
      );
      res.status(200).json(successEnvelope(result, req.requestId));
    }),
  );

  return router;
}
