/**
 * Sync engine decisions - the heart of safe offline support.
 *
 * Mocked endpoint modules: the engine must classify outcomes correctly
 * WITHOUT a live server, including ambiguous failures and conflicts.
 */
import { initDatabase } from './database';
import { enqueueOp } from './outbox';
import { lastSyncAt, syncNow } from './sync';
import { ApiError } from '@/api/errors';
import type { IncidentView } from '@itp/shared';
import * as endpoints from '@/api/endpoints';

jest.mock('@/api/endpoints', () => ({
  createIncident: jest.fn(),
  updateIncident: jest.fn(),
  createIncidentAction: jest.fn(),
  confirmIncidentAction: jest.fn(),
  changeIncidentStatus: jest.fn(),
  changeIncidentIssueStatus: jest.fn(),
  updateRootCause: jest.fn(),
  confirmRootCause: jest.fn(),
  rejectRootCause: jest.fn(),
  recordTemporaryFix: jest.fn(),
  confirmTemporaryFix: jest.fn(),
  recordPermanentFix: jest.fn(),
  confirmPermanentFix: jest.fn(),
  closeIncident: jest.fn(),
  reopenIncident: jest.fn(),
}));

const U = 'user-1';
const mocked = endpoints as jest.MockedObject<typeof endpoints>;

const networkError = () => new ApiError('NETWORK_ERROR', 'Cannot reach the API.');

const resetDb = () => (jest.requireMock('expo-sqlite') as { __resetAll: () => void }).__resetAll();
beforeEach(() => {
  resetDb();
  initDatabase();
  for (const fn of Object.values(mocked)) if (typeof fn?.mockReset === 'function') fn.mockReset();
});

describe('sync engine', () => {
  it('executes ops in order and stores the server result', async () => {
    const first = enqueueOp({ userId: U, type: 'create_incident', payload: { title: 'Pump down' } });
    enqueueOp({ userId: U, type: 'change_status', payload: { incidentId: 'inc1', status: 'investigating' } });
    mocked.createIncident.mockResolvedValue({ id: 'inc-new', incidentNumber: 'INC-2026-000001' } as unknown as IncidentView);
    mocked.changeIncidentStatus.mockResolvedValue({ id: 'inc1', status: 'investigating' } as unknown as IncidentView);

    const outcome = await syncNow(U, 'manual');
    expect(outcome.completed).toBe(2);
    expect(mocked.createIncident).toHaveBeenCalledWith({ title: 'Pump down' });
    expect(mocked.changeIncidentStatus).toHaveBeenCalledWith('inc1', 'investigating', undefined);
    expect(lastSyncAt(U)).toBeTruthy();
    void first;
  });

  it('marks creates as requires_review when the outcome is ambiguous (offline)', async () => {
    enqueueOp({ userId: U, type: 'create_incident', payload: { title: 'x' } });
    mocked.createIncident.mockRejectedValue(networkError());

    const outcome = await syncNow(U, 'manual');
    expect(outcome.review).toBe(1);
    const op = require('./outbox').listOps(U)[0];
    expect(op.status).toBe('requires_review');
    expect(op.lastError).toContain('not known whether the server received');
  });

  it('retries idempotent status changes with backoff instead of flagging them', async () => {
    const op = enqueueOp({ userId: U, type: 'change_status', payload: { incidentId: 'i', status: 'investigating' } });
    mocked.changeIncidentStatus.mockRejectedValue(networkError());

    const outcome = await syncNow(U, 'manual');
    expect(outcome.review).toBe(0);
    const stored = require('./outbox').getOp(op.id);
    expect(stored.status).toBe('pending');
    expect(stored.retryCount).toBe(1);
    expect(stored.lastError).toBeTruthy();
  });

  it('stops retrying idempotent ops after the cap and flags them for review', async () => {
    const op = enqueueOp({ userId: U, type: 'change_status', payload: { incidentId: 'i', status: 'investigating' } });
    mocked.changeIncidentStatus.mockRejectedValue(networkError());
    for (let i = 0; i < 5; i++) {
      await syncNow(U, 'manual');
    }
    const stored = require('./outbox').getOp(op.id);
    expect(stored.retryCount).toBe(5);
    expect(stored.status).toBe('pending');
    // The 6th failure exhausts retries.
    mocked.changeIncidentStatus.mockRejectedValue(networkError());
    await syncNow(U, 'manual');
    expect(require('./outbox').getOp(op.id).status).toBe('requires_review');
  });

  it('marks CONFLICT as requires_review (never overwrite remote changes)', async () => {
    enqueueOp({ userId: U, type: 'close_incident', payload: { incidentId: 'i', resolutionSummary: 'done' } });
    mocked.closeIncident.mockRejectedValue(new ApiError('CONFLICT', 'Already closed.', 409));

    const outcome = await syncNow(U, 'manual');
    expect(outcome.review).toBe(1);
    const op = require('./outbox').listOps(U)[0];
    expect(op.status).toBe('requires_review');
    expect(op.lastError).toContain('Already closed');
  });

  it('marks validation rejections as failed', async () => {
    enqueueOp({ userId: U, type: 'record_temporary_fix', payload: { incidentId: 'i', description: 'x' } });
    mocked.recordTemporaryFix.mockRejectedValue(new ApiError('VALIDATION_ERROR', 'Description too short.', 422));

    const outcome = await syncNow(U, 'manual');
    expect(outcome.failed).toBe(1);
    expect(require('./outbox').listOps(U)[0].status).toBe('failed');
  });

  it('leaves ops pending on auth failures (session expiry handled elsewhere)', async () => {
    enqueueOp({ userId: U, type: 'change_status', payload: { incidentId: 'i', status: 'investigating' } });
    mocked.changeIncidentStatus.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'Expired.', 401));

    const outcome = await syncNow(U, 'manual');
    expect(outcome.remaining).toBe(1);
    expect(require('./outbox').listOps(U)[0].status).toBe('pending');
  });

  it('prevents duplicate submissions for the same idempotency key', async () => {
    const key = 'idem-2';
    mocked.createIncident.mockResolvedValue({ id: 'inc-1', incidentNumber: 'INC-1' } as unknown as IncidentView);
    enqueueOp({ userId: U, type: 'create_incident', payload: { title: 'a' }, idempotencyKey: key });
    await syncNow(U, 'manual');
    // A second enqueue with the same key is ignored locally.
    enqueueOp({ userId: U, type: 'create_incident', payload: { title: 'a' }, idempotencyKey: key });
    await syncNow(U, 'manual');
    expect(mocked.createIncident).toHaveBeenCalledTimes(1);
  });

  it('respects the per-op backoff window on non-manual triggers', async () => {
    const op = enqueueOp({ userId: U, type: 'change_status', payload: { incidentId: 'i', status: 'investigating' } });
    mocked.changeIncidentStatus.mockRejectedValue(networkError());
    await syncNow(U, 'manual');
    // Immediately re-running with an automatic trigger must skip (backoff).
    mocked.changeIncidentStatus.mockClear();
    const outcome = await syncNow(U, 'online');
    expect(mocked.changeIncidentStatus).not.toHaveBeenCalled();
    expect(outcome.processed).toBe(0);
    void op;
  });
});
