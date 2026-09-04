# QDRANT_DESIGN.md

Local Qdrant. Two collections. Tags: **[C]** **[A]** **[R]** **[U]**.

---

## 1. Design principles

1. **Qdrant is a derived index, never a source of truth.** Everything in it is rebuildable from
   MongoDB + `storage/`. This one rule removes an entire class of consistency nightmares.
2. **Deterministic point IDs.** Every point ID is a `uuid5` of stable inputs, so every write is
   idempotent and every retry is safe.
3. **The embedding model is part of the collection identity.** Vectors from different models are
   never allowed to coexist in one collection.
4. **Filters are mandatory and server-derived.** A search without a machine/model filter is
   rejected. This is the structural defence against cross-machine contamination (**[C]** MUST-11).
5. **Payload carries everything needed to render a citation** without a second Mongo round trip
   — but Mongo remains authoritative if the two ever disagree.

---

## 2. Collection: `manual_chunks`

### 2.1 Purpose
Searchable, page-attributed fragments of manuals, scoped to a machine model.

### 2.2 Naming and vector configuration

**Physical name:** `manual_chunks__{embedding_slug}__{dim}` — e.g.
`manual_chunks__nomic_embed_text__768`, with a Qdrant **alias** `manual_chunks` pointing at the
active one. **[R]** The alias is what makes a model migration a zero-downtime pointer swap
(§7).

```
vectors:
  size:      768            # MUST equal the model's output dim (nomic-embed-text)
  distance:  Cosine
  on_disk:   false          # small corpus; keep in RAM for latency
hnsw_config:
  m: 16                     # defaults are correct at this scale
  ef_construct: 128
optimizers_config:
  default_segment_number: 2
quantization: none          # [R] not needed below ~1M points; revisit only if RAM-bound
sparse_vectors:             # [R] optional ARM-2 upgrade, see §2.7
  text: { }                 # BM25-style sparse index, if enabled in Phase 4
```

**Distance metric — Cosine, and why:** `nomic-embed-text` (like most modern embedding models)
produces vectors intended for cosine/normalised-dot comparison; magnitude carries no useful
signal and chunk length would otherwise distort Euclidean distance. Cosine also gives a bounded
`[-1, 1]` score, which is what makes a *fixed refusal threshold* (e.g. 0.45) meaningful and
portable across queries. Dot product would be equivalent **only** if we guaranteed
normalisation ourselves; Cosine lets Qdrant do it. **Do not use Euclid here.**

### 2.3 Embedding-model requirements
| Requirement | Value |
|---|---|
| Model | `nomic-embed-text` (default) — **[R]** re-evaluate in Phase 4 against a golden set |
| Dimension | 768 (asserted at bootstrap against a live probe embedding) |
| Max input | 8192 tokens (chunks are ~700, so ample headroom) |
| Prefixes | `search_document: ` at index time, `search_query: ` at query time **[R]** — asymmetric prefixes measurably improve retrieval for this model family; **the convention must be identical at index and query time** |
| Normalisation | Cosine handles it; still assert non-zero norm and correct dim before upsert |

### 2.4 Payload schema

| Field | Type | Indexed | Purpose |
|---|---|:--:|---|
| `chunk_id` | keyword | ✓ | `"{manual_id}:{chunk_index}"` — the citation handle the LLM must quote |
| `manual_id` | keyword | ✓ | delete-by-filter, citation resolution |
| `machine_model_id` | keyword | ✓ | **the primary safety filter** |
| `machine_id` | keyword | ✓ (sparse) | only for `scope: "machine"` manuals |
| `machine_type` | keyword | ✓ | optional widening / analytics |
| `manufacturer` | keyword | ✓ | display + optional filter |
| `model_name` | keyword | ✓ | display |
| `page_number` | integer | ✓ | **citation; range-filterable** |
| `page_end` | integer | – | for chunks spanning pages |
| `printed_page_label` | keyword | – | **[R]** the folio the technician sees ("7-12") when it differs from the PDF index |
| `section_title` | text | – | display |
| `section_path` | keyword[] | ✓ | e.g. `["7. Faults","7.3 Servo"]`; enables section-scoped search |
| `source_filename` | keyword | – | display (original filename, metadata only) |
| `manual_title` | keyword | – | display |
| `document_type` | keyword | ✓ | prefer `troubleshooting` over `parts_catalog` for fault queries |
| `text` | text | ✓ (full-text) | the chunk content; **full-text payload index powers ARM 2** |
| `text_len` | integer | – | quality signal |
| `chunk_index` | integer | ✓ | ordering, neighbour expansion |
| `chunk_type` | keyword | ✓ | `fault_code \| procedure \| table \| prose \| spec \| safety \| parts` |
| `error_codes` | keyword[] | ✓ | **ARM 1** — exact code matching; includes normalised variants |
| `part_numbers` | keyword[] | ✓ | part lookups |
| `document_version` | keyword | ✓ | version-aware ranking |
| `is_current_version` | bool | ✓ | down-weight superseded manuals |
| `language` | keyword | ✓ | **[U] Q1** |
| `low_ocr_confidence` | bool | ✓ | caps answer confidence; shown in the citation |
| `ocr_confidence` | float | – | 0–100 |
| `injection_flag` | bool | ✓ | suspected prompt injection → excluded from context by default |
| `is_deleted` | bool | ✓ | defence in depth (points are actually purged) |
| `embedding_model` | keyword | ✓ | assertion at query time |
| `embedding_version` | keyword | ✓ | blue/green re-index |
| `chunking_version` | keyword | – | traceability |
| `indexed_at` | integer (epoch s) | – | staleness checks |

**Payload indexes to create at bootstrap:**
`machine_model_id`, `manual_id`, `error_codes`, `part_numbers`, `chunk_type`, `page_number`,
`is_deleted`, `is_current_version`, `document_type`, `language`, `embedding_version`,
`injection_flag`, `machine_id` (sparse), `section_path`, and a **full-text index on `text`**.
Without payload indexes, filtered search degrades badly as the corpus grows — do not skip this.

### 2.5 Point ID strategy
```
point_id = uuid5(NAMESPACE_MANUAL_CHUNK, f"{manual_id}:{chunk_index}:{embedding_version}")
```
- Deterministic ⇒ a retried batch overwrites instead of duplicating (**the single most
  important reliability property of the indexing stage**).
- Includes `embedding_version` ⇒ old and new vectors coexist during a blue/green re-index.
- **[R]** Do **not** use a hash of the chunk *text* as the ID: text edits would orphan points
  and break delete-by-`chunk_index`.

### 2.6 Upsert strategy
1. Bootstrap: create the collection if missing; if it exists, **assert dim and distance** and
   refuse to run on mismatch (never silently index into a wrong-dimension collection).
2. Batch 128 points **[A]**; `wait=false` for intermediate batches, `wait=true` for the last.
3. After upsert, `count(filter: manual_id == X AND embedding_version == V)` must equal the chunk
   count; a mismatch fails the job (`INDEX_VERIFICATION_FAILED`) and the manual is **not**
   marked ready.
4. Re-running a completed job is safe and produces an identical index (idempotency test:
   AC-19).

### 2.7 Retrieval patterns
```
ARM 1 — exact error code (highest precision)
  scroll/query, filter: must[ machine_model_id == M, is_deleted == false,
                              error_codes MATCH_ANY [ "E-041","E041","E 041" ] ]
  no vector needed → deterministic, fast, and immune to embedding weirdness

ARM 2 — lexical
  full-text payload match on `text` (Qdrant full-text index), same filter
  [R] preferred over a Mongo text mirror; decide in Phase 4 (SYSTEM_ARCHITECTURE §4.3)

ARM 3 — dense
  query_vector = embed("search_query: " + q), same filter, limit 20,
  with_payload true, score_threshold applied AFTER fusion (not in the query — you need the
  scores to compute the gap signal used by the refusal gate)

Fusion: RRF(k=60), arm weights [1.5, 0.8, 1.0] (config)
Optional: Qdrant server-side hybrid via the Query API + prefetch, if sparse vectors are enabled
```

**Mandatory filter (always injected server-side, never client-supplied):**
```
must: [ machine_model_id == <resolved>, is_deleted == false ]
should (soft boost): [ is_current_version == true, document_type == "troubleshooting" ]
must_not: [ injection_flag == true ]      # unless an admin explicitly overrides
```
For `scope: "machine"` manuals the model filter becomes
`should: [machine_model_id == M, machine_id == X]` with `min_should: 1` — still closed, still
safe.

### 2.8 Delete strategy
| Trigger | Action |
|---|---|
| Manual deleted | `delete(filter: manual_id == X)`, then verify `count == 0`. Preceded by the Mongo soft delete so the manual is already unsearchable via the Express-side filter even if this step fails. |
| Manual re-indexed | Add new `embedding_version` points **first**, then delete the old version's points (never leaves a gap). |
| Model/dimension change | New collection; alias swap; drop the old collection after verification. |
| Partial/failed job | `delete(filter: manual_id == X AND embedding_version == V)` before retry, or rely on deterministic-ID overwrite. |
| Reconciler | Points whose `manual_id` is absent or soft-deleted in Mongo are purged (orphan sweep). |

### 2.9 Re-indexing strategy
- **Blue/green within the collection** for chunking/prompt/model-*content* changes (same dim):
  upsert new `embedding_version`, verify, delete old. Zero unsearchable window.
- **Collection swap** for dimension changes: build `manual_chunks__{new}__{dim}`, re-index every
  manual, verify totals, move the alias atomically, drop the old collection.
- Both paths are driven by `manual_processing_jobs` (`job_type: reindex_*`), are resumable, and
  are auditable.

---

## 3. Collection: `incident_history`

### 3.1 Purpose
Semantic recall of past troubleshooting events, **carrying resolution status into ranking** so
that a confirmed fix and a failed attempt are never treated alike (**[C]** MUST-22).

### 3.2 Vector configuration
Same embedding model, same dimension, same distance (**Cosine**) — the same model must be used
here as for manuals, because both are searched with **one** query embedding per request
(a deliberate performance and consistency decision).
```
name: incident_history__{embedding_slug}__{dim}   (alias: incident_history)
vectors: { size: 768, distance: Cosine }
```
Volume is tiny (hundreds to thousands of points), so no tuning is needed.

### 3.3 What text gets embedded
A **deterministic template**, not LLM prose (**[R]** — an LLM summary would inject inference
into the evidence corpus):
```
Machine: {manufacturer} {model_name} ({asset_tag})
Error code: {error_code}
Symptoms: {symptom_text}
Actions performed: {action_1 (outcome)}; {action_2 (outcome)}; ...
Parts replaced: {part_numbers}
Root cause: {root_cause_text}
Resolution: {resolution_status} (confirmed: {yes|no})
```
This is stored verbatim in the payload as `text_summary` so the UI shows exactly what was
matched, and a reindex reproduces the identical vector.

### 3.4 Payload schema

| Field | Type | Indexed | Purpose |
|---|---|:--:|---|
| `incident_id` | keyword | ✓ | Mongo join, delete-by-filter |
| `incident_number` | keyword | – | display |
| `machine_id` | keyword | ✓ | **tier-1 filter** |
| `machine_model_id` | keyword | ✓ | **tier-2 filter** |
| `machine_type` | keyword | ✓ | tier-3 (**[U]**, off by default) |
| `asset_tag` | keyword | – | display |
| `error_code` | keyword | ✓ | exact match |
| `symptoms` | text | ✓ | full-text |
| `actual_actions` | text | – | **technician actions only**; AI suggestions are never embedded |
| `parts_replaced` | keyword[] | ✓ | part correlation |
| `root_cause` | text | – | display |
| `resolution_status` | keyword | ✓ | **ranking weight** |
| `resolution_confirmed` | bool | ✓ | **ranking weight**, and a hard filter option |
| `verified_by_test` | bool | – | extra credibility signal |
| `outcome_summary` | keyword | – | `worked \| partial \| no_change \| made_worse` (from the effective action) |
| `occurred_at` | integer (epoch s) | ✓ | recency decay + range filters |
| `resolved_at` | integer (epoch s) | ✓ | |
| `recurrence_count` | integer | ✓ | recurring-failure signal |
| `source_type` | keyword | ✓ | `technician_confirmed \| technician_reported \| ai_assisted_unconfirmed` — **never** `ai_generated` |
| `text_summary` | text | ✓ | what was embedded; shown in the UI |
| `severity` | keyword | – | |
| `downtime_minutes` | integer | – | |
| `is_deleted` | bool | ✓ | defence in depth |
| `embedding_model`,`embedding_version` | keyword | ✓ | consistency assertions |

### 3.5 Point ID, upsert, delete
```
point_id = uuid5(NAMESPACE_INCIDENT, incident_id)      # one point per incident
```
- **Upsert triggers:** on resolution confirmation; on a status change; on a correction; on the
  addition of a significant action **[R]** (an incident whose knowledge changes must be
  re-embedded, or the index quietly rots).
- **Never indexed:** `needs_linking == true`, soft-deleted incidents, and incidents with no
  actions and `unresolved` status (nothing to learn).
- **Delete:** on incident soft delete → `delete(points: [uuid5(...)])`, verified;
  `pending_vector_sync` drives reconciler retries.
- **[C]** Corrections update the point in place (same ID), so a corrected incident can never
  linger as a stale duplicate.

### 3.6 Confirmed vs unconfirmed ranking — **[C]** requirement §9.6
Qdrant returns pure similarity; **status-aware ranking is applied in FastAPI after retrieval**,
because it must be explainable and tunable (a Qdrant score-boost formula would be neither):
```
final_score = 0.55·similarity
            + 0.25·status_weight
            + 0.12·tier_weight
            + 0.08·recency_decay

status_weight:  resolved_confirmed 1.00 | temporarily_resolved 0.50 | recurring 0.45
                | technician_reported_unconfirmed 0.30 | unresolved 0.25
tier_weight:    same machine 1.00 | same model 0.70 | same type 0.40  ([U] off by default)
recency_decay:  exp(-age_days / 180)
```
Additional hard rules that ranking alone must not be trusted to enforce:
1. An **unconfirmed** incident may never be rendered as a "confirmed fix", regardless of score —
   the evidence class is carried in the payload and rendered by the UI, not inferred from rank.
2. Below-threshold matches (`similarity < 0.40` **[A]**) are dropped entirely.
3. `made_worse` outcomes are **surfaced deliberately** as warnings, not suppressed — negative
   evidence is valuable ("last time, resetting made it worse").
4. Max 5 historical items in context, at most 2 of them unconfirmed **[R]**.

---

## 4. Why no third collection for maintenance
Maintenance retrieval is inherently **structured** (this machine, last 90 days, this part
number, this type). A vector search over short maintenance descriptions would add an index to
keep consistent, a second embedding cost per record, and worse precision than a Mongo query with
proper indexes. **[R] Decision: no maintenance vectors in the MVP.** Revisit only if free-text
symptom matching against maintenance notes proves valuable — the payload design above would
extend cleanly.

---

## 5. How vector dimensions are determined
1. The dimension is a **property of the embedding model**, never a choice: `nomic-embed-text` →
   768, `mxbai-embed-large` → 1024, `all-minilm` → 384, `bge-m3` → 1024.
2. At bootstrap the service embeds a fixed probe string (`"dimension probe"`), reads
   `len(vector)`, and compares it with `EMBEDDING_DIM` in config **and** with the existing
   collection's configured size. Any disagreement is a **fatal startup error** with an explicit
   message. Discovering a dimension mismatch at bootstrap costs seconds; discovering it after
   indexing 4,000 chunks costs the demo.
3. The dimension is baked into the physical collection name, so two dimensions can never share a
   collection.

## 6. Why the same embedding model must be used for indexing and querying
An embedding model defines a coordinate system. Vectors from model A and model B are
**numerically comparable but semantically meaningless** together: cosine similarity between them
is noise. The failure mode is nasty because it does not error — it returns plausible-looking
results that are simply wrong, and it would silently destroy grounding while every health check
stays green.

Enforcement (three layers):
1. Physical collection name contains the model slug and dimension.
2. Every point payload stores `embedding_model` / `embedding_version`; the search layer asserts
   the configured model matches the collection's recorded model at startup and logs it per query
   in the retrieval trace.
3. Query-time prefix convention (`search_query:` vs `search_document:`) is centralised in one
   embedding client so it cannot drift between the indexing path and the query path.

## 7. Handling an embedding-model change
```
1. Set EMBEDDING_MODEL / EMBEDDING_DIM in config (new values).
2. Bootstrap creates manual_chunks__{new}__{dim}  (the old collection is untouched).
3. Enqueue reindex_embed jobs for every ready manual + a re-embed sweep for incidents.
   Chunks are reused from chunks.jsonl → no re-extraction, no OCR. This is why chunk artefacts
   are persisted to disk.
4. Verify totals per manual against Mongo's indexed_chunk_count.
5. Atomically move the alias `manual_chunks` → the new collection.
6. Keep the old collection for one day [R], then drop it.
7. Store the model and its calibrated thresholds together — score distributions differ per
   model, so refusal thresholds MUST be re-calibrated after a model change (a commonly missed
   step that quietly breaks refusal behaviour).
```
Queries never mix collections. There is no "migration mode" that reads both.

## 8. How stale vectors are removed
| Staleness source | Removal |
|---|---|
| Manual deleted | Delete by `manual_id` filter, verified; `pending_vector_purge` retry if Qdrant is down |
| Manual re-indexed | Delete points with the superseded `embedding_version` after the new ones are verified |
| Incident deleted / corrected | Point deleted or overwritten by the same deterministic ID |
| Model change | Old collection dropped after the alias swap |
| Orphans (Mongo doc gone, point remains) | **Reconciler orphan sweep**: scroll distinct `manual_id`/`incident_id` values, diff against Mongo, purge the difference. Runs on boot and on demand from the admin page. |
| Cancelled job leftovers | Delete by `manual_id + embedding_version` on cancellation |

## 9. How filtering prevents cross-machine contamination
Four independent layers — because this single failure would invalidate the product:
1. **Express resolves the filter** from the authenticated request's conversation/machine and
   passes it explicitly. The client can never supply it.
2. **FastAPI rejects** any search request whose filter object lacks a non-empty
   `machine_model_id` (or an explicit, logged, admin-only `cross_model: true` override used
   solely by the Workflow-L aggregate probe, which returns counts and model names only — never
   chunk text).
3. **Qdrant applies it as a `must` clause**, so no unfiltered vector ever reaches the ranker.
4. **Post-retrieval assertion**: every returned chunk's payload `machine_model_id` is compared
   with the requested filter; a mismatch raises an alert, drops the result, and writes a
   `security`-severity audit entry. Covered by a dedicated regression test (AC-05).

## 10. Backup and operations
- Qdrant snapshot API per collection → `storage/backups/qdrant/`, plus the named volume.
- **[R]** Because Qdrant is rebuildable from Mongo + `storage/`, the *authoritative* backup is
  `mongodump` + `storage/`. A Qdrant snapshot is a speed optimisation for restore, not a
  requirement — a genuinely reassuring property to state to a judge.
- **[R]** Set `QDRANT_API_KEY` even locally, and keep the service off published host ports.
- Health check reports, per collection: existence, point count, configured dimension, indexed
  payload fields, and the recorded embedding model.
