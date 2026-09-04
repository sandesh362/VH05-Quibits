/**
 * Outbox queue and snapshot cache behaviour on the in-memory SQLite driver.
 */
import { initDatabase, kvGet, kvSet, resetStaleSyncing, wipeUserData } from './database';
import {
  countOpsByStatus,
  deleteOp,
  enqueueOp,
  getOp,
  listOps,
  listPendingOps,
  pruneCompletedOps,
  retryOp,
  updateOp,
} from './outbox';
import { cacheGet, cachePut, cacheClear, pushRecent, readRecents, CACHE_TTL_MS } from './cache';

const resetDb = () => (jest.requireMock('expo-sqlite') as { __resetAll: () => void }).__resetAll();
beforeEach(() => {
  resetDb();
  initDatabase();
});

const U = 'user-1';

describe('outbox queue', () => {
  it('enqueues ops with local id, type, payload, timestamps and pending state', () => {
    const op = enqueueOp({ userId: U, type: 'create_incident', payload: { title: 'x' } });
    const stored = getOp(op.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('pending');
    expect(stored?.retryCount).toBe(0);
    expect(stored?.type).toBe('create_incident');
    expect(stored?.payload).toEqual({ title: 'x' });
    expect(stored?.createdAt).toBeTruthy();
  });

  it('deduplicates identical idempotency keys', () => {
    enqueueOp({ userId: U, type: 'create_action', payload: {}, idempotencyKey: 'idem-1' });
    const second = enqueueOp({ userId: U, type: 'create_action', payload: {}, idempotencyKey: 'idem-1' });
    expect(second.id).toBe('idem-1');
    expect(listOps(U)).toHaveLength(1);
  });

  it('lists pending ops oldest-first (submission order)', () => {
    enqueueOp({ userId: U, type: 'change_status', payload: {} });
    enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    const pending = listPendingOps(U);
    expect(pending.map((op) => op.type)).toEqual(['change_status', 'create_incident']);
  });

  it('keeps users isolated', () => {
    enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    enqueueOp({ userId: 'user-2', type: 'create_incident', payload: {} });
    expect(listPendingOps(U)).toHaveLength(1);
    expect(countOpsByStatus('user-2').pending).toBe(1);
  });

  it('transitions states and stores server results', () => {
    const op = enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    updateOp(op.id, { status: 'syncing' });
    expect(getOp(op.id)?.status).toBe('syncing');
    updateOp(op.id, { status: 'completed', serverResult: { incidentId: 'abc' }, lastError: null });
    const done = getOp(op.id);
    expect(done?.status).toBe('completed');
    expect(done?.serverResult).toEqual({ incidentId: 'abc' });
  });

  it('retries and deletes ops', () => {
    const op = enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    updateOp(op.id, { status: 'failed', lastError: 'boom' });
    retryOp(op.id);
    expect(getOp(op.id)?.status).toBe('pending');
    deleteOp(op.id);
    expect(getOp(op.id)).toBeNull();
  });

  it('recovers ops stuck in syncing after a crash', () => {
    const op = enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    updateOp(op.id, { status: 'syncing' });
    resetStaleSyncing(U);
    expect(getOp(op.id)?.status).toBe('pending');
  });

  it('wipes all user data on logout', () => {
    enqueueOp({ userId: U, type: 'create_incident', payload: {} });
    kvSet(U, 'k', 'v');
    cachePut(U, 'key', { a: 1 }, CACHE_TTL_MS.machines);
    wipeUserData(U);
    expect(listOps(U)).toHaveLength(0);
    expect(kvGet(U, 'k')).toBeNull();
    expect(cacheGet(U, 'key')).toBeNull();
  });

  it('prunes completed ops beyond the retention window', () => {
    for (let i = 0; i < 60; i++) {
      const op = enqueueOp({ userId: U, type: 'create_incident', payload: { n: i } });
      updateOp(op.id, { status: 'completed' });
    }
    pruneCompletedOps(U, 50);
    expect(countOpsByStatus(U).completed).toBe(50);
  });
});

describe('snapshot cache', () => {
  it('stores and returns payloads while fresh', () => {
    cachePut(U, 'machine:1', { id: '1' }, CACHE_TTL_MS.machines);
    expect(cacheGet(U, 'machine:1')).toEqual({ id: '1' });
  });

  it('expires stale snapshots', () => {
    cachePut(U, 'incident:1', { id: '1' }, -1);
    expect(cacheGet(U, 'incident:1')).toBeNull();
  });

  it('never leaks data between users', () => {
    cachePut(U, 'machine:1', { mine: true }, CACHE_TTL_MS.machines);
    expect(cacheGet('someone-else', 'machine:1')).toBeNull();
  });

  it('clears by prefix', () => {
    cachePut(U, 'machine:1', {}, CACHE_TTL_MS.machines);
    cachePut(U, 'incident:1', {}, CACHE_TTL_MS.incidents);
    cacheClear(U, 'machine:');
    expect(cacheGet(U, 'machine:1')).toBeNull();
    expect(cacheGet(U, 'incident:1')).not.toBeNull();
  });
});

describe('recents', () => {
  it('pushes deduplicated capped recents, newest first', () => {
    pushRecent(U, 'machines', { id: 'a', label: 'A' });
    pushRecent(U, 'machines', { id: 'b', label: 'B' });
    pushRecent(U, 'machines', { id: 'a', label: 'A2' });
    const recents = readRecents(U, 'machines');
    expect(recents.map((r) => r.id)).toEqual(['a', 'b']);
    expect(recents[0]?.label).toBe('A2');
  });
});
