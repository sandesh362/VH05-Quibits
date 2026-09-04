/**
 * First-run database preparation: indexes, then an optional bootstrap admin.
 *
 * The bootstrap admin exists because a fresh install with RBAC has a
 * chicken-and-egg problem: creating an admin requires being an admin. The
 * rules that keep it from becoming a backdoor:
 *
 *  - Credentials come from environment variables only. There are no default
 *    credentials anywhere in this source tree, and none are ever logged.
 *  - It runs ONLY when the users collection is empty. Once a real admin
 *    exists, setting the env vars again does nothing.
 *  - The password must satisfy the same strength policy as any other account,
 *    and config validation rejects obvious placeholders before boot.
 *  - The account is flagged `must_change_password`.
 */
import type { Db } from 'mongodb';
import { getConfig } from '../config/env.js';
import { getLogger } from '../core/logger.js';
import { collections, SCHEMA_VERSION, type UserDoc } from './collections.js';
import { hashPassword, validatePasswordStrength } from '../common/password.js';
import { ensureIndexes } from './indexes.js';
import * as audit from '../modules/audit/audit.service.js';

export interface BootstrapResult {
  indexesEnsured: number;
  adminCreated: boolean;
  adminSkippedReason?: string;
}

/**
 * Create the bootstrap admin if configured and if no users exist.
 * Returns what happened so startup can log it accurately.
 */
export async function ensureBootstrapAdmin(
  db: Db,
): Promise<{ created: boolean; reason?: string }> {
  const config = getConfig();
  const log = getLogger();

  if (!config.bootstrapAdmin) {
    return { created: false, reason: 'not_configured' };
  }

  const users = collections.users(db);
  const existing = await users.estimatedDocumentCount();
  if (existing > 0) {
    // Not an error: the normal state after the first boot.
    log.debug('Bootstrap admin skipped - the users collection is not empty');
    return { created: false, reason: 'users_already_exist' };
  }

  const { email, username, password } = config.bootstrapAdmin;

  // Defence in depth: config validation already checked this.
  const strength = validatePasswordStrength(password);
  if (!strength.valid) {
    log.error(
      { issues: strength.issues },
      'BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy - no admin was created',
    );
    return { created: false, reason: 'weak_password' };
  }

  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    username,
    email,
    password_hash: await hashPassword(password),
    full_name: 'Bootstrap Administrator',
    role: 'admin',
    is_active: true,
    // Forces rotation away from whatever was put in the .env file.
    must_change_password: true,
    token_version: 0,
    refresh_tokens: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as Omit<UserDoc, '_id'>;

  try {
    const result = await users.insertOne(doc as UserDoc);

    // Logs the identity, never the password.
    log.warn(
      { username, email },
      'Bootstrap administrator created from environment configuration. Sign in and change this password immediately.',
    );

    await audit.record(db, {
      action: 'user.bootstrap_admin_created',
      actor: { id: result.insertedId, username, role: 'admin' },
      entityType: 'user',
      entityId: result.insertedId,
      severity: 'security',
      metadata: { source: 'environment_configuration' },
    });

    return { created: true };
  } catch (error) {
    // A duplicate here means a race with another starting instance - benign.
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Bootstrap admin creation failed',
    );
    return { created: false, reason: 'insert_failed' };
  }
}

/**
 * Full first-run preparation. Called once at startup after Mongo connects.
 *
 * Index creation is idempotent, so running this on every boot is safe and
 * keeps a redeployed schema in sync without a migration step.
 */
export async function prepareDatabase(db: Db): Promise<BootstrapResult> {
  const log = getLogger();

  const reports = await ensureIndexes(db);
  const created = reports.reduce((sum, report) => sum + report.created.length, 0);

  log.info(
    { collections: reports.length, indexesCreated: created },
    'Database indexes ensured',
  );

  const admin = await ensureBootstrapAdmin(db);

  return {
    indexesEnsured: reports.length,
    adminCreated: admin.created,
    adminSkippedReason: admin.reason,
  };
}
