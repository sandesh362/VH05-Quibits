/**
 * Shared harness for HTTP-level tests: a real app, a real database, and
 * helpers to create users of each role and obtain their tokens.
 *
 * Users are created directly through the service layer rather than through
 * POST /auth/register, because self-registration always yields `viewer` by
 * design. Tests that need a manager must therefore seed one - which is itself
 * evidence the privilege-escalation guard works.
 */
import type { Express } from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';
import { createApp } from '../../src/app.js';
import { setDbForTests } from '../../src/db/mongo.js';
import { collections } from '../../src/database/collections.js';
import { ensureDefaultOrganization } from '../../src/database/bootstrap.js';
import { hashPassword } from '../../src/common/password.js';
import { startTestDb, clearTestDb, stopTestDb, getTestDb } from './db.js';
import type { UserRole } from '@itp/shared';

export const PREFIX = '/api/v1';

/** A password that satisfies the strength policy, used across the suite. */
export const TEST_PASSWORD = 'Str0ng-Test-Pass!42';

export interface TestUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  accessToken: string;
  refreshToken: string;
}

export async function setupTestApp(): Promise<{ app: Express; db: Db }> {
  const db = await startTestDb();
  // Make the application's own getDb() resolve to the in-memory instance.
  setDbForTests(db);
  await ensureDefaultOrganization(db);
  return { app: createApp(), db };
}

export async function teardownTestApp(): Promise<void> {
  setDbForTests(null);
  await stopTestDb();
}

export async function resetDb(): Promise<void> {
  await clearTestDb();
  // Phase 6: every actor resolves to an organization. Production seeds the
  // default org in prepareDatabase; restore it here after the wipe so
  // resolveActorOrg has something to resolve to.
  await ensureDefaultOrganization(getTestDb());
}

/**
 * Seed a user with an exact role and log them in through the real endpoint,
 * so the returned tokens come from the same code path production uses.
 */
export async function createUser(
  app: Express,
  db: Db,
  role: UserRole,
  suffix: string = role,
): Promise<TestUser> {
  const email = `${suffix}@example.test`;
  const username = `${suffix}_user`;
  const now = new Date();

  const result = await collections.users(db).insertOne({
    username,
    email,
    password_hash: await hashPassword(TEST_PASSWORD),
    full_name: `${role} tester`,
    role,
    is_active: true,
    must_change_password: false,
    token_version: 0,
    refresh_tokens: [],
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const login = await request(app)
    .post(`${PREFIX}/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  if (login.status !== 200) {
    throw new Error(
      `Failed to log in seeded ${role}: ${login.status} ${JSON.stringify(login.body)}`,
    );
  }

  return {
    id: result.insertedId.toHexString(),
    username,
    email,
    role,
    accessToken: login.body.data.accessToken,
    refreshToken: login.body.data.refreshToken,
  };
}

/** Convenience: one user per role, all logged in. */
export async function createAllRoles(
  app: Express,
  db: Db,
): Promise<Record<UserRole, TestUser>> {
  return {
    admin: await createUser(app, db, 'admin'),
    manager: await createUser(app, db, 'manager'),
    technician: await createUser(app, db, 'technician'),
    viewer: await createUser(app, db, 'viewer'),
  };
}

/** Authorization header helper. */
export function auth(user: TestUser): [string, string] {
  return ['Authorization', `Bearer ${user.accessToken}`];
}

/** Seed a machine model and a machine, the common fixture for domain tests. */
export async function seedMachine(
  app: Express,
  actor: TestUser,
): Promise<{ modelId: string; machineId: string }> {
  const model = await request(app)
    .post(`${PREFIX}/machine-models`)
    .set(...auth(actor))
    .send({ manufacturer: 'Haas', modelName: `VF-${Date.now()}`, machineType: 'cnc_mill' });

  if (model.status !== 201) {
    throw new Error(`Failed to seed model: ${JSON.stringify(model.body)}`);
  }

  const machine = await request(app)
    .post(`${PREFIX}/machines`)
    .set(...auth(actor))
    .send({
      assetTag: `CNC-${Date.now()}`,
      machineModelId: model.body.data.machineModel.id,
    });

  if (machine.status !== 201) {
    throw new Error(`Failed to seed machine: ${JSON.stringify(machine.body)}`);
  }

  return {
    modelId: model.body.data.machineModel.id,
    machineId: machine.body.data.machine.id,
  };
}
