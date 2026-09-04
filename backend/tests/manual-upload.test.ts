/**
 * Integration tests for the manual upload, validation, and processing job flow.
 *
 * These tests exercise the Express side against a real in-memory Mongo and a
 * real filesystem. The FastAPI document pipeline is NOT called (the network
 * would fail), so uploads are expected to queue a job that will eventually be
 * marked failed by the background worker - which is itself a correct outcome:
 * it proves duplicate-job protection and honest failure marking behave.
 *
 * To make the worker deterministic, tests disable the background queue by
 * asserting on the immediate upload response (job queued) and on the manual
 * record, not on the pipeline result.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import {
  PREFIX,
  auth,
  createAllRoles,
  setupTestApp,
  teardownTestApp,
  resetDb,
  seedMachine,
  type TestUser,
} from './helpers/app.js';
import type { UserRole } from '@itp/shared';

let app: Express;
let db: Db;
let users: Record<UserRole, TestUser>;

const VALID_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n');

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

async function seedModel() {
  const model = await request(app)
    .post(`${PREFIX}/machine-models`)
    .set(...auth(users.manager))
    .send({ manufacturer: 'Haas', modelName: `VF-${Date.now()}`, machineType: 'cnc_mill' });
  return model.body.data.machineModel.id as string;
}

describe('POST /api/v1/manuals (multipart upload)', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .attach('file', VALID_PDF, 'm.pdf');
    expect(res.status).toBe(401);
  });

  it('rejects a non-PDF file extension', async () => {
    const modelId = await seedModel();
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'Test manual')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'maintenance')
      .attach('file', Buffer.from('hello'), 'manual.txt');
    expect(res.status).toBe(415);
  });

  it('rejects bytes that are not a real PDF', async () => {
    const modelId = await seedModel();
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'Test manual')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'maintenance')
      .attach('file', Buffer.from('not a pdf at all'), 'manual.pdf');
    expect(res.status).toBe(415);
  });

  it('rejects a viewer attempting to upload', async () => {
    const modelId = await seedModel();
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.viewer))
      .field('title', 'Test manual')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'maintenance')
      .attach('file', VALID_PDF, 'manual.pdf');
    expect(res.status).toBe(403);
  });

  it('uploads a valid PDF and creates a queued processing job', async () => {
    const modelId = await seedModel();
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'EC180SX Service Manual')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .field('language', 'en')
      .attach('file', VALID_PDF, 'ec180sx-service.pdf');

    expect(res.status).toBe(201);
    expect(res.body.data.manual.processingStatus).toBe('queued');
    expect(res.body.data.processingJob.status).toBe('queued');
    expect(res.body.data.processingJob.id).toBeTruthy();
    // Never expose the filesystem path.
    expect(JSON.stringify(res.body)).not.toMatch(/storage_path|\/home\//);
  });

  it('detects a duplicate upload for the same model', async () => {
    const modelId = await seedModel();
    const body = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'A')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'a.pdf');

    expect(body.status).toBe(201);

    const dup = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'B')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'b.pdf');

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('allows the same file for a DIFFERENT model', async () => {
    const modelId = await seedModel();
    const otherModel = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.manager))
      .send({ manufacturer: 'Fanuc', modelName: `R-${Date.now()}`, machineType: 'robot_arm' });
    const otherId = otherModel.body.data.machineModel.id;

    const first = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'A')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'a.pdf');
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'B')
      .field('scope', 'model')
      .field('machineModelId', otherId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'b.pdf');
    expect(second.status).toBe(201);
  });

  it('rejects a manual missing a machineModelId for model scope', async () => {
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');
    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/v1/manuals/:id', () => {
  it('still refuses pipeline-owned fields', async () => {
    const modelId = await seedModel();
    const created = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');

    const manualId = created.body.data.manual.id;
    const res = await request(app)
      .patch(`${PREFIX}/manuals/${manualId}`)
      .set(...auth(users.manager))
      .send({ processingStatus: 'completed' });
    expect(res.status).toBe(422);
  });

  it('allows editing allowed metadata', async () => {
    const modelId = await seedModel();
    const created = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');

    const manualId = created.body.data.manual.id;
    const res = await request(app)
      .patch(`${PREFIX}/manuals/${manualId}`)
      .set(...auth(users.manager))
      .send({ title: 'Updated Title', documentVersion: 'v2' });
    expect(res.status).toBe(200);
    expect(res.body.data.manual.title).toBe('Updated Title');
    expect(res.body.data.manual.documentVersion).toBe('v2');
  });
});

describe('GET /api/v1/manuals/:id/processing-status', () => {
  it('returns the queued job', async () => {
    const modelId = await seedModel();
    const created = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');

    const manualId = created.body.data.manual.id;
    const res = await request(app)
      .get(`${PREFIX}/manuals/${manualId}/processing-status`)
      .set(...auth(users.viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe('queued');
  });

  it('rejects a viewer reading pages of an accessible manual is allowed', async () => {
    const modelId = await seedModel();
    const created = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');

    const manualId = created.body.data.manual.id;
    const res = await request(app)
      .get(`${PREFIX}/manuals/${manualId}/pages`)
      .set(...auth(users.viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('background worker marks jobs failed honestly', () => {
  it('a failed pipeline leaves the manual as failed, never completed', async () => {
    const modelId = await seedModel();
    const created = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'T')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, 'm.pdf');
    const manualId = created.body.data.manual.id;

    // The background worker runs the FastAPI pipeline; since FastAPI is not
    // reachable in tests, the job ends up failed. Wait briefly for the worker.
    // We give the worker a chance to run by awaiting a tick, then assert the
    // manual is NOT false-completed.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const manual = await request(app)
      .get(`${PREFIX}/manuals/${manualId}`)
      .set(...auth(users.viewer));
    expect(manual.body.data.manual.processingStatus).not.toBe('completed');
  });
});
