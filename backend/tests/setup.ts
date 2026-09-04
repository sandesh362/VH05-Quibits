/**
 * Test environment bootstrap.
 *
 * Sets a valid, self-contained configuration BEFORE any module reads
 * process.env. Values point at unroutable ports so dependency probes fail fast
 * and deterministically rather than accidentally hitting a real service.
 */
process.env.NODE_ENV = 'test';
process.env.APP_NAME = 'itp-test';
process.env.PORT = '8080';
process.env.API_PREFIX = '/api/v1';
process.env.LOG_LEVEL = 'silent';

// Deliberately unreachable: port 1 is never bound.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/itp_test';
process.env.MONGO_DB_NAME = 'itp_test';
process.env.MONGO_CONNECT_TIMEOUT_MS = '500';
process.env.HEALTH_CHECK_TIMEOUT_MS = '1000';

process.env.QDRANT_URL = 'http://127.0.0.1:1';
process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1';
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';

// 64-char test secrets. Not real credentials; never used outside tests.
process.env.JWT_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.INTERNAL_SERVICE_TOKEN = 'c'.repeat(64);

process.env.STORAGE_ROOT = './storage';
process.env.CORS_ORIGIN = 'http://localhost:5173';
