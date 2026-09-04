import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { ragRateLimiter } from '../../middleware/rate-limit.js';
import * as controller from './rag.controller.js';

export function ragRoutes(): Router {
  const router = Router();
  const limiter = ragRateLimiter();

  router.post(
    '/retrieval/search',
    authenticate(),
    authorize('manual.read'),
    limiter,
    asyncHandler(controller.search),
  );

  router.post(
    '/rag/answer',
    authenticate(),
    authorize('manual.read'),
    limiter,
    asyncHandler(controller.answer),
  );

  router.post(
    '/rag/debug',
    authenticate(),
    authorize('audit_log.read'),
    limiter,
    asyncHandler(controller.debug),
  );

  return router;
}
