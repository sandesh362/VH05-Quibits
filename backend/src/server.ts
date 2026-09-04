/**
 * Server bootstrap: config validation -> storage check -> Mongo -> listen,
 * plus graceful shutdown.
 *
 * Boot order is deliberate. Configuration is validated FIRST so a missing
 * secret produces one clear message instead of a confusing downstream failure.
 */
import type { Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ConfigValidationError, getConfig, redactUri, type AppConfig } from './config/env.js';
import { getLogger } from './core/logger.js';
import { createApp } from './app.js';
import { connectMongoSafely, disconnectMongo } from './db/mongo.js';

/** Grace period for in-flight requests before the socket is forced closed. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Ensure the storage tree exists and is writable before accepting traffic. */
async function ensureStorageDirectories(config: AppConfig): Promise<void> {
  const root = path.resolve(config.storageRoot);
  const subdirectories = ['manuals', 'processed', 'page-images', 'temporary'];

  await mkdir(root, { recursive: true });
  await Promise.all(
    subdirectories.map((dir) => mkdir(path.join(root, dir), { recursive: true })),
  );

  getLogger().debug({ storageRoot: root }, 'Storage directories ready');
}

function registerShutdown(server: Server): void {
  const log = getLogger();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'Graceful shutdown initiated');

    // Force-exit guard: never hang forever on a stuck connection.
    const forceTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out - forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 1. Stop accepting new connections, drain the in-flight ones.
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info('HTTP server closed');

      // 2. Release dependencies.
      await disconnectMongo();

      clearTimeout(forceTimer);
      log.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'Error during shutdown');
      clearTimeout(forceTimer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'Uncaught exception - shutting down');
    void shutdown('uncaughtException');
  });
}

async function main(): Promise<void> {
  // --- 1. Validate configuration (fail fast, with an actionable message) ----
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error('\n Configuration validation failed. The server will not start.\n');
      for (const issue of error.issues) console.error(`   - ${issue}`);
      console.error('\n  Fix: copy .env.example to .env and set the required values.');
      console.error('  Generate secrets with: openssl rand -hex 32\n');
      process.exit(1);
    }
    throw error;
  }

  const log = getLogger();
  log.info(
    {
      phase: 'Phase 1 - Infrastructure Foundation',
      environment: config.nodeEnv,
      apiPrefix: config.apiPrefix,
      mongo: redactUri(config.mongo.uri),
      qdrant: config.qdrant.url,
      ragService: config.ragService.url,
      ollama: config.ollama.baseUrl,
    },
    'Starting Express API',
  );

  // --- 2. Storage ----------------------------------------------------------
  await ensureStorageDirectories(config);

  // --- 3. MongoDB (non-fatal: readiness reports the outage) ----------------
  await connectMongoSafely();

  // --- 4. Listen -----------------------------------------------------------
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    log.info(
      { port: config.port, url: `http://localhost:${config.port}${config.apiPrefix}` },
      `API listening on port ${config.port}`,
    );
  });

  server.headersTimeout = 65_000;
  server.requestTimeout = 60_000;

  registerShutdown(server);
}

void main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
