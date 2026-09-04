import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import * as controller from './manual-processing-jobs.controller.js';

/**
 * Processing-job administration. Read is open to all authenticated roles;
 * retry requires a write capability (admin/manager) because it mutates state.
 */
export function manualProcessingJobRoutes(): Router {
  const router = Router();
  const base = '/manual-processing-jobs';

  router.use(base, authenticate());

  router.get(base, authorize('manual.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('manual.read'), asyncHandler(controller.getById));
  router.post(`${base}/:id/retry`, authorize('manual.reprocess'), asyncHandler(controller.retry));

  return router;
}
