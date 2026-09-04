/**
 * Real dependency probes for the readiness endpoint.
 *
 * Every function performs an ACTUAL network operation. There are no hardcoded
 * "healthy" responses anywhere in this file - a probe either reaches the
 * dependency or reports why it could not.
 *
 * Failure messages are sanitised: no credentials, no connection strings.
 */
import type { DependencyCheck } from '@itp/shared';
import { getConfig } from '../config/env.js';
import { connectMongo, getMongoClient, isMongoConnected } from '../db/mongo.js';

/** Reduce a thrown value to a short, safe, credential-free summary. */
function sanitiseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\/\/[^@\s/]+@/g, '//***:***@') // strip user:pass@ from URIs
    .replace(/(api[_-]?key|token|password)=[^\s&]+/gi, '$1=***')
    .slice(0, 200);
}

/** fetch() with a hard timeout so a hung dependency cannot stall readiness. */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * MongoDB: issues a real `ping` command.
 * Required for readiness - nothing works without the database.
 */
export async function checkMongo(timeoutMs: number): Promise<DependencyCheck> {
  const started = Date.now();
  const base = { name: 'mongodb', required: true } as const;

  try {
    if (!isMongoConnected()) {
      // Attempt a (re)connect so readiness recovers automatically once Mongo returns.
      await connectMongo();
    }

    const client = getMongoClient();
    if (!client) throw new Error('No MongoDB client available');

    const ping = client.db(getConfig().mongo.dbName).command({ ping: 1 });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Ping timed out')), timeoutMs),
    );
    await Promise.race([ping, timeout]);

    return {
      ...base,
      status: 'ok',
      latencyMs: Date.now() - started,
      detail: `Database "${getConfig().mongo.dbName}" reachable`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      latencyMs: Date.now() - started,
      error: sanitiseError(error),
      impact: 'The API cannot serve data. Check that the mongo container is running.',
    };
  }
}

/**
 * Qdrant: GET /readyz (falls back to the root endpoint on older builds).
 * NOT required for readiness in Phase 1 - no vector feature exists yet, so the
 * API is fully usable without it.
 */
export async function checkQdrant(timeoutMs: number): Promise<DependencyCheck> {
  const config = getConfig();
  const started = Date.now();
  const base = { name: 'qdrant', required: false } as const;

  const headers: Record<string, string> = {};
  if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;

  try {
    let response = await fetchWithTimeout(`${config.qdrant.url}/readyz`, timeoutMs, { headers });
    if (response.status === 404) {
      response = await fetchWithTimeout(`${config.qdrant.url}/`, timeoutMs, { headers });
    }

    if (!response.ok) {
      return {
        ...base,
        status: 'down',
        latencyMs: Date.now() - started,
        error: `HTTP ${response.status}`,
        impact: 'Vector search will be unavailable (not used in Phase 1).',
      };
    }

    return {
      ...base,
      status: 'ok',
      latencyMs: Date.now() - started,
      detail: 'Vector database reachable. No collections created yet (Phase 4).',
    };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      latencyMs: Date.now() - started,
      error: sanitiseError(error),
      impact: 'Vector search will be unavailable (not used in Phase 1).',
    };
  }
}

/**
 * RAG service: GET /internal/v1/health on the FastAPI service.
 * NOT required for readiness in Phase 1 - no AI feature is wired up yet.
 */
export async function checkRagService(timeoutMs: number): Promise<DependencyCheck> {
  const config = getConfig();
  const started = Date.now();
  const base = { name: 'rag-service', required: false } as const;
  const url = `${config.ragService.url}${config.ragService.apiPrefix}/health`;

  try {
    const response = await fetchWithTimeout(url, timeoutMs);

    if (!response.ok) {
      return {
        ...base,
        status: 'down',
        latencyMs: Date.now() - started,
        error: `HTTP ${response.status}`,
        impact: 'Document processing and AI answers will be unavailable.',
      };
    }

    /**
     * The RAG service replies with the shared envelope, so the health fields
     * live under `data`. Fall back to the top level in case the service is
     * ever fronted by something that unwraps it.
     */
    const body = (await response.json()) as {
      service?: string;
      version?: string;
      data?: { service?: string; version?: string };
    };
    const payload = body.data ?? body;

    return {
      ...base,
      status: 'ok',
      latencyMs: Date.now() - started,
      detail: `FastAPI service reachable (${payload.service ?? 'rag-service'} v${payload.version ?? 'unknown'})`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      latencyMs: Date.now() - started,
      error: sanitiseError(error),
      impact: 'Document processing and AI answers will be unavailable.',
    };
  }
}

/**
 * Ollama: GET /api/tags, then verify the configured models are actually pulled.
 *
 * Reachable-but-model-missing is reported as `degraded`, not `ok` - a green
 * light with no model would be a fake health response.
 *
 * NOT required for readiness in Phase 1.
 */
export async function checkOllama(timeoutMs: number): Promise<DependencyCheck> {
  const config = getConfig();
  const started = Date.now();
  const base = { name: 'ollama', required: false } as const;

  try {
    const response = await fetchWithTimeout(`${config.ollama.baseUrl}/api/tags`, timeoutMs);

    if (!response.ok) {
      return {
        ...base,
        status: 'down',
        latencyMs: Date.now() - started,
        error: `HTTP ${response.status}`,
        impact: 'AI answers and embeddings will be unavailable.',
      };
    }

    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    const installed = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);

    // A model is present if the tag matches exactly or the base name matches
    // (Ollama reports "nomic-embed-text:latest" for "nomic-embed-text").
    const has = (wanted: string): boolean =>
      installed.some((name) => name === wanted || name.split(':')[0] === wanted.split(':')[0]);

    const missing: string[] = [];
    if (config.ollama.embeddingModel && !has(config.ollama.embeddingModel)) {
      missing.push(config.ollama.embeddingModel);
    }
    if (config.ollama.chatModel && !has(config.ollama.chatModel)) {
      missing.push(config.ollama.chatModel);
    }

    if (missing.length > 0) {
      return {
        ...base,
        status: 'degraded',
        latencyMs: Date.now() - started,
        detail: `Reachable with ${installed.length} model(s) installed`,
        error: `Configured model(s) not pulled: ${missing.join(', ')}. Run: ollama pull ${missing[0]}`,
        impact: 'Embeddings and AI answers will fail until the model is pulled.',
      };
    }

    const chatNote = config.ollama.chatModel
      ? `chat=${config.ollama.chatModel}`
      : 'chat model not configured (expected in Phase 1)';

    return {
      ...base,
      status: 'ok',
      latencyMs: Date.now() - started,
      detail: `Reachable. ${installed.length} model(s) installed. ${chatNote}`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      latencyMs: Date.now() - started,
      error: sanitiseError(error),
      impact: 'AI answers and embeddings will be unavailable. Is `ollama serve` running on the host?',
    };
  }
}

/** Run every probe concurrently. Total time is the slowest probe, not the sum. */
export async function runAllChecks(): Promise<DependencyCheck[]> {
  const { healthCheckTimeoutMs } = getConfig();
  return Promise.all([
    checkMongo(healthCheckTimeoutMs),
    checkQdrant(healthCheckTimeoutMs),
    checkRagService(healthCheckTimeoutMs),
    checkOllama(healthCheckTimeoutMs),
  ]);
}
