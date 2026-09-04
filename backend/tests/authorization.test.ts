/**
 * Authorization tests.
 *
 * The authorization matrix is only real if the denials are tested. These
 * exercise every role against representative endpoints, and specifically the
 * ownership rules that a capability check alone cannot express.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { collections } from '../src/database/collections.js';
import {
  PREFIX,
  auth,
  createAllRoles,
  createUser,
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

describe('role-based access to machine models', () => {
  it('lets every role read', async () => {
    for (const role of ['admin', 'manager', 'technician', 'viewer'] as UserRole[]) {
      const res = await request(app)
        .get(`${PREFIX}/machine-models`)
        .set(...auth(users[role]));
      expect(res.status, `${role} should be able to read`).toBe(200);
    }
  });

  it('lets admin and manager create, and refuses technician and viewer', async () => {
    const allowed: UserRole[] = ['admin', 'manager'];
    const denied: UserRole[] = ['technician', 'viewer'];

    for (const role of allowed) {
      const res = await request(app)
        .post(`${PREFIX}/machine-models`)
        .set(...auth(users[role]))
        .send({ manufacturer: 'Fanuc', modelName: `M-${role}`, machineType: 'robot_arm' });
      expect(res.status, `${role} should be able to create`).toBe(201);
    }

    for (const role of denied) {
      const res = await request(app)
        .post(`${PREFIX}/machine-models`)
        .set(...auth(users[role]))
        .send({ manufacturer: 'Fanuc', modelName: `X-${role}`, machineType: 'robot_arm' });
      expect(res.status, `${role} should be denied`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('allows only admin to delete', async () => {
    const created = await request(app)
      .post(`${PREFIX}/machine-models`)
      .set(...auth(users.admin))
      .send({ manufacturer: 'Okuma', modelName: 'Genos', machineType: 'cnc_lathe' });
    const id = created.body.data.machineModel.id;

    for (const role of ['manager', 'technician', 'viewer'] as UserRole[]) {
      const res = await request(app)
        .delete(`${PREFIX}/machine-models/${id}`)
        .set(...auth(users[role]))
        .send({ reason: 'testing deletion permissions' });
      expect(res.status, `${role} must not delete`).toBe(403);
    }

    const res = await request(app)
      .delete(`${PREFIX}/machine-models/${id}`)
      .set(...auth(users.admin))
      .send({ reason: 'testing deletion permissions' });
    expect(res.status).toBe(200);
  });
});

describe('role-based access to incidents', () => {
  async function seedIncident(actor: TestUser) {
    const { machineId } = await seedMachine(app, users.admin);
    const created = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(actor))
      .send({
        machineId,
        title: 'Spindle overheating',
        description: 'The spindle reaches thermal cutout after twenty minutes of operation.',
        severity: 'high',
      });
    if (created.status !== 201) {
      throw new Error(`Failed to seed incident: ${created.status} ${JSON.stringify(created.body)}`);
    }
    return { machineId, incidentId: created.body.data.incident.id };
  }

  it('lets technicians create incidents but not viewers', async () => {
    const { machineId } = await seedMachine(app, users.admin);
    const payload = {
      machineId,
      title: 'Spindle overheating',
      description: 'The spindle reaches thermal cutout after twenty minutes of operation.',
      severity: 'high',
    };

    const technician = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send(payload);
    expect(technician.status).toBe(201);

    const viewer = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.viewer))
      .send(payload);
    expect(viewer.status).toBe(403);
  });

  it('stops a technician from editing an incident somebody else reported', async () => {
    const { machineId } = await seedMachine(app, users.admin);
    const other = await createUser(app, db, 'technician', 'tech_two');

    const created = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(other))
      .send({
        machineId,
        title: 'Coolant leak',
        description: 'Coolant pooling underneath the enclosure during operation.',
        severity: 'medium',
      });
    const id = created.body.data.incident.id;

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${id}`)
      .set(...auth(users.technician))
      .send({ title: 'Hijacked title' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/manage incidents that you reported/i);
  });

  it('lets a manager edit any incident', async () => {
    const { incidentId } = await seedIncident(users.technician);

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.manager))
      .send({ severity: 'critical' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.severity).toBe('critical');
  });

  it('reserves root-cause confirmation for managers and admins', async () => {
    const { incidentId } = await seedIncident(users.technician);
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The spindle bearing is worn.', status: 'suspected' });

    const denied = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.technician))
      .send({ note: 'I am sure of this.' });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed by vibration analysis.' });
    expect(allowed.status).toBe(200);
  });

  it('reserves fix confirmation and closure for managers and admins', async () => {
    const { incidentId } = await seedIncident(users.technician);
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/temporary-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Reduced the spindle speed.' });

    const confirmDenied = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/temporary-fix/confirm`)
      .set(...auth(users.technician))
      .send({ note: 'The temperature dropped.' });
    expect(confirmDenied.status).toBe(403);

    const closeDenied = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.technician))
      .send({ resolutionSummary: 'Fixed by reducing the speed.' });
    expect(closeDenied.status).toBe(403);
  });

  it('lets a technician reopen an incident they reported, and refuses others', async () => {
    const { incidentId } = await seedIncident(users.technician);
    await request(app)
      .patch(`${PREFIX}/incidents/${incidentId}/root-cause`)
      .set(...auth(users.technician))
      .send({ text: 'The spindle bearing is worn.', status: 'suspected' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/root-cause/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Confirmed by vibration analysis.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix`)
      .set(...auth(users.technician))
      .send({ description: 'Replaced the spindle bearing.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/permanent-fix/confirm`)
      .set(...auth(users.manager))
      .send({ note: 'Temperature stable.' });
    await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/close`)
      .set(...auth(users.manager))
      .send({ resolutionSummary: 'Bearing replaced.' });

    // A different technician cannot reopen somebody else's incident.
    const other = await createUser(app, db, 'technician', 'tech_reopen');
    const denied = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/reopen`)
      .set(...auth(other))
      .send({ reason: 'The fault came back.' });
    expect(denied.status).toBe(403);

    // The reporting technician may reopen their own incident.
    const allowed = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/reopen`)
      .set(...auth(users.technician))
      .send({ reason: 'The fault came back the next shift.' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.incident.status).toBe('reopened');
  });

  it('lets a technician cancel their own incident but not somebody else\'s', async () => {
    const { incidentId } = await seedIncident(users.technician);

    const other = await createUser(app, db, 'technician', 'tech_cancel');
    const denied = await request(app)
      .delete(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(other))
      .send({ reason: 'Not yours to cancel.' });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .delete(`${PREFIX}/incidents/${incidentId}`)
      .set(...auth(users.technician))
      .send({ reason: 'Duplicate report.' });
    expect(allowed.status).toBe(200);
  });

  it('lets every role read incident details, timeline and actions', async () => {
    const { incidentId } = await seedIncident(users.technician);

    for (const role of ['admin', 'manager', 'technician', 'viewer'] as UserRole[]) {
      const detail = await request(app)
        .get(`${PREFIX}/incidents/${incidentId}`)
        .set(...auth(users[role]));
      expect(detail.status, `${role} should read the incident`).toBe(200);

      const timeline = await request(app)
        .get(`${PREFIX}/incidents/${incidentId}/timeline`)
        .set(...auth(users[role]));
      expect(timeline.status, `${role} should read the timeline`).toBe(200);
    }
  });

  it('keeps a viewer from recording actions on an incident', async () => {
    const { incidentId } = await seedIncident(users.technician);

    const res = await request(app)
      .post(`${PREFIX}/incidents/${incidentId}/actions`)
      .set(...auth(users.viewer))
      .send({ actionType: 'technician', description: 'Just looking.' });

    expect(res.status).toBe(403);
  });

  it('refuses reindex for technicians and viewers', async () => {
    const { incidentId } = await seedIncident(users.technician);

    for (const role of ['technician', 'viewer'] as UserRole[]) {
      const res = await request(app)
        .post(`${PREFIX}/incidents/${incidentId}/reindex`)
        .set(...auth(users[role]));
      expect(res.status, `${role} must not reindex`).toBe(403);
    }
  });

  it('hides another organization\'s incidents entirely', async () => {
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
    const otherUser = await createUser(app, db, 'manager', 'other_plant_manager');
    await collections.users(db).updateOne(
      { _id: new ObjectId(otherUser.id) },
      { $set: { organization_id: otherOrg.insertedId } },
    );

    const { machineId } = await seedMachine(app, users.admin);
    const created = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Cross-org probe',
        description: 'This incident belongs to the default organization only.',
      });
    const id = created.body.data.incident.id;

    // Reads 404 (not 403): existence itself is not disclosed across orgs.
    const res = await request(app)
      .get(`${PREFIX}/incidents/${id}`)
      .set(...auth(otherUser));
    expect(res.status).toBe(404);

    const list = await request(app)
      .get(`${PREFIX}/incidents`)
      .set(...auth(otherUser));
    expect(list.body.data).toHaveLength(0);
  });
});

describe('machine timeline access (Phase 7)', () => {
  it('lets every role read the machine timeline', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    for (const role of ['admin', 'manager', 'technician', 'viewer'] as UserRole[]) {
      const res = await request(app)
        .get(`${PREFIX}/machines/${machineId}/timeline`)
        .set(...auth(users[role]));
      expect(res.status, `${role} should read the machine timeline`).toBe(200);
    }
  });

  it('requires authentication for the machine timeline', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    const res = await request(app).get(`${PREFIX}/machines/${machineId}/timeline`);
    expect(res.status).toBe(401);
  });

  it('refuses a viewer who tries to record maintenance', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    const res = await request(app)
      .post(`${PREFIX}/maintenance`)
      .set(...auth(users.viewer))
      .send({
        machineId,
        maintenanceType: 'inspection',
        title: 'Unauthorised inspection',
        performedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(403);
  });
});

describe('user listing for assignment pickers', () => {
  it('lets managers list users and refuses viewers', async () => {
    const denied = await request(app)
      .get(`${PREFIX}/users`)
      .set(...auth(users.viewer));
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`${PREFIX}/users`)
      .set(...auth(users.manager));
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.users.length).toBeGreaterThan(0);
  });
});

describe('viewer is strictly read-only', () => {
  it('refuses every write across the domain modules', async () => {
    const { machineId, modelId } = await seedMachine(app, users.admin);

    const writes: [string, string, object][] = [
      ['post', `${PREFIX}/machines`, { assetTag: 'NEW-1', machineModelId: modelId }],
      ['post', `${PREFIX}/maintenance`, {
        machineId,
        maintenanceType: 'preventive',
        title: 'Monthly service',
        performedAt: new Date().toISOString(),
      }],
      ['post', `${PREFIX}/manuals`, {
        title: 'Service manual',
        scope: 'model',
        machineModelId: modelId,
        documentType: 'service',
        originalFilename: 'service.pdf',
        fileSizeBytes: 1024,
        sha256: 'a'.repeat(64),
        mimeType: 'application/pdf',
      }],
      ['post', `${PREFIX}/incidents`, {
        machineId,
        title: 'Viewer cannot report',
        description: 'This write must be refused for the viewer role.',
      }],
    ];

    for (const [method, url, body] of writes) {
      const res =
        method === 'patch'
          ? await request(app).patch(url).set(...auth(users.viewer)).send(body)
          : method === 'delete'
            ? await request(app).delete(url).set(...auth(users.viewer)).send(body)
            : await request(app).post(url).set(...auth(users.viewer)).send(body);
      expect(res.status, `viewer must not ${method.toUpperCase()} ${url}`).toBe(403);
    }
  });

  it('can still read every list endpoint', async () => {
    for (const path of ['machines', 'machine-models', 'manuals', 'incidents', 'maintenance']) {
      const res = await request(app)
        .get(`${PREFIX}/${path}`)
        .set(...auth(users.viewer));
      expect(res.status, `viewer should read ${path}`).toBe(200);
    }
  });
});

describe('unauthenticated access', () => {
  it('is refused on every protected endpoint', async () => {
    const paths = [
      'machines',
      'machine-models',
      'manuals',
      'incidents',
      'maintenance',
      'conversations',
      'users/me',
    ];

    for (const path of paths) {
      const res = await request(app).get(`${PREFIX}/${path}`);
      expect(res.status, `${path} must require authentication`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('leaves health and system info public for probes', async () => {
    expect((await request(app).get(`${PREFIX}/health`)).status).toBe(200);
    expect((await request(app).get(`${PREFIX}/system/info`)).status).toBe(200);
  });

  it('refuses unauthenticated retrieval and RAG', async () => {
    for (const path of ['retrieval/search', 'rag/answer', 'rag/debug']) {
      const res = await request(app)
        .post(`${PREFIX}/${path}`)
        .send({ query: 'Why is error E-104 appearing?' });
      expect(res.status, `${path} must require authentication`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('conversation ownership', () => {
  it('hides another user\'s conversation from a technician', async () => {
    const other = await createUser(app, db, 'technician', 'tech_owner');

    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(other))
      .send({ title: 'Private troubleshooting notes' });
    const id = created.body.data.conversation.id;

    // 404 rather than 403: existence itself is not disclosed.
    const res = await request(app)
      .get(`${PREFIX}/conversations/${id}`)
      .set(...auth(users.technician));
    expect(res.status).toBe(404);
  });

  it('lets a manager read any conversation', async () => {
    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Shared troubleshooting notes' });

    const res = await request(app)
      .get(`${PREFIX}/conversations/${created.body.data.conversation.id}`)
      .set(...auth(users.manager));
    expect(res.status).toBe(200);
  });

  it('scopes the list to the caller for a technician', async () => {
    const other = await createUser(app, db, 'technician', 'tech_three');

    await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(other))
      .send({ title: 'Not yours' });
    await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Yours' });

    const res = await request(app)
      .get(`${PREFIX}/conversations`)
      .set(...auth(users.technician));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Yours');
  });
});
