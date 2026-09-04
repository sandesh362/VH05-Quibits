/**
 * Auth HTTP layer.
 *
 * Controllers stay thin: parse, delegate, serialise. No business rules and no
 * database access live here.
 */
import type { Request, Response } from 'express';
import { successEnvelope } from '../../core/api-error.js';
import { assertNoOperators, parseOrThrow, toObjectId } from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { collections, USER_PUBLIC_PROJECTION } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import * as authService from './auth.service.js';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  updateMeSchema,
} from './auth.validators.js';

export async function register(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(registerSchema, req.body);
  const db = requireDb();

  // An authenticated admin may set a role; anyone else gets the default.
  const user = await authService.register(db, input, {
    actorRole: req.auth?.role,
    actorId: req.auth ? toObjectId(req.auth.userId) : null,
    actorUsername: req.auth?.username ?? null,
    requestId: req.requestId,
  });

  res.status(201).json(successEnvelope({ user }, req.requestId));
}

export async function login(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(loginSchema, req.body);
  const db = requireDb();

  const result = await authService.login(db, input, req.requestId);

  res.status(200).json(successEnvelope(result, req.requestId));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const { refreshToken } = parseOrThrow(refreshSchema, req.body);
  const db = requireDb();

  const result = await authService.refresh(db, refreshToken, req.requestId);

  res.status(200).json(successEnvelope(result, req.requestId));
}

export async function logout(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(logoutSchema, req.body ?? {});
  const auth = requireAuth(req);
  const db = requireDb();

  await authService.logout(
    db,
    toObjectId(auth.userId),
    { refreshToken: input.refreshToken, allDevices: input.allDevices },
    req.requestId,
  );

  res.status(200).json(successEnvelope({ loggedOut: true }, req.requestId));
}

export async function me(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const db = requireDb();

  const user = await collections
    .users(db)
    .findOne({ _id: toObjectId(auth.userId) }, { projection: USER_PUBLIC_PROJECTION });

  if (!user) throw ApiError.notFound('User not found.');

  res.status(200).json(
    successEnvelope({ user: authService.toPublicUser(user) }, req.requestId),
  );
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(updateMeSchema, req.body);
  const auth = requireAuth(req);
  const db = requireDb();

  // Only these two fields are settable. Role, is_active, token_version and
  // password_hash are structurally unreachable from this endpoint.
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (input.fullName !== undefined) update.full_name = input.fullName;
  if (input.preferences !== undefined) update.preferences = input.preferences;

  const result = await collections
    .users(db)
    .findOneAndUpdate(
      { _id: toObjectId(auth.userId), is_deleted: false },
      { $set: update },
      { returnDocument: 'after', projection: USER_PUBLIC_PROJECTION },
    );

  if (!result) throw ApiError.notFound('User not found.');

  res.status(200).json(
    successEnvelope({ user: authService.toPublicUser(result) }, req.requestId),
  );
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(changePasswordSchema, req.body);
  const auth = requireAuth(req);
  const db = requireDb();

  await authService.changePassword(
    db,
    toObjectId(auth.userId),
    input.currentPassword,
    input.newPassword,
    req.requestId,
  );

  // Every session is now invalid, including this one. Say so explicitly.
  res.status(200).json(
    successEnvelope(
      { passwordChanged: true, message: 'Password updated. Please sign in again.' },
      req.requestId,
    ),
  );
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const users = await authService.listUsers(requireDb());
  res.status(200).json(successEnvelope({ users }, req.requestId));
}
