/**
 * Authentication tests.
 *
 * The emphasis is on the security properties rather than the happy path: what
 * the API refuses to do matters more than what it allows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import {
  PREFIX,
  TEST_PASSWORD,
  auth,
  createUser,
  resetDb,
  setupTestApp,
  teardownTestApp,
} from './helpers/app.js';
import { collections } from '../src/database/collections.js';

let app: Express;
let db: Db;

beforeAll(async () => {
  ({ app, db } = await setupTestApp());
});

afterAll(async () => {
  await teardownTestApp();
});

beforeEach(async () => {
  await resetDb();
});

describe('POST /auth/register', () => {
  it('creates the first account as an admin so a fresh install is usable', async () => {
    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'first_admin',
      email: 'first@example.test',
      password: TEST_PASSWORD,
      fullName: 'First Admin',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('admin');
  });

  it('forces every subsequent self-registration to viewer, ignoring a requested role', async () => {
    await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'owner',
      email: 'owner@example.test',
      password: TEST_PASSWORD,
      fullName: 'Owner',
    });

    // The privilege-escalation attempt: ask for admin as an anonymous caller.
    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'sneaky',
      email: 'sneaky@example.test',
      password: TEST_PASSWORD,
      fullName: 'Sneaky',
      role: 'admin',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('viewer');
  });

  it('lets an authenticated admin choose the role', async () => {
    const admin = await createUser(app, db, 'admin');

    const res = await request(app)
      .post(`${PREFIX}/auth/register`)
      .set(...auth(admin))
      .send({
        username: 'new_manager',
        email: 'new_manager@example.test',
        password: TEST_PASSWORD,
        fullName: 'New Manager',
        role: 'manager',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('manager');
    expect(res.body.data.user.mustChangePassword).toBe(true);
  });

  it('never returns the password hash', async () => {
    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'hashcheck',
      email: 'hashcheck@example.test',
      password: TEST_PASSWORD,
      fullName: 'Hash Check',
    });

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$argon2');
    expect(serialised).not.toContain(TEST_PASSWORD);
  });

  it('stores an Argon2id hash, never the plaintext', async () => {
    await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'stored',
      email: 'stored@example.test',
      password: TEST_PASSWORD,
      fullName: 'Stored',
    });

    const user = await collections.users(db).findOne({ username: 'stored' });
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);
    expect(user?.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('rejects a weak password with field-level detail', async () => {
    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'weak',
      email: 'weak@example.test',
      password: 'password',
      fullName: 'Weak',
    });

    // 422 is this API's code for a well-formed request that fails validation.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate email without revealing which field collided', async () => {
    const payload = {
      username: 'dupe_one',
      email: 'dupe@example.test',
      password: TEST_PASSWORD,
      fullName: 'Dupe',
    };
    await request(app).post(`${PREFIX}/auth/register`).send(payload);

    const res = await request(app)
      .post(`${PREFIX}/auth/register`)
      .send({ ...payload, username: 'dupe_two' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // Generic on purpose - naming the field would confirm the account exists.
    expect(res.body.error.message).toMatch(/email or username/i);
  });

  it('treats emails case-insensitively', async () => {
    await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'case_one',
      email: 'Case@Example.test',
      password: TEST_PASSWORD,
      fullName: 'Case One',
    });

    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'case_two',
      email: 'case@example.test',
      password: TEST_PASSWORD,
      fullName: 'Case Two',
    });

    expect(res.status).toBe(409);
  });

  it('rejects unknown fields rather than silently ignoring them', async () => {
    const res = await request(app).post(`${PREFIX}/auth/register`).send({
      username: 'massassign',
      email: 'massassign@example.test',
      password: TEST_PASSWORD,
      fullName: 'Mass Assign',
      tokenVersion: 99,
      isActive: true,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/login', () => {
  it('returns an access token, a refresh token and the user', async () => {
    const user = await createUser(app, db, 'technician');

    const res = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.body.data.tokenType).toBe('Bearer');
    expect(res.body.data.user.role).toBe('technician');
  });

  it('returns an identical error for an unknown email and a wrong password', async () => {
    const user = await createUser(app, db, 'viewer');

    const unknown = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: 'nobody@example.test', password: TEST_PASSWORD });

    const wrong = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: user.email, password: 'Wr0ng-Password!99' });

    // No email enumeration: same status, same code, same message.
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('never echoes the submitted password', async () => {
    const res = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: 'nobody@example.test', password: 'SuperSecret-123!' });

    expect(JSON.stringify(res.body)).not.toContain('SuperSecret-123!');
  });

  it('refuses a deactivated account', async () => {
    const user = await createUser(app, db, 'technician');
    await collections
      .users(db)
      .updateOne({ email: user.email }, { $set: { is_active: false } });

    const res = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/deactivated/i);
  });

  it('locks the account after repeated failures', async () => {
    const user = await createUser(app, db, 'viewer', 'locktarget');

    // Default AUTH_MAX_FAILED_LOGINS is 10.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: user.email, password: 'Definitely-Wrong-1!' });
    }

    // Even the CORRECT password is now refused, and with a distinct code.
    const res = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('writes an audit entry for a successful sign-in', async () => {
    const user = await createUser(app, db, 'manager');

    const entry = await collections
      .auditLogs(db)
      .findOne({ action: 'auth.login.success', entity_id: { $ne: null } });

    expect(entry).toBeTruthy();
    expect(entry?.actor_username).toBe(user.username);
  });

  it('writes an audit entry for a failed sign-in', async () => {
    await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: 'ghost@example.test', password: TEST_PASSWORD });

    const entry = await collections.auditLogs(db).findOne({ action: 'auth.login.failure' });
    expect(entry).toBeTruthy();
    expect(entry?.outcome).toBe('failure');
  });
});

describe('GET /auth/me', () => {
  it('returns the caller and never their hash', async () => {
    const user = await createUser(app, db, 'technician');

    const res = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set(...auth(user));

    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe(user.username);
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });

  it('rejects a missing token', async () => {
    const res = await request(app).get(`${PREFIX}/auth/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed token', async () => {
    const res = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
    // No parser internals leak out.
    expect(JSON.stringify(res.body)).not.toMatch(/jwt|malformed/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const jwt = await import('jsonwebtoken');
    const forged = jwt.default.sign({ sub: '000000000000000000000000', role: 'admin', tv: 0 }, 'wrong-secret');

    const res = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('rejects a token whose user was deactivated after issuance', async () => {
    const user = await createUser(app, db, 'technician');
    await collections
      .users(db)
      .updateOne({ email: user.email }, { $set: { is_active: false } });

    // Re-checked on every request, so the still-valid JWT stops working.
    const res = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set(...auth(user));

    expect(res.status).toBe(403);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const user = await createUser(app, db, 'viewer');

    const res = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: user.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    // Rotation: the new token must differ from the one presented.
    expect(res.body.data.refreshToken).not.toBe(user.refreshToken);
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const user = await createUser(app, db, 'viewer');

    const first = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: user.refreshToken });
    expect(first.status).toBe(200);

    // Replay of the now-rotated token: treated as theft.
    const replay = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);

    // The legitimate successor is revoked too.
    const successor = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: first.body.data.refreshToken });
    expect(successor.status).toBe(401);
  });

  it('stores refresh tokens hashed, never in plaintext', async () => {
    const user = await createUser(app, db, 'viewer');
    const stored = await collections.users(db).findOne({ email: user.email });

    expect(stored?.refresh_tokens.length).toBeGreaterThan(0);
    for (const entry of stored?.refresh_tokens ?? []) {
      expect(entry.token_hash).not.toBe(user.refreshToken);
      expect(entry.token_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: 'a'.repeat(43) });

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('invalidates the presented refresh token', async () => {
    const user = await createUser(app, db, 'technician');

    const out = await request(app)
      .post(`${PREFIX}/auth/logout`)
      .set(...auth(user))
      .send({ refreshToken: user.refreshToken });
    expect(out.status).toBe(200);

    const reuse = await request(app)
      .post(`${PREFIX}/auth/refresh`)
      .send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
  });

  it('invalidates outstanding access tokens when logging out everywhere', async () => {
    const user = await createUser(app, db, 'technician');

    await request(app)
      .post(`${PREFIX}/auth/logout`)
      .set(...auth(user))
      .send({ allDevices: true });

    // token_version was bumped, so the old access token is now stale.
    const res = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set(...auth(user));

    expect(res.status).toBe(401);
  });

  it('requires authentication', async () => {
    const res = await request(app).post(`${PREFIX}/auth/logout`).send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password and invalidates existing sessions', async () => {
    const user = await createUser(app, db, 'technician');
    const newPassword = 'An0ther-Strong-Pass!77';

    const res = await request(app)
      .post(`${PREFIX}/auth/change-password`)
      .set(...auth(user))
      .send({ currentPassword: TEST_PASSWORD, newPassword });

    expect(res.status).toBe(200);

    // Old access token is dead.
    const stale = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set(...auth(user));
    expect(stale.status).toBe(401);

    // The new password works.
    const login = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: user.email, password: newPassword });
    expect(login.status).toBe(200);
  });

  it('refuses when the current password is wrong', async () => {
    const user = await createUser(app, db, 'technician');

    const res = await request(app)
      .post(`${PREFIX}/auth/change-password`)
      .set(...auth(user))
      .send({ currentPassword: 'Not-The-Password!1', newPassword: 'Brand-New-Pass!88' });

    expect(res.status).toBe(401);
  });

  it('refuses a weak new password', async () => {
    const user = await createUser(app, db, 'technician');

    const res = await request(app)
      .post(`${PREFIX}/auth/change-password`)
      .set(...auth(user))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'admin123' });

    expect(res.status).toBe(422);
  });
});

describe('PATCH /users/me', () => {
  it('updates the display name', async () => {
    const user = await createUser(app, db, 'viewer');

    const res = await request(app)
      .patch(`${PREFIX}/users/me`)
      .set(...auth(user))
      .send({ fullName: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.fullName).toBe('Updated Name');
  });

  it('refuses a self-service role change', async () => {
    const user = await createUser(app, db, 'technician');

    const res = await request(app)
      .patch(`${PREFIX}/users/me`)
      .set(...auth(user))
      .send({ role: 'admin' });

    // Rejected by .strict() before any handler logic runs.
    expect(res.status).toBe(422);

    const after = await request(app)
      .get(`${PREFIX}/auth/me`)
      .set(...auth(user));
    expect(after.body.data.user.role).toBe('technician');
  });

  it('refuses a self-service activation change', async () => {
    const user = await createUser(app, db, 'viewer');

    const res = await request(app)
      .patch(`${PREFIX}/users/me`)
      .set(...auth(user))
      .send({ isActive: false });

    expect(res.status).toBe(422);
  });
});
