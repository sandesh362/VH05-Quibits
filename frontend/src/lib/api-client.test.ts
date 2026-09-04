/**
 * API client tests.
 *
 * Covers the required Phase 1 checks: the client handles success, handles
 * failure, and never mistakes a valid-but-503 readiness report for an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiClient } from './api-client';

/** Build a fetch Response-like object. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const successEnvelope = (data: unknown) => ({
  success: true,
  data,
  meta: { requestId: 'req_test_123', timestamp: '2026-09-04T00:00:00.000Z' },
});

const failureEnvelope = (code: string, message: string) => ({
  success: false,
  error: { code, message, requestId: 'req_test_456' },
});

describe('apiClient success handling', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('unwraps the envelope and returns data', async () => {
    const payload = { status: 'ok', service: 'backend', version: '0.1.0' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(successEnvelope(payload))),
    );

    const result = await apiClient.getHealth();
    expect(result).toEqual(payload);
  });

  it('requests a relative URL so the call stays same-origin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(successEnvelope({ status: 'ok' })));
    vi.stubGlobal('fetch', fetchMock);

    await apiClient.getHealth();

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url.startsWith('/')).toBe(true);
    // The browser must never address a service host directly.
    expect(url).not.toContain('http://');
    expect(url).not.toContain('localhost');
  });

  it('resolves a 503 readiness report rather than throwing', async () => {
    // /ready legitimately returns 503 with a valid body when Mongo is down.
    const readiness = {
      status: 'down',
      service: 'backend',
      ready: false,
      checks: [{ name: 'mongodb', status: 'down', required: true, latencyMs: 12 }],
      degradedCapabilities: ['data_persistence'],
      durationMs: 30,
      timestamp: '2026-09-04T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(successEnvelope(readiness), 503)),
    );

    const result = await apiClient.getReadiness();
    expect(result.ready).toBe(false);
    expect(result.checks[0]?.status).toBe('down');
  });
});

describe('apiClient failure handling', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('throws ApiClientError carrying the server error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(failureEnvelope('NOT_FOUND', 'Route not found'), 404)),
    );

    await expect(apiClient.getHealth()).rejects.toThrowError(ApiClientError);

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiClientError;
      expect(apiError.code).toBe('NOT_FOUND');
      expect(apiError.status).toBe(404);
      expect(apiError.requestId).toBe('req_test_456');
    }
  });

  it('reports a network failure as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiClientError;
      expect(apiError.code).toBe('NETWORK_ERROR');
      expect(apiError.message).toContain('Cannot reach the API');
      expect(apiError.isRetryable).toBe(true);
    }
  });

  it('reports a non-JSON response as MALFORMED_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      } as unknown as Response),
    );

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiClientError).code).toBe('MALFORMED_RESPONSE');
    }
  });

  it('rejects a response that does not match the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiClientError).code).toBe('MALFORMED_RESPONSE');
    }
  });

  it('marks 4xx client errors as not retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(failureEnvelope('VALIDATION_ERROR', 'Bad input'), 422)),
    );

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiClientError).isRetryable).toBe(false);
    }
  });

  it('marks 5xx errors as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(failureEnvelope('INTERNAL_SERVER_ERROR', 'Boom'), 500),
        ),
    );

    try {
      await apiClient.getHealth();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiClientError).isRetryable).toBe(true);
    }
  });
});
