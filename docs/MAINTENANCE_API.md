# Maintenance & Timeline API (Phase 7)

All routes under `/api/v1`, JWT-authenticated, org-scoped server-side.

## 1. Maintenance records

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/maintenance` | `maintenance.read` | Filters: `machineId`, `machineModelId`, `maintenanceType`, `performedFrom/To`, `partNumber` (normalised), `dueBefore`, `search`, `sortBy`, pagination |
| `GET` | `/maintenance/:id` | `maintenance.read` | Org-scoped; cross-org → 404 |
| `POST` | `/maintenance` | `maintenance.create` | `{ machineId*, maintenanceType*, title*, performedAt* (not future), description?, performedByExternal?, workOrderRef?, partsReplaced[{partNumber, name?, quantity?}], componentsServiced[], measurements[], durationMinutes?, downtimeMinutes?, nextDueAt?, relatedIncidentId? (same machine enforced), notes? }` |
| `PATCH` | `/maintenance/:id` | `maintenance.update_any/own` | 24 h author edit window; `machineId` immutable |

Org-scoping: records carry `organization_id` (resolved from the actor);
legacy rows are backfilled to the default organization by `prepareDatabase`.
Part numbers are normalised on write (`abc-123` ≡ `ABC123`); the machine's
`last_maintenance_at` is recomputed from the records themselves.

## 2. Machine timeline

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/machines/:id/timeline` | `machine.read` | `kind=all\|maintenance\|incident`, `from`, `to`, `limit` (max 200). Merged maintenance + incident events, newest first. |

## 3. RAG payload (internal, `X-Internal-Token`)

`POST /internal/v1/rag/answer` gains two fields:

| Field | Type | Meaning |
|---|---|---|
| `maintenance_context` | array \| null | Bounded, org-scoped maintenance facts for the scoped machine |
| `query_at` | ISO string \| null | Reference time for `days_before_incident` |

Item shape: `{ id, maintenance_type, title, performed_at,
parts_replaced: [{ part_number, name }], related_incident_id }`.

`/internal/v1/retrieval/search` is unchanged: maintenance never participates
in manual retrieval.

## 4. Answer source shape additions

Sources of `sourceType: 'maintenance'` carry:

```
maintenanceId, daysBeforeIncident, correlationStrength ('strong'|'moderate'|'weak'),
causalClaim (always false), notedByManual, notedByManualSourceId
```

and cite as `maint-N` (no page numbers — maintenance has no pages).

## 5. Environment

| Var | Default | Meaning |
|---|---|---|
| `MAINTENANCE_HISTORY_DAYS` | `365` | Lane lookback window |
| `MAINTENANCE_CONTEXT_MAX_ITEMS` | `5` | Max records passed per answer |
