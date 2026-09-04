/**
 * Health and readiness endpoints.
 *
 *   GET /health  - process liveness. Never touches a dependency, so it stays
 *                  fast and is safe as a container healthcheck.
 *   GET /ready   - real dependency probes. Returns 503 when a REQUIRED
 *                  dependency is down, so orchestrators can act on it.
 */
import { Router, type Request, type Response } from 'express';
import type { HealthResponse, ReadinessResponse, ServiceStatus } from '@itp/shared';
import { getConfig } from '../../config/env.js';
import { runAllChecks } from '../../clients/dependency-checks.js';
import { successEnvelope } from '../../core/api-error.js';

/** Map a dependency name to the capability it powers, for degraded reporting. */
const CAPABILITY_BY_DEPENDENCY: Record<string, string[]> = {
  mongodb: ['data_persistence'],
  qdrant: ['vector_search'],
  'rag-service': ['document_processing', 'rag_answers'],
  ollama: ['embeddings', 'rag_generation'],
};

export function healthRoutes(): Router {
  const router = Router();
  const config = getConfig();

  router.get('/health', (req: Request, res: Response) => {
    const payload: HealthResponse = {
      status: 'ok',
      service: 'backend',
      version: config.version,
      environment: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(successEnvelope(payload, req.requestId));
  });

  router.get('/ready', async (req: Request, res: Response) => {
    const started = Date.now();
    const checks = await runAllChecks();

    const requiredDown = checks.some((c) => c.required && c.status !== 'ok');
    const optionalImpaired = checks.some(
      (c) => !c.required && (c.status === 'down' || c.status === 'degraded'),
    );

    let status: ServiceStatus = 'ok';
    if (requiredDown) status = 'down';
    else if (optionalImpaired) status = 'degraded';

    const degradedCapabilities = checks
      .filter((c) => c.status === 'down' || c.status === 'degraded')
      .flatMap((c) => CAPABILITY_BY_DEPENDENCY[c.name] ?? []);

    const payload: ReadinessResponse = {
      status,
      service: 'backend',
      ready: !requiredDown,
      checks,
      degradedCapabilities: [...new Set(degradedCapabilities)],
      durationMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };

    // 200 when usable (even if degraded), 503 when a required dependency is down.
    res.status(requiredDown ? 503 : 200).json(successEnvelope(payload, req.requestId));
  });

  return router;
}
