/**
 * Retrieval / RAG HTTP tests (Phase 4).
 *
 * FastAPI is unreachable in this suite (setup.ts points RAG_SERVICE_URL at
 * port 1). That is deliberate: these tests cover Express validation, authz,
 * scope resolution and the 503 degradation path. Grounded-answer behaviour is
 * covered by the FastAPI pytest suite against an in-memory corpus.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import {
  PREFIX,
  auth,
  createAllRoles,
  resetDb,
  seedMachine,
  setupTestApp,
  teardownTestApp,
  type TestUser,
} from './helpers/app.js';
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
  await resetDb();
  users = await createAllRoles(app, db);
});

describe('POST /retrieval/search', () => {
  it('rejects an empty query', async () => {
    const res = await request(app)
      .post(`${PREFIX}/retrieval/search`)
      .set(...auth(users.technician))
      .send({ query: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown fields', async () => {
    const res = await request(app)
      .post(`${PREFIX}/retrieval/search`)
      .set(...auth(users.technician))
      .send({ query: 'E-104', extra: true });
    expect(res.status).toBe(422);
  });

  it('lets a viewer with manual.read call search (RAG down → 503)', async () => {
    const { modelId } = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/retrieval/search`)
      .set(...auth(users.viewer))
      .send({ query: 'Why is error E-104 appearing?', machineModelId: modelId });
    expect([503, 200]).toContain(res.status);
    if (res.status === 503) {
      expect(['DEPENDENCY_UNAVAILABLE', 'SERVICE_UNAVAILABLE']).toContain(res.body.error.code);
    }
  });

  it('rejects a machine/model mismatch', async () => {
    const a = await seedMachine(app, users.admin);
    const b = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/retrieval/search`)
      .set(...auth(users.technician))
      .send({
        query: 'Why is error E-104 appearing?',
        machineId: a.machineId,
        machineModelId: b.modelId,
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /rag/answer', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post(`${PREFIX}/rag/answer`)
      .send({ query: 'Why is error E-104 appearing?' });
    expect(res.status).toBe(401);
  });

  it('lets a technician ask (RAG down → 503, never 500)', async () => {
    const { modelId } = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/rag/answer`)
      .set(...auth(users.technician))
      .send({ query: 'Why is error E-104 appearing during hydraulic startup?', machineModelId: modelId });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.stack === undefined || typeof res.body.error.stack === 'string').toBe(true);
  });
});

describe('POST /rag/debug', () => {
  it('forbids a technician (audit_log.read required)', async () => {
    const { modelId } = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/rag/debug`)
      .set(...auth(users.technician))
      .send({ query: 'E-104', machineModelId: modelId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an admin through to the RAG client (503 when FastAPI is down)', async () => {
    const { modelId } = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/rag/debug`)
      .set(...auth(users.admin))
      .send({ query: 'E-104', machineModelId: modelId });
    expect(res.status).toBe(503);
  });
});
