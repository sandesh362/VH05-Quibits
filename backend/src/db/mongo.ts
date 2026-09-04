/**
 * MongoDB connection lifecycle.
 *
 * PHASE 1 SCOPE: connect, ping, disconnect. No collections, no schemas, no
 * indexes - those arrive in Phase 2 (docs/DEVELOPMENT_ROADMAP.md).
 *
 * The server starts even when Mongo is unavailable; readiness reports it as
 * down. Crashing on a missing dependency makes local development miserable and
 * hides the real error behind a restart loop.
 */
import { MongoClient, type Db } from 'mongodb';
import { getConfig, redactUri } from '../config/env.js';
import { getLogger } from '../core/logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;
let connecting: Promise<void> | null = null;

export function getMongoClient(): MongoClient | null {
  return client;
}

export function getDb(): Db | null {
  return db;
}

export function isMongoConnected(): boolean {
  return client !== null && db !== null;
}

/**
 * Establish the connection. Resolves on success, rejects on failure.
 * Safe to call repeatedly - concurrent calls share one attempt.
 */
export async function connectMongo(): Promise<void> {
  if (isMongoConnected()) return;
  if (connecting) return connecting;

  const config = getConfig();
  const log = getLogger();

  connecting = (async () => {
    const nextClient = new MongoClient(config.mongo.uri, {
      serverSelectionTimeoutMS: config.mongo.connectTimeoutMs,
      connectTimeoutMS: config.mongo.connectTimeoutMs,
      // Small pool: single-node local deployment, 1-5 concurrent users.
      maxPoolSize: 10,
      minPoolSize: 1,
      retryWrites: true,
      appName: config.appName,
    });

    try {
      await nextClient.connect();
      await nextClient.db(config.mongo.dbName).command({ ping: 1 });

      client = nextClient;
      db = nextClient.db(config.mongo.dbName);

      log.info(
        { uri: redactUri(config.mongo.uri), database: config.mongo.dbName },
        'MongoDB connected',
      );
    } catch (error) {
      await nextClient.close().catch(() => undefined);
      client = null;
      db = null;
      throw error;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/**
 * Connect without throwing. Used at startup so a missing database degrades
 * readiness instead of preventing the process from booting.
 */
export async function connectMongoSafely(): Promise<boolean> {
  try {
    await connectMongo();
    return true;
  } catch (error) {
    getLogger().warn(
      { err: error instanceof Error ? error.message : String(error) },
      'MongoDB unavailable at startup - the API will report NOT READY until it recovers',
    );
    return false;
  }
}

/**
 * TEST-ONLY: point the singleton at an externally managed database.
 *
 * Integration tests run a real mongod via mongodb-memory-server and need the
 * application code - which resolves its handle through `getDb()` - to use it.
 * Guarded so it can never take effect in a running deployment.
 */
export function setDbForTests(nextDb: Db | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setDbForTests() is only available when NODE_ENV=test.');
  }
  db = nextDb;
}

export async function disconnectMongo(): Promise<void> {
  if (!client) return;
  try {
    await client.close();
    getLogger().info('MongoDB connection closed');
  } catch (error) {
    getLogger().warn({ err: error }, 'Error while closing the MongoDB connection');
  } finally {
    client = null;
    db = null;
  }
}
