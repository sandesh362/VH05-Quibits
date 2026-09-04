# DEVELOPMENT_ROADMAP.md

Brief §19. Tags: **[C]** **[A]** **[R]** **[U]**.

**Sequence change I recommend and justify:** your proposed order is sound, with **two
modifications**:

1. **Move a thin UI slice earlier.** Rather than a monolithic "Phase 9: React interface", build
   a *minimal* UI shell in Phase 3 (upload + job status) and grow it each phase. Reason: you
   cannot evaluate chunking, retrieval, or refusal behaviour through curl alone, and a UI built
   last is always the thing that breaks the demo. Phase 9 becomes "UI completion and polish"
   rather than "UI from scratch".
2. **Insert Phase 4.5 — retrieval quality calibration** (golden set + threshold tuning) *before*
   the full RAG pipeline. Reason: refusal thresholds and chunking parameters are the product's
   core, and tuning them after everything is built means re-testing everything. Calibrate on
   retrieval metrics before adding the LLM's variance on top.

Everything else keeps your ordering.

**Effort units [A]:** "d" = focused developer-day. Total ≈ 22–28 d of work; for a team of 3 over
a hackathon week this is aggressive — **use the cut lines in `MVP_SCOPE.md` §5**.

---

## Phase 0 — Product analysis & architecture ✅ COMPLETE (this document set)
**Goal** Shared understanding, contracts, and risk register before any code.
**Deliverables** The 12 documents + README. **No implementation code** **[C]**.
**Acceptance** You have reviewed them, answered the blocking open questions, and approved
Phase 1.
**Must not** Write application code, migrations, or UI.

---

## Phase 1 — Local infrastructure & repository setup — ~1.5 d
**Goal** `docker compose up` produces a healthy, empty, fully local system.
**Scope** Monorepo skeleton; Compose (mongo as a single-node replica set, qdrant, ai-service,
backend, frontend/nginx; optional `ollama-docker` profile); `.env.example` + boot-time secret
validation; storage volume layout and permissions; a preflight script; healthcheck endpoints
returning static OK; CI-less lint/format config; `.gitignore` (`storage/`, `.env`, backups).
**Files/modules**
```
docker-compose.yml · docker-compose.override.yml (dev) · .env.example · .gitignore
Makefile (up/down/logs/seed/preflight/backup)
infra/{mongo-init.js, preflight.sh, backup.sh, restore.sh}
backend/{package.json, src/server.js, src/config/env.js, src/routes/health.js, Dockerfile}
ai-service/{pyproject.toml, app/main.py, app/config.py, app/routers/health.py, Dockerfile}
frontend/{package.json, vite.config.js, index.html, src/main.jsx, Dockerfile, nginx.conf}
docs/ (from Phase 0)
```
**DB** None (containers only). **API** `GET /api/v1/health`, `GET /internal/v1/health`.
**UI** A single page showing service health — nothing more.
**Tests** Preflight asserts: Mongo reachable + replica set initiated, Qdrant reachable, Ollama
reachable with both models present, storage writable, all required env vars set.
**Acceptance**
- `docker compose up` → all containers healthy within 90 s **[A]**.
- Frontend at `:5173` (dev) / `:80` shows green health for Mongo, Qdrant, FastAPI; Ollama shows
  green when running on the host.
- Only the frontend (and backend in dev) publish ports; Mongo/Qdrant/FastAPI are internal-only.
- The app refuses to start with a missing or default `JWT_SECRET`.
**Dependencies** Docker, Ollama installed, models pulled (`nomic-embed-text`, the chosen chat
model). **Do this first — venue Wi-Fi is not a model-download plan.**
**Must not** No business logic, no schemas, no auth, no UI beyond the health page.

---

## Phase 2 — Backend foundation & database models — ~2 d
**Goal** Authenticated CRUD over the core registry, with audit.
**Scope** Mongo connection + `ensureIndexes()` + JSON Schema validators; the 11 collection
definitions; auth (Argon2id, JWT, refresh rotation, lockout); the central capability policy map;
validation middleware + NoSQL sanitiser; error envelope + request ids + structured logging;
audit module; users/machine-models/machines CRUD; the seed script.
**Files** `backend/src/{db,models,middleware,modules/{auth,users,models,machines,audit},utils}`
**DB** All 11 collections created with indexes and validators (empty except seeds).
**API** `/auth/*`, `/users/*`, `/machine-models/*`, `/machines/*`, `/health/detailed`.
**UI** Login page + machines list/create (functional, unstyled is fine).
**Tests** Auth flows (login, refresh rotation, reuse detection, lockout); the role×route
permission matrix; unique-index conflicts (409); sanitiser rejects `$`-keys; last-admin
protection.
**Acceptance** Seeded users for all 4 roles can log in; a technician receives 403 on machine
creation; duplicate asset tag → 409; every mutation writes an audit entry; no endpoint ever
returns `password_hash`.
**Dependencies** Phase 1. **Must not** No PDF handling, no AI, no vectors.

---

## Phase 3 — PDF upload & document processing — ~3 d **(highest-risk phase)**
**Goal** A PDF (native or scanned) becomes clean, page-anchored, well-formed chunks on disk.
**Scope** Upload endpoint with full validation; storage layout; job records + the unique partial
index; FastAPI worker pool + heartbeats + cancellation; extraction (layout, tables, headings,
density); OCR fallback with confidence; cleaning/normalisation + entity extraction; **chunking
(the fault-code-row path first)**; artefact persistence; the boot reconciler; a minimal upload UI
with progress.
**Files** `backend/src/modules/{manuals,jobs}` · `ai-service/app/{workers,pipeline/{extract,ocr,
clean,chunk},clients/fs}` · `frontend/src/pages/{Manuals,ManualDetail}`
**DB** `manuals`, `manual_processing_jobs` in active use.
**API** `POST /manuals`, `GET /manuals`, `GET /manuals/:id/job(s)`, internal
`/documents/process`, `/documents/extract`, `/documents/ocr`.
**UI** Upload form, manual list with live status, job detail with per-stage progress and errors.
**Tests** Fixture PDFs: native text, scanned, mixed, two-column, table-heavy, corrupt,
encrypted, oversized. Assert page fidelity, fault-code chunk extraction (≥ N rows), OCR
triggering, duplicate-job prevention, restart recovery, cancellation.
**Acceptance**
- A 300-page native PDF processes end-to-end (through chunking) without manual intervention.
- A scanned PDF triggers OCR automatically and produces searchable text.
- A manual with a 20-row fault table yields ≥ 20 `fault_code` chunks carrying the right codes.
- Every chunk has a valid `page_number`; killing the AI container mid-job leaves a recoverable
  `failed` job, never a stuck `running` one.
**Dependencies** Phase 2; Tesseract/OCRmyPDF/Ghostscript in the AI image.
**Must not** No embeddings, no Qdrant, no RAG. **[R] Budget the most slack here** — this phase
determines final answer quality more than any other.

---

## Phase 4 — Local embeddings & Qdrant indexing — ~1.5 d
**Goal** Chunks become searchable vectors with verified integrity.
**Scope** Ollama embedding client (prefixes, batching, retries, dimension probe); collection
bootstrap with payload indexes; deterministic IDs; batched upsert + count verification; the
terminal job transition owned by Express; delete-by-filter; manual re-index (blue/green); the
LLM-free `GET /manuals/search` with hybrid arms; the orphan sweep.
**Files** `ai-service/app/{clients/{ollama,qdrant},pipeline/{embed,index},search/hybrid}` ·
`backend/src/modules/manuals/{reindex,delete}` · `frontend/src/pages/ManualSearch`
**DB** `manuals.{indexed_chunk_count, embedding_model, embedding_version, indexed_at}`.
**VDB** Both collections created; `manual_chunks` populated.
**API** `GET /manuals/search`, `POST /manuals/:id/reindex`, `DELETE /manuals/:id`, internal
`/embeddings/*`, `/indexing/*`, `/search/manuals`.
**UI** A search page showing results with page, section, score, and per-arm hits.
**Tests** Dimension mismatch → startup refusal; idempotent re-index (identical point count, no
duplicates); delete → 0 points and verified; **filter isolation** (model A never returns model
B's chunks); exact code found by ARM 1 when dense search misses it.
**Acceptance** Search for `E-041` returns the correct fault-code chunk in the top 3 for the
right model and **nothing** for a different model; deleting a manual removes it from search
immediately (AC-05, AC-08 precursor).
**Dependencies** Phase 3, Ollama with the embedding model.

---

## Phase 4.5 — Retrieval calibration **[R] new** — ~1 d
**Goal** Know your retrieval quality *before* the LLM hides it.
**Scope** Author a human-written golden set (30–50 questions from your real manuals with
expected manual/page and expected status, including ~8 refusal cases and ~5 clarification
cases); a scoring script (recall@1/5, MRR, latency); a small bake-off (`nomic-embed-text` vs one
alternative; chunk size 500/700/1000; overlap 80/120); pick and record thresholds.
**Files** `eval/{golden_set.yaml, run_eval.py, results/}`
**Acceptance** Recall@5 ≥ 0.85 **[A]** on error-code questions and ≥ 0.70 on symptom questions;
chosen thresholds recorded in `config/evidence.yaml` with the measured score distribution.
**Must not** Do not tune against LLM output yet — retrieval only.
**Why here:** thresholds calibrated now stay valid; calibrated later, they force a re-test of
everything downstream.

---

## Phase 5 — Core RAG pipeline — ~3 d
**Goal** Grounded, validated, structured answers — including honest refusals.
**Scope** Query understanding (classification, code extraction + variants, rewriting); RRF
fusion + exact-code pinning; dedupe; context assembly + token budget; the versioned prompt;
Ollama chat with `format: json`; schema validation with one repair retry; **citation validation**;
confidence + refusal gate; the response contract; Express re-assertion and persistence;
conversation/message CRUD; the troubleshooting UI with the evidence lanes.
**Files** `ai-service/app/rag/{query,retrieve,context,prompt,generate,validate,confidence}` ·
`backend/src/modules/{conversations,troubleshooting}` · `frontend/src/pages/Troubleshoot` +
evidence components.
**DB** `conversations`, `messages` (with `retrieval_trace` and `validation_report`).
**API** `POST /troubleshooting/query`, `/clarify`, `/conversations/*`, internal `/rag/answer`.
**UI** Chat with the machine-context chip, the four lanes, citations, safety block, limitations,
refusal and clarification panels.
**Tests** Contract tests for every `answer_status`; mocked-LLM tests for fabricated `chunk_id`s
and fake page numbers (must be stripped); refusal on an empty corpus; injection fixtures
(document and user); the >50% invalid-citation → refusal rule.
**Acceptance** AC-07, AC-08, AC-09; a query about an unindexed topic **always** refuses;
no page number ever appears that the server did not resolve itself; p95 latency < 15 s **[A]**.
**Dependencies** Phase 4.5. **Must not** No incident/maintenance evidence yet — lanes render
empty.

---

## Phase 6 — Machine & model context — ~1 d
**Goal** Answers are correctly and safely scoped, and ambiguity is handled well.
**Scope** Machine-context loading; conversation binding + recorded context switches; text-based
detection via aliases with a confirmation on conflict; the code-scope probe; clarification
options with divergent meanings; the "0 manuals for this model" banner; machine modifications
producing standing limitations.
**API** `POST /troubleshooting/clarify`, internal `/search/code-scope-probe`.
**UI** The machine picker, the context chip, the clarification chooser.
**Tests** Two models defining the same code differently → unscoped asks, scoped answers
correctly; UI-selected A + text-mentioned B → clarification, never an answer.
**Acceptance** AC-05, AC-06. **Dependencies** Phase 5.

---

## Phase 7 — Incident history & machine memory — ~2.5 d
**Goal** The loop closes: the system learns from confirmed repairs.
**Scope** Incident CRUD + state machine; AI-suggestion snapshots; `incident_actions`; the
resolution/confirmation gate with server-enforced preconditions; deterministic summary template;
incident embedding + upsert; tiered retrieval + the ranking formula; the correction and reopen
flows; deletion with vector purge; recurrence detection **[R]**;
`pending_vector_sync` reconciliation; the historical-evidence lane.
**Files** `backend/src/modules/incidents` · `ai-service/app/{rag/history, indexing/incidents}` ·
`frontend/src/pages/{Incidents,IncidentDetail}` + the history lane.
**DB** `incidents`, `incident_actions`. **VDB** `incident_history` populated.
**API** the full `/incidents/*` group + internal `/indexing/incidents/*`, `/search/incidents`.
**UI** Incident form (prefilled from a conversation), action log, the resolve dialog with
enforced preconditions, status badges.
**Tests** Resolution gate rejects every incomplete path (AC-10); a confirmed incident becomes
retrievable (AC-11); a failed incident is never labelled a fix (AC-12); a corrected incident
re-embeds; a deleted incident vanishes from retrieval.
**Acceptance** The demo loop works: ask → log → act → confirm → re-ask → the confirmed fix
appears as historical evidence, correctly labelled.
**Dependencies** Phase 6. **This phase is the product differentiator — do not let it get cut.**

---

## Phase 8 — Maintenance history — ~1 d
**Goal** The third evidence class, safely presented.
**Scope** Maintenance CRUD + part-number normalisation; the structured retrieval query;
temporal-proximity computation; deterministic `noted_by_manual` correlation; the prompt block
with the non-causal rule; the maintenance lane; the machine timeline.
**Files** `backend/src/modules/{maintenance,timeline}` · `ai-service/app/rag/maintenance` ·
`frontend/src/pages/{Maintenance,MachineTimeline}`
**DB** `maintenance_records`. **VDB** none (by design).
**API** `/maintenance/*`, `GET /machines/:id/timeline`.
**Tests** Maintenance never appears inside `manual_evidence`; a causal-verb output supported only
by maintenance is rejected/hedged; part intersection produces `noted_by_manual` with a manual
citation.
**Acceptance** AC-13; the maintenance lane always shows the non-causal caption.
**Dependencies** Phase 7.

---

## Phase 9 — React interface completion — ~2.5 d
**Goal** A UI a judge can drive without narration.
**Scope** Design system (colour + icon + label per evidence class, accessible contrast, large
touch targets); page-image citation preview **[R]**; loading/empty/error states everywhere;
the health page; the admin jobs page; the machine timeline visual; responsive tablet layout;
keyboard and screen-reader basics; the persistent safety disclaimer; the request-id error card;
**[R]** the debug drawer showing the retrieval trace.
**Files** `frontend/src/{components,pages,hooks,api,theme}`
**Tests** Playwright **[R]**: login → upload → ask → click citation → log incident → resolve →
re-ask; renders correctly for each `answer_status`.
**Acceptance** All eight demo steps in `MVP_SCOPE.md` §6 are completable by a stranger; every
evidence class is visually distinguishable in a photograph of the screen.
**Dependencies** Phases 5–8.

---

## Phase 10 — Full integration — ~1.5 d
**Goal** Everything works together on one machine, from cold start.
**Scope** End-to-end wiring review; cold-start ordering and retries; the reconciler on real
drift; performance pass (context size, batch sizes, model choice, pre-warming); consistent error
handling; log noise reduction; `docker compose down -v && up` from scratch with seed + a real
corpus; backup and **tested** restore.
**Tests** Full E2E on a fresh machine; a 3-manual corpus indexed from zero; concurrent
usage by 3 users **[A]**.
**Acceptance** A clean clone → `make up && make seed && make preflight` → a working demo in
< 15 min (excluding model downloads); backup/restore verified once.
**Dependencies** Phase 9.

---

## Phase 11 — Testing, security & reliability — ~2 d
**Goal** Deliberately try to break it, then fix what breaks.
**Scope** The full test matrix in `SECURITY_AND_RELIABILITY.md`; dependency-outage drills
(Ollama, Qdrant, Mongo stopped in turn); prompt-injection fixtures; path traversal / NoSQL
injection / IDOR sweeps; rate-limit verification; re-run the golden set and record final metrics;
threshold re-calibration against real answers; log redaction audit; secret-scan the repo before
pushing.
**Acceptance** All 20 acceptance criteria pass; no `500`s in any outage scenario; measured
metrics recorded in `eval/results/` and ready for a slide.
**Dependencies** Phase 10.

---

## Phase 12 — Hackathon demo preparation — ~1 d
**Goal** A demo that cannot fail.
**Scope**
- **Freeze the corpus and pre-index it** (2–3 real manuals + one deliberately scanned one).
- Seed a realistic history: 5–6 incidents in **mixed** statuses (confirmed / temporary / failed
  / recurring) and 8–10 maintenance records — the lanes must look real, not empty.
- Build the two-model same-error-code fixture for the clarification beat.
- Build the no-manual fixture for the refusal beat.
- Pre-warm Ollama; verify the health page immediately before presenting.
- A rehearsed 6-minute script with an explicit fallback for each step (screenshots/recording).
- A 5-slide deck: problem → architecture diagram → the evidence-grading idea → measured metrics
  → risks and honest limitations.
- Offline proof: disable Wi-Fi during the demo.
- A "reset demo" script returning the system to the exact starting state.
**Acceptance** Two full rehearsals completed end-to-end without intervention, timed under the
limit, with a laptop reboot before the second.
**Dependencies** Phase 11.

---

## Dependency graph & parallelisation **[R]**

```
P1 ──► P2 ──► P3 ──► P4 ──► P4.5 ──► P5 ──► P6 ──► P7 ──► P8 ──► P9 ──► P10 ──► P11 ──► P12
                │                      │
                └── UI shell grows continuously from P3 onward ──┘
```
With three developers:
- **Dev A (backend/product):** P2 → incidents/maintenance (P7, P8) → API polish
- **Dev B (AI/documents):** P3 → P4 → P4.5 → P5 (the critical path — protect this person's time)
- **Dev C (frontend):** the UI shell from P3, growing per phase, then P9
Integration checkpoints at the end of P4, P5, P7, and P10.

## Standing "must not implement yet" rules
| Until | Do not build |
|---|---|
| P4 | Any embedding or vector code |
| P5 | Any LLM call |
| P7 | Any incident vectorisation |
| P8 | Any maintenance in the prompt |
| Ever (MVP) | Anything in `MVP_SCOPE.md` §3 |
