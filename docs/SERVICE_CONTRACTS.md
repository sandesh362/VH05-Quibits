# Service Contracts (Phase 1)

Every endpoint that exists today, with real captured responses. Endpoints planned
for later phases are in [API_CONTRACTS.md](./API_CONTRACTS.md).

---

## 1. Response envelope

Every response from both services uses one of two shapes.

### Success

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "req_<uuid>",
    "timestamp": "2026-09-04T06:36:49.922Z"
  }
}
```

### Failure

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found: GET /api/v1/nope",
    "requestId": "req_<uuid>",
    "details": {},
    "stack": "only when NODE_ENV != production"
  }
}
```

`details` and `stack` are optional. **`stack` is omitted entirely in production.**

### Error codes

Defined once in `packages/shared/src/index.ts` and mirrored in
`ai-service/app/core/errors.py`. Changing one without the other is a bug.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body or params failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid credentials (Phase 2) |
| `FORBIDDEN` | 403 | Authenticated but not permitted (Phase 2) |
| `NOT_FOUND` | 404 | Route or resource does not exist |
| `METHOD_NOT_ALLOWED` | 405 | Route exists, wrong HTTP verb |
| `CONFLICT` | 409 | State conflict, e.g. duplicate key |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeded `REQUEST_BODY_LIMIT` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Wrong `Content-Type` |
| `UNPROCESSABLE_ENTITY` | 422 | Well-formed but semantically invalid |
| `RATE_LIMITED` | 429 | Too many requests (Phase 2) |
| `INTERNAL_SERVER_ERROR` | 500 | Unhandled server fault |
| `SERVICE_UNAVAILABLE` | 503 | A required dependency is down |
| `DEPENDENCY_UNAVAILABLE` | 503 | A specific downstream dependency failed |

---

## 2. Request correlation

Every request gets an ID, used in every related log line across both services.

- Send your own with the `X-Request-Id` header and it is adopted.
- Send nothing and one is generated as `req_<uuid4>`.
- A malformed or over-long value is rejected and replaced (it would otherwise be
  a log-injection vector).
- The ID always comes back in the `X-Request-Id` response header **and** in the
  body, under `meta.requestId` or `error.requestId`.

Verified:

```bash
$ curl -sD- -o/dev/null -H 'X-Request-Id: my-trace-001' \
    http://localhost:8080/api/v1/health | grep -i x-request-id
x-request-id: my-trace-001
```

---

## 3. Express API — public

Base URL: `http://localhost:8080/api/v1` (prefix configurable via `API_PREFIX`).

This is the **only** service the browser may call.

### `GET /health`

Process liveness. Does not touch any dependency. Used by the Docker healthcheck.

Always `200` while the process is running.

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "backend",
    "version": "0.1.0",
    "environment": "development",
    "uptimeSeconds": 256,
    "timestamp": "2026-09-04T06:41:28.319Z"
  },
  "meta": {
    "requestId": "req_da0831b8-48ea-4a11-b8d1-fe23d3302d13",
    "timestamp": "2026-09-04T06:41:28.319Z"
  }
}
```

### `GET /ready`

Probes every dependency concurrently and reports what it found.

| Status | Condition |
|---|---|
| `200` | All **required** dependencies are `ok` |
| `503` | Any required dependency is `down` |

A 503 here is a correct, informative response — the body is still a valid
readiness report, so clients must read the body rather than only the status code.

Real response with nothing else running:

```json
{
  "success": true,
  "data": {
    "status": "down",
    "service": "backend",
    "ready": false,
    "checks": [
      {
        "name": "mongodb",
        "required": true,
        "status": "down",
        "latencyMs": 8004,
        "error": "connect ECONNREFUSED ::1:27017, connect ECONNREFUSED 127.0.0.1:27017",
        "impact": "The API cannot serve data. Check that the mongo container is running."
      },
      {
        "name": "qdrant",
        "required": false,
        "status": "down",
        "latencyMs": 31,
        "error": "fetch failed",
        "impact": "Vector search will be unavailable (not used in Phase 1)."
      },
      {
        "name": "rag-service",
        "required": false,
        "status": "ok",
        "latencyMs": 14,
        "detail": "FastAPI service reachable (rag-service v0.1.0)"
      },
      {
        "name": "ollama",
        "required": false,
        "status": "down",
        "latencyMs": 6,
        "error": "fetch failed",
        "impact": "AI answers and embeddings will be unavailable. Is `ollama serve` running on the host?"
      }
    ],
    "degradedCapabilities": [
      "data_persistence", "vector_search", "embeddings", "rag_generation"
    ],
    "durationMs": 8004,
    "timestamp": "2026-09-04T06:36:57.961Z"
  },
  "meta": { "requestId": "req_...", "timestamp": "2026-09-04T06:36:57.961Z" }
}
```

#### Dependency status values

| Status | Meaning |
|---|---|
| `ok` | Probe succeeded |
| `degraded` | Reachable but not fully usable — e.g. Ollama is up but the configured model is not installed |
| `down` | Probe failed or timed out |
| `disabled` | Not configured; intentionally not probed |

#### The probes

| Dependency | Probe | Degraded when |
|---|---|---|
| `mongodb` | `db.adminCommand({ ping: 1 })` | — |
| `qdrant` | `GET {QDRANT_URL}/readyz` | — |
| `rag-service` | `GET {RAG_SERVICE_URL}/internal/v1/health` | — |
| `ollama` | `GET {OLLAMA_BASE_URL}/api/tags` | reachable, but `OLLAMA_CHAT_MODEL` is not in the list |

If `OLLAMA_CHAT_MODEL` is empty, Ollama is reported as *not configured* rather
than as a success. The platform never claims a model exists.

### `GET /system/info`

Build and configuration facts. Reveals no secret, URL, or credential.

```json
{
  "success": true,
  "data": {
    "service": "backend",
    "version": "0.1.0",
    "environment": "development",
    "phase": "Phase 1 - Infrastructure Foundation",
    "apiPrefix": "/api/v1",
    "nodeVersion": "v20.20.2",
    "platform": "linux x64",
    "uptimeSeconds": 256,
    "features": {
      "authentication": false,
      "manualUpload": false,
      "documentProcessing": false,
      "ocr": false,
      "embeddings": false,
      "vectorSearch": false,
      "ragAnswers": false,
      "incidentMemory": false,
      "maintenanceHistory": false
    },
    "timestamp": "2026-09-04T06:41:28.319Z"
  },
  "meta": { "requestId": "req_...", "timestamp": "..." }
}
```

Every feature flag is `false` in Phase 1. The frontend renders this table from
the response rather than hardcoding it, so the UI cannot drift from reality.

### Unknown routes

```bash
$ curl -s -w '\n%{http_code}\n' http://localhost:8080/api/v1/does-not-exist
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found: GET /api/v1/does-not-exist",
    "requestId": "req_06f1c54e-833c-475b-8b25-19a84372d34b"
  }
}
404
```

---

## 4. FastAPI service — internal

Base URL: `http://localhost:8000/internal/v1` (configurable via `RAG_API_PREFIX`).

**Not reachable from the browser.** In Docker it publishes no ports; only the
`api` container can reach it over the `itp-net` network.

The `/internal/v1` prefix is a deliberate signal: these endpoints are not part of
the public API and carry no compatibility guarantee.

### `GET /health`

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "rag-service",
    "version": "0.1.0",
    "environment": "development",
    "uptimeSeconds": 20,
    "timestamp": "2026-09-04T06:37:04.031907Z"
  },
  "meta": {
    "requestId": "req_7513278a-0b65-44d5-886b-ed91477420d0",
    "timestamp": "2026-09-04T06:37:04.031962Z"
  }
}
```

### `GET /ready`

Same contract as the Express `/ready`, probing Qdrant, Ollama, and (when
configured) MongoDB. No dependency is required in Phase 1, because the service
has no work to do yet — so it reports `degraded` rather than `down`.

When `MONGODB_URI` is unset, Mongo is reported as `disabled`, not as a failure.

### `GET /system/info`

Mirrors the Express version, with `pythonVersion` instead of `nodeVersion` and
all feature flags `false`.

### `GET /healthz`

Unversioned liveness alias used by the container healthcheck, so the probe does
not break if `RAG_API_PREFIX` changes.

### Error shape

Identical to Express, which is what makes cross-service correlation possible:

```bash
$ curl -s http://localhost:8000/internal/v1/nope
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found: GET /internal/v1/nope",
    "requestId": "req_015de0fd-c0d5-47f7-ad88-c1cd2fbd58ab"
  }
}
```

---

## 5. Service-to-service authentication

Express authenticates to FastAPI with a shared secret:

```
X-Internal-Token: <INTERNAL_SERVICE_TOKEN>
```

- Both services read the same value from the root `.env`.
- Must be at least 32 characters; both refuse to start otherwise.
- **Health endpoints are exempt**, so monitoring works even if the token is
  misconfigured — otherwise a token typo would look identical to a downed
  service.
- Enforcement on non-health endpoints begins in Phase 3, when the first real
  internal endpoint exists.

---

## 6. Frontend → backend

The browser only ever calls the relative path `VITE_API_BASE_URL` (default
`/api/v1`).

| Mode | Who proxies | Where it goes |
|---|---|---|
| `npm run dev` | Vite dev server | `VITE_DEV_PROXY_TARGET`, default `http://localhost:8080` |
| Docker | nginx in the `web` container | `http://api:8080` over `itp-net` |

Because the request is same-origin in both modes, no CORS preflight ever occurs
and the bundle contains no hostname. `CORS_ORIGIN` exists in the Express config
for the case where someone runs the frontend on a genuinely different origin; it
is unused in the standard setup.

All calls go through `frontend/src/lib/api-client.ts`, which:

- unwraps the envelope and returns `data` directly
- converts any failure into a typed `ApiClientError` with a stable `code`
- treats a 503 with a valid readiness body as **success**, so the status page can
  render the outage instead of showing a generic error
- applies a 15 s timeout (20 s for `/ready`, which probes dependencies)
- exposes `isRetryable` so the UI knows whether to offer a retry button
