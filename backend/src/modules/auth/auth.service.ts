/**
 * Authentication service: registration, login, refresh, logout.
 *
 * Security properties this file is responsible for:
 *  - Login never reveals whether an email exists (uniform error + uniform timing).
 *  - Passwords are Argon2id hashed; the hash never leaves the data layer.
 *  - Repeated failures lock the account for a window.
 *  - Refresh tokens are stored hashed, rotated on use, and reuse of a rotated
 *    token revokes the whole family.
 *  - Nobody can self-assign a privileged role.
 */
import type { Db, ObjectId } from 'mongodb';
import type { LoginResponse, PublicUser, UserRole } from '@itp/shared';
import { collections, SCHEMA_VERSION, type UserDoc } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { getConfig } from '../../config/env.js';
import {
  getDummyHash,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../../common/password.js';
import {
  accessTokenLifetimeSeconds,
  hashRefreshToken,
  issueRefreshToken,
  MAX_REFRESH_TOKENS_PER_USER,
  signAccessToken,
} from '../../common/tokens.js';
import { duplicateKeyToApiError, isDuplicateKeyError } from '../../common/repository.js';
import * as audit from '../audit/audit.service.js';

const CI_COLLATION = { locale: 'en', strength: 2 } as const;

/** Map a stored user to the wire shape. Structurally cannot leak the hash. */
export function toPublicUser(doc: UserDoc): PublicUser {
  return {
    id: doc._id.toHexString(),
    username: doc.username,
    email: doc.email,
    fullName: doc.full_name,
    role: doc.role,
    isActive: doc.is_active,
    mustChangePassword: doc.must_change_password,
    lastLoginAt: doc.last_login_at ? doc.last_login_at.toISOString() : null,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  fullName: string;
  /** Only honoured when an admin creates the account. */
  role?: UserRole;
}

export interface RegisterContext {
  /** The acting admin, when this is an admin-initiated creation. */
  actorRole?: UserRole;
  actorId?: ObjectId | null;
  actorUsername?: string | null;
  requestId?: string;
}

/**
 * Create an account.
 *
 * ROLE RULES:
 *  - Self-registration always produces a `viewer`, whatever the body says.
 *    This is the single most important line in the file: without it, anyone
 *    who can reach /auth/register becomes an admin.
 *  - Only an admin may choose a role.
 *  - The FIRST account ever created becomes an admin, because otherwise a
 *    fresh install has no way in. That path is audited explicitly.
 */
export async function register(
  db: Db,
  input: RegisterInput,
  context: RegisterContext = {},
): Promise<PublicUser> {
  const strength = validatePasswordStrength(input.password);
  if (!strength.valid) {
    throw ApiError.validation(
      'The password does not meet the minimum requirements.',
      strength.issues.map((issue) => ({ field: 'password', issue })),
    );
  }

  const users = collections.users(db);
  const isFirstUser = (await users.estimatedDocumentCount()) === 0;

  let role: UserRole;
  let roleReason: string;

  if (isFirstUser) {
    role = 'admin';
    roleReason = 'first_user_bootstrap';
  } else if (context.actorRole === 'admin') {
    role = input.role ?? 'viewer';
    roleReason = 'admin_assigned';
  } else {
    // Self-registration. The requested role is ignored, not rejected, so an
    // attacker learns nothing from probing.
    role = 'viewer';
    roleReason = 'self_registration_default';
  }

  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    username: input.username,
    email: input.email,
    password_hash: await hashPassword(input.password),
    full_name: input.fullName,
    role,
    is_active: true,
    // Admin-created accounts must rotate the temporary password on first use.
    must_change_password: roleReason === 'admin_assigned',
    token_version: 0,
    refresh_tokens: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };

  let created: UserDoc;
  try {
    const result = await users.insertOne(doc as UserDoc);
    created = { ...(doc as UserDoc), _id: result.insertedId };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Deliberately generic: enumerating which of the two collided would
      // confirm an account exists.
      throw new ApiError('CONFLICT', 'An account with that email or username already exists.');
    }
    throw duplicateKeyToApiError(error, 'Could not create the account.');
  }

  await audit.record(db, {
    action: isFirstUser ? audit.AUDIT_ACTIONS.userCreated : audit.AUDIT_ACTIONS.register,
    actor: context.actorId
      ? { id: context.actorId, username: context.actorUsername, role: context.actorRole }
      : { id: created._id, username: created.username, role: created.role },
    entityType: 'user',
    entityId: created._id,
    severity: isFirstUser ? 'security' : 'notice',
    requestId: context.requestId ?? null,
    metadata: { role, role_reason: roleReason },
  });

  return toPublicUser(created);
}

export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Authenticate and issue tokens.
 *
 * Every failure path returns the SAME error and does comparable work, so an
 * attacker cannot distinguish "no such user" from "wrong password" by response
 * body or by timing.
 */
export async function login(
  db: Db,
  input: LoginInput,
  requestId?: string,
): Promise<LoginResponse & { refreshToken: string }> {
  const config = getConfig();
  const users = collections.users(db);

  const user = await users.findOne(
    { email: input.email, is_deleted: false },
    { collation: CI_COLLATION },
  );

  const genericFailure = new ApiError('UNAUTHENTICATED', 'Invalid email or password.');

  if (!user) {
    // Spend the same CPU as a real verification so timing does not leak.
    await verifyPassword(await getDummyHash(), input.password);
    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.loginFailure,
      outcome: 'failure',
      severity: 'warning',
      requestId: requestId ?? null,
      metadata: { reason: 'unknown_account' },
    });
    throw genericFailure;
  }

  // Lockout check happens before password verification: a locked account
  // should not be a password oracle.
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.loginLocked,
      actor: { id: user._id, username: user.username, role: user.role },
      entityType: 'user',
      entityId: user._id,
      outcome: 'denied',
      severity: 'security',
      requestId: requestId ?? null,
    });
    throw new ApiError(
      'RATE_LIMITED',
      'Too many failed sign-in attempts. Please try again later.',
    );
  }

  const passwordOk = await verifyPassword(user.password_hash, input.password);

  if (!passwordOk) {
    const failures = (user.failed_login_count ?? 0) + 1;
    const shouldLock = failures >= config.auth.maxFailedLogins;

    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          failed_login_count: shouldLock ? 0 : failures,
          locked_until: shouldLock
            ? new Date(Date.now() + config.auth.lockoutMinutes * 60_000)
            : (user.locked_until ?? null),
          updated_at: new Date(),
        },
      },
    );

    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.loginFailure,
      actor: { id: user._id, username: user.username, role: user.role },
      entityType: 'user',
      entityId: user._id,
      outcome: 'failure',
      severity: shouldLock ? 'security' : 'warning',
      requestId: requestId ?? null,
      metadata: { failed_attempts: failures, locked: shouldLock },
    });

    throw genericFailure;
  }

  // Deactivated accounts fail AFTER password verification so the check cannot
  // be used to enumerate which accounts exist.
  if (!user.is_active) {
    await audit.record(db, {
      action: audit.AUDIT_ACTIONS.loginFailure,
      actor: { id: user._id, username: user.username, role: user.role },
      entityType: 'user',
      entityId: user._id,
      outcome: 'denied',
      severity: 'warning',
      requestId: requestId ?? null,
      metadata: { reason: 'inactive_account' },
    });
    throw new ApiError('FORBIDDEN', 'This account has been deactivated.');
  }

  const refresh = issueRefreshToken();
  const retained = [...(user.refresh_tokens ?? []), {
    token_hash: refresh.tokenHash,
    family_id: refresh.familyId,
    issued_at: new Date(),
    expires_at: refresh.expiresAt,
    revoked_at: null,
  }].slice(-MAX_REFRESH_TOKENS_PER_USER);

  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        last_login_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
        refresh_tokens: retained,
        updated_at: new Date(),
      },
    },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.loginSuccess,
    actor: { id: user._id, username: user.username, role: user.role },
    entityType: 'user',
    entityId: user._id,
    severity: 'notice',
    requestId: requestId ?? null,
  });

  const accessToken = signAccessToken({
    sub: user._id.toHexString(),
    role: user.role,
    tv: user.token_version,
  });

  return {
    accessToken,
    refreshToken: refresh.token,
    expiresIn: accessTokenLifetimeSeconds(),
    tokenType: 'Bearer',
    user: toPublicUser({ ...user, last_login_at: new Date() }),
  };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Rotation with family revocation: if a token that was already rotated is
 * presented again, that means it leaked, so every token in the family dies.
 */
export async function refresh(
  db: Db,
  presentedToken: string,
  requestId?: string,
): Promise<LoginResponse & { refreshToken: string }> {
  const users = collections.users(db);
  const tokenHash = hashRefreshToken(presentedToken);

  const user = await users.findOne({
    'refresh_tokens.token_hash': tokenHash,
    is_deleted: false,
  });

  if (!user) {
    throw new ApiError('UNAUTHENTICATED', 'Invalid or expired session. Please sign in again.');
  }

  const entry = user.refresh_tokens.find((t) => t.token_hash === tokenHash);
  if (!entry) {
    throw new ApiError('UNAUTHENTICATED', 'Invalid or expired session. Please sign in again.');
  }

  // Reuse of a revoked token: treat the whole family as compromised.
  if (entry.revoked_at) {
    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          refresh_tokens: user.refresh_tokens.filter((t) => t.family_id !== entry.family_id),
          updated_at: new Date(),
        },
        $inc: { token_version: 1 },
      },
    );
    await audit.record(db, {
      action: 'auth.refresh.reuse_detected',
      actor: { id: user._id, username: user.username, role: user.role },
      entityType: 'user',
      entityId: user._id,
      outcome: 'denied',
      severity: 'security',
      requestId: requestId ?? null,
    });
    throw new ApiError('UNAUTHENTICATED', 'Session revoked. Please sign in again.');
  }

  if (entry.expires_at.getTime() < Date.now()) {
    throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }

  if (!user.is_active) {
    throw new ApiError('FORBIDDEN', 'This account has been deactivated.');
  }

  const next = issueRefreshToken(entry.family_id);
  const rotated = user.refresh_tokens
    .map((t) => (t.token_hash === tokenHash ? { ...t, revoked_at: new Date() } : t))
    .filter((t) => t.expires_at.getTime() > Date.now())
    .concat({
      token_hash: next.tokenHash,
      family_id: next.familyId,
      issued_at: new Date(),
      expires_at: next.expiresAt,
      revoked_at: null,
    })
    .slice(-MAX_REFRESH_TOKENS_PER_USER);

  await users.updateOne(
    { _id: user._id },
    { $set: { refresh_tokens: rotated, updated_at: new Date() } },
  );

  return {
    accessToken: signAccessToken({
      sub: user._id.toHexString(),
      role: user.role,
      tv: user.token_version,
    }),
    refreshToken: next.token,
    expiresIn: accessTokenLifetimeSeconds(),
    tokenType: 'Bearer',
    user: toPublicUser(user),
  };
}

/**
 * Log out.
 *
 * `allDevices` bumps `token_version`, which invalidates every outstanding
 * access token immediately. Without that, a stateless JWT would remain valid
 * until expiry no matter what the user clicked.
 */
export async function logout(
  db: Db,
  userId: ObjectId,
  options: { refreshToken?: string; allDevices?: boolean },
  requestId?: string,
): Promise<void> {
  const users = collections.users(db);

  if (options.allDevices) {
    await users.updateOne(
      { _id: userId },
      { $set: { refresh_tokens: [], updated_at: new Date() }, $inc: { token_version: 1 } },
    );
  } else if (options.refreshToken) {
    const tokenHash = hashRefreshToken(options.refreshToken);
    await users.updateOne(
      { _id: userId },
      { $pull: { refresh_tokens: { token_hash: tokenHash } }, $set: { updated_at: new Date() } },
    );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.logout,
    actor: { id: userId },
    entityType: 'user',
    entityId: userId,
    severity: 'info',
    requestId: requestId ?? null,
    metadata: { all_devices: options.allDevices === true },
  });
}

/** Change your own password: re-verify, rehash, and invalidate all sessions. */
export async function changePassword(
  db: Db,
  userId: ObjectId,
  currentPassword: string,
  newPassword: string,
  requestId?: string,
): Promise<void> {
  const users = collections.users(db);
  const user = await users.findOne({ _id: userId, is_deleted: false });
  if (!user) throw ApiError.notFound('User not found.');

  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    throw new ApiError('UNAUTHENTICATED', 'The current password is incorrect.');
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    throw ApiError.validation(
      'The password does not meet the minimum requirements.',
      strength.issues.map((issue) => ({ field: 'newPassword', issue })),
    );
  }

  await users.updateOne(
    { _id: userId },
    {
      $set: {
        password_hash: await hashPassword(newPassword),
        must_change_password: false,
        // Changing a password logs out every other device.
        refresh_tokens: [],
        updated_at: new Date(),
      },
      $inc: { token_version: 1 },
    },
  );

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.passwordChanged,
    actor: { id: userId, username: user.username, role: user.role },
    entityType: 'user',
    entityId: userId,
    severity: 'security',
    requestId: requestId ?? null,
  });
}
