import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import * as controller from './manuals.controller.js';

export function manualRoutes(): Router {
  const router = Router();
  const base = '/manuals';

  router.use(base, authenticate());

  router.get(base, authorize('manual.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('manual.read'), asyncHandler(controller.getById));
  router.post(base, authorize('manual.create'), asyncHandler(controller.create));
  router.patch(`${base}/:id`, authorize('manual.update'), asyncHandler(controller.update));
  router.delete(`${base}/:id`, authorize('manual.delete'), asyncHandler(controller.remove));

  return router;
}
