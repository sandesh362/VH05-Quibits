# Phase 6 — Incident Management and Historical Memory

**Status:** complete
**Scope:** incident CRUD with a real lifecycle, root-cause / fix / action workflows with human confirmation, org-scoped data, incident memory in Qdrant, similar-incident retrieval, historical evidence inside RAG answers, and the incident UI.
**Explicitly out of scope:** predictive maintenance, automatic diagnosis, autonomous actions, notifications, attachments beyond metadata, multi-tenancy UI, Phase 7+ roadmap items.

---

## 1. What Phase 6 delivers

| Capability | Before (Phase 5) | After (Phase 6) |
|---|---|---|
| Incidents | Single resolution flow on one record | Full lifecycle: open → investigate → wait → resolve → close/reopen/cancel |
| Root cause | One text field set at confirmation | `unknown → suspected → confirmed/rejected`, audited history, immutable once confirmed |
| Fixes | One "effective action" | Separate temporary and permanent fix records, each with record → confirm |
| Actions | Free-text outcome | 4-way action model (`technician`, `assistant_suggestion`, `manual`, `other`) |
| Memory | None | Every incident embedded into a Qdrant `incident_memory` collection |
| Retrieval | Manuals only | Hybrid: exact error-code (Mongo) + semantic (Qdrant), ranked with reasons |
| RAG evidence | Manual chunks only | Supplementary historical-evidence block with `history-N` citations |
| Organizations | None | Org-scoped incidents, memory, and retrieval; legacy rows → `default` org |
| Frontend | Chat only | Incident list / create / detail pages with badges and timeline |

`/system/info` reports `PHASE_6_FEATURES`: `incidentManagement`, `incidentMemory`,
and `maintenanceHistory` are now `true`.

---

## 2. Ownership

- **Express** owns incident data, lifecycle, authorization, org scoping, the
  indexing queue, and every HTTP endpoint. Mongo is authoritative for
  incidents and for indexing state (`embedding_status`).
- **FastAPI** owns incident text normalisation, embedding, Qdrant point
  management, and similar-incident retrieval — exactly as it owns manual
  chunks. It is reached only through internal endpoints guarded by
  `X-Internal-Token` (`POST /incidents/index`, `/incidents/delete`,
  `/incidents/similar`).
- **Frontend** talks only to Express (`/api/v1/*`). It never addresses
  Ollama, Qdrant or FastAPI.

```
Incident UI ──► Express /api/v1/incidents (JWT)
                    │ scheduleIncidentIndex → in-process queue (bounded retries)
                    ▼
                FastAPI /internal/v1/incidents/index (X-Internal-Token)
                    │ embed via Ollama
                    ▼
                Qdrant collection "incident_memory"   (derived index)
```

Mongo remains the source of truth; Qdrant is a derived index that can be
rebuilt with `POST /incidents/:id/reindex` at any time.

---

## 3. Non-negotiable invariants

1. **`resolved` is never set directly.** It is only reachable by confirming a
   permanent fix while the root cause is confirmed (or by the issue-status
   flow). `PATCH /incidents/:id/status` rejects `resolved` and `cancelled`.
2. **A confirmed root cause is immutable** until the incident is reopened.
   Any change attempt returns `409 CONFLICT`.
3. **An AI suggestion is never a fact.** `assistant_suggestion` rows can
   never carry a result, be edited, or be confirmed. Conversation→incident
   imports only explicit technician-confirmed facts.
4. **Nothing is confirmed automatically.** Root cause, fixes, and action
   results all require a separate explicit call with a mandatory note, and
   every confirmation is audited.
5. **A recorded result is not a confirmation.** `resultStatus: 'successful'`
   does not flip anything; only the confirm endpoints do.
6. **Organization identity never comes from the request.** It is resolved
   from the authenticated user's `organization_id`; a cross-org id always
   404s (existence is not disclosed).
7. **Historical evidence is supplementary, never proof.** A similar past
   incident does not confirm a diagnosis and its fix is not prescribed; the
   UI and the RAG prompt both carry this disclaimer.
8. **Incident numbers are allocated sequentially per org per year**
   (`INC-<year>-<6 digits>`) and are never reused, even after cancellation.

---

## 4. Module map

| Area | Backend | AI service |
|---|---|---|
| Lifecycle / transitions | `modules/incidents/incidents.lifecycle.ts` | — |
| Append-only timeline | `modules/incidents/incidents.timeline.ts` | — |
| Queue + FastAPI client | `modules/incidents/incidents.indexing.ts` | `app/routers/incidents.py` |
| Org resolution | `modules/organizations/organizations.service.ts` | org-mandatory filters in `incident_memory/*` |
| Actions (4-way model) | `modules/incident-actions/` | — |
| Historical evidence | `modules/rag/rag.service.ts` (sends `organization_id`) | `app/rag/pipeline.py`, `context.py`, `prompt.py` |

---

## 5. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `QDRANT_INCIDENT_COLLECTION` | `incident_memory` | Qdrant collection for incident vectors |
| `INCIDENT_INDEX_RETRY_LIMIT` | `3` | Queue retries before marking `embedding_status: failed` |
| `INCIDENT_INDEX_RETRY_DELAY_MS` | `30_000` | Delay between indexing retries |
| `INCIDENT_SIMILAR_LIMIT` | `10` | Max similar incidents returned |
| `INCIDENT_HISTORY_TOP_K` | `4` | Historical hits injected into RAG context |
| `INCIDENT_HISTORY_MIN_SEMANTIC_SCORE` | `0.5` | Qdrant score floor for RAG history |
| `INCIDENT_HISTORY_MAX_CONTEXT_CHARS` | `2500` | Cap on the historical-evidence block |

Prompt version for Phase 6 is `rag-p6-v1`.

---

## 6. Testing

- **Backend:** `crud.test.ts` covers the lifecycle, root-cause/fix/action
  workflows, cancellation, similar-history fallback, and reindex;
  `authorization.test.ts` covers the role matrix, ownership, org isolation,
  and the `/users` listing; `api.test.ts` asserts the Phase 6 feature flags.
  (HTTP suites require a local `mongod`; they are skipped where one is
  unavailable.)
- **AI service:** 139 pytest tests pass, including incident-memory indexing,
  similar retrieval, org isolation, and the RAG historical-evidence flow.
- **Frontend:** 22 vitest tests pass plus a clean production build; the new
  pages typecheck under `tsconfig.app.json`.

---

## 7. Must not (still)

- Never import AI hypotheses as incident facts.
- Never claim historical similarity proves the current diagnosis.
- Never trust an organization id, machine id, or user id from the request
  body alone — always re-resolve against the actor's organization.
- Never reuse an incident number.
- Never let a non-manager confirm a root cause, a fix, or close an incident.
