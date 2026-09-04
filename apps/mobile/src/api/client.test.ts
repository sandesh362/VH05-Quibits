/**
 * API client behaviour: envelope unwrapping, error normalization, the
 * refresh-once-and-retry flow on 401, retry rules for safe requests,
 * timeouts and malformed responses.
 */
import { configureClient } from './client';
import { ApiError } from './errors';

const json = (payload: unknown, status = 200) =>
  Promise.resolve({
    status,
    ok: status < 400,
    json: () => Promise.resolve(payload),
  } as Response);

const okEnvelope = (data: unknown) => ({
  success: true,
  data,
  meta: { requestId: 'req_1', timestamp: new Date().toISOString() },
});

const failEnvelope = (code: string, message: string, status: number, details?: unknown) => ({
  success: false,
  error: { code, message, requestId: 'req_1', details },
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function configure(overrides: Partial<{ token: string | null; refreshResult: string | null }> = {}) {
  const onUnauthorized = jest.fn();
  const refresh = jest.fn(async () => overrides.refreshResult ?? null);
  configureClient({
    getToken: async () => overrides.token ?? 'token-1',
    refresh,
    onUnauthorized,
  });
  return { onUnauthorized, refresh };
}

/**
 * Return the client module from the shared registry. configureClient() is a
 * full state reset, so no module isolation is needed between tests (isolating
 * would fork the module registry and break ApiError instanceof checks).
 */
function loadClient(): typeof import('./client') {
  return require('./client');
}

describe('api client - envelope handling', () => {
  it('unwraps a success envelope', async () => {
    global.fetch = jest.fn().mockImplementation(() => json(okEnvelope({ hello: 'world' })));
    const { get } = loadClient();
    await expect(get('/machines')).resolves.toEqual({ hello: 'world' });
  });

  it('normalizes failure envelopes into ApiError with code and details', async () => {
    global.fetch = jest.fn().mockImplementation(() =>
      json(failEnvelope('VALIDATION_ERROR', 'Invalid.', 422, [{ field: 'title', issue: 'Required' }]), 422),
    );
    configure();
    const { get } = loadClient();
    const error = await get('/incidents').catch((e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).fieldError('title')).toBe('Required');
  });

  it('maps non-JSON responses to MALFORMED_RESPONSE', async () => {
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new Error('not json')) } as Response),
    );
    configure();
    const { get } = loadClient();
    await expect(get('/anything')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});

describe('api client - auth', () => {
  it('attaches the bearer token', async () => {
    const fetchMock = jest.fn().mockImplementation(() => json(okEnvelope({})));
    global.fetch = fetchMock;
    configure({ token: 'tok' });
    const { get } = loadClient();
    await get('/machines');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('on 401 refreshes once and retries the original request', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(() => json(failEnvelope('UNAUTHENTICATED', 'Expired.', 401), 401))
      .mockImplementationOnce(() => json(okEnvelope({ second: true })));
    global.fetch = fetchMock;
    const { refresh, onUnauthorized } = configure({ refreshResult: 'token-2' });
    const { get } = loadClient();
    await expect(get('/machines')).resolves.toEqual({ second: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
    // Second attempt carries the new token.
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-2' });
  });

  it('reports expiry when refresh fails and rethrows the 401', async () => {
    global.fetch = jest.fn().mockImplementation(() => json(failEnvelope('UNAUTHENTICATED', 'Expired.', 401), 401));
    const { refresh, onUnauthorized } = configure({ refreshResult: null });
    const { get } = loadClient();
    await expect(get('/machines')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('never triggers the refresh flow for auth endpoints themselves', async () => {
    const fetchMock = jest.fn().mockImplementation(() => json(failEnvelope('UNAUTHENTICATED', 'Bad credentials.', 401), 401));
    global.fetch = fetchMock;
    const { refresh } = configure();
    const { post } = loadClient();
    await expect(post('/auth/login', {}, { authenticated: false })).rejects.toBeInstanceOf(ApiError);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('api client - retries and timeouts', () => {
  it('retries safe (GET) requests once on network errors', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockImplementationOnce(() => json(okEnvelope({ recovered: true })));
    global.fetch = fetchMock;
    configure();
    const { get } = loadClient();
    await expect(get('/machines')).resolves.toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry POST requests', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    global.fetch = fetchMock;
    configure();
    const { post } = loadClient();
    await expect(post('/incidents', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps timeouts to TIMEOUT', async () => {
    const fetchMock = jest.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    global.fetch = fetchMock;
    configure();
    const { get } = loadClient();
    await expect(get('/machines', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
