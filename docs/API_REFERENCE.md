# API Reference — Phase 2

Base URL: `http://localhost:8080/api/v1` (configurable via `PORT` / `API_PREFIX`).

All requests and responses are JSON. Every response carries `X-Request-Id`, which also appears in the body and in the server logs.

---

## Response envelopes

**Success**
```json
{ "success": true, "data": { }, "meta": { "requestId": "req_...", "timestamp": "2026-09-04T07:28:52.326Z" } }
```

**Paginated** — the collection is in `data`, the counts in `meta.pagination`:
```json
{ "success": true, "data": [ ], "meta": { "requestId": "req_...", "timestamp": "...",
  "pagination": { "page": 1, "limit": 20, "total": 25, "totalPages": 2 } } }
```

**Failure**
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "The request contains invalid fields.",
  "requestId": "req_...", "details": [ { "field": "modelName", "issue": "Required" } ] } }
```

`stack` is present **only** when `NODE_ENV !== 'production'`.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Well-formed request, invalid content |
| `UNAUTHENTICATED` | 401 | Missing, invalid, or revoked token |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | No such resource, or not visible to you |
| `CONFLICT` | 409 | Duplicate, or a rule forbids the state change |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds `REQUEST_BODY_LIMIT` |
| `RATE_LIMITED` | 429 | Too many attempts, or account locked |
| `NOT_IMPLEMENTED` | 501 | Planned for a later phase |
| `DEPENDENCY_UNAVAILABLE` | 503 | Database unreachable |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected fault |

---

## Pagination and filtering

Shared by every list endpoint:

| Parameter | Default | Rules |
|---|---|---|
| `page` | 1 | Integer ≥ 1 |
| `limit` | 20 | Integer 1–100. **101 is rejected**, not silently clamped |
| `sortBy` | per-module | Must be on that module's allowlist; unknown values fall back to the default |
| `sortOrder` | `desc` (`asc` for incident actions) | `asc` \| `desc` |

Unknown query parameters are **rejected** with 422 — a typo'd filter that silently returns everything is worse than an error.

---

## Authentication

### `POST /auth/register`

Public, or authenticated as admin. Rate limited.

```json
{ "username": "jsmith", "email": "j@example.com", "password": "...", "fullName": "J Smith", "role": "technician" }
```

`role` is honoured **only** when the caller is an authenticated admin. Anonymous self-registration always produces `viewer`; the field is ignored, not rejected. The very first account on an empty database becomes `admin`.

→ `201` `{ user }`. Duplicate email or username → `409` with a deliberately generic message.

### `POST /auth/login`

Rate limited. `{ "email", "password" }`

→ `200` `{ accessToken, refreshToken, expiresIn, tokenType, user }`

All failures return an identical `401 UNAUTHENTICATED` / "Invalid email or password." Inactive accounts → `403`. Locked accounts → `429`.

### `POST /auth/refresh`

`{ "refreshToken" }` → `200`, same shape as login.

Tokens rotate on every use. Replaying a rotated token revokes the whole family and returns `401`.

### `POST /auth/logout`

Authenticated. `{ "refreshToken"?, "allDevices"? }`

`allDevices: true` increments `token_version`, immediately invalidating every outstanding access token.

### `GET /auth/me` · `GET /users/me`

Authenticated → `200` `{ user }`. Never includes the password hash.

### `PATCH /users/me`

Authenticated. Accepts **only** `fullName` and `preferences`. Sending `role`, `isActive`, or any other field → `422`.

### `POST /auth/change-password`

`{ "currentPassword", "newPassword" }` → `200`. Clears all refresh tokens and bumps `token_version`, so every session including the caller's must sign in again.

---

## Machine models

| Method | Path | Capability |
|---|---|---|
| GET | `/machine-models` | `machine_model.read` |
| GET | `/machine-models/:id` | `machine_model.read` |
| POST | `/machine-models` | `machine_model.create` |
| PATCH | `/machine-models/:id` | `machine_model.update` |
| DELETE | `/machine-models/:id` | `machine_model.delete` |

Create: `manufacturer`, `modelName`, `machineType` required; `aliases[]` (≤20), `modelYear`, `specifications` (≤50 keys), `defaultLanguage`, `notes`.

Filters: `manufacturer`, `machineType`, `search` (manufacturer, model name, aliases). Sort: `created_at`, `updated_at`, `manufacturer`, `model_name`.

DELETE takes `{ "reason" }` and returns **409** if any machine or manual still references the model, with the dependents listed in `details`.

---

## Machines

| Method | Path | Capability |
|---|---|---|
| GET | `/machines` | `machine.read` |
| GET | `/machines/:id` | `machine.read` |
| POST | `/machines` | `machine.create` |
| PATCH | `/machines/:id` | `machine.update` |
| DELETE | `/machines/:id` | `machine.delete` |

Create: `assetTag` (uppercased automatically), `machineModelId` required; `displayName`, `serialNumber`, `location{site,area,line,position}`, `status`, `installedAt`, `commissionedAt`, `criticality`, `notes`.

- `assetTag` is **immutable** — sending it to PATCH is a 422.
- Changing `machineModelId` requires `modelChangeReason`.
- DELETE returns **409** if incidents or maintenance exist, advising `status: "retired"`.

Filters: `status`, `machineModelId`, `criticality`, `site`, `search`.

---

## Manuals (metadata only)

| Method | Path | Capability |
|---|---|---|
| GET | `/manuals` | `manual.read` |
| GET | `/manuals/:id` | `manual.read` |
| POST | `/manuals` | `manual.create` |
| PATCH | `/manuals/:id` | `manual.update` |
| DELETE | `/manuals/:id` | `manual.delete` |

Create: `title`, `scope` (`model`|`machine`), `documentType`, `originalFilename`, `fileSizeBytes`, `sha256` (64 hex chars), `mimeType`; plus `machineModelId` **or** `machineId` matching the scope.

**No file is uploaded.** This registers metadata about a document. `processingStatus` is always `queued` and `isSearchable` always `false` in Phase 2.

Sending `processingStatus`, `indexedChunkCount`, or `indexedAt` to create or update → **422** stating the pipeline owns those fields. `storagePath` is never returned.

---

## Incidents

| Method | Path | Capability |
|---|---|---|
| GET | `/incidents` | `incident.read` |
| GET | `/incidents/:id` | `incident.read` |
| POST | `/incidents` | `incident.create` |
| PATCH | `/incidents/:id` | `incident.update_any` or `update_own` |
| POST | `/incidents/:id/confirm-resolution` | `incident.confirm_resolution` |
| POST | `/incidents/:id/reopen` | `incident.reopen` |
| GET | `/incidents/:id/actions` | `incident_action.read` |
| POST | `/incidents/:id/actions` | `incident_action.create` |
| PATCH | `/incidents/:id/actions/:actionId` | `incident_action.create` |

**Create** requires `title`, `symptomText` (≥10 chars), `severity`, and either `machineId` or `machineModelId`. Supplying only a model sets `needsLinking: true`. `incidentNumber` is generated (`INC-2026-000001`).

**PATCH cannot set `status: "resolved"`** — it returns 422 pointing at the confirmation endpoint. A technician may only edit an incident they reported, and only while `open` or `in_progress`.

**Confirm resolution** requires:
```json
{ "rootCauseText": "≥10 chars", "effectiveActionId": "<id>", "confirmationNote": "...", "verifiedByTest": true }
```
The nominated action must belong to this incident **and** have `outcome: "worked"`, otherwise 422. Already-confirmed → 409.

Who may confirm depends on `INCIDENT_CONFIRMATION_MODE`:
- `self` (default) — the reporter or assignee, plus any manager/admin
- `supervisor` — manager/admin only

**Actions** are append-only. `outcome` is required (no default). Editable by the author for 24 hours, with the previous text preserved. Downgrading the confirmed effective action from `worked` flips the incident to `recurring` and writes a warning-severity audit entry.

Filters: `status`, `resolutionStatus`, `severity`, `machineId`, `machineModelId`, `errorCode`, `assignedTo`, `reportedBy`, `needsLinking`, `observedFrom`/`observedTo`, `search`.

---

## Maintenance

| Method | Path | Capability |
|---|---|---|
| GET | `/maintenance` | `maintenance.read` |
| GET | `/maintenance/:id` | `maintenance.read` |
| POST | `/maintenance` | `maintenance.create` |
| PATCH | `/maintenance/:id` | `maintenance.update_any` or `update_own` |

Create: `machineId`, `maintenanceType`, `title`, `performedAt` (not in the future) required; `partsReplaced[]`, `componentsServiced[]`, `measurements[]`, `durationMinutes`, `downtimeMinutes`, `nextDueAt` (may be future), `relatedIncidentId`, `notes`.

`machineId` and `relatedIncidentId` are immutable. A related incident must belong to the same machine. Authors may edit for 24 hours; managers any time.

Filters include `partNumber`, which is normalised the same way as on write.

---

## Conversations

| Method | Path | Capability |
|---|---|---|
| GET | `/conversations` | `conversation.read_own` / `read_any` |
| GET | `/conversations/:id` | `conversation.read_own` / `read_any` |
| POST | `/conversations` | `conversation.create` |
| PATCH | `/conversations/:id` | `conversation.update_own` |
| DELETE | `/conversations/:id` | `conversation.update_own` |
| GET | `/conversations/:id/messages` | `conversation.read_own` / `read_any` |
| POST | `/conversations/:id/messages` | **501 — Phase 5** |

Technicians and viewers see only their own conversations; another user's returns **404**, not 403, so existence is not disclosed. Managers and admins may read any.

`POST .../messages` returns `501 NOT_IMPLEMENTED` and **stores nothing**. Multi-turn chat is Phase 5. Use `POST /rag/answer` for a single grounded answer.

---

## Retrieval and RAG (Phase 4)

| Method | Path | Capability |
|---|---|---|
| POST | `/retrieval/search` | `manual.read` |
| POST | `/rag/answer` | `manual.read` |
| POST | `/rag/debug` | `audit_log.read` |

```json
{ "query": "Why is error E-104 appearing during hydraulic startup?",
  "machineModelId": "<24-hex id>",
  "machineId": "<optional>",
  "manualId": "<optional>",
  "manualVersion": "2.1" }
```

→ `200` `{ status, answer, confidence, evidenceSufficient, query, scope, sources[], retrieval, warnings[] }`.

`status` is one of `answered | clarification_required | insufficient_evidence | conflicting_evidence | processing_unavailable | generation_failed` (search may also return `retrieved`). Missing machine model on a troubleshooting query is **200 + clarification**, not 422.

Citations in `sources[]` are filled from retrieved metadata (`manualTitle`, `manualVersion`, `pageStart`/`pageEnd`, `sectionTitle`). The model is not trusted to invent them.

Internal FastAPI equivalents (token-guarded, never browser-reachable): `POST /internal/v1/retrieval/search`, `POST /internal/v1/rag/answer`, `GET /internal/v1/rag/health`.

Rate limit: `RAG_RATE_LIMIT_MAX` / `RAG_RATE_LIMIT_WINDOW_MINUTES` (default 30/min). FastAPI unreachable → `503 DEPENDENCY_UNAVAILABLE`.

---

## Operational (unauthenticated)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness. Stays 200 while the database is down. |
| GET | `/ready` | Readiness with per-dependency probes. |
| GET | `/system/info` | Version, phase, and the feature flags. |
| GET | `/healthz` | Unversioned alias for container healthchecks. |

`/system/info` reports Phase 4 flags: `vectorSearch` and `ragAnswers` true; `incidentMemory` false.
