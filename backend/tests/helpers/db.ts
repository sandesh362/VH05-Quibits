/**
 * Test database harness.
 *
 * Every integration test runs against a REAL mongod, started in-process by
 * mongodb-memory-server and backed by a temp directory. A mock would not
 * exercise the things most likely to break: unique indexes, collations,
 * partial filter expressions, and duplicate-key errors.
 *
 * The instance is per-process and torn down afterwards, so no test ever
 * touches a developer's real database. `MONGODB_URI` in tests/setup.ts points
 * at an unroutable port precisely so a missed override fails loudly instead of
 * silently connecting somewhere real.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { ensureIndexes } from '../../src/database/indexes.js';

let server: MongoMemoryServer | null = null;
let client: MongoClient | null = null;
let db: Db | null = null;

/** Boot mongod, connect, and create the production index set. */
export async function startTestDb(): Promise<Db> {
  if (db) return db;

  server = await MongoMemoryServer.create({ instance: { dbName: 'itp_test' } });
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db('itp_test');

  // Real indexes: uniqueness and collation behaviour are under test.
  await ensureIndexes(db);

  return db;
}

export function getTestDb(): Db {
  if (!db) throw new Error('Test database not started. Call startTestDb() first.');
  return db;
}

export async function stopTestDb(): Promise<void> {
  await client?.close().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  client = null;
  server = null;
  db = null;
}

/**
 * Empty every collection between tests while KEEPING the indexes.
 *
 * `deleteMany` rather than `dropDatabase`: dropping would also drop the
 * indexes, and tests that assert on duplicate-key behaviour would then pass
 * for the wrong reason.
 */
export async function clearTestDb(): Promise<void> {
  if (!db) return;
  const existing = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(
    existing.map((collection) => db!.collection(collection.name).deleteMany({})),
  );
}
