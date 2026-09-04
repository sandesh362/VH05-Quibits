/**
 * Incident routes, including the nested action log.
 *
 * Actions are nested under `/incidents/:id/actions` because an action has no
 * meaning outside its incident - there is no reason to address one globally.
 */
import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize, authorizeAny } from '../../middleware/authenticate.js';
import * as controller from './incidents.controller.js';
import * as actionsController from '../incident-actions/incident-actions.controller.js';

export function incidentRoutes(): Router {
  const router = Router();
  const base = '/incidents';

  router.use(base, authenticate());

  router.get(base, authorize('incident.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('incident.read'), asyncHandler(controller.getById));
  router.post(base, authorize('incident.create'), asyncHandler(controller.create));

  /**
   * Update accepts either capability; the service then decides ownership.
   * A technician holds only `incident.update_own`, so the middleware lets them
   * through and the service enforces "you reported it, and it is still open".
   */
  router.patch(
    `${base}/:id`,
    authorizeAny('incident.update_any', 'incident.update_own'),
    asyncHandler(controller.update),
  );

  router.post(
    `${base}/:id/confirm-resolution`,
    authorize('incident.confirm_resolution'),
    asyncHandler(controller.confirmResolution),
  );

  router.post(
    `${base}/:id/reopen`,
    authorize('incident.reopen'),
    asyncHandler(controller.reopen),
  );

  router.get(
    `${base}/:id/actions`,
    authorize('incident_action.read'),
    asyncHandler(actionsController.list),
  );
  router.post(
    `${base}/:id/actions`,
    authorize('incident_action.create'),
    asyncHandler(actionsController.create),
  );
  router.patch(
    `${base}/:id/actions/:actionId`,
    authorize('incident_action.create'),
    asyncHandler(actionsController.update),
  );

  return router;
}
