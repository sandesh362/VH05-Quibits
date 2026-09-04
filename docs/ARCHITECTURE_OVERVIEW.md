# Architecture Overview (Phase 1)

What exists **right now**, after Phase 1. This is an as-built document, not a
plan. For the full target design see [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md);
for the roadmap see [DEVELOPMENT_ROADMAP.md](./DEVELOPMENT_ROADMAP.md).

---

## 1. Topology

```
                            YOUR MACHINE
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Browser                                                           │
│      │  http://localhost:5173                                       │
│      ▼                                                              │
│   ┌──────────────────────────┐                                      │
│   │  Frontend                │  Vite dev server (dev)               │
│   │  React 18 + TS           │  nginx (docker)                      │
│   │                          │  proxies /api ──┐                    │
│   └──────────────────────────┘                 │                    │
│                                                ▼                    │
│                                   ┌──────────────────────────┐      │
│                                   │  Express API      :8080  │      │
│      ONLY PUBLIC SURFACE ────────▶│  TypeScript              │      │
│                                   │  /api/v1                 │      │
│                                   └───┬────────┬────────┬────┘      │
│                        ┌──────────────┘        │        └────────┐  │
│                        ▼                       ▼                 ▼  │
│         ┌─────────────────────┐  ┌──────────────────┐  ┌───────────┐│
│         │ MongoDB      :27017 │  │ FastAPI    :8000 │  │  Ollama   ││
│         │ loopback only       │  │ internal only    │  │  :11434   ││
│         └─────────────────────┘  │ /internal/v1     │  │  on HOST  ││
│                                  └────────┬─────────┘  └───────────┘│
│         ┌─────────────────────┐           │                  ▲      │
│         │ Qdrant        :6333 │◀──────────┴──────────────────┘      │
│         │ loopback only       │                                     │
│         └─────────────────────┘                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
             No traffic leaves this machine. No cloud AI.
```

### The rule that shapes everything

**The browser talks to Express and nothing else.** It never addresses MongoDB,
Qdrant, Ollama, or the FastAPI service — not even in development.

This is why:

- **Security.** Mongo and Qdrant are bound to `127.0.0.1` and the FastAPI
  container publishes no ports at all. They are unreachable from the network even
  if something else on your machine is compromised.
- **One trust boundary.** Authentication, rate limiting, and validation land in
  Phase 2 in exactly one place instead of four.
- **No CORS.** The frontend calls the relative path `/api/v1/...`; the dev proxy
  or nginx forwards it. Same-origin throughout.
- **Portability.** The browser never needs to know a service hostname, which
  matters because the browser is not necessarily on the same host as the
  containers.

---

## 2. Services as built

### Frontend — `frontend/`

React 18, TypeScript, Vite 5, React Router 6. Plain CSS with custom properties;
no UI framework yet.

| Path | Purpose |
|---|---|
| `src/main.tsx` | Entry point: error boundary → router → app |
| `src/App.tsx` | Route table |
| `src/layouts/app-layout.tsx` | Header, nav, content outlet, footer |
| `src/pages/home-page.tsx` | Connection proof + implementation status |
| `src/pages/status-page.tsx` | Live dependency dashboard, polls every 15 s |
| `src/lib/api-client.ts` | **The only place `fetch` is called** |
| `src/lib/use-api.ts` | Loading/error/data state hook |
| `src/components/states.tsx` | Shared loading, error, and empty states |
| `src/components/error-boundary.tsx` | Catches render crashes |

### Express API — `backend/`

TypeScript, Express 4, Zod for config validation, Pino for logging, the official
MongoDB driver.

| Path | Purpose |
|---|---|
| `src/server.ts` | Startup, listen, graceful shutdown |
| `src/app.ts` | Middleware chain and route mounting |
| `src/config/env.ts` | Zod schema; **fails fast** on bad config |
| `src/core/logger.ts` | Structured logger with redaction |
| `src/core/api-error.ts` | Typed error class → error codes |
| `src/middleware/request-context.ts` | Request ID generation/propagation |
| `src/middleware/request-logging.ts` | One structured line per request |
| `src/middleware/error-handler.ts` | Central error → envelope, plus 404 |
| `src/db/mongo.ts` | Connection lifecycle and ping |
| `src/clients/dependency-checks.ts` | **Real probes** of all four dependencies |
| `src/modules/health/` | `/health`, `/ready` |
| `src/modules/system/` | `/system/info` |

Modular monolith, not microservices: `src/modules/<feature>/` is where Phase 2+
features are added.

### FastAPI service — `ai-service/`

Python 3.11, FastAPI, Pydantic v2, structlog, Motor.

| Path | Purpose |
|---|---|
| `app/main.py` | App factory, lifespan, exception handlers |
| `app/core/config.py` | Pydantic settings; fails fast |
| `app/core/logging.py` | JSON structlog with request-ID context |
| `app/core/errors.py` | Error envelope mirroring the Express one |
| `app/core/middleware.py` | Request ID + access logging |
| `app/clients/health_checks.py` | Real Qdrant / Ollama / Mongo probes |
| `app/routers/health.py` | `/health`, `/ready`, `/system/info` |
| `app/rag/` | **Empty.** Placeholder for Phase 3–5 |

It exists now, with zero AI in it, so that later phases add code to a service
that already starts, logs, and is monitored — rather than debugging a new service
and a new pipeline at once.

### Shared types — `packages/shared/`

A tiny TypeScript package imported by both the backend and frontend. It holds the
response envelope types, the 13 error codes, and the health/readiness/system-info
shapes. One definition, so a backend change that breaks the frontend fails at
compile time.

The Python service **mirrors** these shapes by hand in `app/core/errors.py`,
since it cannot import TypeScript. The two must be changed together.

---

## 3. Request lifecycle

```
Browser
  └─ GET /api/v1/ready
       │
       ▼
  Vite proxy / nginx          rewrite → http://api:8080/api/v1/ready
       │
       ▼
  ┌─────────────────────────────── Express ──────────────────────────────┐
  │ 1. CORS                                                              │
  │ 2. Request context   ── assign or accept X-Request-Id                │
  │ 3. Body parser       ── JSON, capped at REQUEST_BODY_LIMIT           │
  │ 4. Request logging   ── start line                                   │
  │ 5. Route handler     ── probe dependencies concurrently              │
  │ 6. Response          ── success envelope, 200 or 503                 │
  │ 7. Error handler     ── on throw: failure envelope, no stack in prod │
  │ 8. Request logging   ── completion line with status + duration       │
  └──────────────────────────────────────────────────────────────────────┘
```

Every log line for one request carries the same `requestId`, so a failure can be
traced across both services.

---

## 4. Response contract

Success:

```json
{
  "success": true,
  "data": { "...": "endpoint-specific" },
  "meta": {
    "requestId": "req_b563b649-3291-4957-b067-b60fdc6165c8",
    "timestamp": "2026-09-04T06:36:49.922Z"
  }
}
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found: GET /api/v1/does-not-exist",
    "requestId": "req_06f1c54e-833c-475b-8b25-19a84372d34b"
  }
}
```

`error.stack` is added **only** when `NODE_ENV !== 'production'`. Both services
emit byte-identical shapes. Full endpoint reference:
[SERVICE_CONTRACTS.md](./SERVICE_CONTRACTS.md).

---

## 5. Health vs readiness

Two distinct questions, deliberately separated:

| | `/health` | `/ready` |
|---|---|---|
| Question | Is the process alive? | Can it actually do its job? |
| Probes dependencies | **No** | **Yes** |
| Typical latency | < 5 ms | up to `HEALTH_CHECK_TIMEOUT_MS` |
| Status codes | 200 | 200 ready, 503 not ready |
| Used by | Docker healthcheck, restart logic | The status page, humans |

`/health` must never probe dependencies. If it did, a downed database would make
Docker kill and restart a perfectly healthy API container in a loop.

### Required vs optional dependencies

| Dependency | Required in Phase 1 | If down |
|---|---|---|
| MongoDB | **Yes** | `/ready` → 503 |
| Qdrant | No | `degraded`, 200 |
| FastAPI | No | `degraded`, 200 |
| Ollama | No | `degraded`, 200 |

Only Mongo is required, because Phase 1 has no feature that uses the other three.
As each phase lands, its dependency graduates to required.

**Every probe is a real network call.** Mongo gets an actual `ping` command,
Qdrant a `GET /readyz`, FastAPI a `GET /internal/v1/health`, Ollama a
`GET /api/tags` plus a check that the configured model is in the returned list.
Nothing returns a hardcoded `"healthy"`.

---

## 6. Configuration

One `.env` at the repository root feeds all three services — one file to edit, no
chance of the backend and the RAG service disagreeing about a URL.

Both services validate their configuration **at import time** and exit with a
non-zero status on a problem, printing every error at once. Startup fails when:

- a required variable is missing
- `JWT_SECRET` or `INTERNAL_SERVICE_TOKEN` is shorter than 32 characters
- a secret still contains a placeholder such as `change_me`
- `JWT_REFRESH_SECRET` equals `JWT_SECRET`
- `MONGODB_URI` points at Atlas, or any URL points at a hosted AI provider

A misconfigured service must fail loudly at boot, not mysteriously at 2 a.m.

---

## 7. Logging

Structured, one JSON object per event, with `timestamp`, `level`, `service`,
`requestId`, and `event`. Pretty-printed in development, raw JSON in production.

**Never logged:** passwords, JWTs, `INTERNAL_SERVICE_TOKEN`, API keys, connection
strings with credentials, or (from Phase 3) document contents and full user
messages. Connection strings are redacted to
`mongodb://***:***@localhost:27017/itp` before they reach a log line, which you
can see in the real startup output.

---

## 8. Deliberate omissions

| Not used | Why |
|---|---|
| Kubernetes | A single machine runs five containers. Compose is sufficient. |
| Redis | No proven need. Phase 0 found no cache or session requirement that Mongo cannot serve. |
| Kafka / job queue | Phase 3 processes one manual at a time; a Mongo-backed job document is enough. |
| Nginx in development | The Vite proxy already provides same-origin. Nginx is used in Docker only. |
| Mongo replica set | Recommended in Phase 0 for transactions, **not enabled yet** — it complicates the connection string and needs an init step. Revisit in Phase 2 when multi-document writes appear. |
| A state library (Redux etc.) | Two pages and three read-only endpoints. |
| A component library | The design system arrives in Phase 9. |

---

## 9. What Phase 2 changes

- Auth middleware in Express, `users` collection, login/refresh routes
- `ensureIndexes()` runs at startup
- The Mongo replica set decision gets made
- The frontend gains a login page and an auth-aware API client
