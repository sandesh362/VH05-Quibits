/**
 * Sync engine - flushes the outbox to the existing API.
 *
 * Contract with the field reality:
 *  - Ops are executed strictly in submission order, one at a time.
 *  - Definitive server rejections (422/403/404) mark the op `failed`.
 *  - CONFLICT (409) means the record changed remotely → `requires_review`.
 *    The app never overwrites server data to "resolve" this.
 *  - Ambiguous transport failures on non-idempotent ops (creates, confirms,
 *    close/reopen) → `requires_review`. On idempotent ops → back to `pending`
 *    with a backoff window.
 *  - Nothing is reported as "done" until the server confirmed it.
 */
import { ApiError } from '@/api/errors';
import {
  changeIncidentIssueStatus,
  changeIncidentStatus,
  closeIncident,
  confirmIncidentAction,
  confirmPermanentFix,
  confirmRootCause,
  confirmTemporaryFix,
  createIncident,
  createIncidentAction,
  recordPermanentFix,
  recordTemporaryFix,
  reopenIncident,
  rejectRootCause,
  updateIncident,
  updateRootCause,
} from '@/api/endpoints';
import { kvGet, kvSet } from './database';
import {
  countOpsByStatus,
  getOp,
  listPendingOps,
  pruneCompletedOps,
  SAFE_TO_RETRY_OPS,
  updateOp,
  type OutboxOp,
  type OutboxOpType,
  type OutboxStatus,
} from './outbox';

const LAST_SYNC_KEY = 'sync.lastCompletedAt';
const BACKOFF_BASE_MS = 5_000;
const MAX_AUTO_RETRIES = 5;

export type SyncTrigger = 'online' | 'foreground' | 'manual' | 'after-write';

export interface SyncOutcome {
  processed: number;
  completed: number;
  failed: number;
  review: number;
  remaining: number;
}

export function lastSyncAt(userId: string): string | null {
  return kvGet<string>(userId, LAST_SYNC_KEY);
}

function backoffElapsed(op: OutboxOp): boolean {
  if (op.retryCount === 0) return true;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (op.retryCount - 1), 10 * 60_000);
  return Date.now() - new Date(op.updatedAt).getTime() >= wait;
}

interface IncidentRef {
  incidentId: string;
}

function asIncidentRef(payload: Record<string, unknown>): IncidentRef {
  const incidentId = typeof payload.incidentId === 'string' ? payload.incidentId : '';
  if (!incidentId) throw new Error(`Operation is missing incidentId: ${JSON.stringify(Object.keys(payload))}`);
  return { incidentId };
}

function optString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Dispatch one op to the API. Every call here is the real backend contract -
 * the sync engine invents no endpoints and no fields.
 */
async function dispatchOp(op: OutboxOp): Promise<Record<string, unknown>> {
  const p = op.payload;
  switch (op.type) {
    case 'create_incident': {
      const incident = await createIncident(p);
      return { incidentId: incident.id, incidentNumber: incident.incidentNumber };
    }
    case 'update_incident': {
      const { incidentId } = asIncidentRef(p);
      const body = (p.body ?? {}) as Record<string, unknown>;
      const incident = await updateIncident(incidentId, body);
      return { incidentId: incident.id, updatedAt: incident.updatedAt };
    }
    case 'create_action': {
      const { incidentId } = asIncidentRef(p);
      const body = (p.body ?? {}) as Record<string, unknown>;
      const action = await createIncidentAction(incidentId, body);
      return { incidentId, actionId: action.id };
    }
    case 'confirm_action': {
      const { incidentId } = asIncidentRef(p);
      const action = await confirmIncidentAction(incidentId, String(p.actionId), String(p.note));
      return { incidentId, actionId: action.id, confirmed: action.confirmed };
    }
    case 'change_status': {
      const { incidentId } = asIncidentRef(p);
      const incident = await changeIncidentStatus(incidentId, p.status as never, optString(p, 'reason'));
      return { incidentId, status: incident.status };
    }
    case 'change_issue_status': {
      const { incidentId } = asIncidentRef(p);
      const incident = await changeIncidentIssueStatus(incidentId, p.issueStatus as never, optString(p, 'note'));
      return { incidentId, issueStatus: incident.issueStatus };
    }
    case 'update_root_cause': {
      const { incidentId } = asIncidentRef(p);
      const incident = await updateRootCause(incidentId, {
        text: optString(p, 'text'),
        status: p.status as 'suspected' | 'unknown' | undefined,
        note: optString(p, 'note'),
      });
      return { incidentId, rootCauseStatus: incident.rootCause.status };
    }
    case 'confirm_root_cause': {
      const { incidentId } = asIncidentRef(p);
      const incident = await confirmRootCause(incidentId, String(p.note), optString(p, 'text'));
      return { incidentId, rootCauseStatus: incident.rootCause.status };
    }
    case 'reject_root_cause': {
      const { incidentId } = asIncidentRef(p);
      const incident = await rejectRootCause(incidentId, String(p.reason));
      return { incidentId, rootCauseStatus: incident.rootCause.status };
    }
    case 'record_temporary_fix':
    case 'record_permanent_fix': {
      const { incidentId } = asIncidentRef(p);
      const body = { description: String(p.description), result: optString(p, 'result'), notes: optString(p, 'notes') };
      const incident =
        op.type === 'record_temporary_fix'
          ? await recordTemporaryFix(incidentId, body)
          : await recordPermanentFix(incidentId, body);
      return { incidentId, fixStatus: (op.type === 'record_temporary_fix' ? incident.temporaryFix : incident.permanentFix)?.status ?? null };
    }
    case 'confirm_temporary_fix':
    case 'confirm_permanent_fix': {
      const { incidentId } = asIncidentRef(p);
      const note = String(p.note);
      const result = optString(p, 'result');
      const incident =
        op.type === 'confirm_temporary_fix'
          ? await confirmTemporaryFix(incidentId, note, result)
          : await confirmPermanentFix(incidentId, note, result);
      return {
        incidentId,
        fixStatus: (op.type === 'confirm_temporary_fix' ? incident.temporaryFix : incident.permanentFix)?.status ?? null,
        status: incident.status,
      };
    }
    case 'close_incident': {
      const { incidentId } = asIncidentRef(p);
      const incident = await closeIncident(incidentId, String(p.resolutionSummary));
      return { incidentId, status: incident.status };
    }
    case 'reopen_incident': {
      const { incidentId } = asIncidentRef(p);
      const incident = await reopenIncident(incidentId, String(p.reason));
      return { incidentId, status: incident.status };
    }
    default: {
      const exhaustive: never = op.type;
      throw new Error(`Unsupported outbox operation: ${String(exhaustive)}`);
    }
  }
}

const SHORT_ERROR_MAX = 160;
function shortError(error: unknown): string {
  if (error instanceof ApiError) {
    const base = error.message || error.code;
    return base.length > SHORT_ERROR_MAX ? `${base.slice(0, SHORT_ERROR_MAX)}…` : base;
  }
  if (error instanceof Error) return error.message.slice(0, SHORT_ERROR_MAX);
  return 'Unknown error.';
}

/** Run pending ops for a user. Safe to call concurrently (ops are claimed). */
export async function syncNow(userId: string, trigger: SyncTrigger = 'foreground'): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { processed: 0, completed: 0, failed: 0, review: 0, remaining: 0 };

  for (;;) {
    const pending = listPendingOps(userId, 1);
    const op = pending[0];
    if (!op) break;

    // Manual syncs ignore the per-op backoff window.
    if (trigger !== 'manual' && !backoffElapsed(op)) {
      outcome.remaining += countOpsByStatus(userId).pending;
      break;
    }

    updateOp(op.id, { status: 'syncing' });
    outcome.processed += 1;
    try {
      const result = await dispatchOp(op);
      updateOp(op.id, { status: 'completed', serverResult: result, lastError: null });
      outcome.completed += 1;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.isAuthError) {
          // Session problem - leave the op pending; the auth flow will surface
          // the expiry and the op syncs after re-login.
          updateOp(op.id, { status: 'pending', lastError: 'Waiting for sign-in.' });
          outcome.remaining = countOpsByStatus(userId).pending;
          break;
        }
        if (error.code === 'CONFLICT') {
          updateOp(op.id, { status: 'requires_review', lastError: error.message });
          outcome.review += 1;
          continue;
        }
        if (error.code === 'VALIDATION_ERROR' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND') {
          updateOp(op.id, { status: 'failed', lastError: error.message });
          outcome.failed += 1;
          continue;
        }
      }
      // Transport-level ambiguity.
      const isSafe = SAFE_TO_RETRY_OPS.has(op.type);
      const retryCount = op.retryCount + 1;
      if (isSafe && retryCount <= MAX_AUTO_RETRIES) {
        updateOp(op.id, { status: 'pending', retryCount, lastError: shortError(error) });
        outcome.remaining += 1;
        break; // surface to the caller; next trigger retries with backoff
      }
      updateOp(op.id, {
        status: 'requires_review',
        retryCount,
        lastError: `${shortError(error)}${isSafe ? '' : ' — It is not known whether the server received this change. Review before retrying.'}`,
      });
      outcome.review += 1;
    }
  }

  if (outcome.completed > 0) {
    kvSet(userId, LAST_SYNC_KEY, new Date().toISOString());
  }
  pruneCompletedOps(userId);
  return outcome;
}

export function pendingCount(userId: string): number {
  const counts = countOpsByStatus(userId);
  return counts.pending + counts.syncing;
}

export function opCounts(userId: string): Record<OutboxStatus, number> {
  return countOpsByStatus(userId);
}

export function reviewOpAfterUserDecision(opId: string, decision: 'retry' | 'discard'): void {
  const op = getOp(opId);
  if (!op) return;
  if (decision === 'retry') {
    // The user has checked the server state and wants the op re-applied.
    updateOp(opId, { status: 'pending', retryCount: 0, lastError: null });
  } else {
    updateOp(opId, { status: 'failed', lastError: 'Discarded after review.' });
  }
}
