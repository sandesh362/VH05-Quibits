# Phase 2 — Backend Foundation

**Status:** complete, pending review
**Scope:** data layer, authentication, authorization, CRUD, validation, audit logging, tests
**Explicitly out of scope:** PDF processing, embeddings, Qdrant, RAG, any LLM call

---

## 1. What Phase 2 delivers

Phase 1 produced a running skeleton: an Express app that could answer health probes and report which dependencies were reachable. It had no database collections, no users, and no domain endpoints.

Phase 2 turns that skeleton into a working backend. Concretely:

| Capability | Before (Phase 1) | After (Phase 2) |
|---|---|---|
| Collections | none | 11 + a `counters` helper collection |
| Indexes | none | 51 created at startup |
| Users / auth | none | register, login, refresh, logout, change password |
| Authorization | none | 4 roles over ~36 capabilities, deny-by-default |
| Domain endpoints | none | 30 across 7 modules |
| Validation | config only | every endpoint, body and query |
| Audit logging | none | every state-changing operation |
| Backend tests | 42 | 149 |

The AI features remain absent, and `/system/info` says so — `PHASE_2_FEATURES` reports `authentication: true` and every document/AI flag `false`. The frontend reads those flags, so it cannot advertise a capability the backend does not have.

---

## 2. Architecture

### 2.1 Layering

Each domain module is split the same way, and the separation is enforced by what each file is allowed to import:

```
routes       → declares paths + the capability each requires
controller   → parses input, calls the service, serialises the response
validators   → zod schemas; the only place request shapes are defined
service      → business rules, cross-entity checks, audit writes
```

There is no repository class per entity. `common/repository.ts` holds the handful of helpers that would otherwise be duplicated — `liveFilter`, `paginate`, timestamp builders, duplicate-key translation — and services call the typed collection accessors directly. A per-entity repository wrapping single-collection calls would have been indirection without benefit at this size; the shared helpers capture the parts that actually repeat.

**No business logic lives in a route handler.** Routes contain path strings and capability names, nothing else.

### 2.2 Directory layout

```
backend/src/
├── app.ts                      Express assembly, router mounting
├── server.ts                   boot sequence, index creation, shutdown
├── config/env.ts               validated configuration (fail-fast)
├── core/
│   ├── api-error.ts            ApiError + response envelopes
│   └── logger.ts               pino, with redaction
├── common/
│   ├── async-handler.ts        promise → error middleware bridge
│   ├── password.ts             Argon2id hashing + strength policy
│   ├── policy.ts               the RBAC capability map
│   ├── repository.ts           soft-delete filter, pagination, timestamps
│   ├── sequences.ts            atomic counters (incident numbers)
│   ├── tokens.ts               JWT signing, refresh token issue/hash
│   └── validation.ts           shared zod primitives, operator rejection
├── database/
│   ├── bootstrap.ts            first-run indexes + optional admin
│   ├── collections.ts          document interfaces + typed accessors
│   └── indexes.ts              every index, each with a stated caller
├── middleware/
│   ├── authenticate.ts         authenticate / optionalAuthenticate / authorize
│   ├── rate-limit.ts           credential-endpoint limiter
│   ├── request-context.ts      request id + scoped logger   (Phase 1)
│   ├── request-logging.ts      access log                    (Phase 1)
│   └── error-handler.ts        envelope + 404                (Phase 1)
├── modules/
│   ├── audit/                  append-only audit writer
│   ├── auth/                   register, login, refresh, logout, me
│   ├── conversations/          container only — no AI
│   ├── incident-actions/       append-only work log
│   ├── incidents/              incidents + the resolution gate
│   ├── machine-models/
│   ├── machines/
│   ├── maintenance/
│   ├── manuals/                metadata only
│   ├── health/                                               (Phase 1)
│   └── system/                                               (Phase 1)
└── scripts/create-admin.ts     explicit admin setup command
```

---

## 3. Decisions worth explaining

### 3.1 Resolution confirmation is a separate endpoint

`PATCH /incidents/:id` cannot set `status: "resolved"`. It returns a validation error pointing at `POST /incidents/:id/confirm-resolution`.

This looks like friction, and it is deliberate. Phase 4 treats confirmed incidents as ground truth for "this fix worked before". If a resolution could be recorded by flipping a dropdown, the corpus would fill with incidents someone closed at the end of a shift. The confirmation endpoint requires a root cause *and* a nominated action whose recorded outcome is `worked` — so every confirmed incident can answer "what actually fixed it?".

`resolution_status` is a separate axis from `status` for the same reason: an incident can be administratively `closed` while remaining `unresolved`, and only the resolution axis feeds retrieval.

### 3.2 Manuals are metadata, and the API cannot lie about them

`processing_status` is written exactly once, as `queued`, at creation. The update endpoint rejects `processingStatus`, `indexedChunkCount` and `indexedAt` with an explicit message rather than a generic "unknown field", because the honest answer is "the pipeline owns this, and it does not exist yet".

`isSearchable` is derived on read (`ready && indexed_chunk_count > 0`), never stored, so it cannot drift out of sync with reality. In Phase 2 it is always `false`.

### 3.3 Conversations return 501 rather than a stub reply

`POST /conversations/:id/messages` returns `NOT_IMPLEMENTED` and stores nothing. Two alternatives were rejected: returning a canned assistant message (a fake AI response), and storing the user's message for later (a growing backlog of questions nobody can answer, which looks like a bug and complicates Phase 5).

### 3.4 Deletion refuses rather than cascades

- A machine model with machines or manuals → **409**, listing the dependents.
- A machine with incidents or maintenance → **409**, telling the operator to set `status: "retired"` instead.

Cascading would silently destroy failure history. The error names what is blocking so the operator can act.

Incident actions have **no delete at all** — not even soft delete. A mistake is corrected by appending, or by editing within 24 hours with the previous text preserved in `edit_history`.

### 3.5 Timing-safe, enumeration-free login

Every login failure returns the same code and message. When the email is unknown the service still verifies against a dummy Argon2 hash so the response time matches a real verification. The account-inactive check runs *after* password verification for the same reason — checking it first would turn the endpoint into an account-existence oracle.

### 3.6 The first user becomes an admin

A fresh install with RBAC cannot bootstrap itself: creating an admin requires being one. Three mechanisms, no default credentials anywhere:

1. The first account ever registered becomes `admin` (audited as `first_user_bootstrap`).
2. `BOOTSTRAP_ADMIN_*` env vars create one at startup, only when `users` is empty.
3. `npm run create-admin` does the same on demand.

Self-registration after the first user **always** yields `viewer`, regardless of what the request body asks for. A requested `role` is ignored rather than rejected, so probing reveals nothing.

### 3.7 No transactions

The compose file ships a single-node MongoDB, where multi-document transactions are unavailable without converting to a replica set. Phase 2 avoids needing them: the operations that touch two documents are a write plus a denormalised counter update (`machine_count`, `open_incident_count`, `last_maintenance_at`). A crash between the two leaves a counter slightly stale — these are display-only values, never query filters, and `last_maintenance_at` is recomputed from the records themselves rather than incremented.

Anything that must be exact uses a single atomic operation: unique indexes for duplicate prevention, `findOneAndUpdate` with `$inc` for incident numbers.

---

## 4. Files created and modified

### Created (34)

**Shared contracts / config**
- `backend/src/database/collections.ts`, `indexes.ts`, `bootstrap.ts`
- `backend/src/common/policy.ts`, `password.ts`, `tokens.ts`, `validation.ts`, `repository.ts`, `sequences.ts`, `async-handler.ts`
- `backend/src/middleware/authenticate.ts`, `rate-limit.ts`
- `backend/src/scripts/create-admin.ts`

**Modules** — each of `auth`, `machine-models`, `machines`, `manuals`, `incidents`, `maintenance`, `conversations` has `*.service.ts`, `*.controller.ts`, `*.validators.ts`, `*.routes.ts`; plus `audit/audit.service.ts` and `incident-actions/{service,controller,validators}`.

**Tests**
- `backend/tests/helpers/db.ts`, `helpers/app.ts`
- `backend/tests/auth.test.ts` (34), `authorization.test.ts` (14), `crud.test.ts` (33), `general.test.ts` (26)

### Modified (6)

| File | Change |
|---|---|
| `packages/shared/src/index.ts` | Phase 2 contracts: roles, capabilities, 16 enum tuples, pagination constants, `PublicUser`, `PHASE_2_FEATURES` |
| `backend/src/config/env.ts` | JWT issuer/audience, lockout + rate-limit settings, `INCIDENT_CONFIRMATION_MODE`, bootstrap-admin vars with all-or-nothing and placeholder validation |
| `backend/src/app.ts` | mounts the seven domain routers |
| `backend/src/server.ts` | calls `prepareDatabase()` after connecting |
| `backend/src/db/mongo.ts` | added `setDbForTests()`, guarded to `NODE_ENV=test` |
| `backend/src/modules/system/system.routes.ts` | reports Phase 2 and `PHASE_2_FEATURES` |
| `backend/tests/api.test.ts` | phase assertions updated; the AI flags are still asserted false |

### Fixed during Phase 2

Two defects the tests caught, both real:

1. **`indexes.ts`** declared `uniq_serial` with both `sparse: true` and `partialFilterExpression`. MongoDB rejects that combination outright — startup would have failed on a real server. The partial filter alone provides the sparse behaviour. Found the first time the suite ran against a real `mongod`.
2. **`policy.ts`** withheld `incident.confirm_resolution` from technicians, contradicting the §13.4 decision that `canConfirmResolution()` implements. The route gate rejected them before the ownership rule could run. Technicians now hold the capability; the service still enforces "your own incident, in `self` mode only".

---

## 5. Verification performed

- `npm run typecheck` — clean across all four workspaces
- `npm run test --workspace @itp/backend` — **149 passed**
- `npm run build --workspace @itp/backend` — compiles
- Booted against a real `mongod`: 51 indexes created, bootstrap admin created (password never logged), full incident lifecycle exercised over HTTP
- Booted with `NODE_ENV=production`: confirmed no stack traces, file paths, or internal detail in error responses

See `docs/TESTING.md` for the manual verification script.

---

## 6. Known gaps

Carried into later phases, all deliberate:

- **No user-administration endpoints.** Admins can create users via `POST /auth/register`, but there is no `GET /users`, no role-change endpoint, and no user deactivation endpoint. Changing a role currently requires a direct database edit. This is the largest functional gap and the first candidate for Phase 3.
- **In-memory rate limiting.** Correct for one node; a horizontally scaled deployment would need a shared store.
- **No JSON-Schema validators on the collections.** Validation is enforced in zod only. The Phase 0 design calls for `validationLevel: "moderate"` schemas as defence in depth against direct database writes.
- **No audit-log read endpoint.** Entries are written and queryable in the database, but no API exposes them.
- **Counters are eventually consistent** — see §3.7.
- **No TTL index on audit logs.** The Phase 0 design specifies 365-day expiry for `severity: "info"` entries via a partial TTL index; not yet added.

Security limitations are listed in `docs/SECURITY_NOTES.md`. **This is not a production-hardened system.**
