/**
 * Authentication and authorization middleware.
 *
 * `authenticate` proves who the caller is; `authorize` decides what they may
 * do. They are separate so a route can never accidentally authorise an
 * anonymous caller: `authorize` throws if `req.auth` is missing.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Capability, UserRole } from '@itp/shared';
import { ApiError } from '../core/api-error.js';
import { verifyAccessToken } from '../common/tokens.js';
import { roleHasCapability } from '../common/policy.js';
import { getDb } from '../db/mongo.js';
import { collections } from '../database/collections.js';
import { toObjectId } from '../common/validation.js';

/** The safe identity attached to a request. Never the raw user document. */
export interface AuthContext {
  userId: string;
  username: string;
  role: UserRole;
  tokenVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  return token.trim() || null;
}

/**
 * Require a valid access token.
 *
 * The token alone is not enough: we re-read the user on every request to check
 * `is_active`, soft deletion, and `token_version`. That costs one indexed
 * lookup and is what makes deactivation and forced logout take effect
 * immediately rather than whenever the token happens to expire.
 */
export function authenticate(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = extractBearer(req);
      if (!token) {
        throw new ApiError('UNAUTHENTICATED', 'Authentication is required to access this resource.');
      }

      const payload = verifyAccessToken(token);

      const db = getDb();
      if (!db) {
        throw ApiError.dependencyUnavailable('mongodb');
      }

      const user = await collections
        .users(db)
        .findOne(
          { _id: toObjectId(payload.sub) },
          { projection: { username: 1, role: 1, is_active: 1, is_deleted: 1, token_version: 1 } },
        );

      if (!user || user.is_deleted) {
        throw new ApiError('UNAUTHENTICATED', 'Invalid authentication token.');
      }
      if (!user.is_active) {
        throw new ApiError('FORBIDDEN', 'This account has been deactivated.');
      }
      // Password change, role change, or logout-everywhere bumps the version.
      if (user.token_version !== payload.tv) {
        throw new ApiError('UNAUTHENTICATED', 'Your session is no longer valid. Please sign in again.');
      }

      req.auth = {
        userId: user._id.toHexString(),
        username: user.username,
        role: user.role,
        tokenVersion: user.token_version,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Attach identity when a token is present, but allow anonymous access.
 * Used by endpoints whose response varies by role without requiring login.
 */
export function optionalAuthenticate(): RequestHandler {
  const strict = authenticate();
  return (req, res, next) => {
    if (!extractBearer(req)) return next();
    strict(req, res, (error?: unknown) => next(error instanceof ApiError ? undefined : error));
  };
}

/**
 * Require a capability. Deny by default.
 *
 * The 403 message deliberately names the capability: this is an internal tool,
 * and "you need machine.create" saves far more support time than it leaks.
 */
export function authorize(capability: Capability): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(
        new ApiError('UNAUTHENTICATED', 'Authentication is required to access this resource.'),
      );
    }

    if (!roleHasCapability(req.auth.role, capability)) {
      return next(
        new ApiError(
          'FORBIDDEN',
          `Your role (${req.auth.role}) does not permit this action (${capability}).`,
          { internalContext: { capability, role: req.auth.role } },
        ),
      );
    }

    next();
  };
}

/** Require any one of several capabilities (e.g. update_own OR update_any). */
export function authorizeAny(...capabilities: Capability[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(
        new ApiError('UNAUTHENTICATED', 'Authentication is required to access this resource.'),
      );
    }

    const role = req.auth.role;
    if (!capabilities.some((capability) => roleHasCapability(role, capability))) {
      return next(
        new ApiError('FORBIDDEN', `Your role (${role}) does not permit this action.`, {
          internalContext: { capabilities, role },
        }),
      );
    }

    next();
  };
}

/** Narrow `req.auth` for handlers that run behind `authenticate()`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new ApiError('UNAUTHENTICATED', 'Authentication is required to access this resource.');
  }
  return req.auth;
}
