/**
 * JWT access tokens and opaque refresh tokens.
 *
 * Design:
 *  - ACCESS token: short-lived JWT, stateless, verified on every request.
 *    Carries only `sub`, `role`, and `tv` (token version) - no email, no name,
 *    nothing that becomes stale or leaks if the token is captured.
 *  - REFRESH token: an opaque 256-bit random string. Only its SHA-256 hash is
 *    stored, so a database dump does not yield usable tokens. Rotated on every
 *    use; reuse of a rotated token revokes the whole family (theft detection).
 *
 * `token_version` on the user document is the revocation lever: bumping it
 * invalidates every live access token for that user without a blocklist.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { UserRole } from '@itp/shared';
import { getConfig } from '../config/env.js';
import { ApiError } from '../core/api-error.js';

export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  role: UserRole;
  /** Token version; must match the user document or the token is stale. */
  tv: number;
}

interface DecodedAccessToken extends AccessTokenPayload {
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const config = getConfig();
  const options: SignOptions = {
    expiresIn: config.jwt.expiration as SignOptions['expiresIn'],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    algorithm: 'HS256',
  };
  return jwt.sign(payload, config.jwt.secret, options);
}

/**
 * Verify signature, expiry, issuer, and audience.
 *
 * Algorithm is pinned to HS256: without it, a forged `alg: none` (or an
 * RS256/HS256 confusion) token would be accepted.
 */
export function verifyAccessToken(token: string): DecodedAccessToken {
  const config = getConfig();
  try {
    return jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }) as DecodedAccessToken;
  } catch (error) {
    const message =
      error instanceof jwt.TokenExpiredError
        ? 'Your session has expired. Please sign in again.'
        : 'Invalid authentication token.';
    throw new ApiError('UNAUTHENTICATED', message);
  }
}

/** Seconds until an access token expires, for the client to schedule refresh. */
export function accessTokenLifetimeSeconds(): number {
  const spec = getConfig().jwt.expiration;
  const match = /^(\d+)\s*([smhd])?$/.exec(spec.trim());
  if (!match) return 900;

  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd': return amount * 86_400;
    case 'h': return amount * 3_600;
    case 'm': return amount * 60;
    case 's':
    case undefined: return amount;
    default: return 900;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface IssuedRefreshToken {
  /** Sent to the client exactly once; never stored in this form. */
  token: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

/** 256 bits of CSPRNG output. Opaque - it carries no claims. */
export function issueRefreshToken(familyId?: string): IssuedRefreshToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashRefreshToken(token),
    familyId: familyId ?? randomUUID(),
    expiresAt: new Date(Date.now() + refreshLifetimeMs()),
  };
}

/**
 * SHA-256 (not Argon2) is correct here: the input is already 256 bits of
 * uniform randomness, so there is nothing to brute-force, and refresh happens
 * often enough that a slow hash would hurt.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refreshLifetimeMs(): number {
  const spec = getConfig().jwt.refreshExpiration;
  const match = /^(\d+)\s*([smhd])?$/.exec(spec.trim());
  if (!match) return 7 * 86_400_000;

  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd': return amount * 86_400_000;
    case 'h': return amount * 3_600_000;
    case 'm': return amount * 60_000;
    case 's': return amount * 1_000;
    default: return 7 * 86_400_000;
  }
}

/** Cap on stored refresh tokens per user; oldest is evicted. */
export const MAX_REFRESH_TOKENS_PER_USER = 5;
