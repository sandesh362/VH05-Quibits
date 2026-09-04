# Incident Management

The incident record, its lifecycle, and the root-cause / fix / close / reopen /
cancel workflows. See [Incident API](./INCIDENT_API.md) for the endpoints and
[Authorization](./INCIDENT_AUTHORIZATION.md) for who may do what.

---

## 1. Data shape

An `IncidentDoc` (org-scoped, `organization_id` required) carries:

- Identity: `incident_number` (`INC-<year>-<6 digits>`, per-org sequence),
  `title`, `description`, `source` (`conversation|manual|import|other`).
- Machine context: `machine_id` (required in Phase 6), `machine_model_id`
  (always derived from the machine — a mismatched `machineModelId` in the
  payload is rejected), optional `conversation_id` / `manual_id`.
- Structured context: `symptoms[]`, `error_codes[]` (normalised:
  trimmed/uppercased, de-duplicated), `operating_conditions[]`, `tags[]`
  (lowercased), `attachments[]` (metadata only).
- Workflow state: `status`, `issue_status`, `severity`, `priority`,
  `assigned_to`, `root_cause{}`, `temporary_fix{}`, `permanent_fix{}`,
  `resolution_summary`, `resolved_at`, `closed_at`, `reopened_at`.
- Indexing state: `embedding_status`, `qdrant_point_id`, `embedding_error`
  (Mongo is authoritative; Qdrant is a derived index).
- `timeline[]` — append-only events (see below).
- Search: `search_text` rebuilt on every update; the list endpoint matches
  title, description, incident number, error codes, symptoms, conditions,
  and tags.

## 2. Status lifecycle

**Incident status** transitions (everything else is rejected):

```
open                     → investigating, cancelled
investigating            → waiting_for_information, waiting_for_parts, resolved, cancelled
waiting_for_information  → investigating, cancelled
waiting_for_parts        → investigating, resolved, cancelled
resolved                 → closed, reopened
closed                   → reopened
reopened                 → investigating, cancelled
cancelled                → (terminal)
```

Active statuses (`open_incident_count` on the machine counts these):
`open`, `investigating`, `waiting_for_information`, `waiting_for_parts`,
`reopened`.

**Issue status** (independent of incident status):

```
unknown        → investigating
investigating  → temporary_fix, resolved, unresolved, escalated
temporary_fix  → investigating, resolved, unresolved, recurring
resolved       → recurring, unresolved
unresolved     → investigating, escalated, temporary_fix
recurring      → investigating, temporary_fix, resolved
escalated      → investigating, resolved, unresolved
```

Rules:

- `PATCH /incidents/:id/status` may only perform transitions in the map.
  `resolved` is rejected there — "only reachable via the workflow endpoints";
  `cancelled` is rejected there — "use DELETE".
- `closed` and `cancelled` lock the incident: any update, status change,
  root-cause change, fix record, or action record returns `409 CONFLICT`
  until the incident is reopened.

## 3. Root-cause workflow

- Record a suspicion with
  `PATCH /incidents/:id/root-cause { text, status: 'suspected' }`
  (`unknown`/`rejected` are also reachable here).
- Confirm with `POST /incidents/:id/root-cause/confirm { note, text? }`.
  - The note is mandatory (min 3 chars).
  - A text must exist (from the update call or the confirm body).
  - `confirmed` is only reachable through this endpoint; the update endpoint
    refuses `status: 'confirmed'` with `403 FORBIDDEN`.
  - Confirmation records `confirmation_note`, `confirmed_by`, `confirmed_at`
    and is audited (`incident.root_cause_confirmed`).
- Reject with `POST /incidents/:id/root-cause/reject { reason }` — reason
  mandatory, audited (`incident.root_cause_rejected`).
- **A confirmed root cause is immutable.** Any further change returns
  `409 CONFLICT` until the incident is reopened.
- Every change appends to `root_cause.history` (at/by/from/to/note/text),
  exposed via `GET /incidents/:id/root-cause/history`.

## 4. Temporary / permanent fixes

Both fix kinds share the same shape and rules:

1. **Record** — `POST /incidents/:id/{temporary-fix,permanent-fix}`
   `{ description, result?, notes? }` → `status: 'recorded'` (201).
2. **Confirm** — `POST /incidents/:id/{temporary-fix,permanent-fix}/confirm`
   `{ note, result? }` → `status: 'confirmed'`, `confirmed_by/at` (200).
   The note is mandatory and the act is audited.

Deterministic consequences of confirmation (never inferred from AI output or
timers):

- Confirming a **temporary** fix moves `issue_status` to `temporary_fix`
  when the current issue status allows it.
- Confirming a **permanent** fix **while the root cause is confirmed**
  moves the incident to `resolved` (and decrements the machine's
  `open_incident_count`). Without a confirmed root cause, nothing changes —
  the fix is confirmed but the incident stays open.
- A confirmed fix blocks recording another fix of the same kind (`409`).
- `resolved` is not closure; the incident still needs `POST /close`.

`GET /incidents/:id/fixes/history` returns both fixes with their own
confirmation histories.

## 5. Close, reopen, cancel

- **Close** — `POST /incidents/:id/close { resolutionSummary }`. Only a
  `resolved` incident can be closed (`409` otherwise); summary is mandatory
  and stored as `resolution_summary`.
- **Reopen** — `POST /incidents/:id/reopen { reason }`. Allowed from
  `resolved`, `closed`, or `reopened`; requires a reason; technicians may
  reopen only incidents they reported or are assigned to.
- **Cancel** — `DELETE /incidents/:id { reason }`. Soft delete:
  `status: 'cancelled'` + deletion stamps; the incident disappears from
  reads and lists; the machine's open counter is released; the Qdrant point
  is scheduled for deletion; the number is never reused.

## 6. Timeline

Append-only events under `timeline[]`, returned newest-last by
`GET /incidents/:id/timeline` (max 200). Event types include
`incident_created`, `incident_updated`, `status_changed`,
`issue_status_changed`, `root_cause_changed`, `root_cause_confirmed`,
`root_cause_rejected`, `temporary_fix_recorded/confirmed`,
`permanent_fix_recorded/confirmed`, `technician_action_recorded/updated/
confirmed`, `ai_suggestion_recorded`, `assignment_changed`,
`incident_closed/reopened/cancelled`, `similar_incident_search`,
`qdrant_reindex_queued`. Events carry `actorId`, `actorUsername`,
`previous`/`next`, `note`, and optional `metadata` — never modified after
write.
