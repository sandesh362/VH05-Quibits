/**
 * Incident routes.
 *
 * Every route behind the incident base requires authentication. Read routes
 * need `incident.read`; mutating routes declare capabilities and the service
 * layer resolves ownership/assignment rules (technicians manage their own
 * incidents, managers/admins any incident in the organization).
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

  // --- CRUD -----------------------------------------------------------------
  router.get(base, authorize('incident.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('incident.read'), asyncHandler(controller.getById));
  router.post(base, authorize('incident.create'), asyncHandler(controller.create));
  router.patch(
    `${base}/:id`,
    authorizeAny('incident.update_any', 'incident.update_own'),
    asyncHandler(controller.update),
  );
  router.delete(
    `${base}/:id`,
    authorizeAny('incident.delete', 'incident.update_any', 'incident.update_own'),
    asyncHandler(controller.remove),
  );

  // --- Lifecycle --------------------------------------------------------------
  router.patch(
    `${base}/:id/status`,
    authorizeAny('incident.update_any', 'incident.update_own'),
    asyncHandler(controller.changeStatus),
  );
  router.patch(
    `${base}/:id/issue-status`,
    authorizeAny('incident.update_any', 'incident.update_own'),
    asyncHandler(controller.changeIssueStatus),
  );
  router.post(
    `${base}/:id/close`,
    authorize('incident.close'),
    asyncHandler(controller.close),
  );
  router.post(
    `${base}/:id/reopen`,
    authorizeAny('incident.reopen', 'incident.update_any', 'incident.update_own'),
    asyncHandler(controller.reopen),
  );

  // --- Root cause --------------------------------------------------------------
  router.patch(
    `${base}/:id/root-cause`,
    authorize('incident.root_cause_update'),
    asyncHandler(controller.updateRootCause),
  );
  router.post(
    `${base}/:id/root-cause/confirm`,
    authorize('incident.root_cause_confirm'),
    asyncHandler(controller.confirmRootCause),
  );
  router.post(
    `${base}/:id/root-cause/reject`,
    authorize('incident.root_cause_reject'),
    asyncHandler(controller.rejectRootCause),
  );
  router.get(
    `${base}/:id/root-cause/history`,
    authorize('incident.read'),
    asyncHandler(controller.rootCauseHistory),
  );

  // --- Temporary / permanent fixes ---------------------------------------------
  router.post(
    `${base}/:id/temporary-fix`,
    authorize('incident.fix_record'),
    asyncHandler(controller.recordTemporaryFix),
  );
  router.post(
    `${base}/:id/temporary-fix/confirm`,
    authorize('incident.fix_confirm'),
    asyncHandler(controller.confirmTemporaryFix),
  );
  router.post(
    `${base}/:id/permanent-fix`,
    authorize('incident.fix_record'),
    asyncHandler(controller.recordPermanentFix),
  );
  router.post(
    `${base}/:id/permanent-fix/confirm`,
    authorize('incident.fix_confirm'),
    asyncHandler(controller.confirmPermanentFix),
  );
  router.get(
    `${base}/:id/fixes/history`,
    authorize('incident.read'),
    asyncHandler(controller.fixHistory),
  );

  // --- Timeline ----------------------------------------------------------------
  router.get(
    `${base}/:id/timeline`,
    authorize('incident.read'),
    asyncHandler(controller.timeline),
  );

  // --- Similar incidents ----------------------------------------------------------
  router.get(
    `${base}/:id/similar`,
    authorize('incident.read'),
    asyncHandler(controller.similar),
  );

  // --- Reindex --------------------------------------------------------------------
  router.post(
    `${base}/:id/reindex`,
    authorizeAny('incident.reindex', 'incident.update_any'),
    asyncHandler(controller.reindex),
  );

  // --- Actions ---------------------------------------------------------------------
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
    authorizeAny('incident_action.update', 'incident_action.create'),
    asyncHandler(actionsController.update),
  );
  router.post(
    `${base}/:id/actions/:actionId/confirm`,
    authorizeAny('incident_action.confirm', 'incident_action.create'),
    asyncHandler(actionsController.confirm),
  );
  router.get(
    `${base}/:id/actions/:actionId/history`,
    authorize('incident_action.read'),
    asyncHandler(actionsController.history),
  );

  return router;
}
