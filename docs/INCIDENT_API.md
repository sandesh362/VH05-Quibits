# Incident API Reference (Phase 6)

All routes under `/api/v1`, JWT-authenticated, org-scoped server-side.
Errors use the standard failure envelope (`VALIDATION_ERROR`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, …).

---

## 1. Incident CRUD

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/incidents` | `incident.read` | Filters: `machineId`, `machineModelId`, `status`, `issueStatus`, `severity`, `priority`, `rootCauseStatus`, `errorCode`, `tag`, `reportedBy`, `assignedTo`, `source`, `createdFrom/To`, `resolvedFrom/To`, `search`, `sortBy`, `sortOrder`, `page`, `limit` |
| `GET` | `/incidents/:id` | `incident.read` | Enriched with machine/model/manual/user labels |
| `POST` | `/incidents` | `incident.create` | `machineId` required; `machineModelId` must match the machine; `source` ∈ `conversation|manual|import|other`; arrays of `symptoms`, `errorCodes` (normalised), `operatingConditions`, `tags` |
| `PATCH` | `/incidents/:id` | `update_any`/`update_own` | Ownership checked in the service; settled incidents refuse (`409`) |
| `DELETE` | `/incidents/:id` | `delete`/`update_any`/`update_own` | Cancellation: `{ reason }` required; soft-delete + counter release + Qdrant point deletion |

## 2. Lifecycle

| Method | Path | Auth | Notes |
|---|---|---|---|
| `PATCH` | `/incidents/:id/status` | update | `{ status, reason? }`; transition map only; `resolved`/`cancelled` refused here |
| `PATCH` | `/incidents/:id/issue-status` | update | `{ issueStatus, note? }`; independent transition map |
| `POST` | `/incidents/:id/close` | `incident.close` | `{ resolutionSummary }`; only from `resolved` |
| `POST` | `/incidents/:id/reopen` | `incident.reopen`/update | `{ reason }`; from `resolved|closed|reopened`; technicians: own incidents only |

## 3. Root cause

| Method | Path | Auth | Notes |
|---|---|---|---|
| `PATCH` | `/incidents/:id/root-cause` | `root_cause_update` | `{ text?, status?, note? }`; `confirmed` refused (`403`) |
| `POST` | `/incidents/:id/root-cause/confirm` | `root_cause_confirm` | `{ note, text? }`; note mandatory; text must exist; confirmed is immutable |
| `POST` | `/incidents/:id/root-cause/reject` | `root_cause_reject` | `{ reason }` mandatory |
| `GET` | `/incidents/:id/root-cause/history` | `incident.read` | Full status history |

## 4. Fixes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/incidents/:id/temporary-fix` | `fix_record` | `{ description, result?, notes? }` → `recorded` (201) |
| `POST` | `/incidents/:id/temporary-fix/confirm` | `fix_confirm` | `{ note, result? }`; moves issue status to `temporary_fix` when allowed |
| `POST` | `/incidents/:id/permanent-fix` | `fix_record` | → `recorded` (201) |
| `POST` | `/incidents/:id/permanent-fix/confirm` | `fix_confirm` | With confirmed root cause → incident `resolved` |
| `GET` | `/incidents/:id/fixes/history` | `incident.read` | Both fixes with histories |

## 5. Actions

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/incidents/:id/actions` | `incident_action.read` | `actionType`, `confirmed` filters; paginated |
| `POST` | `/incidents/:id/actions` | `incident_action.create` | 4-way model; results only for `technician` |
| `PATCH` | `/incidents/:id/actions/:actionId` | action update/create | Performer or manager; suggestions/confirmed refuse |
| `POST` | `/incidents/:id/actions/:actionId/confirm` | confirm/create | `{ note }`; owner or manager; technician actions only |
| `GET` | `/incidents/:id/actions/:actionId/history` | `incident_action.read` | Edit history |

## 6. Memory

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/incidents/:id/similar` | `incident.read` | Hybrid retrieval + Mongo fallback; reasons + `confirmed` flag |
| `POST` | `/incidents/:id/reindex` | `incident.reindex`/`update_any` | `202`; resets to `pending` |
| `GET` | `/incidents/:id/timeline` | `incident.read` | Append-only events, newest last |

## 7. Related

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/conversations/:id/create-incident` | `incident.create` | Explicit facts only |
| `GET` | `/users` | `user.read_all` | Assignment picker (manager/admin) |

Internal AI-service endpoints (`X-Internal-Token`): `POST /incidents/index`,
`POST /incidents/delete`, `POST /incidents/similar`.
