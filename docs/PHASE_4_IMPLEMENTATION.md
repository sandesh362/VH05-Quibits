# Phase 4 — Retrieval Engine and RAG Pipeline

**Status:** complete, pending review
**Scope:** exact + semantic retrieval, machine-model isolation, merge/dedupe/rank, evidence sufficiency, local Ollama generation from retrieved evidence only, citation construction/validation, structured refusals, Express and FastAPI contracts
**Explicitly out of scope:** full chat UI/memory, incident/maintenance retrieval, feedback learning, autonomous workflows, tool-calling, web/cloud AI, fine-tuning, voice/images, predictive maintenance, Phase 5 conversation answers

---

## 1. What Phase 4 delivers

Phase 3 indexed manuals. Phase 4 makes them *searchable and answerable*, without inventing procedures.

| Capability | Before (Phase 3) | After (Phase 4) |
|---|---|---|
| Exact identifier search | none | Mongo regex with word-boundary codes (`E-104` ≠ `E-140`) |
| Semantic search | vectors stored, unused | Qdrant cosine + `search_query:` prefix, filtered by model |
| Machine-model isolation | payload field only | hard filter + post-retrieval drop |
| RAG answers | none | Ollama chat, evidence-only, JSON schema |
| Citations | none | application-authored titles/pages from retrieved metadata |
| Refusals | n/a | clarification / insufficient / conflict / unavailable |
| Public API | upload/jobs only | `POST /retrieval/search`, `POST /rag/answer`, `POST /rag/debug` |
| Feature flags | `vectorSearch`/`ragAnswers` false | true; `incidentMemory` still false |

`/system/info` reports `PHASE_4_FEATURES`.

---

## 2. Architecture

### 2.1 Ownership

- **Express** authenticates, authorises (`manual.read` / `audit_log.read`), resolves machine/manual scope from live Mongo records, rate-limits, audits (query hash, never raw query unless `RAG_LOG_QUERY_TEXT=true`), and maps snake_case → camelCase.
- **FastAPI** owns query normalisation, exact + semantic retrieval, ranking, evidence gates, prompting, Ollama generation, and citation validation. It may *read* `manuals` / `manual_chunks`; it still must not write business collections.

The browser never calls FastAPI.

```
Client
  POST /api/v1/rag/answer  (JWT, manual.read)
        │
        ▼
Express  resolveScope → audit rag_query_submitted
        POST /internal/v1/rag/answer  (X-Internal-Token)
        │
        ▼
FastAPI  normalize → exact Mongo + semantic Qdrant
         merge/dedupe/rank → evidence gate
         [refuse] or prompt → Ollama → validate citations
        │
        ▼
Express  camelCase + audit rag_answer_generated / refused / failed
```

### 2.2 Layout

```
ai-service/app/rag/
  normalize.py    query preprocessing (no LLM)
  exact.py        identifier retrieval
  semantic.py     Qdrant + MemoryVectorIndex
  ranking.py      merge, Jaccard near-dupes, weighted score
  evidence.py     sufficiency, conflicts, refusal copy
  context.py      budget, adjacent combine, evidence block
  prompt.py       system prompt + untrusted delimiters
  citations.py    SOURCE_ID / page validation
  generate.py     Ollama chat + ScriptedGenerator
  pipeline.py     retrieve / run_search / run_answer
  store.py        MemoryChunkStore + MongoChunkStore
  settings.py     RagRuntimeConfig from Settings

backend/src/modules/rag/
  rag.validators.ts  rag.service.ts  rag.controller.ts  rag.routes.ts
```

---

## 3. Endpoint contract

### 3.1 Public (Express)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/retrieval/search` | `manual.read` | Ranked chunks, no LLM |
| POST | `/api/v1/rag/answer` | `manual.read` | Grounded answer or structured refusal |
| POST | `/api/v1/rag/debug` | `audit_log.read` | Same as answer with `debug: true` |

Body (strict): `{ query, machineId?, machineModelId?, manualId?, manualVersion?, manualType?, manufacturer?, conversationId?, includeInactive? }`.

`query` is 1–2000 characters. Clarification (missing machine model) is **HTTP 200** with `status: "clarification_required"`, not 422.

If FastAPI is unreachable → `503 DEPENDENCY_UNAVAILABLE`. If only Ollama is down, FastAPI still returns 200 with `status: "generation_failed"` / `OLLAMA_UNAVAILABLE` and retrieved sources.

### 3.2 Internal (FastAPI)

| Method | Path | Auth |
|---|---|---|
| POST | `/internal/v1/retrieval/search` | `X-Internal-Token` |
| POST | `/internal/v1/rag/answer` | `X-Internal-Token` |
| GET | `/internal/v1/rag/health` | `X-Internal-Token` |

---

## 4. Answer statuses

| Status | Meaning |
|---|---|
| `answered` | Grounded answer from retrieved manual evidence |
| `conflicting_evidence` | Multiple versions disagree; both cited, confidence low |
| `clarification_required` | Troubleshooting/error-code query without a machine model (or manual id) |
| `insufficient_evidence` | Nothing relevant, or metadata-incomplete hits |
| `processing_unavailable` | Qdrant down *and* no exact match |
| `generation_failed` | Ollama down, invalid JSON, or citation validation failed after one retry |

Guessing is never an option. `RAG_ALLOW_UNSUPPORTED_ANSWER` defaults to false and must stay false.

---

## 5. Isolation and citations

- A selected `machine_model_id` with zero in-scope manuals does **not** fall back to the global corpus.
- Semantic hits whose payload model disagrees with the filter are dropped (`machine_model_contamination_dropped`).
- The model never authors page numbers or manual titles. It may only emit `SOURCE_ID`s from the evidence block. Express/FastAPI fill `[title, version, p. N, section]` from retrieved metadata.
- Invented `source-99` → one regeneration → `generation_failed` (evidence-only sources still returned).
- Invented page numbers are stripped.

---

## 6. Prompt injection

Retrieved text and the user query are wrapped in `<<<UNTRUSTED_*>>>` delimiters. The system prompt forbids following instructions found there. JSON schema validation is the backstop. There is no tool-calling surface.

---

## 7. Configuration

See `.env.example`. Highlights: `OLLAMA_CHAT_MODEL` (default `llama3.1`), `RAG_TOP_K`, `RAG_MIN_SEMANTIC_SCORE`, `RAG_MIN_FINAL_SCORE`, `RAG_REQUIRE_SOURCE_METADATA`, `RAG_ALLOW_UNSUPPORTED_ANSWER=false`, `RAG_REQUEST_TIMEOUT_MS`, `RAG_LOG_QUERY_TEXT`, ranking weights.

Pull the chat model before answering:

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

---

## 8. Testing

- FastAPI: unit tests for normalize/exact/semantic/ranking/evidence/context/citations/prompt; pipeline tests with `MemoryChunkStore` + `ScriptedGenerator`; HTTP contract tests with injected deps; evaluation corpus `ai-service/tests/fixtures/evaluation/corpus.json`.
- Express: `tests/rag.test.ts` (authz, validation, scope mismatch, 503 when FastAPI is down) plus `/system/info` Phase 4 flags.

---

## 9. Notable decisions

- **No RRF / no cross-encoder in this phase.** Exact matches are pinned; remaining score is a documented linear combination. Cosine is never the final score.
- **Mongo is authoritative for chunk text.** Qdrant is a derived index. Exact search reads Mongo.
- **`machine_model_id` is now persisted on `manual_chunks`** (Phase 3 left it null). Reprocess existing manuals after upgrade.
- **Conversation `conversationId` is accepted and ignored** as a retrieval input. Multi-turn memory is Phase 5.
- **Incident and maintenance retrieval are not wired.** Those evidence classes remain Phase 5+.

See also [`RETRIEVAL_ENGINE.md`](./RETRIEVAL_ENGINE.md).
