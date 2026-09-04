# MODULE_BREAKDOWN.md

All 28 modules. Tags: **[C]** confirmed · **[A]** assumption · **[R]** recommendation · **[U]** unknown.

**Owner** = which service the module lives in. **MVP** = ✅ in / 🔶 partial / ❌ deferred.

---

## Module map

```
EXPRESS (product)                          FASTAPI (documents + AI)
├─ 1  Auth & AuthZ            ✅           ├─  7 PDF extraction        ✅
├─ 2  User management         ✅           ├─  8 OCR processing        ✅
├─ 3  Machine management      ✅           ├─  9 Cleaning/normalise    ✅
├─ 4  Machine model mgmt      ✅           ├─ 10 Chunking              ✅
├─ 5  Manual management       ✅           ├─ 11 Embedding             ✅
├─ 6  PDF upload              ✅           ├─ 12 Vector indexing       ✅
├─ 19 Conversation mgmt       ✅           ├─ 13 Manual search         ✅
├─ 20 Incident management     ✅           ├─ 14 Query understanding   ✅
├─ 21 Historical retrieval    🔶(orch)     ├─ 15 Machine/model detect  🔶
├─ 22 Maintenance mgmt        ✅           ├─ 16 RAG generation        ✅
├─ 23 Machine timeline        ✅           ├─ 17 Citation validation   ✅
├─ 24 Audit logging           ✅           ├─ 18 Refusal & confidence  ✅
├─ 25 Background jobs (state) ✅           ├─ 25 Background jobs (exec)✅
├─ 26 Health monitoring       ✅           ├─ 26 Health (self)         ✅
└─ 28 Deployment/backup       ✅           └─ 27 Evaluation harness    🔶
```

---

## 1. Authentication & Authorization — Express — ✅ MVP

**Purpose** Establish who the actor is and whether the action is permitted; the trust anchor
for every other module.

**Responsibilities** Password hashing/verification (Argon2id **[R]**); access-token issuance
(JWT, 15 min) and refresh-token rotation (7 d, httpOnly cookie, single-use, reuse detection);
`requireAuth` and `requireCapability(cap)` middleware; a single central policy map
`(role → capability[])`; login rate limiting and lockout; token revocation via a `token_version`
counter on the user.

**Inputs** Credentials; `Authorization: Bearer` header; refresh cookie; route capability
declaration. **Outputs** `req.user {id, role, tokenVersion}`; 401/403; audit events.

**Dependencies** Mongo (`users`), config secrets, audit module.

**Business rules** ① Deny by default — a route without a declared capability is 403.
② `viewer` never mutates. ③ Only `admin` changes roles. ④ Bumping `token_version` invalidates
all live access tokens (used on role change, password change, deactivation). ⑤ Auth decisions
happen only here — FastAPI does not re-authorise users. ⑥ No self-registration **[R]**.

**Failure cases** Secret missing at boot (fail fast, never default); clock skew invalidating
tokens; refresh-token replay (→ revoke the whole family); lockout used as a DoS against a known
user (mitigate: lock per IP+user pair, not user alone **[R]**); role changed mid-session but
the old token still valid (mitigated by ④).

---

## 2. User management — Express — ✅ MVP
**Purpose** CRUD for accounts and roles.
**Responsibilities** Create/list/update/deactivate users; password reset by admin; self-service
password change; profile (display name, default machine **[R]** — a nice technician touch).
**Inputs** Admin forms. **Outputs** User docs (never `password_hash`).
**Dependencies** Auth, audit.
**Rules** Unique email+username (case-insensitive); soft delete via `is_active: false` (hard
delete would orphan audit trails and incident attributions); the **last active admin cannot be
deactivated** (a classic self-lockout bug — guard it); role change bumps `token_version`.
**Failures** Admin lockout; a deactivated user's historical attributions must still render
(join must tolerate inactive users).

---

## 3. Machine management — Express — ✅ MVP
**Purpose** Registry of physical assets — the anchor for incidents, maintenance, and
conversation scope.
**Responsibilities** CRUD; asset-tag uniqueness; model linkage; status
(`operational|down|maintenance|retired`); location; a machine detail view aggregating manuals
(via model), incidents, maintenance.
**Inputs** Forms; **[R]** CSV bulk import for demo seeding.
**Outputs** Machine docs with a display-only `model_snapshot`.
**Dependencies** Machine models, Mongo.
**Rules** ① Every machine references exactly one model (**[C]** machine ≠ model). ② `asset_tag`
is unique, immutable after creation **[R]** (it is printed on the asset), and charset-restricted.
③ Cannot delete a machine that has incidents or maintenance — retire it instead. ④ Changing a
machine's model is a significant event: audit it and warn that historical incidents were
recorded under a different model (see `RAG_PIPELINE.md` §11 on machine modifications).
**Failures** Duplicate tags from CSV import; model deleted while machines reference it (blocked);
timezone confusion on `installed_at`.

---

## 4. Machine model management — Express — ✅ MVP
**Purpose** The **filter key** that makes safe retrieval possible. Architecturally the most
important small CRUD in the system.
**Responsibilities** CRUD for `{manufacturer, model_name, machine_type, spec fields, aliases[]}`;
list machines and manuals per model; indexing readiness indicator.
**Inputs** Admin forms. **Outputs** Model docs.
**Dependencies** Mongo; consumed by manuals, machines, retrieval filters.
**Rules** ① Unique `(manufacturer, model_name)` with case-insensitive collation — duplicates
here silently fragment the corpus and are hard to detect later. ② `aliases[]` **[R]** (e.g.
"EC180SX", "EC-180 SX", "EC180") powers text-based model detection in Workflow L. ③ Merging two
accidentally duplicated models is a real admin need — **[R]** provide a merge action (repoint
machines + manuals, then re-index the vector payloads' `machine_model_id`). ❌ Merge is
post-MVP; duplicate *prevention* is MVP.
**Failures** Fragmented corpus from near-duplicate models (the top data-quality risk in this
system); deleting a model with dependents (blocked).

---

## 5. Manual management — Express — ✅ MVP
**Purpose** Lifecycle and metadata of manual documents.
**Responsibilities** Metadata CRUD (title, doc type, version, language, publication date, model
link); processing status surface; re-index and delete orchestration; page-image and PDF serving
for citation preview; duplicate detection by sha256.
**Inputs** Upload module, admin edits. **Outputs** Manual docs; PDF/page-image byte streams.
**Dependencies** Upload, jobs, FastAPI, filesystem, Qdrant (indirectly).
**Rules** ① A manual is scoped to a **model** by default; `scope: "machine"` exists for
machine-specific documents (contradiction **X1**) — **[R]** field present in MVP, UI optional.
② A manual only becomes searchable when `processing_status == "ready"` **and** the verified
chunk count > 0. ③ Deletion is soft in Mongo and **hard in Qdrant** (MUST-24). ④ Version is
metadata; superseding is explicit (`supersedes_manual_id` **[R]**), never inferred from dates.
⑤ Serving a PDF page must be by `manual_id` + page number only — never by a path parameter.
**Failures** A manual marked ready with zero vectors (guarded by verification); two versions of
the same manual both indexed and contradicting each other (see `RAG_PIPELINE.md` §11); a
confidential manual served without an auth check.

---

## 6. PDF upload — Express — ✅ MVP
**Purpose** Get bytes safely onto disk.
**Responsibilities** Multipart handling with size/count limits; magic-byte validation; sha256;
atomic move into `storage/manuals/<id>/`; temp cleanup; job dispatch.
**Inputs** `multipart/form-data`. **Outputs** A stored file + `manual_id` + `job_id`.
**Dependencies** fs, manuals, jobs, auth.
**Rules** ① Stream to disk, never buffer in memory (a 100 MB PDF in RAM × 3 concurrent uploads
kills the process). ② Validate magic bytes **after** upload but **before** creating the manual
record. ③ Generated filenames only. ④ Reject encrypted/password-protected PDFs early with a
clear message. ⑤ `MAX_PDF_MB` and pages-per-PDF caps enforced.
**Failures** Disk full (check free space before accepting **[R]**); a client aborting mid-upload
(temp reaper); a polyglot file that is a valid PDF *and* something else (mitigated by never
executing it and by rendering only server-side); zip-bomb-style PDFs (page cap + subprocess
timeout).

---

## 7. PDF extraction — FastAPI — ✅ MVP
**Purpose** Turn PDF bytes into page-anchored, structure-annotated text. **Everything
downstream inherits this module's quality.**
**Responsibilities** Per-page text with layout (blocks/lines/spans + bboxes + font metrics);
page-count and rotation handling; text-density scoring; table detection; heading-hierarchy
inference; header/footer detection; `pages.jsonl` emission; page-image rendering on demand.
**Inputs** `original.pdf`, options. **Outputs** `extracted/pages.jsonl`, quality metrics.
**Dependencies** PyMuPDF, fs, jobs.
**Rules** ① Page numbers are **1-based and printed-page-aware where possible** — if the PDF page
index differs from the printed folio, store both (`pdf_page`, `printed_page` **[R]**) and cite
the printed one, since that is what the technician sees in the paper manual. This detail
separates a good implementation from a naive one. ② Never discard the bbox — it enables
highlight-on-page. ③ Extraction is deterministic and versioned (`extraction_version`).
**Failures** Corrupt/encrypted PDF; CJK/symbol fonts without a text mapping producing mojibake
(detect by non-printable ratio → route to OCR); two-column layouts read in the wrong order
(PyMuPDF `sort=True` + block-order heuristics; a real risk for technical manuals — test it);
rotated pages; memory blowup on huge pages (subprocess + cap).

---

## 8. OCR processing — FastAPI — ✅ MVP
**Purpose** Make scanned manuals searchable. Non-negotiable for real industrial documents.
**Responsibilities** Decide scope (document vs specific pages); run OCRmyPDF (deskew, rotate,
clean); re-extract; capture per-page confidence; flag low-confidence pages.
**Inputs** `original.pdf` + text-poor page list. **Outputs** `ocr/ocr.pdf`,
`ocr/report.json`, refreshed page text.
**Dependencies** OCRmyPDF, Tesseract, Ghostscript, unpaper; PyMuPDF; fs.
**Rules** ① Auto-trigger on density heuristic; also offer a manual "force OCR" for mixed
documents. ② `--skip-text` by default (never destroy a good existing text layer). ③ Language
packs must match the corpus (**[U] Q1**); a wrong language pack produces confident garbage —
worse than no OCR. ④ Confidence is stored and propagated to the chunk and then to the citation.
**Failures** Binary missing (the #1 local-setup failure — the error message must include the
install command); very slow on large scans (300 dpi ≈ 1–3 s/page CPU → a 300-page scan is
5–15 min; **[A]** budget for it and pre-index demo manuals); tables destroyed by OCR (rows
merged) — flag and down-weight; upside-down pages (auto-rotate handles most).

---

## 9. Document cleaning & normalisation — FastAPI — ✅ MVP
**Purpose** Reduce noise so that chunking and embeddings see clean signal.
**Responsibilities** Unicode NFKC; de-hyphenation across line breaks; whitespace collapse;
repeated header/footer removal; page-number stripping from body text; ligature fixes; bullet
normalisation; **conservative** OCR error correction limited to detected code patterns;
extraction of `error_codes[]` and `part_numbers[]` via a configurable regex family;
injection-pattern scanning.
**Inputs** Raw page text + blocks. **Outputs** Cleaned text + entity annotations + flags.
**Dependencies** Extraction/OCR output.
**Rules** ① Never destroy information you cannot reconstruct — keep the raw text alongside the
cleaned text in `pages.jsonl`. ② Aggressive normalisation of codes is dangerous (`O`→`0` could
corrupt a legitimate code); apply only inside a matched code token and record both forms.
③ The error-code regex family is **config**, because it varies by manufacturer.
**Failures** Over-cleaning removing a table's meaning; header removal deleting a genuine
recurring section title; the regex missing an unusual code format (mitigation: index both the
normalised and raw forms, and let lexical search catch the rest).

---

## 10. Document chunking — FastAPI — ✅ MVP — **highest-attention module**
**Purpose** Produce retrieval units that are self-contained, page-attributable, and preserve
fault-code semantics.
**Responsibilities** Fault-code table → one chunk per row; procedure preservation; section-aware
recursive prose splitting with overlap; contextual header prefixing; metadata attachment;
minimum-size filtering; `chunks.jsonl` emission; `chunking_version` stamping.
**Inputs** Cleaned pages + structure. **Outputs** Chunk objects.
**Dependencies** Cleaning; tokenizer (approximate token counting is fine **[R]**).
**Rules** ① Never split a table row or a numbered procedure step. ② Every chunk **must** have a
resolvable `page_number` — a chunk without one is dropped (citations are the product).
③ Chunks spanning pages record `page_start`/`page_end` and cite the start page.
④ Target ~700 tokens / ~120 overlap **[A]**, tuned against the golden set. ⑤ Fault-code chunks
are typically short — the contextual header and the `error_codes[]` payload compensate.
**Failures** Multi-page tables (join across page boundaries when the header repeats **[R]**);
tables detected as prose; a 50-page uninterrupted parts list producing thousands of tiny
chunks (cap and coalesce); overlap causing duplicate retrieval hits (dedupe stage handles it);
chunk text exceeding the embedding model's context (hard-truncate with a warning counter).
**MVP** ✅ — and budget **real** time here; this is where answer quality is won or lost.

---

## 11. Embedding generation — FastAPI — ✅ MVP
**Purpose** Vectorise chunks, queries, and incident summaries locally.
**Responsibilities** Ollama client with retries/backoff; batching and bounded concurrency;
document vs query prefixes; dimension verification against config; normalisation checks; a
small in-process LRU cache for repeated query embeddings **[R]**.
**Inputs** Text batches. **Outputs** Float vectors + the model/version used.
**Dependencies** Ollama.
**Rules** ① **The same model and the same prefix convention must be used for indexing and
querying** — a mismatch degrades retrieval silently and catastrophically. Guard: store
`embedding_model` in the collection name *and* the payload, and assert at query time.
② Dimension mismatch is a hard failure, never a silent truncation. ③ Concurrency > 2–4 against
a single Ollama instance usually hurts.
**Failures** Ollama down/model not pulled; OOM on a large batch (reduce batch size and retry);
throughput surprise on CPU-only hardware (**measure in Phase 4**: at ~50–150 chunks/s for a
768-dim small model on a decent CPU, a 1,300-chunk manual is ~10–30 s — but validate, do not
assume); silent model swap by an operator (detected by the payload assertion).

---

## 12. Vector indexing — FastAPI — ✅ MVP
**Purpose** Own all Qdrant writes.
**Responsibilities** Collection bootstrap with correct dim/metric/payload indexes; deterministic
point IDs; batched upserts; verification counts; delete-by-filter; blue/green re-index;
collection stats; snapshot trigger for backup **[R]**.
**Inputs** Chunks + vectors; delete requests. **Outputs** Point counts, verification results.
**Dependencies** Qdrant.
**Rules** ① Deterministic IDs (`uuid5`) make every write idempotent — this is what makes retries
safe. ② Never report success without verifying the count. ③ Deletes are by filter, and verified.
④ Payload always includes `is_deleted` for defence in depth even though deleted points are
purged.
**Failures** Qdrant restart mid-batch (idempotent retry); disk full on the Qdrant volume
(monitor in health); a dimension-mismatched collection created by an earlier config (detect at
bootstrap and refuse to start rather than corrupting the index).

---

## 13. Manual search — FastAPI — ✅ MVP
**Purpose** Hybrid retrieval over `manual_chunks`. The retrieval engine used by both the search
UI and the RAG pipeline.
**Responsibilities** Three arms (exact-code filter, lexical, dense) + RRF fusion; mandatory
metadata pre-filter; dedupe; optional rerank; page-neighbour expansion; snippet generation with
term highlighting; score exposure for debugging.
**Inputs** Query, mandatory filter object, k, options. **Outputs** Ranked chunks with full
metadata and per-arm scores.
**Dependencies** Embedding, Qdrant, optional reranker.
**Rules** ① **A search request without a non-empty model/machine filter is rejected with a 400**
— this is the structural guarantee against cross-machine contamination (MUST-11). ② Deleted
manuals excluded. ③ Scores from different arms are never compared directly; only ranks are fused.
④ Return the retrieval trace (which arm produced what) — indispensable for tuning and for the
demo's "explain the retrieval" moment.
**Failures** Vector-only failure on codes (solved by ARM 1); recall loss from an over-narrow
filter (surface "0 results within filter" distinctly from "0 results overall"); reranker latency
blowing the budget (make it optional and time-boxed).

---

## 14. Query understanding — FastAPI — ✅ MVP
**Purpose** Decide what kind of question this is before spending retrieval and LLM budget.
**Responsibilities** Normalise; length/charset validation; classify
(`error_code | symptom | procedure | part_lookup | spec_lookup | followup | out_of_scope |
meta`); extract error codes (+variants), part numbers, measurements, component nouns;
follow-up detection and standalone-query rewriting; injection scanning.
**Inputs** Raw query + conversation history. **Outputs** A structured query object driving arm
weights and thresholds.
**Dependencies** Conversation context; optionally a small LLM for rewriting **[R]** (rules first,
LLM only for pronoun resolution).
**Rules** ① Classification is rules-first (regex + heuristics) — fast, deterministic, debuggable;
LLM only where rules genuinely fail. ② Extracted codes drive ARM 1 and the exact-match boost.
③ An `out_of_scope` classification short-circuits to refusal with no LLM call.
**Failures** Unusual code formats (config-driven regex + lexical fallback); a symptom containing
a number misread as a code (require a code *pattern*, not a bare number); over-eager rewriting
changing the user's meaning (log both original and rewritten; show the rewritten query in the
UI's debug pane **[R]**).

---

## 15. Machine & model detection — FastAPI (assist) + Express (authority) — 🔶 MVP
**Purpose** Determine the retrieval scope, with the correct authority ordering.
**Responsibilities** Resolution order: ① explicit UI selection / conversation binding
(authoritative) → ② asset tag or model alias mentioned in the query text → ③ the user's default
machine **[R]** → ④ ambiguous → clarification.
**Inputs** Conversation, query text, the machine/model registry (aliases).
**Outputs** `{machine_id?, machine_model_id?, confidence, source, alternatives[]}`.
**Dependencies** Machine/model modules, conversation.
**Rules** ① **Express owns the final filter value**; FastAPI may only *suggest* a detection from
text. ② A text mention can never *silently override* an explicit UI selection — it triggers a
confirmation. ③ Ambiguity → clarify, never guess (MUST-12). ④ A conflict between the selected
machine and a mentioned machine is surfaced, not resolved silently (this is the "conflicting
machine context" case).
**Failures** Fuzzy alias matching hitting the wrong model (require a high match threshold);
a user who genuinely wants a general question (offer an explicit "ask across all models" mode
**[R]**, clearly labelled, results tagged with their model).
**MVP** 🔶 — UI selection + conversation binding + simple alias matching. Sophisticated NER is
deferred.

---

## 16. RAG response generation — FastAPI — ✅ MVP
**Purpose** Convert retrieved, classified evidence into a validated structured answer.
**Responsibilities** Context assembly with a token budget and priority ordering; prompt
construction (system rules, evidence blocks with IDs, untrusted-data delimiters, schema
instruction); Ollama chat invocation with `format: json` and low temperature (0.1–0.2 **[R]**);
robust JSON parsing with one repair retry; schema validation; timeout and cancellation.
**Inputs** Query object, manual chunks, incident evidence, maintenance records, machine context,
conversation summary. **Outputs** A validated response object + generation metadata.
**Dependencies** Ollama, retrieval modules, the response schema.
**Rules** ① The LLM may **only** use the provided evidence; it must cite `chunk_id`s that exist
in the context. ② Each schema field maps to exactly one evidence class; inference lives only in
designated fields and is labelled. ③ Deterministic-ish settings (low temperature, fixed seed
**[R]** where supported) so the demo is reproducible. ④ Hard timeout (default 60 s **[A]**) with
a clean, honest failure. ⑤ `PROMPT_VERSION` recorded on every message.
**Failures** Invalid JSON (retry once with a repair instruction, then fall back to a
retrieval-only response — never show raw broken output); the model ignoring grounding (caught by
citation validation); truncation mid-JSON (cap `max_tokens` and request compact fields); a slow
first token because the model was cold (pre-warm at startup **[R]**).

---

## 17. Citation validation — FastAPI (authoritative) + Express (re-assert) — ✅ MVP
**Purpose** Make "the AI invented a page number" mechanically impossible to display.
**Responsibilities** For each citation: `chunk_id` ∈ the context set? `page_number` == the
chunk's actual page? `manual_id` matches? Does the quoted snippet actually appear in the chunk
(normalised fuzzy containment, ≥ 0.8 ratio **[R]**)? Then: drop unverifiable citations, drop or
demote claims left with no citation, recompute confidence, set `validation_report`.
**Inputs** LLM response + the exact context set. **Outputs** A cleaned response + a report of
what was removed.
**Dependencies** Retrieval context, response schema.
**Rules** ① A `manual_evidence` entry without a valid `chunk_id` is **deleted**, always.
② A `corrective_step` whose only support was a deleted citation is moved into `ai_inference`
with an explicit unverified label — downgraded, not silently kept. ③ If > 50% of citations fail
**[A]**, the whole answer is converted to a refusal — that model output cannot be trusted.
④ The validation report is stored on the message (great for the demo and for debugging).
**Failures** Legitimate paraphrase failing snippet containment (use a lenient threshold and
weight `chunk_id` correctness far more than snippet matching); an LLM citing a real chunk for
an unrelated claim (**not** detectable by this module — this is why confidence gating and the
evidence-class UI matter; be honest about this limit in `SECURITY_AND_RELIABILITY.md`).

---

## 18. Refusal & confidence logic — FastAPI — ✅ MVP
**Purpose** Decide honestly whether to answer, clarify, or refuse. **The trust differentiator.**
**Responsibilities** Compute signals (`top_score`, `mean_top3`, `score_gap`, `n_supporting`,
`exact_code_hit`, `evidence_class_coverage`, `citation_validity_rate`, `ocr_confidence`,
`query_specificity`); map to `answer_status` ∈ `{answered, answered_from_history,
partial_answer, clarification_required, insufficient_evidence, out_of_scope,
generation_unavailable}`; map to `confidence` ∈ `{high, medium, low}`; produce `limitations[]`
and `suggested_next_action`.
**Inputs** Retrieval + validation results. **Outputs** Status, confidence, limitations.
**Dependencies** Retrieval, validation; a config file of thresholds.
**Rules** ① Thresholds are **configuration, not constants** — you will tune them in Phase 11
against the golden set. ② `high` confidence requires an exact code hit **or** ≥ 2 independent
chunks above the strong threshold, plus 100% citation validity. ③ OCR-low-confidence sources cap
confidence at `medium`. ④ History-only evidence caps at `medium` and sets
`answered_from_history` (contradiction **X3**). ⑤ Refusal always includes what *was* searched —
a refusal without context feels broken; a refusal with "I searched 3 manuals, 4,102 chunks,
best score 0.31" feels rigorous.
**Failures** Mis-calibrated thresholds (too strict is the more common and more damaging demo
failure; calibrate on real data); score distributions shifting when the embedding model changes
(thresholds are model-specific — store them per model **[R]**).

---

## 19. Conversation management — Express — ✅ MVP
**Purpose** Persist multi-turn troubleshooting sessions with a stable machine scope.
**Responsibilities** Create/list/get/soft-delete conversations; append user and assistant
messages; maintain the machine/model binding; enforce ownership; assemble the recent-turn window
and a rolling summary **[R]**; link conversations to incidents.
**Inputs** User messages, structured AI responses. **Outputs** Conversation + message docs.
**Dependencies** Auth, machines, troubleshooting orchestration.
**Rules** ① A conversation may be linked to a physical machine **[C]**; the binding is set once
and changes only via an explicit, recorded switch. ② Assistant messages store the **full
validated response object** plus the retrieval trace — reproducibility. ③ Users see their own
conversations; managers/admins may read all (for quality review). ④ Prior assistant content is
never used as grounding evidence (**X4**).
**Failures** Unbounded message growth (window + summary); a conversation whose machine was
deleted (render gracefully); two tabs writing concurrently (append-only messages make this safe).

---

## 20. Incident management — Express — ✅ MVP — **the product moat**
**Purpose** Capture what actually happened and what actually fixed it.
**Responsibilities** Incident CRUD and state machine; AI-suggestion snapshots; actions
sub-resource (module 21's data source); the resolution/confirmation gate; recurrence detection
**[R]**; correction/reopen flow; deletion with vector purge.
**Inputs** Technician forms, conversation snapshots. **Outputs** Incident + action docs; a
trigger to embed on confirmation.
**Dependencies** Machines, conversations, audit, FastAPI (embedding).
**Rules** ① Linked to a physical machine whenever possible **[C]**; unlinked incidents are
excluded from retrieval. ② `ai_suggestions` and `incident_actions` are **separate structures**
**[C]**. ③ `resolved_confirmed` requires an explicit human confirmation plus a successful action
plus a root cause **[C]**. ④ Historical resolution status is preserved forever — corrections
create a new revision and are audited, they do not rewrite the past **[C]**. ⑤ Only confirmed
*or* explicitly-status-labelled incidents enter the vector index, and status travels with the
vector.
**Failures** Technicians not logging actions (mitigate with UX: prefill from the conversation,
make it two taps); premature confirmation (allow reopen; recurrence detection catches it);
an incident whose machine is later re-modelled (see `RAG_PIPELINE.md` §11).

---

## 21. Historical incident retrieval — FastAPI (search) + Express (exact/orchestration) — ✅ MVP
**Purpose** Bring the right past experience to the current fault, with honest status labels.
**Responsibilities** Tiered vector search (same machine → same model → **[U]** same type);
exact-code Mongo lookup; the composite ranking formula; status-aware presentation; excluding
unlinked/deleted incidents.
**Inputs** Query embedding, machine context. **Outputs** Ranked historical evidence entries.
**Dependencies** Qdrant `incident_history`, Mongo, embedding.
**Rules** ① Confirmed > unconfirmed, same-machine > same-model, recent > old — via an explicit
weighted formula, not an opaque heuristic. ② **Failed and temporary fixes are shown, clearly
labelled** — negative evidence is real evidence. ③ An unconfirmed incident can never be
presented as a fact. ④ Cross-model retrieval is off by default and, when enabled, is visibly
warned (**X2**).
**Failures** A wrong past fix becoming authoritative (mitigated by the status weighting, the
manual-first evidence priority, and the correction flow); cold start with no history (say so
explicitly); embedding drift between old and new incident vectors after a model change (handled
by full re-index).

---

## 22. Maintenance management — Express — ✅ MVP
**Purpose** Record service events; supply the third evidence class.
**Responsibilities** CRUD; typed records; parts and measurements; due-date tracking **[R]**;
time-window and part-based query API for the RAG pipeline; timeline feed.
**Inputs** Forms **[U]** (CSV import deferred). **Outputs** Maintenance docs.
**Dependencies** Machines, audit.
**Rules** ① Always linked to a physical machine. ② `performed_at` may be in the past, never the
future. ③ Retrieved by **structured query, not embeddings** (Workflow S rationale). ④ Surfaced
as correlation only — the response schema has no field in which the system can assert
maintenance causation (**enforcing a rule via the schema is stronger than enforcing it via a
prompt**).
**Failures** Sparse data making the feature look empty in the demo (**seed realistic maintenance
history** — an explicit Phase 12 task); part numbers entered inconsistently (normalise/uppercase
+ trim **[R]**).

---

## 23. Machine timeline — Express — ✅ MVP (read-model)
**Purpose** One chronological view merging incidents, maintenance, manual additions, and status
changes. The manager's home screen and a very strong demo visual.
**Responsibilities** Merge-sort heterogeneous events with cursor pagination; filter by type/date;
highlight recurrences; annotate temporal proximity between maintenance and incidents.
**Inputs** `machine_id`, filters. **Outputs** A typed event list.
**Dependencies** Incidents, maintenance, manuals, audit.
**Rules** ① Read-only projection; no separate storage (a materialised timeline collection would
be premature). ② Respects soft deletes. ③ Times rendered in the user's timezone.
**Failures** Slow merges as data grows (indexed queries + pagination; trivial at MVP scale).

---

## 24. Audit logging — Express — ✅ MVP
**Purpose** Answer "who changed what, when, and why" for integrity-relevant actions.
**Responsibilities** Append-only writes on: auth events, user/role changes, machine/model
changes, manual upload/reindex/delete, incident create/action/resolve/correct/delete,
maintenance changes, config changes, suspected prompt injection; store actor, IP, request ID,
entity, action, before/after diff (for small documents), and reason.
**Inputs** Service-layer hooks. **Outputs** `audit_logs` docs; an admin query API.
**Dependencies** Mongo, auth.
**Rules** ① No update or delete API exists — append-only (**X9**). ② Never log secrets, tokens,
passwords, or full manual text. ③ Failure to write an audit entry must not silently swallow —
log an error; **[R]** for the most critical actions (role change, deletion), treat an audit
write failure as a failed operation. ④ **[R]** Optional daily hash-chain checkpoint for
tamper-evidence — be honest that it is not tamper-*proof*.
**Failures** Unbounded growth (**[R]** TTL of 365 days on low-value events only, never on
security events); PII/confidential leakage through diffs (allowlist the fields you diff).

---

## 25. Background processing — Express (state) + FastAPI (execution) — ✅ MVP
**Purpose** Run long operations without blocking requests, reliably, without adding a broker.
**Responsibilities** Job records with a stage machine; an in-process bounded worker pool
(`MAX_CONCURRENT_JOBS`, default 2 **[A]**); heartbeats; progress; cooperative cancellation;
classified retries; a boot-time reconciler; duplicate prevention via a unique partial index.
**Inputs** Dispatch requests. **Outputs** Job state transitions, artefacts, vectors.
**Dependencies** Mongo, fs, Ollama, Qdrant.
**Rules** ① Every stage is idempotent and resumable from disk artefacts. ② Only one live job per
manual (DB-enforced). ③ Transient vs deterministic failure classification governs auto-retry.
④ Crash recovery is a **boot-time** responsibility, not a cron. ⑤ No broker in the MVP; the
upgrade path (BullMQ+Redis) is documented but deliberately not taken.
**Failures** A worker dying leaving a stale `running` job (reaper); a queue starved by one huge
document (bounded pool + a per-job time cap); a restart losing in-memory queue entries
(reconciler re-dispatches from Mongo — this is why job state lives in Mongo, not in memory).

---

## 26. System health monitoring — both — ✅ MVP
**Purpose** Know, in one screen, whether the system can actually work right now. Invaluable
30 seconds before a demo.
**Responsibilities** Liveness/readiness per service; Ollama reachability **and** required models
present; Qdrant collection existence + point counts + expected dimension; Mongo ping + index
presence; disk free; job queue depth and failed-job count; last successful indexing; version
info.
**Inputs** Poll. **Outputs** A per-dependency status object (`ok|degraded|down`) + an overall
verdict.
**Dependencies** All.
**Rules** ① Degraded ≠ down — report granularly and describe what still works (e.g. "Ollama
down: search works, answers unavailable"). ② Health checks are cached (5 s **[R]**) so a
polling UI cannot DoS Ollama. ③ Unauthenticated liveness is fine; detailed health requires auth
(it leaks topology otherwise).
**Failures** A health check that itself hangs (short timeouts, always); a false green because
only TCP was checked (verify the *model list*, not just the port).

---

## 27. Evaluation & testing — FastAPI + repo tooling — 🔶 MVP
**Purpose** Prove quality with numbers instead of vibes. A real differentiator with judges.
**Responsibilities** A golden set (30–50 questions with expected manual/page and expected
`answer_status`, including deliberate refusal and clarification cases); a scoring script
(recall@k, MRR, citation validity, refusal precision/recall, latency percentiles); regression
comparison across chunking/embedding/prompt versions; unit and integration tests; e2e tests.
**Inputs** The golden set + a frozen corpus. **Outputs** A metrics report (Markdown/JSON).
**Dependencies** The full pipeline.
**Rules** ① The golden set is authored **by a human** from the actual manuals (this is a
Phase 4/11 task, and it takes real hours — schedule it). ② Every retrieval-affecting change is
re-scored. ③ Refusal cases are first-class test cases, not an afterthought.
**Failures** Overfitting thresholds to a tiny set (keep a held-out subset); a golden set built
from the LLM's own outputs (circular and worthless — must be human-authored).
**MVP** 🔶 — a small set (20–30 questions) plus the core test suites; the full harness is a
stretch goal.

---

## 28. Local deployment & backup — repo/infra — ✅ MVP
**Purpose** One-command startup, and the ability to recover.
**Responsibilities** `docker-compose.yml` (+ profiles for host vs containerised Ollama);
`.env.example`; a preflight script (models pulled, collections created, indexes ensured, storage
writable); a seed script (demo users, models, machines, maintenance, sample manuals); backup
(`mongodump` + Qdrant snapshot + `storage` tar) and a **tested** restore; a README quickstart.
**Inputs** `.env`. **Outputs** A running system.
**Dependencies** Docker, Ollama.
**Rules** ① Only the frontend (and backend in dev) publish ports. ② Named volumes, never
anonymous. ③ Preflight must fail loudly with actionable messages — a hackathon morning is not
the time to debug a missing model. ④ Restore must be tested at least once (an untested backup is
not a backup).
**Failures** GPU passthrough problems (host-Ollama profile is the escape hatch); Compose
version/platform drift (pin image tags — never `:latest` for the demo); first-run model pulls
taking 10+ minutes on venue Wi-Fi (**pull everything the night before**; document the exact
model list and sizes).
