# API_CONTRACTS.md

Covers brief §14 (API boundaries) and §15 (background jobs). **No implementation code.**
Tags: **[C]** **[A]** **[R]** **[U]**.

---

## 1. Conventions

| Aspect | Rule |
|---|---|
| Base | Express public: `/api/v1/*` · FastAPI internal: `/internal/v1/*` (**never** browser-reachable) |
| Auth | `Authorization: Bearer <access_jwt>`; refresh via httpOnly cookie. Internal calls use `X-Internal-Token` + `X-Request-Id`. |
| Content | `application/json`, except manual upload (`multipart/form-data`) and byte responses |
| Errors | Uniform envelope (below). Never leak stack traces, file paths, or internal hostnames to non-admins. |
| Pagination | `?page=1&limit=20` (max 100) → `{items, page, limit, total, has_more}`; **[R]** cursor pagination for the timeline |
| Filtering | Explicit allowlisted query params only — never a raw Mongo query object from the client |
| Idempotency | Mutating POSTs that create expensive artefacts accept `Idempotency-Key`; natural keys used where possible |
| Sync/async | Marked per endpoint. Long work returns `202` + a `job_id`. |
| Versioning | `v1` in the path; the response contract carries its own `schema_version` |

**Error envelope**
```json
{ "error": { "code": "MANUAL_NOT_READY", "message": "Human-readable, safe to display.",
             "details": [{"field":"machine_model_id","issue":"required"}],
             "request_id": "req_01J…", "retryable": false } }
```
**Codes:** `VALIDATION_ERROR` 422 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
`CONFLICT` 409 · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_MEDIA_TYPE` 415 · `RATE_LIMITED` 429 ·
`INTERNAL_ERROR` 500 · `SERVICE_UNAVAILABLE` 503 (Ollama/Qdrant/AI service down) ·
`INSUFFICIENT_STORAGE` 507.

---

## 2. Express — public API

### 2.1 `/api/v1/auth`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/login` | Issue tokens | none | sync |
| POST | `/refresh` | Rotate refresh → new access | refresh cookie | sync |
| POST | `/logout` | Revoke the presented refresh token | bearer | sync |
| GET | `/me` | Current user + capabilities | bearer | sync |
| POST | `/change-password` | Self-service | bearer | sync |

**POST /login** — body `{username|email, password}` → `200 {access_token, expires_in, user:{id,
username, full_name, role, must_change_password}}` + `Set-Cookie: refresh_token`.
Validation: both fields present, length caps. Errors: `401 UNAUTHENTICATED` (generic message —
no user enumeration), `423 LOCKED` after 5 failures/15 min **[A]**, `429`. Idempotency: n/a
(each call issues a new token). **Sec:** rate limit 10/min/IP; audit success and failure;
constant-ish-time comparison; never log the password field.

**POST /refresh** — no body; the cookie is single-use and rotated. Reuse of a consumed token
revokes the whole family and forces re-login (`401`), audited as `security`.

**POST /change-password** — `{current_password, new_password}`; increments `token_version`
(logging out every other session) and clears `must_change_password`.

### 2.2 `/api/v1/users` — admin (read: admin/manager)

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| GET | `/` | List (paginated, filter by role/active) | admin, manager(read) | sync |
| POST | `/` | Create user | admin | sync |
| GET | `/:id` | Detail | admin, manager | sync |
| PATCH | `/:id` | Update name/role/active | admin | sync |
| POST | `/:id/reset-password` | Admin reset → temp password | admin | sync |
| DELETE | `/:id` | Deactivate (soft) | admin | sync |

**POST /** — `{username, email, full_name, role, password?}`. Validation: uniqueness (409),
role enum, password policy. **Never** returns `password_hash`. `PATCH` role change bumps
`token_version`. `DELETE` refuses on the last active admin (`409 LAST_ADMIN`).

### 2.3 `/api/v1/machine-models`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| GET | `/` | List/search (`?q=&machine_type=`) | any | sync |
| POST | `/` | Create | admin, manager | sync |
| GET | `/:id` | Detail + counts + indexing readiness | any | sync |
| PATCH | `/:id` | Update | admin, manager | sync |
| DELETE | `/:id` | Soft delete | admin | sync |
| GET | `/:id/manuals` | Manuals for the model | any | sync |
| GET | `/:id/machines` | Machines of the model | any | sync |

**POST /** — `{manufacturer, model_name, machine_type, aliases[], model_year?,
specifications?}` → `201`. **Idempotency:** natural key `(manufacturer, model_name)`
case-insensitive → a duplicate returns `409` **with the existing id**, so a retried client can
proceed. `DELETE` → `409 HAS_DEPENDENTS` listing dependent machines/manuals.

### 2.4 `/api/v1/machines`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| GET | `/` | List (`?q=&model_id=&status=&line=`) | any | sync |
| POST | `/` | Create | admin, manager | sync |
| GET | `/:id` | Detail (model, manual readiness, open incidents) | any | sync |
| PATCH | `/:id` | Update (status, location, criticality, notes) | admin, manager | sync |
| POST | `/:id/modifications` | Record a modification | admin, manager | sync |
| DELETE | `/:id` | Soft delete / retire | admin | sync |
| GET | `/:id/timeline` | Merged events (cursor paginated) | any | sync |
| GET | `/:id/incidents` | Incidents for the machine | any | sync |
| GET | `/:id/maintenance` | Maintenance for the machine | any | sync |

**POST /** — `{asset_tag, machine_model_id, display_name?, serial_number?, location?, status?,
installed_at?, criticality?}` → `201`. Validation: `asset_tag` charset + uniqueness (409),
model exists and is not deleted (422). `asset_tag` is immutable on PATCH **[R]**.
Changing `machine_model_id` requires `reason` and is audited at `warning` severity.
**GET /:id/timeline** — `?types=incident,maintenance,manual&cursor=&limit=` → typed events
sorted desc; annotates temporal proximity between maintenance and incidents.

### 2.5 `/api/v1/manuals`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/` | **Upload PDF** | admin, manager | **async** (202-style: 201 + job) |
| GET | `/` | List (`?model_id=&status=&q=`) | any | sync |
| GET | `/:id` | Detail + processing summary | any | sync |
| PATCH | `/:id` | Edit metadata (title, version, type, current-version flag) | admin, manager | sync |
| DELETE | `/:id` | Soft delete + **vector purge** | admin, manager | sync (purge) |
| POST | `/:id/reindex` | Re-process | admin, manager | async |
| GET | `/:id/job` | Latest job status | any | sync |
| GET | `/:id/jobs` | Job history (traceability) | admin, manager | sync |
| GET | `/:id/file` | Stream the original PDF | any (authz) | sync |
| GET | `/:id/pages/:page/image` | Rendered page image (citation preview) **[R]** | any | sync |
| GET | `/search` | Manual search, **no LLM** | any | sync |

**POST /** — `multipart`: `file` (PDF), `machine_model_id` **or** `machine_id`, `title?`,
`document_type`, `document_version?`, `language?`.
Validation: extension + declared MIME + **magic bytes**; `size ≤ MAX_PDF_MB`; not encrypted;
`page_count ≤ 2000` **[A]**; target model/machine exists.
Response `201 {manual_id, job_id, processing_status:"queued"}`.
Errors: `413`, `415`, `422`, `409 DUPLICATE_MANUAL` (same sha256 + model, returns the existing
id), `507`.
**Idempotency:** sha256 + model is the natural key; an `Idempotency-Key` header is also
accepted and makes a retry return the original `201` body. **Sec:** see
`SECURITY_AND_RELIABILITY.md` §5–8; upload rate limit 10/h/user **[A]**.

**DELETE /:id** — `?purge_files=false` (default: retain the PDF 30 days **[R]**). Order: soft
delete → Qdrant purge → verify → audit. Response includes `{vectors_deleted, verified: bool}`.
If Qdrant is down: `200` with `{verified:false, pending_vector_purge:true}` and a warning —
the manual is already unsearchable via the Express filter.

**POST /:id/reindex** — `{scope: "full"|"embed_only"|"index_only", reason (required)}` → `202
{job_id}`. `409 JOB_IN_PROGRESS` if a live job exists (DB-enforced). Blue/green: the manual
stays searchable throughout.

**GET /search** — `?q=&machine_id=|model_id=&limit=&document_type=` → ranked chunks
`{chunk_id, manual_id, manual_title, page_number, printed_page_label, section_title, snippet,
score, arm_hits[]}`. **422 if no machine/model scope is supplied** (the structural
anti-contamination rule). Degrades to lexical-only with a `warnings[]` entry when Ollama is
down.

**GET /:id/pages/:page/image** — `?w=1200` → `image/webp`, cached on disk, `page` bounded by
`page_count` (a `404` otherwise). Rendered server-side from the PDF; the path is derived from
`manual_id`, never from user input.

### 2.6 `/api/v1/conversations`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/` | Create (optionally bound to a machine) | non-viewer **[U]** | sync |
| GET | `/` | List own (managers/admins: all) | any | sync |
| GET | `/:id` | Detail + messages | owner/manager/admin | sync |
| PATCH | `/:id` | Rename, archive, set/switch machine | owner | sync |
| DELETE | `/:id` | Soft delete | owner/admin | sync |
| GET | `/:id/messages` | Paginated messages | owner/manager/admin | sync |

`PATCH` machine switch requires `reason` and appends to `context_switches[]` — scope never
changes silently.

### 2.7 `/api/v1/troubleshooting` — the core

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/query` | Ask a question → validated structured answer | non-viewer **[U]** | **sync** (long) |
| POST | `/clarify` | Answer a clarification (machine/model/code choice) | non-viewer | sync |
| POST | `/feedback` | 👍/👎 + reason on a message **[R]** | non-viewer | sync |

**POST /query**
```jsonc
// request
{ "conversation_id": "…",            // optional; created if absent
  "machine_id": "…",                 // optional if the conversation is bound
  "machine_model_id": "…",           // optional alternative scope
  "query": "E-041 on the injection axis, machine stops mid-shot",
  "options": { "include_history": true, "include_maintenance": true,
               "cross_model_history": false, "debug": false } }
```
→ `200 { conversation_id, message_id, response: <RAG response contract> }` (see
`RAG_PIPELINE.md` §9).
Validation: query 1–2000 chars; conversation ownership; machine/model exists; at least one
scope resolvable, else the response itself is `clarification_required` (**not** an HTTP error —
clarification is a normal outcome).
Errors: `422` invalid input; `403` not the owner; `429` rate limit (30/min/user **[A]**);
`503 SERVICE_UNAVAILABLE` only if FastAPI itself is unreachable — **if only Ollama is down the
call returns `200` with `answer_status: "generation_unavailable"` and retrieval results**
(AC-14).
**Idempotency:** not idempotent by design (each query is a new turn); **[R]** an
`Idempotency-Key` may be honoured for 60 s to protect against double-taps on a tablet.
**Timeout:** 90 s hard **[A]**, with a client-visible countdown. **[R]** Optional SSE variant
`POST /query/stream` — post-MVP.
**Sec:** the retrieval filter is server-derived; injection scanning; audit on suspicion; the
`debug` option (retrieval trace) is admin/manager-only.

### 2.8 `/api/v1/incidents`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/` | Create | non-viewer | sync |
| GET | `/` | List (`?machine_id=&status=&resolution_status=&error_code=&q=`) | any | sync |
| GET | `/:id` | Detail + actions + AI suggestions | any | sync |
| PATCH | `/:id` | Update while open | owner/manager/admin | sync |
| POST | `/:id/actions` | **Record an actual action** | non-viewer | sync |
| PATCH | `/:id/actions/:actionId` | Edit within 24 h **[A]** | author/manager | sync |
| POST | `/:id/resolve` | **Confirm resolution** → triggers embedding | per `INCIDENT_CONFIRMATION_MODE` | sync + async embed |
| POST | `/:id/reopen` | Reopen with a reason | manager, admin | sync |
| POST | `/:id/correct` | Correct with a reason (appends a revision) | manager, admin | sync |
| POST | `/:id/link-machine` | Link an unlinked incident | non-viewer | sync |
| DELETE | `/:id` | Soft delete + vector purge | manager, admin | sync |
| GET | `/similar` | Similar-incident search (debug/standalone) | any | sync |

**POST /** — `{machine_id?, title, error_code?, symptom_text, observed_at, severity,
conversation_id?, ai_message_id?}` → `201`. If `machine_id` is null → `needs_linking: true`
(excluded from retrieval). If `ai_message_id` is given, the AI suggestion is snapshotted into
`ai_suggestions[]` — **as a suggestion**.
**Idempotency:** `Idempotency-Key` **[R]** — double-tap on a shop-floor tablet is a real risk.

**POST /:id/actions** — `{action_text, action_type?, parts_replaced[]?, outcome,
duration_minutes?, performed_at, followed_ai_suggestion?, ai_message_id?, deviation_reason?}`
→ `201`. `performed_by` from the JWT (never the body). `409` if the incident is closed
(reopen first).

**POST /:id/resolve** — `{resolution_status, root_cause_text, effective_action_id,
confirmation_note?, verified_by_test?, confirm: true}`.
**Server preconditions for `resolved_confirmed`:** `confirm === true` **AND** ≥ 1 action with
`outcome === "worked"` **AND** non-empty `root_cause_text` **AND** the caller's role satisfies
`INCIDENT_CONFIRMATION_MODE`. Otherwise `422 CONFIRMATION_REQUIREMENTS_NOT_MET` listing exactly
what is missing. **[C]** MUST-23 / AC-10.
Response `200 {incident, vector_sync: "queued"|"done"|"failed"}` — a vector failure never fails
the business operation. **Idempotent:** re-resolving with the same status is a no-op `200`.

**GET /similar** — `?machine_id=&error_code=&symptom_text=&limit=` → ranked historical evidence
with status labels and the ranking breakdown. Useful standalone, and an excellent demo of the
memory system without invoking the LLM.

### 2.9 `/api/v1/maintenance`

| Method | Route | Purpose | Auth | Sync |
|---|---|---|---|---|
| POST | `/` | Create record | non-viewer | sync |
| GET | `/` | List (`?machine_id=&type=&from=&to=&part_number=`) | any | sync |
| GET | `/:id` | Detail | any | sync |
| PATCH | `/:id` | Update (own ≤24 h, or manager) | per role | sync |
| DELETE | `/:id` | Soft delete | manager, admin | sync |
| GET | `/due` | Upcoming/overdue (`next_due_at`) **[R]** | any | sync |

**POST /** — `{machine_id, maintenance_type, title, description?, performed_at,
performed_by?|performed_by_external?, parts_replaced[]?, components_serviced[]?,
measurements[]?, duration_minutes?, work_order_ref?, next_due_at?, related_incident_id?}`.
Validation: machine exists; `performed_at ≤ now + 5 min`; part numbers normalised (uppercased,
trimmed) — **[R]** essential, otherwise the maintenance-correlation feature silently fails.

### 2.10 `/api/v1/health` and admin

| Method | Route | Purpose | Auth |
|---|---|---|---|
| GET | `/health` | Liveness (shallow) | none |
| GET | `/health/detailed` | Per-dependency status | bearer |
| GET | `/admin/jobs` | Job queue: running/failed/queued | admin, manager |
| POST | `/admin/jobs/:id/retry` | Retry a failed job | admin, manager |
| POST | `/admin/jobs/:id/cancel` | Cooperative cancel | admin, manager |
| POST | `/admin/reconcile` | Run the reconciler on demand | admin |
| GET | `/admin/audit-logs` | Query the audit log | admin, manager |
| GET | `/admin/stats` | Corpus/usage stats (demo slide material) | admin, manager |

**GET /health/detailed** →
```json
{ "status": "degraded",
  "checks": {
    "mongodb":    {"status":"ok","latency_ms":3},
    "qdrant":     {"status":"ok","collections":{"manual_chunks":{"points":4102,"dim":768}}},
    "ollama":     {"status":"down","error":"ECONNREFUSED","impact":"Answers unavailable; keyword search still works"},
    "ai_service": {"status":"ok","version":"0.1.0"},
    "storage":    {"status":"ok","free_gb":124.5},
    "jobs":       {"queued":0,"running":1,"failed_24h":2}
  },
  "degraded_capabilities": ["rag_generation","semantic_search"] }
```
Cached 5 s **[R]** so UI polling cannot DoS Ollama.

---

## 3. FastAPI — internal API

**Not browser-reachable.** Requires `X-Internal-Token` (shared secret) and `X-Request-Id`;
bound to the internal Docker network only.

### 3.1 `/internal/v1/documents`

| Method | Route | Purpose | Sync |
|---|---|---|---|
| POST | `/process` | Full pipeline for a manual | **async** (`202`) |
| POST | `/extract` | Extraction only (debug/tooling) | sync |
| POST | `/ocr` | OCR only (forced/page subset) | async |
| GET | `/jobs/:job_id` | Worker-side job view | sync |
| POST | `/jobs/:job_id/cancel` | Set the cancel flag | sync |
| POST | `/render-page` | Render a page image | sync |

**POST /process** — `{job_id, manual_id, storage_path, machine_model_id, machine_id?, options:
{force_ocr, ocr_language, chunking_version, embedding_model, resume_from_stage}}` → `202
{accepted:true, job_id}`. Rejects with `409` if the worker already has that `job_id`
(in addition to the Mongo unique partial index). The worker writes progress to
`manual_processing_jobs` (the single permitted Mongo write, `SYSTEM_ARCHITECTURE.md` §3.4).

### 3.2 `/internal/v1/embeddings`

| Method | Route | Purpose | Sync |
|---|---|---|---|
| POST | `/embed` | Embed texts `{texts[], type:"document"\|"query"}` | sync |
| GET | `/model-info` | Model name, dim, probe result | sync |

Applies the correct prefix per `type` — the single place where the index/query prefix
convention lives, so it cannot drift.

### 3.3 `/internal/v1/indexing`

| Method | Route | Purpose | Sync |
|---|---|---|---|
| POST | `/manual-chunks/upsert` | Upsert chunk points | sync |
| POST | `/manual-chunks/delete` | Delete by `manual_id` (+optional `embedding_version`) | sync |
| POST | `/manual-chunks/verify` | Count vs expected | sync |
| POST | `/incidents/upsert` | Upsert one incident point | sync |
| POST | `/incidents/delete` | Delete an incident point | sync |
| POST | `/collections/ensure` | Bootstrap collections + payload indexes | sync |
| GET | `/collections/stats` | Points, dim, indexed fields, model | sync |
| POST | `/reindex/orphan-sweep` | Purge points with no Mongo parent | async |

All upserts/deletes are **idempotent** (deterministic IDs, delete-by-filter).

### 3.4 `/internal/v1/search`

| Method | Route | Purpose | Sync |
|---|---|---|---|
| POST | `/manuals` | Hybrid manual retrieval | sync |
| POST | `/incidents` | Tiered incident retrieval | sync |
| POST | `/code-lookup` | Exact error-code lookup (no LLM) | sync |
| POST | `/code-scope-probe` | Which models define this code (**counts/labels only**) | sync |

**POST /manuals** — `{query, filters:{machine_model_id (REQUIRED, non-empty), machine_id?,
document_type?, is_current_version?}, k, arms:{exact,lexical,dense}, rerank:bool}` →
`{results[], trace{}}`. **`422` if the filter is missing/empty** — the structural guarantee
(`QDRANT_DESIGN.md` §9 layer 2).
**POST /code-scope-probe** returns only `[{machine_model_id, label, chunk_count,
short_definition}]` — never chunk text, to avoid a cross-machine leak (Workflow L).

### 3.5 `/internal/v1/rag`

| Method | Route | Purpose | Sync |
|---|---|---|---|
| POST | `/answer` | Full pipeline → validated response | sync (long) |
| POST | `/validate-citations` | Standalone validator (testing) | sync |
| POST | `/summarize-incident` | Deterministic incident summary template | sync |
| POST | `/rewrite-query` | Follow-up → standalone query | sync |

**POST /answer** — `{query, conversation_context[], machine_context{}, filters{},
options{include_history, include_maintenance, cross_model_history, debug},
maintenance_records[] /* supplied by Express */}` →
`{response: <contract>, context_chunk_ids[], trace{}, timings{}}`.
Express re-validates the response and the citations before persisting (defence in depth).

### 3.6 `/internal/v1/health`
`GET /` → `{status, ollama:{reachable, models_present[], missing[]}, qdrant:{reachable,
collections{}}, versions:{embedding_model, dim, prompt_version, chunking_version}}`.

---

## 4. Endpoint summary — idempotency and sync/async

| Endpoint | Idempotent | Mode | Notes |
|---|---|---|---|
| `POST /auth/login` | No | sync | New token per call |
| `POST /machine-models` | Natural key → 409 with id | sync | |
| `POST /machines` | Natural key (`asset_tag`) | sync | |
| `POST /manuals` (upload) | sha256+model, `Idempotency-Key` | **async** work | 201 + `job_id` |
| `POST /manuals/:id/reindex` | Guarded by a live-job unique index | **async** | 409 if running |
| `DELETE /manuals/:id` | Yes (repeat = no-op) | sync purge | Files async |
| `POST /troubleshooting/query` | No (60 s key **[R]**) | sync, long | 90 s timeout |
| `POST /incidents` | `Idempotency-Key` **[R]** | sync | Double-tap protection |
| `POST /incidents/:id/actions` | No | sync | Append-only |
| `POST /incidents/:id/resolve` | Yes (same status = no-op) | sync + async embed | Embedding failure ≠ business failure |
| `POST /maintenance` | `Idempotency-Key` **[R]** | sync | |
| Internal upsert/delete | Yes (deterministic IDs) | sync | Safe retries |

---

## 5. Rate limits **[A] — tune with real usage**

| Scope | Limit |
|---|---|
| `/auth/login` | 10/min/IP, 5 failures → 15 min lockout per (IP,user) |
| `/troubleshooting/query` | 30/min/user, 5 concurrent/user |
| `POST /manuals` | 10/hour/user, 2 concurrent uploads |
| `/manuals/:id/reindex` | 5/hour/user |
| Global authenticated | 300/min/user |
| Unauthenticated | 60/min/IP |

---

## 6. Background jobs (brief §15)

### 6.1 The chosen approach — simplest reliable local design **[R]**

> **MongoDB-backed job records + an in-process bounded worker pool in FastAPI + a reconciler in
> Express. No Redis, no Celery, no broker.**

Justification: single node, a handful of jobs per hour, and Mongo is already a dependency. A
broker would add a container, a failure mode, and operational surface for zero benefit at this
scale. Durability comes from job state living in Mongo (surviving restarts) plus idempotent,
resumable stages backed by on-disk artefacts. The upgrade path (BullMQ + Redis) is documented
but deliberately not taken.

### 6.2 Which operations are background jobs

| Operation | Background? | Reasoning |
|---|---|---|
| PDF extraction | ✅ | Seconds to minutes |
| OCR | ✅ | Minutes; the longest stage by far |
| Chunking | ✅ (same job) | Fast, but part of the pipeline |
| Embedding generation | ✅ (same job) | Ollama-bound; the second-longest stage |
| Qdrant indexing | ✅ (same job) | Fast, but must be atomic with verification |
| Manual re-indexing | ✅ | Same pipeline, different entry stage |
| **Incident embedding** | ⚠ **Deferred inline** — attempted synchronously (≈1 s), and on failure flagged `pending_vector_sync` for the reconciler. A full job record would be overkill for one vector. |
| Large-document deletion | Vector purge **sync** (must be immediate for MUST-24); file cleanup **async** |
| Orphan sweep / reconcile | ✅ Scheduled (boot + every 5 min **[A]**) |
| Recurrence detection | ✅ On resolve + nightly **[A]** |

### 6.3 Job state machine
```
queued ──► running ──► completed
   │          │    └──► completed_with_warnings
   │          ├──► failed ──(retryable & attempts<max)──► queued(attempt+1, new doc)
   │          └──► cancelled
   └──► cancelled (before start)

stages: extraction → ocr? → cleaning → chunking → embedding → indexing → verification
```

### 6.4 Per-job policy

| Job | Retry | Failure state | Progress | Cancel | Duplicate prevention | Restart recovery |
|---|---|---|---|---|---|---|
| `full_process` | 3× on transient (`OLLAMA_UNAVAILABLE`, `QDRANT_UNAVAILABLE`, `TIMEOUT`); **never** on `PDF_CORRUPT`/`PDF_ENCRYPTED`/`NO_TEXT_EXTRACTED` | Manual → `processing_failed`, not searchable | Per stage, per page/chunk | Cooperative flag between stages and every 20 units | Unique partial index on `(manual_id) where status ∈ {queued,running}` | Stale reaper on boot → `failed/STALE_ABANDONED` → retryable, resuming from disk artefacts |
| `ocr_only` | 2× | Partial pages indexed, `completed_with_warnings` | Per page | Yes | Same index | Same |
| `reindex_*` | 3× | Old vectors retained (blue/green) — manual stays usable | Per chunk | Yes | Same index | Same |
| `delete_vectors` | 5× (cheap) | `pending_vector_purge` on the manual | n/a | No | Idempotent by filter | Reconciler retries |
| Incident embed | 3× inline + reconciler | `pending_vector_sync` | n/a | No | Deterministic point ID | Reconciler retries |

### 6.5 Progress reporting
`stages[].progress = {current, total, unit}` + a derived `progress_percent` weighted per stage
**[A]** (extraction 20% · OCR 30% · chunking 10% · embedding 30% · indexing 10%). Written at
most every 2 s or 20 units **[R]** to avoid hammering Mongo. The UI polls
`GET /manuals/:id/job` every 2 s while a job is active. **[R]** SSE is a post-MVP nicety.

### 6.6 Cancellation
Cooperative only — never kill a worker mid-Qdrant-write. `cancel_requested: true` is checked
between stages and every N units; the worker sets `cancelled`, purges partial vectors for that
`manual_id + embedding_version`, and leaves disk artefacts (so a resume is possible).

### 6.7 Recovery after restart
1. **Express boot reconciler:** running/queued jobs with a stale heartbeat → `failed
   STALE_ABANDONED`; manuals stuck `processing` with no live job → `processing_failed`;
   `pending_vector_purge` / `pending_vector_sync` retried; orphaned `storage/tmp/*` removed;
   counter caches recomputed.
2. **FastAPI boot:** rebuilds nothing in memory — it is stateless; it only ensures collections
   exist and the embedding dimension matches.
3. **Resume:** a retry inspects disk artefacts (`chunks.jsonl` present → skip
   extraction/OCR/chunking) and sets `resume_from_stage`. This is why chunk artefacts are
   persisted, and it makes an embedding-stage failure cheap to recover from.

### 6.8 Concurrency
`MAX_CONCURRENT_JOBS = 2` **[A]** (Ollama serialises anyway; more concurrency just causes
timeouts). Per-job wall clock cap `JOB_MAX_MINUTES = 45` **[A]**. Embedding concurrency 2,
batch 32. All configurable, and all should be **measured in Phase 4**, not guessed at
permanently.
