/**
 * Local SQLite database (expo-sqlite - Expo Go compatible).
 *
 * Holds ONLY: the offline operation queue (outbox), read-through snapshots of
 * recently viewed records (short TTL), and small per-user key/value state
 * (recents, last sync time). No tokens ever land here (SecureStore only).
 *
 * Every row carries `user_id`: data is isolated per signed-in account and
 * wiped on logout / account switch (see `wipeUserData`).
 *
 * A minimal `SqliteHandle` interface is exported so the whole layer runs under
 * Vitest against an in-memory driver without native modules.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'itp-mobile.db';
const SCHEMA_VERSION = 1;

export interface SqliteHandle {
  execSync(sql: string): void;
  runSync(sql: string, params?: unknown[]): { changes: number };
  getAllSync<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  getFirstSync<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
}

let handle: SqliteHandle | null = null;

/** Test hook: inject an in-memory driver. */
export function setDatabaseHandle(injected: SqliteHandle | null): void {
  handle = injected;
}

export function getDb(): SqliteHandle {
  if (!handle) {
    const db = SQLite.openDatabaseSync(DB_NAME);
    handle = db as unknown as SqliteHandle;
  }
  return handle;
}

const MIGRATIONS: Record<number, string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS kv (
       user_id TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (user_id, key)
     )`,
    `CREATE TABLE IF NOT EXISTS outbox (
       id TEXT PRIMARY KEY NOT NULL,
       user_id TEXT NOT NULL,
       type TEXT NOT NULL,
       payload TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       last_error TEXT,
       server_result TEXT,
       idempotency_key TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_user_status ON outbox (user_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS cache (
       user_id TEXT NOT NULL,
       cache_key TEXT NOT NULL,
       payload TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       PRIMARY KEY (user_id, cache_key)
     )`,
  ],
};

function migrate(db: SqliteHandle): void {
  db.execSync('PRAGMA journal_mode = WAL');
  const row = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const statements = MIGRATIONS[v] ?? [];
    for (const statement of statements) db.execSync(statement);
    db.execSync(`PRAGMA user_version = ${v}`);
  }
}

let initialized = false;

/**
 * Open + migrate the database. If the file is corrupted it is deleted and
 * recreated from scratch: losing offline snapshots is recoverable; crashing
 * at launch is not.
 */
export function initDatabase(): void {
  if (initialized) return;
  try {
    migrate(getDb());
    initialized = true;
  } catch {
    initialized = false;
    handle = null;
    try {
      SQLite.deleteDatabaseSync(DB_NAME);
    } catch {
      /* nothing to delete */
    }
    migrate(getDb());
    initialized = true;
  }
}

/** Recover ops stuck in `syncing` after a crash mid-sync (boot-time). */
export function resetStaleSyncing(userId: string): void {
  getDb().runSync(
    `UPDATE outbox SET status = 'pending', updated_at = ? WHERE user_id = ? AND status = 'syncing'`,
    [new Date().toISOString(), userId],
  );
}

/** Delete every local row belonging to a user (logout / account switch). */
export function wipeUserData(userId: string): void {
  const db = getDb();
  db.runSync('DELETE FROM outbox WHERE user_id = ?', [userId]);
  db.runSync('DELETE FROM cache WHERE user_id = ?', [userId]);
  db.runSync('DELETE FROM kv WHERE user_id = ?', [userId]);
}

/** Nuke expired cache rows (called opportunistically on sync). */
export function pruneExpiredCache(): void {
  getDb().runSync('DELETE FROM cache WHERE expires_at <= ?', [new Date().toISOString()]);
}

// --- Key/value state ---------------------------------------------------------

export function kvGet<T>(userId: string, key: string): T | null {
  const row = getDb().getFirstSync<{ value: string }>(
    'SELECT value FROM kv WHERE user_id = ? AND key = ?',
    [userId, key],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function kvSet(userId: string, key: string, value: unknown): void {
  getDb().runSync(
    `INSERT INTO kv (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [userId, key, JSON.stringify(value), new Date().toISOString()],
  );
}

export function kvDelete(userId: string, key: string): void {
  getDb().runSync('DELETE FROM kv WHERE user_id = ? AND key = ?', [userId, key]);
}
