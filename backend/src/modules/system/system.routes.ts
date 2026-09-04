/**
 * GET /system/info - non-sensitive build and configuration facts.
 *
 * Deliberately exposes NO hostnames, URLs, ports, credentials or file paths.
 * It reports WHICH dependencies are configured, never WHERE they live.
 */
import os from 'node:os';
import { Router, type Request, type Response } from 'express';
import { PHASE_4_FEATURES, type SystemInfoResponse } from '@itp/shared';
import { getConfig } from '../../config/env.js';
import { successEnvelope } from '../../core/api-error.js';

const STARTED_AT = new Date().toISOString();

export function systemRoutes(): Router {
  const router = Router();
  const config = getConfig();

  router.get('/system/info', (req: Request, res: Response) => {
    // Names only. Never the URLs.
    const configuredDependencies = ['mongodb', 'qdrant', 'rag-service', 'ollama'];

    const payload: SystemInfoResponse = {
      service: 'backend',
      version: config.version,
      environment: config.nodeEnv,
      apiPrefix: config.apiPrefix,
      nodeVersion: process.version,
      platform: `${os.type()} ${os.arch()}`,
      phase: 'Phase 4 - Retrieval Engine and RAG Pipeline',
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
      features: PHASE_4_FEATURES,
      configuredDependencies,
    };

    res.status(200).json(successEnvelope(payload, req.requestId));
  });

  return router;
}
