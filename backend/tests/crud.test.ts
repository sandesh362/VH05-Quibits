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
  resetDb,
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
        symptomText: 'Audible chatter and poor surface finish on the finishing pass.',
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

describe('incidents and the resolution flow', () => {
  async function seedIncident() {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const incident = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId: machine.body.data.machine.id,
        title: 'Hydraulic pressure loss',
        symptomText: 'System pressure drops below 40 bar under load and trips the alarm.',
        severity: 'high',
        errorCode: ' e-1042 ',
      });
    return { incidentId: incident.body.data.incident.id, body: incident.body };
  }

  it('creates an incident with a generated number and normalised error code', async () => {
    const { body } = await seedIncident();

    expect(body.data.incident.incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);
    expect(body.data.incident.errorCode).toBe('E-1042');
    expect(body.data.incident.status).toBe('open');
    expect(body.data.incident.resolutionStatus).toBe('unresolved');
    expect(body.data.incident.resolutionConfirmed).toBe(false);
  });

  it('allocates unique sequential incident numbers', async () => {
    const model = await createModel();
    const machine = await createMachine(model.body.data.machineModel.id);
    const machineId = machine.body.data.machine.id;

    const numbers = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post(`${PREFIX}/incidents`)
        .set(...auth(users.technician))
        .send({
          machineId,
          title: `Fault ${i}`,
          symptomText: 'A repeated fault used to verify sequence allocation behaviour.',
          severity: 'low',
        });
      numbers.add(res.body.data.incident.incidentNumber);
    }

    expect(numbers.size).toBe(5);
  });

  it('refuses to mark an incident resolved through a plain update', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.manager))
      .send({ status: 'resolved' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/confirmation endpoint/i);
  });

  it('refuses confirmation without an effective action', async () => {
    const { incidentId } = await seedIncident();

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/confirm-resolution`)
      .set(...auth(users.manager))
      .send({ rootCauseText: 'A worn seal on the main hydraulic pump.' });

    expect(res.status).toBe(422);
  });

  it('refuses confirmation when the nominated action did not work', async () => {
    const { incidentId } = await seedIncident();

    const action = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionText: 'Topped up the hydraulic reservoir.', outcome: 'no_change' });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/confirm-resolution`)
      .set(...auth(users.technician))
      .send({
        rootCauseText: 'Suspected a low reservoir level.',
        effectiveActionId: action.body.data.action.id,
      });

    expect(res.status).toBe(422);
    expect(res.body.error.details[0].issue).toMatch(/no_change/);
  });

  it('confirms a resolution when a working action and root cause are supplied', async () => {
    const { incidentId } = await seedIncident();

    const action = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({
        actionText: 'Replaced the main pump shaft seal and refilled the system.',
        outcome: 'worked',
        partsReplaced: [{ partNumber: 'SEAL-88', quantity: 1 }],
      });

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/confirm-resolution`)
      .set(...auth(users.technician))
      .send({
        rootCauseText: 'The main pump shaft seal had perished, bleeding off pressure under load.',
        effectiveActionId: action.body.data.action.id,
        verifiedByTest: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.resolutionStatus).toBe('resolved_confirmed');
    expect(res.body.data.incident.resolutionConfirmed).toBe(true);
    expect(res.body.data.incident.confirmedBy).toBeTruthy();
    expect(res.body.data.incident.status).toBe('resolved');
  });

  it('refuses a second confirmation', async () => {
    const { incidentId } = await seedIncident();
    const action = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionText: 'Replaced the seal.', outcome: 'worked' });

    const payload = {
      rootCauseText: 'The main pump shaft seal had perished.',
      effectiveActionId: action.body.data.action.id,
    };

    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/confirm-resolution`)
      .set(...auth(users.manager))
      .send(payload);

    const second = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/confirm-resolution`)
      .set(...auth(users.manager))
      .send(payload);

    expect(second.status).toBe(409);
  });

  it('numbers actions sequentially within an incident', async () => {
    const { incidentId } = await seedIncident();

    for (const text of ['Checked pressure.', 'Inspected the pump.', 'Replaced the seal.']) {
      await request(app)
        .post(`${PREFIX}/incidents/${incidentId}/actions`)
        .set(...auth(users.technician))
        .send({ actionText: text, outcome: 'unknown' });
    }

    const res = await request(app)
      .get(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { sequence: number }) => a.sequence)).toEqual([1, 2, 3]);
  });

  it('moves an incident to in_progress when the first action is recorded', async () => {
    const { incidentId } = await seedIncident();

    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.technician))
      .send({ actionText: 'Started diagnosis.', outcome: 'unknown' });

    const res = await request(app)
      .get(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.viewer));

    expect(res.body.data.incident.status).toBe('in_progress');
  });

  it('flags an incident as needing linking when only a model is given', async () => {
    const model = await createModel();

    const res = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineModelId: model.body.data.machineModel.id,
        title: 'Unknown asset fault',
        symptomText: 'Reported from the floor before the asset tag was confirmed.',
        severity: 'medium',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.incident.needsLinking).toBe(true);
    expect(res.body.data.incident.machineId).toBeNull();
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
