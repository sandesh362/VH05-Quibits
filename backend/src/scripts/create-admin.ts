/**
 * Explicit administrator setup command.
 *
 *   npm run create-admin --workspace @itp/backend
 *
 * Reads BOOTSTRAP_ADMIN_EMAIL / _USERNAME / _PASSWORD from the environment and
 * creates an admin ONLY if the users collection is empty. It is the deliberate
 * alternative to shipping default credentials: nothing exists until an operator
 * supplies real values.
 *
 * The password is never echoed, never logged, and never written to a file.
 */
import { getConfig, ConfigValidationError } from '../config/env.js';
import { getLogger } from '../core/logger.js';
import { connectMongo, disconnectMongo, getDb } from '../db/mongo.js';
import { ensureIndexes } from '../database/indexes.js';
import { ensureBootstrapAdmin } from '../database/bootstrap.js';

async function main(): Promise<void> {
  const log = getLogger();

  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Config errors already carry actionable messages; no stack needed.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  if (!config.bootstrapAdmin) {
    console.error(
      [
        'No bootstrap administrator is configured.',
        '',
        'Set all three variables in your .env file, then run this command again:',
        '  BOOTSTRAP_ADMIN_EMAIL=you@example.com',
        '  BOOTSTRAP_ADMIN_USERNAME=your-username',
        '  BOOTSTRAP_ADMIN_PASSWORD=<a strong password of at least 12 characters>',
        '',
        'The password is read from the environment only. It is never stored in source',
        'or printed by this command.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // Fail loudly here rather than degrading: this command exists to do one job.
  await connectMongo();
  const db = getDb();
  if (!db) throw new Error('MongoDB connection was not established.');

  // Indexes first, so the unique constraints exist before the insert.
  await ensureIndexes(db);

  const result = await ensureBootstrapAdmin(db);

  if (result.created) {
    console.log(
      [
        '',
        'Administrator account created.',
        `  username: ${config.bootstrapAdmin.username}`,
        `  email:    ${config.bootstrapAdmin.email}`,
        '',
        'Sign in and change this password immediately - the account is flagged',
        'must_change_password. Then remove BOOTSTRAP_ADMIN_PASSWORD from your .env.',
        '',
      ].join('\n'),
    );
  } else if (result.reason === 'users_already_exist') {
    console.log(
      [
        '',
        'No account was created: the users collection already contains at least one user.',
        'This command only runs on an empty database, so it can never be used to add a',
        'second administrator or to reset an existing one.',
        '',
        'To promote an existing user, sign in as an administrator and change their role',
        'through the API.',
        '',
      ].join('\n'),
    );
  } else {
    console.error(`No account was created (reason: ${result.reason ?? 'unknown'}).`);
    await disconnectMongo();
    process.exit(1);
  }

  await disconnectMongo();
  log.debug('create-admin finished');
}

void main().catch(async (error) => {
  console.error(
    'create-admin failed:',
    error instanceof Error ? error.message : String(error),
  );
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
