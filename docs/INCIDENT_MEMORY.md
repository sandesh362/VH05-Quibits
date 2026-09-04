# Incident Memory (AI service)

The AI service side of Phase 6: a Qdrant collection of verified incident
outcomes plus the code that builds and queries it.

---

## 1. Package layout (`ai-service/app/incident_memory/`)

| File | Responsibility |
|---|---|
| `qdrant_helpers.py` | Point ids, embedding text, payload construction |
| `indexing.py` | `IncidentVectorIndex`: collection management + upsert/delete/search |
| `store.py` | `MongoIncidentStore`: incident lookup + exact error-code matching |
| `similar.py` | Hybrid similar-incident retrieval with ranking |

The FastAPI router `app/routers/incidents.py` exposes
`/incidents/index`, `/incidents/delete`, `/incidents/similar` (internal
token only).

## 2. Point construction

- **Point id:** `uuid5(NAMESPACE, "inc-v1:" + incident_id)` — deterministic,
  so re-indexing overwrites the same point.
- **Embedding text:** title + symptoms + error codes + operating conditions
  + confirmed root cause + confirmed fix. Only **confirmed** root cause and
  fix text is included; unconfirmed/speculative content is never embedded.
- **Payload:** org id (mandatory — every query filters on it), machine and
  model ids, incident number, statuses, severity/priority, tags, and the
  confirmed root cause / fix.
- **Empty text is refused** (`422`) — no empty-embedding points.

## 3. Collection management

- `ensure_collection(db, embedding_size)` creates the configured collection
  (`QDRANT_INCIDENT_COLLECTION`, default `incident_memory`) with cosine
  distance; if a collection already exists with a **different** dimension,
  it raises instead of silently mis-querying (a model switch must be a
  deliberate migration).
- Upsert/delete/search use the Qdrant client with `try/finally` close and
  timeout handling; failures propagate as warnings to callers rather than
  crashing user-facing flows.

## 4. Configuration

| Setting | Default | Meaning |
|---|---|---|
| `QDRANT_INCIDENT_COLLECTION` | `incident_memory` | Collection name |
| `INCIDENT_HISTORY_TOP_K` | `4` | Historical hits injected into RAG answers |
| `INCIDENT_HISTORY_MIN_SEMANTIC_SCORE` | `0.5` | Semantic score floor |
| `INCIDENT_HISTORY_MAX_CONTEXT_CHARS` | `2500` | Cap on the injected block |

## 5. Organization isolation

Every Qdrant query carries `organization_id` as a hard filter, and the
Mongo fallback query filters on it too. A caller can never see another
organization's incidents — and the value always originates from the
Express-side actor resolution, never from the AI service guessing.

## 6. Mongo store (`MongoIncidentStore`)

The AI service also reads the incident collection directly (read-only) to:

- hydrate semantic hits into full records,
- find **exact error-code matches** for the deterministic leg of hybrid
  retrieval,
- map a document to its confirmed outcome
  (`confirmed_root_cause = root_cause.text when status == 'confirmed'`;
  `confirmed_fix = permanent_fix if confirmed else temporary_fix if
  confirmed`).

Graceful degradation: if Mongo is unreachable, similar retrieval returns
what Qdrant alone can provide (with a warning) instead of failing.
