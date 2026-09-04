import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize, authorizeAny } from '../../middleware/authenticate.js';
import * as controller from './conversations.controller.js';

export function conversationRoutes(): Router {
  const router = Router();
  const base = '/conversations';

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

  /**
   * Registered so the route returns an honest 501 rather than a 404 that
   * implies the endpoint was never planned. See the controller for why no
   * message is stored.
   */
  router.post(
    `${base}/:id/messages`,
    authorize('conversation.create'),
    asyncHandler(controller.postMessage),
  );

  return router;
}
