/**
 * Outbox - the offline operation queue.
 *
 * Only explicitly supported write operations may be queued (never "every
 * request"). Each op carries: local id, type, payload, created timestamp,
 * retry count, state, last error and the server result when it completed.
 *
 * States: pending → syncing → completed | failed | requires_review
 *   - failed           the server answered with a definitive rejection.
 *   - requires_review  the outcome is ambiguous (e.g. a create whose response
 *                      was lost, or a conflict with a remote change). The app
 *                      NEVER overwrites server data automatically; the user
 *                      reviews and decides.
 */
import { newId } from '@/lib/id';
import { getDb } from './database';

export const OUTBOX_OP_TYPES = [
  'create_incident',
  'update_incident',
  'create_action',
  'confirm_action',
  'change_status',
  'change_issue_status',
  'update_root_cause',
  'confirm_root_cause',
  'reject_root_cause',
  'record_temporary_fix',
  'confirm_temporary_fix',
  'record_permanent_fix',
  'confirm_permanent_fix',
  'close_incident',
  'reopen_incident',
] as const;

export type OutboxOpType = (typeof OUTBOX_OP_TYPES)[number];

export type OutboxStatus = 'pending' | 'syncing' | 'completed' | 'failed' | 'requires_review';

export interface OutboxOp {
  id: string;
  userId: string;
  type: OutboxOpType;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  serverResult: Record<string, unknown> | null;
  idempotencyKey: string | null;
}

/**
 * Ops that can be replayed safely after an ambiguous failure because the
 * server treats a repeat as a no-op (same-value PATCH etc.). Everything else
 * (creates, confirms, closes) goes to `requires_review` when the outcome is
 * unknown - the app must never guess.
 */
export const SAFE_TO_RETRY_OPS: ReadonlySet<OutboxOpType> = new Set<OutboxOpType>([
  'update_incident',
  'change_status',
  'change_issue_status',
  'update_root_cause',
]);

interface OutboxRow {
  id: string;
  user_id: string;
  type: string;
  payload: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  server_result: string | null;
  idempotency_key: string | null;
}

function toOp(row: OutboxRow): OutboxOp {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as OutboxOpType,
    payload: safeParse(row.payload),
    status: row.status as OutboxStatus,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    serverResult: row.server_result ? safeParse(row.server_result) : null,
    idempotencyKey: row.idempotency_key,
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function enqueueOp(input: {
  userId: string;
  type: OutboxOpType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): OutboxOp {
  const now = new Date().toISOString();
  const op: OutboxRow = {
    id: input.idempotencyKey ?? newId(),
    user_id: input.userId,
    type: input.type,
    payload: JSON.stringify(input.payload),
    status: 'pending',
    retry_count: 0,
    created_at: now,
    updated_at: now,
    last_error: null,
    server_result: null,
    idempotency_key: input.idempotencyKey ?? null,
  };
  getDb().runSync(
    `INSERT OR IGNORE INTO outbox (id, user_id, type, payload, status, retry_count, created_at, updated_at, last_error, server_result, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      op.id,
      op.user_id,
      op.type,
      op.payload,
      op.status,
      op.retry_count,
      op.created_at,
      op.updated_at,
      op.last_error,
      op.server_result,
      op.idempotency_key,
    ],
  );
  return toOp(op);
}

export function getOp(id: string): OutboxOp | null {
  const row = getDb().getFirstSync<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
  return row ? toOp(row) : null;
}

/** Pending ops in submission order (oldest first). */
export function listPendingOps(userId: string, limit = 50): OutboxOp[] {
  const rows = getDb().getAllSync<OutboxRow>(
    `SELECT * FROM outbox WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    [userId, limit],
  );
  return rows.map(toOp);
}

/** Ops for the sync status screen, newest first. */
export function listOps(userId: string, limit = 100): OutboxOp[] {
  const rows = getDb().getAllSync<OutboxRow>(
    'SELECT * FROM outbox WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit],
  );
  return rows.map(toOp);
}

export function countOpsByStatus(userId: string): Record<OutboxStatus, number> {
  const rows = getDb().getAllSync<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM outbox WHERE user_id = ? GROUP BY status',
    [userId],
  );
  const counts: Record<OutboxStatus, number> = {
    pending: 0,
    syncing: 0,
    completed: 0,
    failed: 0,
    requires_review: 0,
  };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as OutboxStatus] = row.n;
  }
  return counts;
}

export function updateOp(
  id: string,
  patch: Partial<Pick<OutboxOp, 'status' | 'retryCount' | 'lastError' | 'serverResult'>>,
): void {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.retryCount !== undefined) {
    fields.push('retry_count = ?');
    params.push(patch.retryCount);
  }
  if (patch.lastError !== undefined) {
    fields.push('last_error = ?');
    params.push(patch.lastError);
  }
  if (patch.serverResult !== undefined) {
    fields.push('server_result = ?');
    params.push(JSON.stringify(patch.serverResult));
  }
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().runSync(`UPDATE outbox SET ${fields.join(', ')} WHERE id = ?`, params);
}

/** Re-queue a failed/review op by hand (user pressed Retry). */
export function retryOp(id: string): void {
  getDb().runSync(
    `UPDATE outbox SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

export function deleteOp(id: string): void {
  getDb().runSync('DELETE FROM outbox WHERE id = ?', [id]);
}

/** Prune old completed ops so the queue log stays bounded. */
export function pruneCompletedOps(userId: string, keep = 50): void {
  getDb().runSync(
    `DELETE FROM outbox WHERE user_id = ? AND status = 'completed' AND id NOT IN (
       SELECT id FROM outbox WHERE user_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT ?
     )`,
    [userId, userId, keep],
  );
}
