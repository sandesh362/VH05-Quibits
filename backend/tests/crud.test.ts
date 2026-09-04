/**
 * CRUD and business-rule tests for the domain modules.
 *
 * These cover the 14 business rules from the Phase 0 data model, especially
 * the referential-integrity refusals that protect machine history.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import {
  PREFIX,
  auth,
  createAllRoles,
  createUser,
  resetDb,
  setupTestApp,
  teardownTestApp,
  type TestUser,
} from './helpers/app.js';
import type { UserRole } from '@itp/shared';
import { ObjectId } from 'mongodb';
import { collections } from '../src/database/collections.js';

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

async function createModel(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`${PREFIX}/machine-models`)
    .set(...auth(users.admin))
    .send({
      manufacturer: 'Haas',
      modelName: 'VF-2',
      machineType: 'cnc_mill',
      ...overrides,
    });
}

async function createMachine(modelId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`${PREFIX}/machines`)
    .set(...auth(users.admin))
    .send({ assetTag: 'CNC-001', machineModelId: modelId, ...overrides });
}

describe('machine models', () => {
  it('creates, reads, updates and soft-deletes', async () => {
    const created = await createModel();
    expect(created.status).toBe(201);
    const id = created.body.data.machineModel.id;

    const read = await request(app)
      .get(`${PREFIX}/machine-models/${id}`)
      .set(...auth(users.viewer));
    expect(read.status).toBe(200);
    expect(read.body.data.machineModel.manufacturer).toBe('Haas');

    const updated = await request(app)
      .patch(`${PREFIX}/machine-models/${id}`)
      .set(...auth(users.manager))
      .send({ notes: 'Primary milling cell' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.machineModel.notes).toBe('Primary milling cell');

    const deleted = await request(app)
      .delete(`${PREFIX}/machine-models/${id}`)
      .set(...auth(users.admin))
      .send({ reason: 'duplicate entry' });
    expect(deleted.status).toBe(200);

    // Rule: soft-deleted records disappear from reads and lists.
    const gone = await request(app)
      .get(`${PREFIX}/machine-models/${id}`)
      .set(...auth(users.admin));
    expect(gone.status).toBe(404);

    const list = await request(app)
      .get(`${PREFIX}/machine-models`)
      .set(...auth(users.admin));
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects a duplicate manufacturer and model pair, case-insensitively', async () => {
    await createModel();
    const duplicate = await createModel({ manufacturer: 'HAAS', modelName: 'vf-2' });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('refuses to delete a model that machines still reference', async () => {
    const model = await createModel();
    const modelId = model.body.data.machineModel.id;
    await createMachine(modelId);

    const res = await request(app)
      .delete(`${PREFIX}/machine-models/${modelId}`)
      .set(...auth(users.admin))
      .send({ reason: 'attempted cleanup' });

    expect(res.status).toBe(409);
    // The error names the dependents so the operator knows what to fix.
    expect(JSON.stringify(res.body.error.details)).toMatch(/machine/i);
  });

  it('rejects an unknown machine type', async () => {
    const res = await createModel({ machineType: 'teleporter' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('machines', () => {
  it('refuses a machine whose model does not exist', async () => {
    const res = await createMachine('507f1f77bcf86cd799439011');
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/machine model does not exist/i);
  });

  it('rejects a malformed model id as a validation error, not a 500', async () => {
    const res = await createMachine('not-an-object-id');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('normalises the asset tag to uppercase', async () => {
    const model = await createModel();
    const res = await createMachine(model.body.data.machineModel.id, { assetTag: 'cnc-lower' });

    expect(res.status).toBe(201);
    expect(res.body.data.machine.assetTag).toBe('CNC-LOWER');
  });

  it('rejects a duplicate asset tag', async () => {
    const model = await createModel();
    const modelId = model.body.data.machineModel.id;
    await createMachine(modelId);

    const duplicate = await createMachine(modelId);
    expect(duplicate.status).toBe(409);
  });

  it('refuses to change the immutable asset tag', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);

    const res = await request(app)
      .patch(`${PREFIX}/machines/${machine.body.data.machine.id}`)
      .set(...auth(users.admin))
      .send({ assetTag: 'CNC-RENAMED' });

    expect(res.status).toBe(422);
  });

  it('requires a reason when reassigning a machine to another model', async () => {
    const first = await createModel();
    const second = await createModel({ modelName: 'VF-4' });
    const machine = await createMachine(first.body.data.machineModel.id);

    const withoutReason = await request(app)
      .patch(`${PREFIX}/machines/${machine.body.data.machine.id}`)
      .set(...auth(users.admin))
      .send({ machineModelId: second.body.data.machineModel.id });
    expect(withoutReason.status).toBe(422);

    const withReason = await request(app)
      .patch(`${PREFIX}/machines/${machine.body.data.machine.id}`)
      .set(...auth(users.admin))
      .send({
        machineModelId: second.body.data.machineModel.id,
        modelChangeReason: 'the asset was re-badged after a controller retrofit',
      });
    expect(withReason.status).toBe(200);
  });

  it('refuses to delete a machine that has incident history', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const machineId = machine.body.data.machine.id;

    await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Chatter during finishing pass',
        description: 'Audible chatter and poor surface finish on the finishing pass.',
        severity: 'medium',
      });

    const res = await request(app)
      .delete(`${PREFIX}/machines/${machineId}`)
      .set(...auth(users.admin))
      .send({ reason: 'decommissioned' });

    expect(res.status).toBe(409);
    // Points the operator at the correct action instead of just refusing.
    expect(res.body.error.message).toMatch(/retired/i);
  });
});

describe('manuals', () => {
  const VALID_PDF = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n',
  );

  /**
   * Phase 3 changed POST /manuals into a multipart upload. Filename, checksum,
   * size and mime are now computed from the file by the server, so the fields
   * are no longer accepted in the body. Existing stale fields are sent to prove
   * they are simply ignored (the schema is `.strict()` but only on the body).
   */
  async function createManual(
    modelId: string,
    overrides: Record<string, unknown> = {},
    filename = 'vf2-service.pdf',
  ) {
    let req = request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .field('title', 'VF-2 Service Manual')
      .field('scope', 'model')
      .field('machineModelId', modelId)
      .field('documentType', 'service')
      .attach('file', VALID_PDF, filename);
    for (const [key, value] of Object.entries(overrides)) {
      req = req.field(key, String(value));
    }
    return req;
  }

  it('creates metadata with processing queued and not searchable', async () => {
    const model = await createModel();
    const res = await createManual(model.body.data.machineModel.id);

    expect(res.status).toBe(201);
    // Phase 3 owns the pipeline; nothing here can advance the status.
    expect(res.body.data.manual.processingStatus).toBe('queued');
    expect(res.body.data.manual.isSearchable).toBe(false);
    expect(res.body.data.manual.indexedChunkCount).toBe(0);
  });

  it('never exposes the server storage path', async () => {
    const model = await createModel();
    const res = await createManual(model.body.data.machineModel.id);

    expect(res.body.data.manual.storagePath).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/storage_path|\/home\/|manuals\/20/);
  });

  it('refuses an attempt to mark a manual as processed', async () => {
    const model = await createModel();
    const manual = await createManual(model.body.data.machineModel.id);

    const res = await request(app)
      .patch(`${PREFIX}/manuals/${manual.body.data.manual.id}`)
      .set(...auth(users.manager))
      .send({ processingStatus: 'ready' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/pipeline/i);
  });

  it('sanitises a traversal-looking upload filename to a single component', async () => {
    const model = await createModel();
    // The filename is taken from multer's own `originalname` for the uploaded
    // file, then sanitised server-side. It is never trusted or used for the
    // on-disk path (which is server-generated).
    const res = await createManual(
      model.body.data.machineModel.id,
      {},
      '../../etc/passwd',
    );

    expect(res.status).toBe(201);
    // The stored original filename is sanitised to a single component.
    expect(res.body.data.manual.originalFilename).not.toMatch(/\.\.|\//);
  });

  it('rejects a malformed body (no file)', async () => {
    const model = await createModel();
    const res = await request(app)
      .post(`${PREFIX}/manuals`)
      .set(...auth(users.manager))
      .send({
        title: 'VF-2 Service Manual',
        scope: 'model',
        machineModelId: model.body.data.machineModel.id,
        documentType: 'service',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/file/i);
  });

  it('rejects a model-scoped manual that also supplies a machine', async () => {
    const model = await createModel();
    const modelId = model.body.data.machineModel.id;
    const machine = await createMachine(modelId);

    const res = await createManual(modelId, { machineId: machine.body.data.machine.id, scope: 'model' });
    expect(res.status).toBe(422);
  });

describe('manual chunk citation preview (Phase 8)', () => {
  it('returns the exact chunk for a citation preview', async () => {
    const model = await createModel();
    const manual = await createManual(model.body.data.machineModel.id);
    const manualId = manual.body.data.manual.id;

    const chunk = await collections.manualChunks(db).insertOne({
      _id: new ObjectId(),
      manual_id: new ObjectId(manualId),
      machine_model_id: new ObjectId(model.body.data.machineModel.id),
      chunk_index: 0,
      page_start: 42,
      page_end: 43,
      section_title: 'Startup alarms',
      section_path: ['Hydraulics', 'Startup'],
      text: 'E-104 indicates low hydraulic pressure during startup.',
      normalized_text: 'e-104 indicates low hydraulic pressure during startup.',
      character_count: 54,
      word_count: 9,
      content_hash: 'chunk-hash-1',
      indexing_status: 'indexed',
      created_at: new Date(),
      updated_at: new Date(),
      schema_version: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await request(app)
      .get(`${PREFIX}/manuals/${manualId}/chunks/${chunk.insertedId.toHexString()}`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.chunk).toMatchObject({
      id: chunk.insertedId.toHexString(),
      manualId,
      pageStart: 42,
      pageEnd: 43,
      sectionTitle: 'Startup alarms',
      text: 'E-104 indicates low hydraulic pressure during startup.',
    });
  });

  it('refuses a chunk that belongs to a different manual (404)', async () => {
    const model = await createModel();
    const manualA = await createManual(model.body.data.machineModel.id, {}, 'manual-a.pdf');
    const manualB = await createManual(model.body.data.machineModel.id, {}, 'manual-b.pdf');
    const manualAId = manualA.body.data.manual.id;
    const manualBId = manualB.body.data.manual.id;

    const chunk = await collections.manualChunks(db).insertOne({
      _id: new ObjectId(),
      manual_id: new ObjectId(manualAId),
      chunk_index: 0,
      page_start: 1,
      page_end: 1,
      text: 'Content for manual A.',
      normalized_text: 'content for manual a.',
      character_count: 20,
      word_count: 4,
      content_hash: 'chunk-hash-2',
      indexing_status: 'indexed',
      created_at: new Date(),
      updated_at: new Date(),
      schema_version: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await request(app)
      .get(`${PREFIX}/manuals/${manualBId}/chunks/${chunk.insertedId.toHexString()}`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(404);
  });

  it('requires manual.read for chunk previews', async () => {
    const res = await request(app).get(
      `${PREFIX}/manuals/${new ObjectId().toHexString()}/chunks/${new ObjectId().toHexString()}`,
    );
    expect(res.status).toBe(401);
  });
});


});

describe('maintenance', () => {
  async function seed() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    return { machineId: machine.body.data.machine.id };
  }

  it('records maintenance and updates the machine last-serviced date', async () => {
    const { machineId } = await seed();
    const performedAt = new Date('2026-08-01T09:00:00.000Z').toISOString();

    const res = await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'preventive',
        title: 'Quarterly lubrication',
        performedAt,
        partsReplaced: [{ partNumber: ' abc-123 ', name: 'Grease cartridge', quantity: 2 }],
      });

    expect(res.status).toBe(201);
    // Part numbers are normalised on write so structured lookups match.
    expect(res.body.data.maintenanceRecord.partsReplaced[0].partNumber).toBe('ABC-123');

    const machine = await request(app)
      .get(`${PREFIX}/machines/${machineId}`)
      .set(...auth(users.viewer));
    expect(machine.body.data.machine.lastMaintenanceAt).toBe(performedAt);
  });

  it('refuses a future performed date', async () => {
    const { machineId } = await seed();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const res = await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'inspection',
        title: 'Future inspection',
        performedAt: future,
      });

    expect(res.status).toBe(422);
  });

  it('finds records by normalised part number', async () => {
    const { machineId } = await seed();
    await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'part_replacement',
        title: 'Spindle bearing swap',
        performedAt: new Date().toISOString(),
        partsReplaced: [{ partNumber: 'brg-7204', quantity: 1 }],
      });

    // Query in a different case: normalisation makes it match.
    const res = await request(app)
      .get(`${PREFIX}/maintenance?partNumber=BRG-7204`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('incidents - creation', () => {
  async function seedIncident(overrides: Record<string, unknown> = {}) {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load and trips the alarm.',
        severity: 'high',
        errorCodes: [' e-1042 '],
        symptoms: ['Pressure drop under load'],
        ...overrides,
      });
    return {
      incidentId: incident.body.data.incident.id,
      body: incident.body,
      machineId: machine.body.data.machine.id,
    };
  }

  it('creates an incident with a generated number, open status and normalised error codes', async () => {
    const { body } = await seedIncident();

    expect(body.data.incident.incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);
    expect(body.data.incident.errorCodes).toEqual(['E-1042']);
    expect(body.data.incident.status).toBe('open');
    expect(body.data.incident.issueStatus).toBe('unknown');
    expect(body.data.incident.severity).toBe('high');
    expect(body.data.incident.rootCause.status).toBe('unknown');
    expect(['not_indexed', 'pending']).toContain(body.data.incident.embeddingStatus);
  });

  it('allocates unique sequential incident numbers per organization', async () => {
    const { machineId } = await seedIncident();

    const numbers = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post(`${PREFIX}/incidents`)
        .set(...auth(users.technician))
        .send({
          machineId,
          title: `Fault ${i}`,
          description: 'A repeated fault used to verify sequence allocation behaviour.',
          severity: 'low',
        });
      numbers.add(res.body.data.incident.incidentNumber);
    }

    expect(numbers.size).toBe(6);
  });

  it('requires a physical machine', async () => {
    const res = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        title: 'Floating fault',
        description: 'A fault reported without a machine reference.',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a machine model that does not belong to the selected machine', async () => {
    const otherModel = await createModel({ modelName: 'VF-4' });
    const { machineId } = await seedIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        machineModelId: otherModel.body.data.machineModel.id,
        title: 'Mismatched model',
        description: 'The supplied model does not match the machine.',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/does not belong to the selected machine/i);
  });

  it('rejects lastObservedAt before firstObservedAt', async () => {
    const { machineId } = await seedIncident();
    const res = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Bad dates',
        description: 'The observation window is inverted.',
        firstObservedAt: '2026-08-02T09:00:00.000Z',
        lastObservedAt: '2026-08-01T09:00:00.000Z',
      });

    expect(res.status).toBe(422);
  });

  it('lists incidents with filters and pagination metadata', async () => {
    const { incidentId } = await seedIncident();

    const list = await request(app)
      .get(`${PREFIX}/incidents?status=open&limit=5`)
      .set(...auth(users.viewer));
    expect(list.status).toBe(200);
    expect(list.body.meta.pagination.total).toBe(1);
    expect(list.body.data[0].id).toBe(incidentId);

    const filteredOut = await request(app)
      .get(`${PREFIX}/incidents?status=closed`)
      .set(...auth(users.viewer));
    expect(filteredOut.body.data).toHaveLength(0);

    const byCode = await request(app)
      .get(`${PREFIX}/incidents?errorCode=e-1042`)
      .set(...auth(users.viewer));
    expect(byCode.body.data).toHaveLength(1);
  });
});

describe('incidents - status workflow', () => {
  async function seedIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load and trips the alarm.',
        severity: 'high',
      });
    return { incidentId: incident.body.data.incident.id };
  }

  it('allows open -> investigating and records it in the timeline', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/status`)
      .set(...auth(users.technician))
      .send({ status: 'investigating', reason: 'Started diagnosis.' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.status).toBe('investigating');

    const timeline = await request(app)
      .get(`${PREFIX}/incidents/${incidentId}/timeline`)
      .set(...auth(users.viewer));
    expect(timeline.status).toBe(200);
    const change = timeline.body.data.timeline.find((e: { type: string }) => e.type === 'status_changed');
    expect(change).toBeTruthy();
    expect(change.previous).toBe('open');
    expect(change.next).toBe('investigating');
  });

  it('refuses to reach resolved through the status endpoint', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/status`)
      .set(...auth(users.manager))
      .send({ status: 'resolved' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only reachable via those flows|workflow/i);
  });

  it('refuses cancelled through the status endpoint - cancellation has its own endpoint', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/status`)
      .set(...auth(users.manager))
      .send({ status: 'cancelled' });

    expect(res.status).toBe(422);
  });

  it('refuses a transition the lifecycle map does not allow', async () => {
    const { incidentId } = await seedIncident();

    // open -> waiting_for_parts is not in the transition map.
    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/status`)
      .set(...auth(users.technician))
      .send({ status: 'waiting_for_parts' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/transition open -> waiting_for_parts is not allowed/i);
  });

  it('tracks issue status separately with its own transition map', async () => {
    const { incidentId } = await seedIncident();

    const investigating = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'investigating' });
    expect(investigating.status).toBe(200);

    // investigating -> resolved is not allowed for issue status either.
    const resolved = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'resolved' });
    expect(resolved.status).toBe(422);
  });
});

describe('incidents - root-cause workflow', () => {
  async function seedIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load.',
        severity: 'high',
      });
    return { incidentId: incident.body.data.incident.id };
  }

  it('records a suspected root cause and keeps confirmation separate', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.rootCause.status).toBe('suspected');
    expect(res.body.data.incident.rootCause.text).toMatch(/shaft seal/i);
  });

  it('refuses to confirm through the update endpoint - only the confirm endpoint can', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.manager))
      .send({ text: 'The pump is worn.', status: 'confirmed' });

    expect(res.status).toBe(403);
  });

  it('requires a root-cause text before confirmation', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Verified on the bench.' });

    expect(res.status).toBe(422);
  });

  it('requires a confirmation note', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'ok' });

    expect(res.status).toBe(422);
  });

  it('confirms a suspected root cause with a mandatory note', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed by bench test and visual inspection.' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.rootCause.status).toBe('confirmed');
    expect(res.body.data.incident.rootCause.confirmationNote).toBe('Confirmed by bench test and visual inspection.');
    expect(res.body.data.incident.rootCause.confirmedBy).toBe(users.manager.id);
  });

  it('keeps a confirmed root cause immutable until reopen', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed by bench test.' });

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.manager))
      .send({ text: 'Actually the reservoir was empty.' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a suspected root cause with a mandatory reason', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/reject`)
      .set(...auth(users.manager))
      .send({ reason: 'Bench test showed the seal holds pressure.' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.rootCause.status).toBe('rejected');
    expect(res.body.data.incident.rootCause.rejectionReason).toMatch(/seal holds pressure/i);
  });

  it('refuses a second confirmation', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The main pump shaft seal has perished.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed by bench test.' });

    const second = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Trying to confirm again.' });

    expect(second.status).toBe(409);
  });
});

describe('incidents - fix workflows', () => {
  /** An incident whose issue status allows temporary_fix. */
  async function seedInvestigatingIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load.',
        severity: 'high',
      });
    await request(app)
      .patch(`${PREFIX}/incidents/${incident.body.data.incident.id}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'investigating' });
    await request(app)
      .patch(`${PREFIX}/incidents/${incident.body.data.incident.id}/status`)
      .set(...auth(users.technician))
      .send({ status: 'investigating' });
    return { incidentId: incident.body.data.incident.id };
  }

  it('records and confirms a temporary fix, moving the issue status', async () => {
    const { incidentId } = await seedInvestigatingIncident();

    const recorded = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/temporary-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Bypassed the clogged filter.' });
    expect(recorded.status).toBe(201);
    expect(recorded.body.data.incident.temporaryFix.status).toBe('recorded');

    const confirmed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/temporary-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Pressure restored for the shift.', result: 'Pressure stable at 45 bar.' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.incident.temporaryFix.status).toBe('confirmed');
    expect(confirmed.body.data.incident.issueStatus).toBe('temporary_fix');
  });

  it('refuses to confirm a fix that was never recorded', async () => {
    const { incidentId } = await seedInvestigatingIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Nothing to confirm.' });

    expect(res.status).toBe(422);
  });

  it('resolves the incident only when a permanent fix AND a root cause are confirmed', async () => {
    const { incidentId } = await seedInvestigatingIncident();

    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The filter housing gasket was installed upside down.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed after disassembly.' });

    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Reinstalled the gasket and replaced the filter element.' });

    const confirmed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Pressure stable for 24 hours.' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.incident.status).toBe('resolved');
    expect(confirmed.body.data.incident.resolvedAt).toBeTruthy();
    expect(confirmed.body.data.incident.issueStatus).toBe('resolved');
  });

  it('does not resolve when the permanent fix is confirmed without a confirmed root cause', async () => {
    const { incidentId } = await seedInvestigatingIncident();

    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the filter element.' });

    const confirmed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Pressure looked fine afterwards.' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.incident.status).toBe('investigating');
    expect(confirmed.body.data.incident.permanentFix.status).toBe('confirmed');
  });

  it('refuses a second permanent fix after one is confirmed', async () => {
    const { incidentId } = await seedInvestigatingIncident();
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the filter element.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Pressure stable.' });

    const second = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'A different fix.' });

    expect(second.status).toBe(409);
  });

  it('closes only a resolved incident, with a resolution summary', async () => {
    const { incidentId } = await seedInvestigatingIncident();

    const premature = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.manager))
      .send({ resolutionSummary: 'Done, probably.' });
    expect(premature.status).toBe(409);

    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The gasket failed.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed after disassembly.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the gasket.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Stable.' });

    const closed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.manager))
      .send({ resolutionSummary: 'Gasket replaced; pressure stable for 24 hours.' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.incident.status).toBe('closed');
    expect(closed.body.data.incident.resolutionSummary).toMatch(/gasket replaced/i);
  });

  it('reopens a closed incident with a reason', async () => {
    const { incidentId } = await seedInvestigatingIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The gasket failed.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed after disassembly.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the gasket.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Stable.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.manager))
      .send({ resolutionSummary: 'Gasket replaced.' });

    const reopened = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/reopen`)
      .set(...auth(users.manager))
      .send({ reason: 'Pressure loss returned the next shift.' });

    expect(reopened.status).toBe(200);
    expect(reopened.body.data.incident.status).toBe('reopened');
    expect(reopened.body.data.incident.reopenedAt).toBeTruthy();
  });
});

describe('incidents - actions', () => {
  async function seedIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load.',
        severity: 'high',
      });
    return { incidentId: incident.body.data.incident.id };
  }

  it('records a technician action with a default not_tested result', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionType: 'technician', description: 'Topped up the reservoir.' });

    expect(res.status).toBe(201);
    expect(res.body.data.action.resultStatus).toBe('not_tested');
    expect(res.body.data.action.confirmed).toBe(false);
  });

  it('refuses an observed result on anything but a technician action', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({
        actionType: 'assistant_suggestion',
        description: 'The AI suggested checking the reservoir.',
        resultStatus: 'successful',
      });

    expect(res.status).toBe(422);
  });

  it('never confirms an AI suggestion', async () => {
    const { incidentId } = await seedIncident();
    const suggestion = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionType: 'assistant_suggestion', description: 'Check the reservoir level.' });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions/${suggestion.body.data.action.id}/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'This looked right.' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/AI suggestions can never be confirmed/i);
  });

  it('confirms a technician action with a note, and locks it against edits', async () => {
    const { incidentId } = await seedIncident();
    const action = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionType: 'technician', description: 'Topped up the reservoir.', resultStatus: 'successful' });

    const confirmed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions/${action.body.data.action.id}/confirm`)
      .set(...auth(users.technician))
      .send({ note: 'Pressure returned to nominal on the gauge.' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.action.confirmed).toBe(true);
    expect(confirmed.body.data.action.confirmedBy).toBe(users.technician.id);

    const edit = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/actions/${action.body.data.action.id}`)
      .set(...auth(users.technician))
      .send({ description: 'Actually we replaced the whole pump.' });
    expect(edit.status).toBe(409);
  });

  it('does not treat a recorded successful result as a confirmation', async () => {
    const { incidentId } = await seedIncident();
    const action = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({
        actionType: 'technician',
        description: 'Topped up the reservoir.',
        result: 'Pressure recovered.',
        resultStatus: 'successful',
      });

    expect(action.body.data.action.resultStatus).toBe('successful');
    expect(action.body.data.action.confirmed).toBe(false);
  });
});

describe('incidents - cancellation and lifecycle locking', () => {
  async function seedIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'System pressure drops below 40 bar under load.',
        severity: 'high',
      });
    return {
      incidentId: incident.body.data.incident.id,
      machineId: machine.body.data.machine.id,
    };
  }

  it('requires a reason to cancel', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .delete(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.admin))
      .send({});

    expect(res.status).toBe(422);
  });

  it('cancels an incident, hides it from reads, and releases the open counter', async () => {
    const { incidentId, machineId } = await seedIncident();

    const machineBefore = await request(app)
      .get(`${PREFIX}/machines/${machineId}`)
      .set(...auth(users.viewer));
    expect(machineBefore.body.data.machine.openIncidentCount).toBe(1);

    const res = await request(app)
      .delete(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.manager))
      .send({ reason: 'Duplicate report of the same fault.' });
    expect(res.status).toBe(200);
    expect(res.body.data.incident.status).toBe('cancelled');

    const gone = await request(app)
      .get(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.manager));
    expect(gone.status).toBe(404);

    const machineAfter = await request(app)
      .get(`${PREFIX}/machines/${machineId}`)
      .set(...auth(users.viewer));
    expect(machineAfter.body.data.machine.openIncidentCount).toBe(0);
  });

  it('refuses updates on a cancelled incident', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .delete(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.admin))
      .send({ reason: 'Duplicate report.' });

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.manager))
      .send({ severity: 'low' });

    expect(res.status).toBe(404);
  });

  it('refuses updates on a closed incident until it is reopened', async () => {
    const { incidentId } = await seedIncident();
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The gasket failed.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed after disassembly.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the gasket.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Stable.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.manager))
      .send({ resolutionSummary: 'Gasket replaced.' });

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.manager))
      .send({ text: 'A second theory.', status: 'suspected' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/closed/i);
  });
});

describe('incidents - similar history and reindex', () => {
  it('falls back to exact error-code matches when the AI service is unavailable', async () => {
    const model = await createModel();
    const firstMachine = await createMachine(model.body.data.machineModel.id);
    const secondMachine = await createMachine(model.body.data.machineModel.id, { assetTag: 'CNC-002' });

    const first = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: firstMachine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'Pressure drops below 40 bar under load.',
        errorCodes: ['E-1042'],
      });
    await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: secondMachine.body.data.machine.id,
        title: 'Second pressure fault',
        description: 'Similar pressure behaviour on the other machine.',
        errorCodes: ['E-1042'],
      });

    const res = await request(app)
      .get(`${PREFIX}/incidents/${first.body.data.incident.id}/similar`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.similar.length).toBeGreaterThan(0);
    expect(res.body.data.similar[0].errorCodes).toContain('E-1042');
    expect(res.body.data.similar[0].similarityReasons).toContain('Exact error-code match');
    expect(res.body.data.similar[0].confirmed).toBe(false);
  });

  it('queues a reindex for managers', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        description: 'Pressure drops below 40 bar under load.',
      });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incident.body.data.incident.id}/reindex`)
      .set(...auth(users.manager));

    expect(res.status).toBe(202);
    expect(res.body.data.incident.embeddingStatus).toBe('pending');
  });
});

describe('machine timeline (Phase 7)', () => {
  it('merges maintenance records and incident events newest first', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const machineId = machine.body.data.machine.id;

    await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Hydraulic pressure loss',
        description: 'Pressure drops below 40 bar under load.',
        severity: 'high',
      });

    await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'part_replacement',
        title: 'Replaced suction strainer',
        performedAt: new Date().toISOString(),
        partsReplaced: [{ partNumber: 'strainer-88', quantity: 1 }],
      });

    const res = await request(app)
      .get(`${PREFIX}/machines/${machineId}/timeline`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.machine.assetTag).toBe('CNC-001');
    const kinds = new Set(res.body.data.timeline.map((e: { kind: string }) => e.kind));
    expect(kinds).toEqual(new Set(['maintenance', 'incident']));

    // Newest first.
    const dates = res.body.data.timeline.map((e: { at: string }) => new Date(e.at).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it('filters the timeline by kind', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const machineId = machine.body.data.machine.id;

    await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'inspection',
        title: 'Weekly inspection',
        performedAt: new Date().toISOString(),
      });

    const onlyMaintenance = await request(app)
      .get(`${PREFIX}/machines/${machineId}/timeline?kind=maintenance`)
      .set(...auth(users.viewer));
    expect(onlyMaintenance.status).toBe(200);
    expect(onlyMaintenance.body.data.timeline).toHaveLength(1);
    expect(onlyMaintenance.body.data.timeline[0].kind).toBe('maintenance');
    expect(onlyMaintenance.body.data.timeline[0].maintenanceType).toBe('inspection');

    const onlyIncidents = await request(app)
      .get(`${PREFIX}/machines/${machineId}/timeline?kind=incident`)
      .set(...auth(users.viewer));
    expect(onlyIncidents.body.data.timeline).toHaveLength(0);
  });
});

describe('maintenance organization isolation (Phase 7)', () => {
  it('scopes maintenance records to the actor organization', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const machineId = machine.body.data.machine.id;

    const created = await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.technician))
      .send({
        machineId,
        maintenanceType: 'preventive',
        title: 'Quarterly lubrication',
        performedAt: new Date().toISOString(),
      });
    expect(created.status).toBe(201);
    const recordId = created.body.data.maintenanceRecord.id;

    // A second organization plus a user that belongs to it.
    const otherOrg = await collections.organizations(db).insertOne({
      name: 'Other Plant',
      slug: 'other-plant',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
      schema_version: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const other = await createUser(app, db, 'technician', 'other_plant_tech');
    await collections.users(db).updateOne(
      { _id: new ObjectId(other.id) },
      { $set: { organization_id: otherOrg.insertedId } },
    );

    // Cross-org reads 404 (existence not disclosed) and lists stay empty.
    const cross = await request(app)
      .get(`${PREFIX}/maintenance/${recordId}`)
      .set(...auth(other));
    expect(cross.status).toBe(404);

    const list = await request(app)
      .get(`${PREFIX}/maintenance`)
      .set(...auth(other));
    expect(list.body.data).toHaveLength(0);

    // The owner still sees it.
    const own = await request(app)
      .get(`${PREFIX}/maintenance/${recordId}`)
      .set(...auth(users.technician));
    expect(own.status).toBe(200);
  });
});

describe('conversations', () => {
  it('creates a conversation and records how its scope was chosen', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);

    const res = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Pressure loss diagnosis', machineId: machine.body.data.machine.id });

    expect(res.status).toBe(201);
    expect(res.body.data.conversation.scopeSource).toBe('user_selected_machine');
    expect(res.body.data.conversation.turnCount).toBe(0);
  });

  it('persists the user message when RAG is unavailable rather than inventing an answer', async () => {
    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Chat attempt' });

    const res = await request(app)
      .post(`${PREFIX}/conversations/${created.body.data.conversation.id}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is the spindle overheating?' });

    expect(res.status).toBe(503);
    expect(['DEPENDENCY_UNAVAILABLE', 'SERVICE_UNAVAILABLE']).toContain(res.body.error.code);

    const stored = await request(app)
      .get(`${PREFIX}/conversations/${created.body.data.conversation.id}/messages`)
      .set(...auth(users.technician));
    expect(stored.status).toBe(200);
    expect(stored.body.data.some((m: { role: string }) => m.role === 'user')).toBe(true);
    expect(stored.body.data.some((m: { content: string }) => /spindle overheating/i.test(m.content))).toBe(true);
  });

  it('returns an empty message list rather than invented content', async () => {
    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Empty conversation' });

    const res = await request(app)
      .get(`${PREFIX}/conversations/${created.body.data.conversation.id}/messages`)
      .set(...auth(users.technician));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
