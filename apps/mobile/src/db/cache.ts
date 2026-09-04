/**
 * Read-through snapshot cache.
 *
 * Recently viewed machines, incidents and conversations are cached with a
 * short TTL so the app can render them offline (clearly labeled as cached
 * copies). Sensitive data is kept to what the technician recently opened -
 * never bulk dumps - and everything is user-scoped and wiped on logout.
 */
import { getDb, kvGet, kvSet } from './database';

export const CACHE_TTL_MS = {
  machines: 24 * 60 * 60 * 1000,
  incidents: 12 * 60 * 60 * 1000,
  conversations: 60 * 60 * 1000,
} as const;

export function cachePut(userId: string, key: string, payload: unknown, ttlMs: number): void {
  const now = new Date();
  getDb().runSync(
    `INSERT INTO cache (user_id, cache_key, payload, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, cache_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
    [userId, key, JSON.stringify(payload), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()],
  );
}

export function cacheGet<T>(userId: string, key: string): T | null {
  const row = getDb().getFirstSync<{ payload: string; expires_at: string }>(
    'SELECT payload, expires_at FROM cache WHERE user_id = ? AND cache_key = ?',
    [userId, key],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    getDb().runSync('DELETE FROM cache WHERE user_id = ? AND cache_key = ?', [userId, key]);
    return null;
  }
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function cacheClear(userId: string, prefix?: string): void {
  if (prefix) {
    getDb().runSync('DELETE FROM cache WHERE user_id = ? AND cache_key LIKE ?', [userId, `${prefix}%`]);
  } else {
    getDb().runSync('DELETE FROM cache WHERE user_id = ?', [userId]);
  }
}

// --- Recently accessed (kv-backed, capped) -------------------------------------

export interface RecentEntry {
  id: string;
  label: string;
  subtitle?: string;
  at: string;
}

const RECENTS_LIMIT = 8;

export function pushRecent(
  userId: string,
  kind: 'machines' | 'incidents',
  entry: { id: string; label: string; subtitle?: string },
): void {
  const key = `recents.${kind}`;
  const existing = kvGet<RecentEntry[]>(userId, key) ?? [];
  const next: RecentEntry[] = [
    { ...entry, at: new Date().toISOString() },
    ...existing.filter((item) => item.id !== entry.id),
  ].slice(0, RECENTS_LIMIT);
  kvSet(userId, key, next);
}

export function readRecents(userId: string, kind: 'machines' | 'incidents'): RecentEntry[] {
  return kvGet<RecentEntry[]>(userId, `recents.${kind}`) ?? [];
}
