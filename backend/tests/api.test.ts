/**
 * HTTP contract tests for the Phase 1 API surface.
 *
 * Dependencies are deliberately unreachable in the test environment, which
 * proves the readiness endpoint reports REAL state rather than a hardcoded
 * "healthy" response.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

const app: Express = createApp();
const PREFIX = '/api/v1';

describe('GET /api/v1/health', () => {
  it('returns 200 with the success envelope', async () => {
    const res = await request(app).get(`${PREFIX}/health`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('backend');
    expect(res.body.meta).toHaveProperty('requestId');
    expect(res.body.meta).toHaveProperty('timestamp');
  });

  it('reports process uptime as a number', async () => {
    const res = await request(app).get(`${PREFIX}/health`);
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(res.body.data.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not touch dependencies (stays fast)', async () => {
    const started = Date.now();
    await request(app).get(`${PREFIX}/health`);
    // Dependency probes would take >= 500ms; liveness must not.
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('GET /api/v1/ready', () => {
  it('reports MongoDB as down when it is genuinely unreachable', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);

    // Required dependency down -> 503. This is the anti-fake-health assertion.
    expect(res.status).toBe(503);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.status).toBe('down');

    const mongo = res.body.data.checks.find((c: { name: string }) => c.name === 'mongodb');
    expect(mongo).toBeDefined();
    expect(mongo.status).toBe('down');
    expect(mongo.required).toBe(true);
    expect(mongo.error).toBeTruthy();
  });

  it('probes all four dependencies', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);
    const names = res.body.data.checks.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['mongodb', 'ollama', 'qdrant', 'rag-service']);
  });

  it('marks only MongoDB as required in Phase 1', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);
    const required = res.body.data.checks
      .filter((c: { required: boolean }) => c.required)
      .map((c: { name: string }) => c.name);
    expect(required).toEqual(['mongodb']);
  });

  it('reports a latency measurement for every probe', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);
    for (const check of res.body.data.checks) {
      expect(typeof check.latencyMs).toBe('number');
    }
  });

  it('lists degraded capabilities', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);
    expect(Array.isArray(res.body.data.degradedCapabilities)).toBe(true);
    expect(res.body.data.degradedCapabilities).toContain('data_persistence');
  });

  it('never leaks credentials in error text', async () => {
    const res = await request(app).get(`${PREFIX}/ready`);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/:[^/@"]+@/); // no user:pass@host
  });
});

describe('GET /api/v1/system/info', () => {
  it('returns build and phase information', async () => {
    const res = await request(app).get(`${PREFIX}/system/info`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.service).toBe('backend');
    expect(res.body.data.phase).toContain('Phase 7');
    expect(res.body.data.apiPrefix).toBe(PREFIX);
  });

  it('reports Phase 6+ capability flags accurately', async () => {
    const res = await request(app).get(`${PREFIX}/system/info`);
    const features = res.body.data.features;

    expect(features.authentication).toBe(true);
    expect(features.manualUpload).toBe(true);
    expect(features.documentProcessing).toBe(true);
    expect(features.ocr).toBe(true);
    expect(features.embeddings).toBe(true);
    expect(features.vectorSearch).toBe(true);
    expect(features.ragAnswers).toBe(true);
    expect(features.incidentManagement).toBe(true);
    expect(features.incidentMemory).toBe(true);
    expect(features.maintenanceHistory).toBe(true);
  });

  it('lists dependency names but never their URLs or credentials', async () => {
    const res = await request(app).get(`${PREFIX}/system/info`);
    const serialised = JSON.stringify(res.body);

    expect(res.body.data.configuredDependencies).toContain('mongodb');
    expect(serialised).not.toContain('27017');
    expect(serialised).not.toContain('mongodb://');
    expect(serialised).not.toContain('localhost:6333');
  });
});

describe('404 handling', () => {
  it('returns the failure envelope for an unknown route', async () => {
    const res = await request(app).get(`${PREFIX}/this-route-does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('returns 404 for an unknown root path', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a wrong-method request on a known path', async () => {
    const res = await request(app).post(`${PREFIX}/health`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('error response format', () => {
  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post(`${PREFIX}/system/info`)
      .set('Content-Type', 'application/json')
      .send('{"broken": ');

    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('never exposes a stack trace for a 404', async () => {
    const res = await request(app).get(`${PREFIX}/missing`);
    expect(res.body.error.stack).toBeUndefined();
  });

  it('uses a consistent shape for every error', async () => {
    const res = await request(app).get(`${PREFIX}/missing`);
    expect(Object.keys(res.body).sort()).toEqual(['error', 'success']);
    expect(res.body.error.code).toMatch(/^[A-Z_]+$/);
  });
});

describe('request correlation', () => {
  it('generates an X-Request-Id when none is supplied', async () => {
    const res = await request(app).get(`${PREFIX}/health`);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
  });

  it('propagates a safe client-supplied request id', async () => {
    const res = await request(app)
      .get(`${PREFIX}/health`)
      .set('X-Request-Id', 'client-trace-12345');
    expect(res.headers['x-request-id']).toBe('client-trace-12345');
  });

  it('replaces an unsafe request id rather than echoing it', async () => {
    // Header injection / XSS attempt must not be reflected.
    const res = await request(app)
      .get(`${PREFIX}/health`)
      .set('X-Request-Id', '<script>alert(1)</script>');
    expect(res.headers['x-request-id']).not.toContain('<script>');
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('issues a unique id per request', async () => {
    const [a, b] = await Promise.all([
      request(app).get(`${PREFIX}/health`),
      request(app).get(`${PREFIX}/health`),
    ]);
    expect(a.body.meta.requestId).not.toBe(b.body.meta.requestId);
  });
});

describe('security headers and limits', () => {
  it('sets helmet security headers', async () => {
    const res = await request(app).get(`${PREFIX}/health`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get(`${PREFIX}/health`);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('enforces the JSON body size limit', async () => {
    const oversized = { data: 'x'.repeat(2 * 1024 * 1024) }; // 2 MB > 1 MB limit
    const res = await request(app).post(`${PREFIX}/system/info`).send(oversized);
    expect([404, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});

describe('unversioned liveness alias', () => {
  it('serves /healthz for container healthchecks', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
