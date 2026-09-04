/**
 * Machine model routes.
 *
 * Every route states the capability it needs. The policy map in
 * common/policy.ts decides which roles hold it - no role names appear here.
 */
import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import * as controller from './machine-models.controller.js';

export function machineModelRoutes(): Router {
  const router = Router();
  const base = '/machine-models';

  // authenticate() once for the whole module; each route adds its capability.
  router.use(base, authenticate());

  router.get(base, authorize('machine_model.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('machine_model.read'), asyncHandler(controller.getById));
  router.post(base, authorize('machine_model.create'), asyncHandler(controller.create));
  router.patch(`${base}/:id`, authorize('machine_model.update'), asyncHandler(controller.update));
  router.delete(`${base}/:id`, authorize('machine_model.delete'), asyncHandler(controller.remove));

  return router;
}
