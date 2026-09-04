/**
 * Centralised API client.
 *
 * Every network call in the app goes through here. Rules:
 *  - Only relative URLs. The browser is not necessarily on the same host as
 *    the containers, so it must never address a service directly. The Vite dev
 *    proxy (and nginx in Docker) forwards /api to Express.
 *  - Never talks to FastAPI, Qdrant, MongoDB or Ollama.
 *  - Always unwraps the shared envelope and normalises failures into ApiClientError.
 */
import {
  isApiFailure,
  type ApiErrorCode,
  type ApiResponse,
  type HealthResponse,
  type ReadinessResponse,
  type SystemInfoResponse,
} from '@itp/shared';

/** Relative by default so the request stays same-origin. */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Normalised client-side error. `code` is stable; `message` is for humans. */
export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'TIMEOUT' | 'MALFORMED_RESPONSE',
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** True when retrying could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT' ||
      this.code === 'SERVICE_UNAVAILABLE' ||
      this.code === 'DEPENDENCY_UNAVAILABLE' ||
      (this.status !== undefined && this.status >= 500)
    );
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Perform a request and unwrap the envelope.
 *
 * A non-2xx status is NOT automatically an error: /ready returns 503 with a
 * perfectly valid readiness body. Errors are decided by the envelope's
 * `success` flag, not the status code.
 */
async function request<T>(
  path: string,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Honour an externally supplied signal (e.g. component unmount).
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiClientError('TIMEOUT', `Request timed out after ${timeoutMs / 1000}s.`);
    }
    throw new ApiClientError(
      'NETWORK_ERROR',
      'Cannot reach the API. Is the backend running?',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError(
      'MALFORMED_RESPONSE',
      `The API returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (isApiFailure(body)) {
    throw new ApiClientError(
      body.error.code,
      body.error.message,
      response.status,
      body.error.requestId,
    );
  }

  if (body?.success !== true || body.data === undefined) {
    throw new ApiClientError(
      'MALFORMED_RESPONSE',
      'The API response did not match the expected format.',
      response.status,
    );
  }

  return body.data;
}

export const apiClient = {
  /** Process liveness. Fast; does not probe dependencies. */
  getHealth: (options?: RequestOptions) => request<HealthResponse>('/health', options),

  /**
   * Dependency readiness. Returns HTTP 503 when a required dependency is down,
   * but the body is still a valid readiness report - so this resolves rather
   * than throwing, and the UI renders the real state.
   */
  getReadiness: (options?: RequestOptions) =>
    request<ReadinessResponse>('/ready', { timeoutMs: 20_000, ...options }),

  /** Build and configuration facts. */
  getSystemInfo: (options?: RequestOptions) =>
    request<SystemInfoResponse>('/system/info', options),
};

export { BASE_URL as apiBaseUrl };
