import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize, authorizeAny } from '../../middleware/authenticate.js';
import * as controller from './maintenance.controller.js';

export function maintenanceRoutes(): Router {
  const router = Router();
  const base = '/maintenance';

  router.use(base, authenticate());

  router.get(base, authorize('maintenance.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('maintenance.read'), asyncHandler(controller.getById));
  router.post(base, authorize('maintenance.create'), asyncHandler(controller.create));

  // Ownership and the 24-hour window are resolved in the service.
  router.patch(
    `${base}/:id`,
    authorizeAny('maintenance.update_any', 'maintenance.update_own'),
    asyncHandler(controller.update),
  );

  return router;
}
