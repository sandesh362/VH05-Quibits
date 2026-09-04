# Incident Indexing (Express → FastAPI → Qdrant)

How incidents become searchable in the historical memory. Mongo is
authoritative for incident data **and** for indexing state; Qdrant is a
derived index that can always be rebuilt.

---

## 1. Ownership split

- **Express** decides *when* an incident should be (re)indexed, persists
  `embedding_status`, and owns the queue and retries.
- **FastAPI** (`app/routers/incidents.py`) normalises the text, calls
  Ollama for the embedding, and upserts the Qdrant point.
- **Qdrant** stores only the vector plus the payload FastAPI builds — it is
  never a source of truth.

All three internal endpoints require `X-Internal-Token`:

| Endpoint | Purpose |
|---|---|
| `POST /internal/v1/incidents/index` | Upsert one incident (idempotent) |
| `POST /internal/v1/incidents/delete` | Delete one incident's point (idempotent) |
| `POST /internal/v1/incidents/similar` | Ranked similar incidents |

## 2. Embedding states

`embedding_status` on the incident document (Mongo):

| State | Meaning |
|---|---|
| `not_indexed` | Never sent (or point deleted after cancellation) |
| `pending` | Queued / reindex requested |
| `indexed` | Qdrant point present (`qdrant_point_id` set) |
| `failed` | Attempts exhausted; `embedding_error` explains why |

## 3. Queue and retries

- `scheduleIncidentIndex` marks the incident `pending` and enqueues a job on
  the in-process manual-processing queue (concurrency 2).
- A failure marks `failed` with the error, audits
  (`incident.index_failed`), and retries after
  `INCIDENT_INDEX_RETRY_DELAY_MS` (default 30 s) up to
  `INCIDENT_INDEX_RETRY_LIMIT` (default 3).
- `POST /incidents/:id/reindex` (manager, `202 Accepted`) resets the state
  to `pending` and re-enqueues; `DELETE /incidents/:id` schedules a Qdrant
  point deletion instead.
- Every success/failure is audited
  (`incident.indexed` / `incident.index_failed` / `incident.index_deleted` /
  `incident.reindexed`), so the derived index can be reconciled against
  Mongo at any time.

## 4. The index payload

`toIndexPayload` sends: ids (incident, org, machine, model), number, title,
source, statuses, severity/priority, error codes, symptoms, operating
conditions, tags, **confirmed root cause** (only when `root_cause.status ===
'confirmed'`), **confirmed fix** (permanent fix if confirmed, else temporary
fix if confirmed), resolution summary, and timestamps.

Speculative content is deliberately excluded: unconfirmed root causes and
unconfirmed fixes are not embedded, so historical retrieval can only ever
surface outcomes a human verified.

## 5. FastAPI side

- `IncidentVectorIndex.ensure_collection` asserts the existing collection
  dimension matches the configured embedding model (an accidental model
  switch fails loudly instead of corrupting the index).
- Point ids are deterministic: `uuid5(NAMESPACE, 'inc-v1:' + incident_id)` —
  re-indexing the same incident overwrites instead of duplicating.
- Embedding text is built from title, symptoms, error codes, operating
  conditions, confirmed root cause, and confirmed fix; an empty text is
  refused with `422` rather than embedding garbage.

## 6. Failure behaviour

- **AI service down:** creates/updates still succeed; the incident simply
  stays `pending → failed` and can be reindexed later. No user request ever
  fails because Ollama is unreachable.
- **Incident deleted before the job runs:** the job throws and exhausts its
  retries harmlessly; Mongo remains authoritative.
