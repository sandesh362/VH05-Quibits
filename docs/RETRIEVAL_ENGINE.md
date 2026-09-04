# Retrieval Engine (Phase 4)

How a technician query becomes a ranked, isolated, citable evidence set. Generation is described in [`PHASE_4_IMPLEMENTATION.md`](./PHASE_4_IMPLEMENTATION.md); this document is the retrieval half.

---

## 1. Query preprocessing (deterministic, no LLM)

`app/rag/normalize.py`

- Original string is stored unchanged (audit logs the SHA-256, not the text).
- NFKC + whitespace collapse produce `normalized`.
- Error codes: `E-104` / `e104` / `E 104` → canonical `E-104`. Variants `{E-104, E104, E 104, E_104}` are generated. **Never** `E-140` or `E-014`.
- Word-boundary regex: `(?<![A-Z0-9])E[\s_-]?104(?!\d)` so `E-1040` cannot hit.
- Also extracted: part numbers, fasteners (`M12 x 1.5`), units (`24 VDC`, `3.5 bar`), PLC points (`X1-14`), component lexicon, symptoms, operating conditions.
- Classification: `error_code | troubleshooting | procedure | general | manual_reference`.
- Error-code, troubleshooting, procedure, and named-manual queries **require machine scope**.

---

## 2. Scope filters

Express resolves live records first:

- `machineId` → load machine → set `machineModelId` (mismatch with an explicit model is 422).
- `machineModelId` → load model (404 if missing/deleted).
- `manualId` → load manual; if it belongs to another model, 422.

FastAPI then:

1. Finds completed, active manuals matching model / type / manufacturer.
2. Restricts exact search to those `manual_id`s.
3. Restricts Qdrant with `must: [is_deleted=false, machine_model_id=M, embedding_model=…]`.
4. If a model is selected and **zero** manuals match, semantic search is skipped (empty), never widened.

A general question (no error code, no troubleshooting intent) may run without a model. A troubleshooting question without a model short-circuits to `clarification_required` / `MACHINE_MODEL_REQUIRED` before any search.

---

## 3. Exact arm

`app/rag/exact.py` + `MongoChunkStore.find_chunks`

- Patterns from error-code variants, part numbers, units, multi-word technical terms, I/O points.
- Mongo `$regex` on `text` and `normalized_text`, case-insensitive, limited to in-scope manuals.
- In-memory store (tests) uses the same regexes.
- A hit is `exact_match` only if an identifier regex actually matches. An error-code query that only matched a fuzzy term is dropped.

---

## 4. Semantic arm

`app/rag/semantic.py`

- Query embedding uses the **same model and `search_query:` prefix** as Phase 3 indexing (`search_document:` at index time).
- Dimension is asserted against the Qdrant collection and `RAG_EXPECTED_EMBEDDING_DIMENSION` (768 for `nomic-embed-text`). Mismatch → skip semantic, continue with exact.
- Qdrant down → skip semantic, continue with exact. If exact is also empty → `processing_unavailable`.
- Post-condition: drop any hit whose `machine_model_id` ≠ requested model.

---

## 5. Merge, dedupe, rank

`app/rag/ranking.py`

1. Union by `chunk_id`, then `content_hash`. Signals (exact flag, semantic score, matched terms) are merged.
2. Score (clipped to `[0, 1]`):

| Signal | Default weight | Notes |
|---|---:|---|
| exact identifier match | 0.35 | pinned first when the query has an error code |
| semantic cosine | 0.45 | never used alone as the final rank |
| technical-term overlap | 0.15 | codes, parts, units, lexicon |
| machine-model match | 0.10 | |
| manual/version match | 0.10 | selected version > current version |
| section-title boost | 0.05 | “troubleshooting” / matching terms |

3. Near-duplicates: token Jaccard ≥ `RAG_NEAR_DUPLICATE_THRESHOLD` (0.92) keeps the higher score.
4. Sort key: `(exact_match_and_error_code, final_score, is_current_version)` descending.

Raw Qdrant cosine is **not** the final score.

---

## 6. Evidence sufficiency

`app/rag/evidence.py`

A hit is eligible only if:

- source metadata is complete when `RAG_REQUIRE_SOURCE_METADATA` (title, page ≥ 1, ids), **and**
- it is an exact match **or** `semantic_score ≥ RAG_MIN_SEMANTIC_SCORE` **or** `final_score ≥ RAG_MIN_FINAL_SCORE`, **and**
- it belongs to the selected machine model.

Fewer than `RAG_MIN_CONTEXT_CHUNKS` eligible hits → `insufficient_evidence` (or `processing_unavailable` if Qdrant was down and nothing exact survived).

Numeric conflicts across **current** manuals (e.g. 200 bar vs 250 bar for the same code) → `conflicting_evidence`. If a superseded version disagrees with the current one, the current version is used and the disagreement is a warning — the pipeline does **not** silently merge two procedures.

---

## 7. Context assembly

`app/rag/context.py`

- Adjacent same-section chunks may be concatenated; both source ids are retained.
- Exact matches are kept first. Whole chunks are dropped rather than truncated mid-instruction when over `RAG_MAX_CONTEXT_CHARS`.
- Each block is:

```
SOURCE_ID: source-1
MANUAL: …
VERSION: …
PAGES: 42-43
SECTION: …
CHUNK_ID: …
MACHINE_MODEL_ID: …

CONTENT:
<<<UNTRUSTED_DOCUMENT_CONTENT>>>
…
<<<END_UNTRUSTED_DOCUMENT_CONTENT>>>
```

---

## 8. Failure modes (retrieval)

| Failure | Behaviour |
|---|---|
| Missing machine model on a scoped query | `clarification_required`, no search |
| No manuals for that model | empty results, no global fallback |
| Qdrant down, exact hits exist | degrade, answer from exact |
| Qdrant down, no exact hits | `processing_unavailable` |
| Embedding dim / model mismatch | skip semantic, warn |
| Similar error code | no exact hit (`E-104` vs `E-140`) |
| Weak semantic only | `insufficient_evidence` |
| Missing page/title on a hit | dropped; may refuse if nothing else remains |
