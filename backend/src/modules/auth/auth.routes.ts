/**
 * Auth routes.
 *
 * `/auth/register` uses `optionalAuthenticate` rather than being fully public
 * or fully protected: an anonymous caller may self-register (always as a
 * viewer), and an authenticated admin may create an account with a chosen role.
 * One endpoint, two behaviours, decided in the service.
 */
import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize, optionalAuthenticate } from '../../middleware/authenticate.js';
import { authRateLimiter } from '../../middleware/rate-limit.js';
import * as controller from './auth.controller.js';

export function authRoutes(): Router {
  const router = Router();
  const limiter = authRateLimiter();

  router.post('/auth/register', limiter, optionalAuthenticate(), asyncHandler(controller.register));
  router.post('/auth/login', limiter, asyncHandler(controller.login));
  router.post('/auth/refresh', limiter, asyncHandler(controller.refresh));

  router.post('/auth/logout', authenticate(), asyncHandler(controller.logout));
  router.get('/auth/me', authenticate(), asyncHandler(controller.me));
  router.post('/auth/change-password', authenticate(), asyncHandler(controller.changePassword));

  return router;
}

/** `/users/me` mirrors `/auth/me`; both are in the Phase 2 API surface. */
export function userRoutes(): Router {
  const router = Router();

  router.get('/users/me', authenticate(), asyncHandler(controller.me));
  router.patch('/users/me', authenticate(), asyncHandler(controller.updateMe));
  router.get('/users', authenticate(), authorize('user.read_all'), asyncHandler(controller.listUsers));

  return router;
}
