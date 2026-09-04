/**
 * Rate limiting for credential endpoints.
 *
 * Scope is deliberately narrow: login, register, and refresh. These are the
 * endpoints where an attacker gets unlimited free guesses, and they are cheap
 * to protect. General API rate limiting is NOT applied in Phase 2 - with 1-5
 * local users it would only produce false positives during a demo.
 *
 * The store is in-memory, which is correct for a single-node deployment. If
 * the API is ever scaled horizontally this must move to a shared store, and
 * that is recorded as a known limitation.
 */
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { getConfig } from '../config/env.js';
import { failureEnvelope, ApiError } from '../core/api-error.js';

function limitHandler(req: Request, res: Response): void {
  const config = getConfig();
  const error = new ApiError(
    'RATE_LIMITED',
    'Too many attempts. Please wait a few minutes and try again.',
  );

  // Same envelope as every other error, so clients need no special case.
  res.status(error.statusCode).json(
    failureEnvelope(error, req.requestId ?? 'unknown', !config.isProduction),
  );
}

/** Applied to retrieval / RAG endpoints. */
export function ragRateLimiter(): RateLimitRequestHandler {
  const config = getConfig();

  return rateLimit({
    windowMs: config.rag.rateLimitWindowMinutes * 60_000,
    limit: config.rag.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limitHandler,
    skip: () => getConfig().isTest,
  });
}

/** Applied to login/register/refresh. */
export function authRateLimiter(): RateLimitRequestHandler {
  const config = getConfig();

  return rateLimit({
    windowMs: config.auth.rateLimitWindowMinutes * 60_000,
    limit: config.auth.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limitHandler,
    // Tests would otherwise inherit limits from earlier test files and fail
    // in confusing, order-dependent ways.
    skip: () => getConfig().isTest,
  });
}
