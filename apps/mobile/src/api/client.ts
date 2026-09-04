/**
 * Central API client for the mobile app.
 *
 * Talks ONLY to the existing Express API (`/api/v1`). Rules:
 *  - Unwraps the shared envelope; failures become ApiError (see errors.ts).
 *  - Attaches the access token; on 401 it refreshes ONCE (single-flight) and
 *    retries the original request once, then gives up and reports expiry.
 *  - Safe (read) requests get one automatic retry on network errors/timeouts.
 *  - Request timeout via AbortController; callers can pass their own signal.
 *  - Never logs passwords, tokens or Authorization headers.
 */
import { isApiFailure, type ApiResponse, type PaginationMeta } from '@itp/shared';
import { env } from '@/config/env';
import { ApiError } from './errors';

export interface EnvelopeMeta {
  requestId: string;
  timestamp: string;
  pagination?: PaginationMeta;
}

export interface ApiResult<T> {
  data: T;
  meta?: EnvelopeMeta;
  status: number;
}

export type TokenProvider = () => Promise<string | null>;

export interface ClientHooks {
  getToken: TokenProvider;
  /** Attempt a refresh; resolves with a new access token or null on failure. */
  refresh: () => Promise<string | null>;
  /** Invoked when the session is definitively expired. */
  onUnauthorized: () => void;
}

let hooks: ClientHooks = {
  getToken: async () => null,
  refresh: async () => null,
  onUnauthorized: () => {},
};

export function configureClient(next: ClientHooks): void {
  hooks = next;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** False for endpoints that must never silently retry (mutations). */
  autoRetry?: boolean;
  /** False for auth endpoints - prevents refresh recursion. */
  authenticated?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Endpoints that must never trigger the refresh-retry flow. */
const PATHS_EXEMPT_FROM_REFRESH = ['/auth/login', '/auth/refresh', '/auth/logout'];

function buildUrl(path: string, query?: QueryParams): string {
  const base = path.startsWith('/') ? path : `/${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function fetchOnce<T>(
  path: string,
  query: QueryParams | undefined,
  options: RequestOptions,
  token: string | null,
): Promise<ApiResult<T>> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);

  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${buildUrl(path, query)}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    if (signal?.aborted) throw new ApiError('ABORTED', 'Request cancelled.');
    if (controller.signal.aborted) throw new ApiError('TIMEOUT', `Request timed out after ${timeoutMs / 1000}s.`);
    throw new ApiError('NETWORK_ERROR', 'Cannot reach the API.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  let parsed: ApiResponse<T> & { meta?: EnvelopeMeta };
  try {
    parsed = (await response.json()) as ApiResponse<T> & { meta?: EnvelopeMeta };
  } catch {
    throw new ApiError(
      'MALFORMED_RESPONSE',
      `The API returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (isApiFailure(parsed)) {
    throw new ApiError(
      parsed.error.code,
      parsed.error.message,
      response.status,
      parsed.error.requestId,
      parsed.error.details,
    );
  }
  if (parsed?.success !== true || parsed.data === undefined) {
    throw new ApiError('MALFORMED_RESPONSE', 'The API response did not match the expected format.', response.status);
  }
  return { data: parsed.data, meta: parsed.meta, status: response.status };
}

export async function request<T>(
  path: string,
  options: RequestOptions & { query?: QueryParams } = {},
): Promise<ApiResult<T>> {
  const isRead = options.method === undefined || options.method === 'GET';
  const autoRetry = options.autoRetry ?? isRead;
  const authenticated = options.authenticated ?? true;
  const exempt = PATHS_EXEMPT_FROM_REFRESH.some((p) => path === p || path.startsWith(`${p}?`));

  let token = authenticated ? await hooks.getToken() : null;
  let refreshedAlready = false;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce<T>(path, options.query, options, token);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR', 'Cannot reach the API.');

      // Session expiry: refresh once, retry the original request once.
      if (apiError.isAuthError && authenticated && !exempt && !refreshedAlready) {
        refreshedAlready = true;
        const newToken = await hooks.refresh();
        if (newToken) {
          token = newToken;
          continue;
        }
        hooks.onUnauthorized();
        throw apiError;
      }

      // One automatic retry for safe requests on transient failures.
      if (autoRetry && apiError.isRetryable && attempt < 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw apiError;
    }
  }
}

export async function dataOf<T>(
  path: string,
  options: RequestOptions & { query?: QueryParams } = {},
): Promise<T> {
  const result = await request<T>(path, options);
  return result.data;
}

/** A paginated list endpoint returns `data: T[]` + `meta.pagination`. */
export interface Page<T> {
  items: T[];
  pagination: PaginationMeta;
}

export async function pageOf<T>(
  path: string,
  query?: QueryParams,
  options: RequestOptions = {},
): Promise<Page<T>> {
  const result = await request<T[]>(path, { ...options, query });
  return {
    items: result.data,
    pagination:
      result.meta?.pagination ?? {
        page: 1,
        limit: result.data.length,
        total: result.data.length,
        totalPages: 1,
      },
  };
}

export const get = <T,>(path: string, options?: RequestOptions & { query?: QueryParams }) =>
  dataOf<T>(path, options);
export const post = <T,>(path: string, body?: unknown, options?: RequestOptions) =>
  dataOf<T>(path, { ...options, method: 'POST', body });
export const patch = <T,>(path: string, body?: unknown, options?: RequestOptions) =>
  dataOf<T>(path, { ...options, method: 'PATCH', body });
export const del = <T,>(path: string, body?: unknown, options?: RequestOptions) =>
  dataOf<T>(path, { ...options, method: 'DELETE', body });
