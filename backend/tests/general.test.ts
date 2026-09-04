/**
 * Cross-cutting concerns: response envelopes, validation, pagination limits,
 * NoSQL-operator injection, audit logging, and database-failure behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import {
  PREFIX,
  TEST_PASSWORD,
  auth,
  createAllRoles,
  resetDb,
  setupTestApp,
  teardownTestApp,
  type TestUser,
} from './helpers/app.js';
import { collections } from '../src/database/collections.js';
import { setDbForTests } from '../src/db/mongo.js';
import { getTestDb } from './helpers/db.js';
import type { UserRole } from '@itp/shared';

let app: Express;
let db: Db;
let users: Record<UserRole, TestUser>;

beforeAll(async () => {
  ({ app, db } = await setupTestApp());
});

afterAll(async () => {
  await teardownTestApp();
});

beforeEach(async () => {
  // Always restore the handle: one test below deliberately removes it.
  setDbForTests(getTestDb());
  await resetDb();
  users = await createAllRoles(app, db);
});

describe('response envelopes', () => {
  it('wraps success in the documented shape with a request id', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models`)
      .set(...auth(users.viewer));

    expect(res.body.success).toBe(true);
    expect(res.body.meta.requestId).toBeTruthy();
    expect(res.body.meta.timestamp).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('wraps failures in the documented shape with a matching request id', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models/not-a-valid-id`)
      .set(...auth(users.viewer));

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBeTruthy();
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a caller-supplied request id for correlation', async () => {
    const supplied = 'test-request-id-12345';
    const res = await request(app)
      .get(`${PREFIX}/system/info`)
      .set('X-Request-Id', supplied);

    expect(res.body.meta.requestId).toBe(supplied);
  });

  it('returns a structured 404 for an unknown route', async () => {
    const res = await request(app).get(`${PREFIX}/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('never leaks a stack trace or internal path in an error', async () => {
    const res = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'X' });

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/\/home\/|node_modules|\.ts:\d+/);
    expect(res.body.error.stack).toBeUndefined();
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    // 25 models, so the default limit of 20 leaves a second page.
    for (let i = 0; i < 25; i += 1) {
      await request(app)
        .post(`${PREFIX}/machine-models`)
        .set(...auth(users.admin))
        .send({
          manufacturer: 'Bulk',
          modelName: `Model-${String(i).padStart(3, '0')}`,
          machineType: 'other',
        });
    }
  });

  it('applies the default page size and reports accurate totals', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models`)
      .set(...auth(users.viewer));

    expect(res.body.data).toHaveLength(20);
    expect(res.body.meta.pagination).toMatchObject({
      page: 1,
      limit: 20,
      total: 25,
      totalPages: 2,
    });
  });

  it('returns the remainder on the second page', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models?page=2`)
      .set(...auth(users.viewer));

    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta.pagination.page).toBe(2);
  });

  it('rejects a page size above the maximum instead of honouring it', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models?limit=5000`)
      .set(...auth(users.viewer));

    // Refused outright, so no caller can request an unbounded scan.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a zero or negative page', async () => {
    for (const page of ['0', '-3']) {
      const res = await request(app)
        .get(`${PREFIX}/machine-models?page=${page}`)
        .set(...auth(users.viewer));
      expect(res.status).toBe(422);
    }
  });

  it('rejects a non-numeric page', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models?page=abc`)
      .set(...auth(users.viewer));
    expect(res.status).toBe(422);
  });

  it('ignores a sort field that is not on the allowlist', async () => {
    // Falls back to the default sort rather than sorting by an unindexed field.
    const res = await request(app)
      .get(`${PREFIX}/machine-models?sortBy=password_hash`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
  });

  it('honours an allowlisted sort field', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models?sortBy=model_name&sortOrder=asc`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data[0].modelName).toBe('Model-000');
  });

  it('rejects an unknown query parameter', async () => {
    const res = await request(app)
      .get(`${PREFIX}/machine-models?bogusFilter=1`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(422);
  });
});

describe('NoSQL operator injection', () => {
  it('refuses a Mongo operator in a login body', async () => {
    const res = await request(app)
      .post(`${PREFIX}/auth/login`)
      .send({ email: { $ne: null }, password: { $ne: null } });

    // Blocked before any query is built.
    expect([422, 400]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  it('refuses an operator nested inside a create body', async () => {
    const res = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({
        manufacturer: 'Haas',
        modelName: 'VF-2',
        machineType: 'cnc_mill',
        specifications: { $where: 'sleep(5000)' },
      });

    expect(res.status).toBe(422);
  });

  it('refuses a prototype-pollution attempt', async () => {
    /**
     * Sent as a raw JSON string on purpose. Writing `__proto__` in a JavaScript
     * object literal sets the prototype instead of creating an own property, so
     * the key would never reach the wire and the test would pass vacuously.
     */
    const res = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .set('Content-Type', 'application/json')
      .send(
        '{"manufacturer":"Haas","modelName":"VF-3","machineType":"cnc_mill","__proto__":{"isAdmin":true}}',
      );

    expect(res.status).toBe(422);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it('treats a regex-like search term as a literal string', async () => {
    await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'Literal', modelName: 'A.B', machineType: 'other' });

    // '.' must not act as a wildcard, so 'AXB' must not match 'A.B'.
    const wildcard = await request(app)
      .get(`${PREFIX}/machine-models?search=AXB`)
      .set(...auth(users.viewer));
    expect(wildcard.body.data).toHaveLength(0);

    const literal = await request(app)
      .get(`${PREFIX}/machine-models?search=A.B`)
      .set(...auth(users.viewer));
    expect(literal.body.data).toHaveLength(1);
  });
});

describe('request body limits', () => {
  it('rejects an oversized payload', async () => {
    const res = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({
        manufacturer: 'Haas',
        modelName: 'VF-2',
        machineType: 'cnc_mill',
        notes: 'x'.repeat(2_000_000),
      });

    // Either the body-parser limit (413) or field validation (422) stops it.
    expect([413, 422]).toContain(res.status);
  });

  it('rejects an over-long array', async () => {
    const res = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({
        manufacturer: 'Haas',
        modelName: 'VF-9',
        machineType: 'cnc_mill',
        aliases: Array.from({ length: 500 }, (_, i) => `alias-${i}`),
      });

    expect(res.status).toBe(422);
  });
});

describe('audit logging', () => {
  it('records an entry for a sensitive create', async () => {
    await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'Audited', modelName: 'AM-1', machineType: 'pump' });

    const entry = await collections
      .auditLogs(db)
      .findOne({ action: 'machine_model.created' });

    expect(entry).toBeTruthy();
    // The actor is snapshotted so the trail survives a later rename.
    expect(entry?.actor_username).toBe(users.admin.username);
    expect(entry?.actor_role).toBe('admin');
    expect(entry?.entity_type).toBe('machine_model');
  });

  it('records the reason supplied with a delete', async () => {
    const created = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'Audited', modelName: 'AM-2', machineType: 'pump' });

    await request(app)
      .delete(`${PREFIX}/machine-models/${created.body.data.machineModel.id}`)
      .set(...auth(users.admin))
      .send({ reason: 'entered in error during data migration' });

    const entry = await collections
      .auditLogs(db)
      .findOne({ action: 'machine_model.deleted' });

    expect(entry?.reason).toBe('entered in error during data migration');
  });

  it('records field-level changes on an update', async () => {
    const created = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'Audited', modelName: 'AM-3', machineType: 'pump' });

    await request(app)
      .patch(`${PREFIX}/machine-models/${created.body.data.machineModel.id}`)
      .set(...auth(users.manager))
      .send({ notes: 'Now serviced quarterly' });

    const entry = await collections
      .auditLogs(db)
      .findOne({ action: 'machine_model.updated' });

    expect(entry?.changes).toBeTruthy();
    expect(entry?.changes?.notes?.to).toBe('Now serviced quarterly');
  });

  it('never stores a password or token in an audit entry', async () => {
    await request(app).post(`${PREFIX}/auth/login`).send({
      email: users.admin.email,
      password: TEST_PASSWORD,
    });

    const entries = await collections.auditLogs(db).find({}).toArray();
    const serialised = JSON.stringify(entries);

    expect(serialised).not.toContain(TEST_PASSWORD);
    expect(serialised).not.toContain(users.admin.accessToken);
    expect(serialised).not.toMatch(/\$argon2/);
  });

  it('exposes no endpoint for altering the audit trail', async () => {
    const entry = await collections.auditLogs(db).findOne({});
    const id = entry?._id.toHexString() ?? '507f1f77bcf86cd799439011';

    for (const method of ['patch', 'delete'] as const) {
      const res = await (request(app) as never as Record<string, Function>)[method](
        `${PREFIX}/audit-logs/${id}`,
      ).set(...auth(users.admin));
      expect(res.status).toBe(404);
    }
  });
});

describe('database unavailability', () => {
  it('returns a clean 503 rather than crashing when Mongo is gone', async () => {
    const user = users.viewer;

    // Simulate a lost connection the way the app would observe it.
    setDbForTests(null);

    const res = await request(app)
      .get(`${PREFIX}/machine-models`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    // The failure is reported without naming hosts or credentials.
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb:\/\/|27017/);
  });

  it('keeps liveness up while the database is down', async () => {
    setDbForTests(null);

    const res = await request(app).get(`${PREFIX}/health`);
    expect(res.status).toBe(200);
  });
});
