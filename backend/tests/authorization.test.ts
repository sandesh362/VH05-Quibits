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
  it('lets technicians create incidents but not viewers', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    const payload = {
      machineId,
      title: 'Spindle overheating',
      symptomText: 'The spindle reaches thermal cutout after twenty minutes of operation.',
      severity: 'high' as const,
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
        symptomText: 'Coolant pooling underneath the enclosure during operation.',
        severity: 'medium',
      });
    const id = created.body.data.incident.id;

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${id}`)
      .set(...auth(users.technician))
      .send({ title: 'Hijacked title' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/only edit incidents that you reported/i);
  });

  it('lets a manager edit any incident', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    const created = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Axis drift',
        symptomText: 'The Y axis drifts by half a millimetre across a long program.',
        severity: 'low',
      });

    const res = await request(app)
      .patch(`${PREFIX}/incidents/${created.body.data.incident.id}`)
      .set(...auth(users.manager))
      .send({ severity: 'high' });

    expect(res.status).toBe(200);
    expect(res.body.data.incident.severity).toBe('high');
  });

  it('allows only manager and admin to reopen a resolved incident', async () => {
    const { machineId } = await seedMachine(app, users.admin);

    const created = await request(app)
      .post(`${PREFIX}/incidents`)
      .set(...auth(users.technician))
      .send({
        machineId,
        title: 'Tool changer jam',
        symptomText: 'The tool changer jams intermittently when swapping to pocket four.',
        severity: 'medium',
      });
    const id = created.body.data.incident.id;

    // Genuinely resolve it first: log a working action, then confirm.
    const action = await request(app)
      .post(`${PREFIX}/incidents/${id}/actions`)
      .set(...auth(users.technician))
      .send({ actionText: 'Realigned the tool changer carousel.', outcome: 'worked' });
    expect(action.status).toBe(201);

    const confirmed = await request(app)
      .post(`${PREFIX}/incidents/${id}/confirm-resolution`)
      .set(...auth(users.technician))
      .send({
        rootCauseText: 'The carousel had drifted out of alignment after a crash.',
        effectiveActionId: action.body.data.action.id,
      });
    expect(confirmed.status).toBe(200);

    // Authorization: a technician may not reopen, a manager may.
    const denied = await request(app)
      .post(`${PREFIX}/incidents/${id}/reopen`)
      .set(...auth(users.technician))
      .send({ reason: 'the fault came back the next shift' });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .post(`${PREFIX}/incidents/${id}/reopen`)
      .set(...auth(users.manager))
      .send({ reason: 'the fault came back the next shift' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.incident.resolutionConfirmed).toBe(false);
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
    ];

    for (const [method, url, body] of writes) {
      const res = await (request(app) as never as Record<string, Function>)[method](url)
        .set(...auth(users.viewer))
        .send(body);
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
