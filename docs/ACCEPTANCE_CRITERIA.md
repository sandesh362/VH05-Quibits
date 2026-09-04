# ACCEPTANCE_CRITERIA.md

Brief §20. Every criterion is **measurable**, has a **verification method**, and is
**demo-observable**. Tags: **[C]** from your list · **[R]** added by me.

**Legend:** *Method* — `M` manual/UI check · `A` automated test · `E` evaluation script.

---

## Core criteria (your 15) **[C]**

### AC-01 — A manual can be uploaded and processed successfully
**Given** a valid native-text PDF (≤ 100 MB, ≤ 2000 pages) and a target machine model,
**when** an admin/manager uploads it, **then** within the processing budget the manual reaches
`processing_status: "ready"` with `indexed_chunk_count > 0`, a verified Qdrant count equal to
`chunk_count`, and every stage recorded as completed.
**Measure** ≥ 95% success on the fixture set; a 300-page native PDF completes in < 3 min **[A]**
on the demo machine. **Method** A + M. **Phase** 3–4.

### AC-02 — A scanned PDF can be processed through OCR
**Given** an image-only PDF, **when** uploaded, **then** OCR triggers automatically (no user
action), text is extracted, per-page confidence is recorded, `ocr_applied: true`, and the content
is retrievable by search.
**Measure** A known phrase on a scanned page is found by `GET /manuals/search` in the top 5;
low-confidence pages are counted and displayed. **Method** A + M. **Phase** 3–4.

### AC-03 — Every indexed chunk preserves its source page
**Given** any processed manual, **then** 100% of indexed chunks have an integer `page_number`
within `1..page_count`, and a random sample of 20 chunks matches the actual PDF page content.
**Measure** 100% presence (a hard invariant — chunks without a page are dropped, never indexed);
≥ 95% sample accuracy **[A]**. **Method** A + M. **Phase** 3.

### AC-04 — Exact error-code searches return relevant results
**Given** a manual containing a fault-code table, **when** searching an exact code (in any
common variant: `E-041`, `E041`, `e 041`), **then** the corresponding fault-code chunk is
returned at rank 1.
**Measure** ≥ 95% rank-1 accuracy across all codes in the golden set. **Method** E. **Phase** 4.

### AC-05 — Machine-specific searches do not mix unrelated machines
**Given** ≥ 2 machine models with indexed manuals, **when** any scoped search or query runs,
**then** 100% of returned chunks carry the requested `machine_model_id`, verified by a
post-retrieval assertion; **and** a search request with an empty/missing filter is rejected
(`422`).
**Measure** **Zero** cross-model results across the entire golden set — a hard gate; any
violation blocks release. **Method** A + E. **Phase** 4/6.

### AC-06 — The system asks for clarification when context is ambiguous
**Given** an error code defined differently by two models, **when** asked without a machine
selected, **then** `answer_status: "clarification_required"` with a question and ≥ 2 options
whose labels show the divergent meanings — and **no** answer content.
**Also** UI-selected machine A + text-mentioned machine B → clarification, never a silent choice.
**Measure** 100% on the clarification cases in the golden set. **Method** A + M. **Phase** 6.

### AC-07 — Unsupported questions are refused
**Given** a question whose answer is absent from the indexed corpus (or is out of scope),
**then** `answer_status ∈ {insufficient_evidence, out_of_scope}`, `corrective_steps` and
`probable_causes` are empty, `limitations` states what was searched (models, manuals, chunks,
best score, threshold), and `suggested_next_action` is concrete.
**Measure** Refusal recall ≥ 95% on the 8 refusal cases; refusal precision ≥ 80% **[A]**
(refusing answerable questions is a failure too). **Method** E. **Phase** 5.

### AC-08 — Answers contain valid citations
**Given** `answer_status: "answered"`, **then** `manual_evidence` is non-empty, every
`chunk_id` exists in `context_chunk_ids`, every page resolves to a real page of the referenced
manual, and every `corrective_step`/`probable_cause` either cites valid evidence or is labelled
`ai_inference` / `unverified`.
**Measure** Citation validity rate = 100% of *displayed* citations (invalid ones are dropped
before display, and the drop count is recorded). **Method** A + E. **Phase** 5.

### AC-09 — The system does not invent page numbers
**Given** an LLM (or a mocked LLM) emitting a nonexistent `chunk_id` or an out-of-range page,
**then** the citation is dropped, the dependent claim is downgraded or removed, and nothing
fabricated reaches the UI; if > 50% of citations fail, the response becomes a refusal.
**Measure** Zero fabricated pages displayed across the adversarial mocked-LLM suite.
**Method** A. **Phase** 5.

### AC-10 — An incident cannot be marked resolved without confirmation
**Given** an incident, **when** `POST /incidents/:id/resolve` is called with
`resolution_status: "resolved_confirmed"`, **then** the server rejects it (`422`, listing what is
missing) unless **all** of: `confirm === true`, ≥ 1 action with `outcome: "worked"`, a non-empty
`root_cause_text`, and a role permitted by `INCIDENT_CONFIRMATION_MODE`. No timer, heuristic, or
AI output can ever set `resolution_confirmed`.
**Measure** 100% of the negative-path tests rejected; `confirmed_by`/`confirmed_at` always
populated on success. **Method** A. **Phase** 7.

### AC-11 — Confirmed incidents can be retrieved later
**Given** a confirmed incident on machine M, **when** a similar query is asked about M
afterwards, **then** it appears in `historical_evidence` with `resolution_confirmed: true`,
`machine_scope: "same_machine"`, and the confirming user's name.
**Measure** Appears within ≤ 5 s of confirmation (embedding latency), at rank 1 for an identical
error code. **Method** A + M — **this is the flagship demo beat**. **Phase** 7.

### AC-12 — Failed incidents are not treated as confirmed fixes
**Given** an incident with `outcome: "no_change"`/`"made_worse"` and
`resolution_status: "unresolved"`, **then** it may appear as historical evidence but is labelled
`history_failed`, is never described as a fix, never becomes a primary `corrective_step`, and
ranks below any confirmed incident of equal similarity.
**Measure** 100% correct labelling; a `made_worse` outcome is rendered as a warning.
**Method** A + M. **Phase** 7.

### AC-13 — Maintenance history appears separately from manual evidence
**Given** a machine with maintenance records, **when** a troubleshooting answer is produced,
**then** maintenance appears **only** in `maintenance_context[]`, never in `manual_evidence[]`,
each entry carries `days_before_incident` and `correlation_strength`, `causal_claim` is always
`false`, and the UI shows the non-causal caption.
**Measure** Zero maintenance items in `manual_evidence`; zero unhedged causal statements in the
adversarial suite. **Method** A + M. **Phase** 8.

### AC-14 — The system remains usable when Ollama is unavailable
**Given** Ollama stopped, **when** a user searches or asks, **then** `GET /manuals/search`
returns lexical results with a warning, `POST /troubleshooting/query` returns `200` with
`answer_status: "generation_unavailable"` plus manual excerpts, the health page shows Ollama
`down` with the impact stated, and **no endpoint returns a 500**.
**Measure** Zero 5xx during the outage drill; all non-AI features fully functional.
**Method** A + M — **a strong live demo beat**. **Phase** 11.

### AC-15 — Processing failures are visible and recoverable
**Given** a job that fails (or is abandoned by a restart), **then** it appears on the admin jobs
page with stage, error code, and a plain-language message; the manual shows `failed` (never
`ready`); Retry creates a new job resuming from the last successful stage; transient errors
auto-retry up to 3×; deterministic errors never auto-retry.
**Measure** 100% of killed-mid-job scenarios recover to a correct terminal state; zero jobs stuck
in `running` after the reaper interval. **Method** A + M. **Phase** 3/11.

---

## Additional criteria **[R]**

### AC-16 — Evidence classes are visually distinguishable
Four lanes with distinct colour **and** icon **and** text label; AI inference is visibly demoted
and badged "unverified"; safety warnings are always rendered first and are not collapsible.
**Measure** A stranger, shown a screenshot, correctly names the source of each block.
**Method** M. **Phase** 9.

### AC-17 — Deleted manuals are immediately unsearchable **[C from MUST-24]**
After `DELETE /manuals/:id`: 0 Qdrant points for that `manual_id` (verified), 0 results in any
search, and the manual is excluded even if Qdrant is unreachable (soft-delete-first ordering +
Express filter). Pre-existing citations in old conversations render as "source manual deleted".
**Measure** Verified point count = 0; a search immediately after deletion returns nothing from it.
**Method** A. **Phase** 4/7.

### AC-18 — Audit trail completeness
Every login (success and failure), user/role change, machine/model change, manual
upload/reindex/delete, incident create/action/resolve/correct/delete, and maintenance change
produces an `audit_logs` entry with actor, action, entity, outcome, and request id. No
update/delete API exists for audit logs.
**Measure** 100% coverage on the audited-action list; a spot check reconstructs a full incident
lifecycle from the log alone. **Method** A. **Phase** 2+.

### AC-19 — Re-indexing is idempotent and non-disruptive
Re-indexing an unchanged manual yields the same point count with no duplicates; the manual
remains searchable throughout; the old `embedding_version` points are removed only after the new
ones are verified.
**Measure** `points_after == points_before`; zero search-unavailable window.
**Method** A. **Phase** 4.

### AC-20 — Performance budget met on the demo machine
| Operation | Target **[A]** |
|---|---|
| Login | < 500 ms |
| Machine/incident list | < 300 ms |
| Manual search (no LLM) | < 1.5 s |
| Troubleshooting query p50 | < 10 s |
| Troubleshooting query p95 | < 18 s |
| 300-page native PDF → ready | < 3 min |
| 100-page scanned PDF → ready | < 12 min |
| Health page | < 1 s |
**Method** E (measured, recorded in `eval/results/`). **Phase** 10–11.
**Note:** these are targets for *your* hardware — measure in Phase 4 and revise the numbers
honestly rather than pretending. A judge respects a measured 14 s far more than a claimed 3 s.

---

## Release gate

**Blocking (must all pass):** AC-01 … AC-15, AC-17.
**Strongly expected:** AC-16, AC-18, AC-19.
**Best effort, must be measured and reported:** AC-20.

**Any AC-05 violation (cross-machine contamination) is an automatic release block**, regardless
of everything else — it is the one failure that invalidates the product's core claim.
