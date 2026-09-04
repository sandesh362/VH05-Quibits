import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize, authorizeAny } from '../../middleware/authenticate.js';
import { ragRateLimiter } from '../../middleware/rate-limit.js';
import * as controller from './conversations.controller.js';

export function conversationRoutes(): Router {
  const router = Router();
  const base = '/conversations';
  const limiter = ragRateLimiter();

  router.use(base, authenticate());

  router.get(
    base,
    authorizeAny('conversation.read_own', 'conversation.read_any'),
    asyncHandler(controller.list),
  );
  router.get(
    `${base}/:id`,
    authorizeAny('conversation.read_own', 'conversation.read_any'),
    asyncHandler(controller.getById),
  );
  router.post(base, authorize('conversation.create'), asyncHandler(controller.create));
  router.patch(
    `${base}/:id`,
    authorize('conversation.update_own'),
    asyncHandler(controller.update),
  );
  router.delete(
    `${base}/:id`,
    authorize('conversation.update_own'),
    asyncHandler(controller.remove),
  );

  router.get(
    `${base}/:id/messages`,
    authorizeAny('conversation.read_own', 'conversation.read_any'),
    asyncHandler(controller.listMessages),
  );
  router.post(
    `${base}/:id/messages`,
    authorize('conversation.create'),
    limiter,
    asyncHandler(controller.postMessage),
  );

  router.post(
    `${base}/:id/close`,
    authorize('conversation.update_own'),
    asyncHandler(controller.close),
  );
  router.post(
    `${base}/:id/reopen`,
    authorize('conversation.update_own'),
    asyncHandler(controller.reopen),
  );
  router.post(
    `${base}/:id/archive`,
    authorize('conversation.update_own'),
    asyncHandler(controller.archive),
  );
  router.patch(
    `${base}/:id/issue-status`,
    authorize('conversation.update_own'),
    asyncHandler(controller.patchIssueStatus),
  );

  router.get(
    `${base}/:id/actions`,
    authorizeAny('conversation.read_own', 'conversation.read_any'),
    asyncHandler(controller.listActions),
  );
  router.post(
    `${base}/:id/actions`,
    authorize('conversation.create'),
    asyncHandler(controller.createAction),
  );
  router.patch(
    `${base}/:id/messages/:messageId/suggestions/:suggestionId`,
    authorize('conversation.update_own'),
    asyncHandler(controller.patchSuggestion),
  );

  /**
   * Create an incident from this conversation. Only explicit factual
   * information is copied; AI suggestions are never imported as facts.
   */
  router.post(
    `${base}/:id/create-incident`,
    authorize('incident.create'),
    asyncHandler(controller.createIncident),
  );

  return router;
}
