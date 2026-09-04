# SYSTEM_ARCHITECTURE.md

Tags: **[C]** confirmed · **[A]** assumption · **[R]** recommendation · **[U]** unknown

---

## 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER (technician's tablet / shop-floor PC)                               │
│  React 18 + Vite + React Router + TanStack Query + Tailwind                  │
│  - JWT in memory; refresh token in httpOnly cookie                           │
│  - Talks to ONE origin only: the Express API                                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS/HTTP  (dev: Vite proxy /api → express)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  EXPRESS API  (Node 20, port 8080)   ── THE ONLY PUBLIC SURFACE ──           │
│  Modular monolith. src/modules/{auth,users,models,machines,manuals,          │
│                    incidents,maintenance,conversations,troubleshooting,      │
│                    audit,health,jobs}                                        │
│  Owns: authN/authZ · validation · business rules · orchestration · Mongo     │
│  Never: PDF parsing, embeddings, vector search, LLM calls                    │
└───┬───────────────────────────┬──────────────────────────────┬───────────────┘
    │ Mongo driver              │ HTTP + shared secret         │ fs (read/write)
    │                           │ (internal network only)      │
    ▼                           ▼                              ▼
┌─────────────┐   ┌──────────────────────────────────┐   ┌─────────────────────┐
│  MongoDB 7  │   │  FASTAPI AI SERVICE (py3.11,     │   │  LOCAL FILESYSTEM   │
│  :27017     │   │  port 8000)  NOT internet-facing │   │  ./storage          │
│  11 colls   │   │  routers: documents, embeddings, │   │  manuals/ ocr/      │
│  authored   │   │  indexing, search, rag, health   │   │  text/ pages/ tmp/  │
│  by Express │   │  in-process worker pool for jobs │   │                     │
└─────────────┘   └───┬──────────────┬───────────┬───┘   └─────────────────────┘
       ▲              │              │           │                  ▲
       │ status       │ vectors      │ generate  │ read/write       │
       │ writeback    ▼              ▼           └──────────────────┘
       │        ┌───────────┐  ┌──────────────┐
       └────────│ QDRANT    │  │  OLLAMA      │
                │ :6333     │  │  :11434      │
                │ 2 colls   │  │ embed + chat │
                └───────────┘  └──────────────┘
```

**Data-flow invariants**

1. The browser talks **only** to Express. FastAPI is never exposed to the browser. **[C]**
2. FastAPI never writes to MongoDB business collections. It returns results; Express persists.
   *One deliberate exception, see §3.4.*
3. Qdrant is a **derived index**. It can always be rebuilt from MongoDB + filesystem.
4. The filesystem holds bytes (PDFs, OCR output, page images). MongoDB holds facts. Qdrant
   holds vectors. Nothing important lives in only one of the three.
5. Ollama is reachable **only** from FastAPI. Express never calls an LLM.

---

## 2. Why exactly two services (and not one, and not seven)

You said "no unnecessary microservices" and "prefer a modular monolith with a separate Python
RAG service." I agree, and here is the defensible reasoning:

**Why not one service?** The document/AI stack (PyMuPDF, Tesseract, OCRmyPDF, tokenizers,
numpy, qdrant-client, optional rerankers) is Python-native. The Node equivalents are
materially worse (`pdf.js` extraction loses layout, no credible OCR binding, no reranker
ecosystem). Forcing one language costs quality where quality matters most (chunking).

**Why not more?** Splitting OCR, embedding, and RAG into separate services would add network
hops, three deployment units, and distributed failure modes for a single-node hackathon app
with ~5 concurrent users. Zero benefit.

**So: two processes, split along a *runtime/language* boundary, not a domain boundary.**
Each is internally a modular monolith with clean module folders. This is the smallest
architecture that satisfies the constraints — and "two services" is defensible to a judge in
one sentence: *"Node owns the product; Python owns the documents and the model."*

**Explicitly rejected infrastructure** (per your instruction, with reasons):

| Rejected | Why not needed |
|---|---|
| Redis | Only needed for a distributed queue/cache. Single node + Mongo-backed job table + in-process worker is sufficient and has fewer moving parts. Mongo can hold the job state transactionally with the business data. |
| Kafka / RabbitMQ | No event streaming, no fan-out, no cross-service pub/sub. Throughput is a handful of jobs per hour. |
| Kubernetes | One machine. Docker Compose is the correct tool. |
| Nginx (prod-hardened) | **[R]** Optional single container to serve the built React bundle and reverse-proxy `/api`. Cheap and makes the demo a single URL. Include it, but it is not "infrastructure complexity" — it is 12 lines of config. |
| Elasticsearch / OpenSearch | Qdrant's payload indexing + a Mongo text index cover the lexical need at this scale. See §4.3. |
| Celery | Requires a broker (Redis/Rabbit). Replaced by FastAPI `BackgroundTasks` + a bounded worker pool + Mongo job state. See `API_CONTRACTS.md` §6. |

---

## 3. Component responsibilities and the ownership boundary

### 3.1 React + Vite (frontend)
| Owns | Does NOT own |
|---|---|
| Rendering, routing, form UX, optimistic states | Any authorization decision (UI hiding is cosmetic) |
| Token lifecycle (memory + refresh cookie) | Any direct call to FastAPI, Qdrant, Ollama, or Mongo |
| Rendering the 4 evidence lanes distinctly | Deciding evidence class (server-assigned) |
| Job progress polling | Business validation (mirrors server rules for UX only) |

**[R]** Dev-time: Vite `server.proxy` maps `/api` → `http://backend:8080`, so the browser sees
one origin and CORS is a non-issue. Prod-ish: static bundle served by Nginx with the same
proxy. This also satisfies the preview-environment constraint that browser code must never
call `localhost` for another service.

### 3.2 Express (the product service) — matches your proposal, confirmed
Owns: authentication, authorization, all user-facing REST APIs, machine/model/manual/incident/
maintenance/conversation persistence, request validation, orchestration of FastAPI calls,
audit logging, job records, file storage of the uploaded PDF, health aggregation.

**Assessment: your proposed split is correct.** I recommend three clarifications:

- **Express, not FastAPI, owns the *decision* to search with a given filter.** Express resolves
  `conversationId`/`machineId` → the authoritative `machine_model_id` and passes it as a
  **mandatory** parameter. FastAPI refuses a search request with an absent filter. This makes
  cross-machine contamination a two-sided invariant.
- **Express owns the job lifecycle record** (`ManualProcessingJob` in Mongo); FastAPI owns job
  *execution* and reports progress back. Rationale: the user-facing truth about "is my manual
  ready" must live where the user-facing API lives, and must survive a FastAPI restart.
- **Express owns conversation persistence**, including the assistant message — it stores the
  validated structured response returned by FastAPI. FastAPI stays stateless w.r.t. Mongo.

### 3.3 FastAPI (the AI/document service) — matches your proposal, confirmed
Owns: PDF text extraction, OCR, cleaning/normalisation, chunking, embedding generation,
Qdrant upsert/delete/search, hybrid retrieval + fusion, optional reranking, context assembly,
prompt construction, Ollama invocation, structured-output parsing, **citation validation**,
confidence scoring and the refusal decision, page-image rendering.

**Change I recommend:** citation validation and the refusal decision should live in FastAPI
(as you proposed) **and** be re-asserted cheaply in Express before persistence — Express
verifies that every `chunk_id` cited in the response was present in the `context_chunk_ids`
FastAPI also returns, and that the response validates against the JSON schema. Defence in
depth: if FastAPI is ever changed carelessly, Express still refuses to store an ungrounded
answer. Cost: ~30 lines. Benefit: the core product guarantee has two independent enforcers.

### 3.4 The one exception to "FastAPI never writes Mongo"
FastAPI needs to write **job progress** frequently (per page during OCR). Two options:
- (a) HTTP callback to Express on each progress tick — chatty, and a job can be orphaned if
  Express restarts mid-tick.
- (b) **[R] Chosen:** FastAPI writes **only** to the `manual_processing_jobs` collection
  (progress, stage, error, counters) using a Mongo user restricted to that one collection.
  Express remains the sole writer of all business collections and of the job's terminal
  status transition to `completed` (which it performs after verifying the vector count).

This keeps the invariant meaningful while avoiding a chatty, fragile callback path. Documented
explicitly so nobody "fixes" it later.

### 3.5 MongoDB — as you proposed, confirmed
Users, machine models, machines, manual metadata, processing jobs, incidents, incident
actions, maintenance records, conversations, messages, audit logs. Details in `DATA_MODEL.md`.
Single-node (no replica set) is acceptable for the MVP; **[R]** note that this means no
multi-document transactions. Design avoids needing them (see `DATA_MODEL.md` §13). If you want
transactions, run a single-node replica set — a one-line Compose change; **[R] do this in
Phase 1**, it is free and unlocks `withTransaction` for the manual-delete path.

### 3.6 Qdrant — as you proposed, confirmed
Two collections: `manual_chunks`, `incident_history`. Details in `QDRANT_DESIGN.md`.

### 3.7 Ollama — as you proposed, confirmed
Two model roles: an **embedding model** and a **generation model**. Runs on the host **[R]**
for GPU access and easier `ollama pull` management, reached via a configurable base URL.
Compose provides an optional containerised profile for machines without GPU.

### 3.8 Local filesystem layout

```
storage/                          # bind-mounted; gitignored; single source for bytes
├── manuals/<manual_id>/
│   ├── original.pdf              # immutable, checksum-verified, mode 0640
│   ├── meta.json                 # sha256, size, page_count, uploader, mime
│   ├── extracted/pages.jsonl     # one JSON per page: {page, text, blocks, source:"native|ocr"}
│   ├── ocr/ocr.pdf               # OCRmyPDF output (only if OCR ran)
│   ├── ocr/report.json           # per-page confidence, DPI, language, duration
│   ├── chunks/chunks.jsonl       # final chunk objects (audit trail of what was embedded)
│   └── pages/p{n}.webp           # rendered page images (lazy, for citation preview) [R]
└── tmp/<job_id>/                 # scratch; reaped on boot and on job completion
```

Rules: filenames on disk are **system-generated** (`manual_id` = ObjectId/UUID), never the
user's filename. The original filename is metadata in Mongo only. This kills path traversal
and unsafe-filename issues at the source (see `SECURITY_AND_RELIABILITY.md` §7–8).

---

## 4. Key architectural decisions

### 4.1 Sync vs async boundary
| Operation | Mode | Budget |
|---|---|---|
| Manual upload (accept bytes) | Sync | < 2 s |
| Extraction → OCR → chunk → embed → index | **Async job** | 1–10 min |
| Troubleshooting query | **Sync request/response** | target < 12 s **[A]** |
| Incident embedding on confirmation | Async, fire-and-forget with retry | < 5 s |
| Manual delete (vector purge) | Sync purge, async file cleanup | < 3 s |

**[R]** Streaming the answer is optional; if added, stream *only* after validation, or stream
prose and attach validated citations at the end. Never stream unvalidated citations.

### 4.2 Embedding model decision **[R] — with a real evaluation, not a default**

You said start with `nomic-embed-text` and evaluate. My assessment:

| Model (Ollama) | Dim | Ctx | Notes for technical manuals |
|---|---|---|---|
| `nomic-embed-text` (v1.5) | 768 | 8192 | Strong general retrieval, long context, small (~274 MB), **supports task prefixes** (`search_document:` / `search_query:`) which measurably helps asymmetric retrieval. Safe default. |
| `mxbai-embed-large` | 1024 | 512 | Often edges out nomic on MTEB retrieval, but the **512-token context is a real constraint** for table-heavy chunks; larger index. |
| `bge-m3` | 1024 | 8192 | Multilingual + supports multi-vector/sparse concepts; heavier. **Choose this if Q1 (manual language) answers "not only English".** |
| `all-minilm` | 384 | 512 | Fast and tiny; noticeably weaker. Only a fallback for a very weak demo laptop. |
| `snowflake-arctic-embed` | 768/1024 | 512 | Competitive on retrieval; short context again. |

**Recommendation:** keep `nomic-embed-text` as the default, *because* of 8k context + prefix
support + small footprint, but treat it as a **configuration value, not a hard-coded
constant**, and run a real comparison in Phase 4 against a 30-query golden set on your actual
manuals (measure recall@5 and MRR). Switch to `bge-m3` if non-English manuals are in scope.

**Critical rule:** the model name **and** its dimension are recorded in the Qdrant collection
name and in every point payload (`embedding_model`, `embedding_version`). Changing the model
means creating a new collection and re-indexing — never mixing. See `QDRANT_DESIGN.md` §7.

**Generation model [R]:** default `qwen2.5:7b-instruct` (strong instruction-following and
reliable JSON, good technical reasoning) with `llama3.1:8b-instruct` as the alternate, and
`qwen2.5:3b-instruct` as the low-VRAM fallback. Decide after Phase 5 measurement. Requirements
that actually matter: (1) obeys a JSON schema, (2) obeys "answer only from context", (3) fits
in available VRAM with a 8k context, (4) ≤ ~10 s for a ~400-token answer on the demo machine.
Use Ollama's structured-output/`format: json` support plus a schema validator.

### 4.3 Retrieval architecture — hybrid, not vector-only **[R], and non-negotiable in my view**

Vector search **cannot** reliably distinguish `E-041` from `E-042`; they are near-identical
tokens and embeddings will place them adjacent. For a system whose headline use case is error
codes, vector-only retrieval is a design defect.

**Chosen: three retrieval arms fused with Reciprocal Rank Fusion.**

```
Query "E-041 servo overload on INJ-03"
   ├── ARM 1  Exact code match     → Qdrant scroll with payload filter
   │          error_codes CONTAINS "E-041"   (+ normalised variants E041, E 041, E-41)
   │          Deterministic. Highest weight when it hits.
   ├── ARM 2  Lexical/keyword      → MongoDB text index over chunk text (mirror of chunk text)
   │          OR Qdrant sparse/BM25 if enabled. Catches part numbers, model strings.
   └── ARM 3  Dense vector         → Qdrant search, same metadata filter, top-k 20
                    │
                    ▼  RRF fusion (k=60) with arm weights [1.5, 0.8, 1.0]  (configurable)
                    ▼  dedupe by chunk_id, then by 0.92 cosine near-dup
                    ▼  optional cross-encoder rerank → top-n 6..8
                    ▼  context assembly with page-neighbour expansion
```

**On ARM 2's storage**: **[R]** mirror chunk text into a `manual_chunks_text` Mongo collection
with a text index. Cost: duplicated text (already duplicated in Qdrant payload and in
`chunks.jsonl`) — acceptable at this scale and it avoids adding Elasticsearch. Alternative:
Qdrant's built-in sparse vectors / full-text payload index (Qdrant supports full-text match
filters), which avoids the mirror entirely. **[R] Prefer Qdrant's full-text payload index
first**; fall back to the Mongo mirror only if it proves inadequate. Decide in Phase 4.

### 4.4 Evidence separation as an architectural property, not a prompt request
The four evidence classes are retrieved by **separate calls into separate collections** and
kept in **separate arrays** all the way to the UI. The LLM receives them in labelled,
delimited blocks and must emit them back into separate schema fields (`manual_evidence`,
`historical_evidence`, `maintenance_context`). Anything the LLM says outside those fields is
by definition `INFERENCE`. Separation is thus enforced by the *schema*, not by the model's
goodwill.

### 4.5 Deployment topology

```yaml
# docker-compose.yml (shape only — no implementation this phase)
services:
  mongo:        # mongo:7  --replSet rs0 (single node) [R]; volume mongo_data; no host port in prod profile
  mongo-init:   # one-shot rs.initiate()
  qdrant:       # qdrant/qdrant:latest; volume qdrant_data; 6333/6334
  ai-service:   # ./ai-service; depends_on mongo,qdrant; mounts ./storage; OLLAMA_BASE_URL env
  backend:      # ./backend; depends_on mongo, ai-service; mounts ./storage; 8080
  frontend:     # ./frontend (build) served by nginx; proxies /api → backend; 5173/80
  # ollama:     # optional profile "ollama-docker" for GPU-less/host-less setups
networks: { internal: {} }   # ai-service, mongo, qdrant NOT published to host in prod profile
volumes:  { mongo_data, qdrant_data }
```

Key points:
- **Only `frontend` (and `backend` in dev) publish ports.** Mongo/Qdrant/FastAPI stay on the
  internal network. This single decision removes a large class of security findings.
- `OLLAMA_BASE_URL` defaults to `http://host.docker.internal:11434`; Linux Compose adds
  `extra_hosts: ["host.docker.internal:host-gateway"]`. Resolves contradiction **X5**.
- Healthchecks on every service; `depends_on: condition: service_healthy`.
- A `preflight` script (Phase 1) verifies: models pulled, Qdrant collections exist with the
  right dimension, storage writable, Mongo indexes created.

### 4.6 Configuration & secrets
Single `.env` at the repo root + `.env.example` committed. Secrets: `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `INTERNAL_SERVICE_TOKEN`, `MONGO_ROOT_PASSWORD`, `QDRANT_API_KEY` **[R]**
(yes, set one even locally). Never committed; validated at boot by a schema (`zod`/`pydantic-
settings`) so the app fails loudly on a missing secret rather than defaulting to `"secret"`.

---

## 5. End-to-end workflows (A–W)

Common notation: **T** trigger · **S** steps · **Svc** services · **DB** Mongo changes ·
**VDB** Qdrant changes · **UX** user-visible result · **F** failure behaviour · **Sec**
security considerations.

---
### Workflow A — User registration and login
**T** Admin creates a user (self-registration is **disabled** in MVP **[R]** — an industrial
tool should not allow anonymous signup; a seed admin is created by an infra script).
**S**
1. `POST /api/v1/users` (admin, authorised) → validate email/username uniqueness, role ∈ enum,
   password policy (≥ 12 chars **[A]**).
2. Hash with **Argon2id** (`memory 64 MB, time 3, parallelism 1`) **[R]**; bcrypt cost 12 is an
   acceptable alternative.
3. Insert `users` doc with `is_active: true`, `must_change_password: true` **[R]**.
4. Login: `POST /api/v1/auth/login` → constant-time-ish lookup, verify hash, check `is_active`.
5. Issue access JWT (15 min, `{sub, role, jti, ver}`) + refresh token (7 days, **httpOnly,
   SameSite=Strict, Secure-in-prod cookie**, stored hashed in `users.refresh_tokens[]`).
6. `POST /api/v1/auth/refresh` rotates the refresh token (single-use, reuse ⇒ revoke family).
7. `POST /api/v1/auth/logout` revokes the presented refresh token.

**Svc** Express, Mongo. **DB** `users` insert/update (`last_login_at`, token hashes);
`audit_logs`: `user.created`, `auth.login.success|failure`, `auth.logout`.
**VDB** none. **UX** Login screen → role-appropriate dashboard.
**F** Wrong credentials → generic `401 "Invalid credentials"` (never reveal which field);
5 failures in 15 min → lockout for 15 min **[R]**; Mongo down → `503` with a clear banner.
**Sec** No user enumeration; rate limit `/auth/*` (10/min/IP); access token never in
localStorage (XSS exfiltration) — keep in memory, rely on the refresh cookie for reload;
`users.password_hash` excluded by default projection; audit failures without logging the
attempted password.

---
### Workflow B — Machine creation
**T** Admin/manager submits the machine form (must pick an existing model).
**S**
1. `POST /api/v1/machine-models` first if the model is new: `{manufacturer, model_name,
   machine_type}` → unique compound index `(manufacturer, model_name)` (case-insensitive
   collation) prevents duplicates like "Siemens" vs "siemens".
2. `POST /api/v1/machines` `{asset_tag, machine_model_id, location, serial_number,
   installed_at, status}`.
3. Validate `machine_model_id` exists and is not soft-deleted; `asset_tag` unique.
4. Insert; denormalise a **read-only display snapshot** `model_snapshot:{manufacturer,
   model_name, machine_type}` for list rendering (see `DATA_MODEL.md` §13 on the consistency
   rule: snapshots are display-only and never used for filtering).

**Svc** Express, Mongo. **DB** `machine_models` and/or `machines` insert; `audit_logs`.
**VDB** none. **UX** Machine appears in the picker; its timeline page exists but is empty;
a banner shows "0 manuals indexed for this model" if applicable — an important honesty cue.
**F** Duplicate asset tag → `409` with the conflicting machine linked. Missing model → `422`.
**Sec** Role check (`machine:create`); strict field allowlist to prevent mass assignment;
`asset_tag` sanitised to `[A-Za-z0-9._-]{1,64}` **[R]** since it may appear in filters and QR.

---
### Workflow C — Manual upload
**T** Admin/manager uploads one or more PDFs and selects the target machine model.
**S**
1. `POST /api/v1/manuals` `multipart/form-data`, one file per request **[R]** (simpler
   progress and error handling; the UI loops for multi-file).
2. Express (multer, disk storage to `storage/tmp/`) enforces: extension `.pdf`, declared MIME,
   **magic bytes `%PDF-`**, size ≤ `MAX_PDF_MB` (default 100 **[A]**), page count ≤ 2000 **[A]**.
3. Compute `sha256`. If a non-deleted manual with the same hash **and** same model exists →
   `409 duplicate` with a link (idempotency without a token).
4. Create `manuals` doc: `status: "uploaded"`, `processing_status: "queued"`, original filename
   retained as *metadata only*.
5. Move file to `storage/manuals/<manual_id>/original.pdf` (atomic rename within the same
   volume), write `meta.json`, `chmod 0640`.
6. Create `manual_processing_jobs` doc `{manual_id, status:"queued", stages:[...]}`.
7. Call FastAPI `POST /internal/v1/documents/process` `{job_id, manual_id, path, options}` →
   returns `202 accepted` immediately.
8. Respond `201 {manual_id, job_id}`.

**Svc** Express (+fs) → FastAPI. **DB** `manuals`, `manual_processing_jobs`, `audit_logs`.
**VDB** none yet. **UX** Manual card appears with a live "Queued → Extracting → OCR → Chunking
→ Embedding → Indexing → Ready" progress bar (polled every 2 s **[R]**).
**F** Oversize/wrong magic bytes → `422`, temp file deleted. Disk full → `507`, job not
created. FastAPI unreachable → job stays `queued` with `dispatch_error`; a **reconciler**
(§Workflow W) retries; the UI shows "Waiting for the processing service".
**Sec** Never trust `req.file.originalname` for any path (path traversal). Store under a
generated ID. Reject encrypted PDFs. Scan for JavaScript/embedded-file/launch actions and
strip or flag (see `SECURITY_AND_RELIABILITY.md` §6). Upload rate limit (10/hour/user **[A]**).
Multer file-count and field-size limits to prevent memory DoS.

---
### Workflow D — PDF extraction (native text)
**T** FastAPI worker picks up the job.
**S**
1. Open with PyMuPDF; read page count, metadata, per-page rotation. Reject encrypted.
2. For each page: extract text **with layout** (`get_text("dict")` → blocks, lines, spans with
   bounding boxes and font sizes). Bounding boxes are what later enable citation highlighting.
3. Compute a **text-density metric** per page: `chars_per_page`, `alpha_ratio`,
   `image_area_ratio`. Threshold **[A]**: a page is "text-poor" if `< 120` extractable chars
   **and** `image_area_ratio > 0.5`.
4. Detect table-like structures: aligned x-positions across ≥ 3 consecutive lines, or
   PyMuPDF `find_tables()`. Mark blocks `is_table: true`.
5. Infer heading hierarchy from font size/weight percentiles per document → `section_path`
   (e.g. `["7. Faults","7.3 Servo faults"]`). Best-effort, nullable (contradiction **X8**).
6. Write `extracted/pages.jsonl`; update job progress per page.
7. If `text_poor_pages / total_pages > OCR_TRIGGER_RATIO` (default 0.25 **[A]**) → Workflow E
   for the whole document; if only isolated pages are poor → OCR **those pages only**.

**Svc** FastAPI, fs. **DB** `manual_processing_jobs.stages.extraction` progress/metrics;
`manuals.page_count`.
**VDB** none. **UX** Progress "Extracting page 41/312"; on completion, an
extraction-quality badge (Good / Partial / OCR required).
**F** Corrupt PDF → job `failed`, `error_code: PDF_CORRUPT`, actionable message. Encrypted →
`PDF_ENCRYPTED`. Timeout (default 15 min **[A]**) → `failed` with the page reached, resumable.
**Sec** Parse in a subprocess with a wall-clock timeout and memory cap **[R]** so a PDF bomb
kills the worker child, not the service. No shell interpolation of paths.

---
### Workflow E — OCR fallback
**T** Extraction flags text-poor pages, or the user forces OCR.
**S**
1. Choose scope: whole document or a page list.
2. Run **OCRmyPDF** (`--skip-text` for mixed docs, `--force-ocr` only when explicitly
   requested, `--rotate-pages --deskew --clean --optimize 1 --language eng` **[U] language
   depends on Q1**) into `ocr/ocr.pdf`. Rationale for OCRmyPDF over raw Tesseract: it handles
   rasterisation, deskew, rotation, and *writes a text layer back into a PDF*, which preserves
   page identity — critical for citations — and gives us a verifiable artefact.
3. Re-run Workflow D extraction against `ocr.pdf` for those pages.
4. Capture per-page OCR confidence (Tesseract TSV mean confidence) into `ocr/report.json`;
   store `min/mean` confidence on the job and per chunk.
5. Pages with mean confidence `< OCR_MIN_CONF` (default 60 **[A]**) are marked
   `low_ocr_confidence: true` — indexed, but **down-weighted in ranking and visibly flagged in
   citations** ("OCR quality: low — verify against the printed manual").

**Svc** FastAPI (OCRmyPDF/Tesseract/Ghostscript), fs.
**DB** job stage `ocr` metrics; `manuals.ocr_applied`, `manuals.ocr_quality`.
**VDB** none. **UX** "Scanned document detected — running OCR (this takes longer)". Final
badge shows OCR quality. **[R]** Show the count of low-confidence pages honestly.
**F** Tesseract missing → `failed: OCR_UNAVAILABLE` with the fix instruction (this is a very
common local-setup failure — make the error message excellent). OCR timeout → partial success:
index the pages that succeeded, mark the job `completed_with_warnings`, list failed pages.
**Sec** OCRmyPDF invoked via `subprocess` with an **argument list, never a shell string**;
output paths generated, not user-supplied; per-page timeout to bound DoS from a
1000-page scan.

---
### Workflow F — Document chunking
**T** Extraction (and OCR, if any) complete.
**S** — *this is the highest-value algorithm in the system; see `RAG_PIPELINE.md` §3.*
1. Normalise: de-hyphenate line breaks, collapse whitespace, strip repeated headers/footers
   (detected as identical text at the same y-position on ≥ 60% of pages **[A]**), drop page
   numbers from the text body (they live in metadata), normalise unicode (NFKC), fix common OCR
   confusions in codes (`O`↔`0`, `l`↔`1`) **only inside detected code patterns [R]**.
2. **Fault-code table extraction (special path):** when a table has a column matching
   `/(fault|error|alarm|code)/i`, emit **one chunk per row**, formatted as
   `"Error code: E-041 | Description: ... | Cause: ... | Remedy: ..."`, with
   `chunk_type: "fault_code"` and `error_codes: ["E-041"]`. This single behaviour is what makes
   error-code lookup work well.
3. **Prose path:** section-aware recursive splitting — never cross an H1/H2 boundary; target
   ~700 tokens, overlap ~120 tokens **[A, tune in Phase 4]**; never split a table or a
   numbered procedure mid-step.
4. **Procedure preservation:** a detected numbered/step list is kept whole up to 1500 tokens.
5. Attach to every chunk: `page_number` (page of the chunk's *start*; plus `page_end` if it
   spans), `section_path`, `section_title`, `chunk_index`, `bbox_union`, `char_span`,
   `is_table`, `low_ocr_confidence`, extracted `error_codes[]`, `part_numbers[]`.
6. Prepend a small **contextual header** to the embedded text **[R]**:
   `"[{manufacturer} {model_name} — {section_path}] "` — cheap contextual retrieval that
   measurably improves matching for short chunks, at ~15 tokens' cost.
7. Drop chunks with `< 40` meaningful chars (page-number-only fragments, artefacts).
8. Write `chunks/chunks.jsonl`.

**Svc** FastAPI. **DB** job stage `chunking` (`chunk_count`, `fault_code_chunks`).
**VDB** none. **UX** "Created 1,284 chunks (73 fault-code entries)" — a genuinely reassuring
detail to show.
**F** Zero chunks → job `failed: NO_TEXT_EXTRACTED` (prevents an empty manual silently
appearing "Ready" — a nasty class of bug). Pathological tables → fall back to prose chunking
and record a warning.
**Sec** Chunking is where a **prompt-injection scan** runs: flag chunks matching patterns like
`ignore (all )?previous instructions`, `system prompt`, `you are now`, `disregard`. Store
`injection_flag: true` on the chunk; such chunks are still indexed (they may be legitimate
text) but are wrapped in extra-strong delimiters and, if flagged, **excluded from context by
default** with an admin-visible notice **[R]**.

---
### Workflow G — Local embedding generation
**T** Chunking complete.
**S**
1. Load config `EMBEDDING_MODEL`, `EMBEDDING_DIM`. Verify against Ollama
   (`POST /api/embeddings` on a probe string, assert vector length == configured dim; fail the
   job loudly on mismatch rather than indexing garbage).
2. Prefix each chunk text with the document prefix (`search_document: ` for nomic) **[R]**.
3. Batch (default 32 **[A]**) with bounded concurrency (default 2 **[A]**) — Ollama serialises
   internally; excessive concurrency only causes timeouts.
4. Retry per batch: 3 attempts, exponential backoff (1 s/4 s/12 s). On persistent failure the
   job goes `failed` at stage `embedding` with `chunks_embedded` recorded so it can resume.
5. Sanity checks: no NaN, non-zero norm, correct dim. **[R]** Compute a corpus-level mean
   pairwise similarity on a sample; if > 0.98 the model is degenerate/misconfigured — abort.
6. Keep vectors in memory (or a temp `.npy`) for the indexing stage; do not persist to Mongo.

**Svc** FastAPI → Ollama. **DB** job stage `embedding` progress.
**VDB** none yet. **UX** "Embedding 640/1284".
**F** Ollama down → job `failed: OLLAMA_UNAVAILABLE`, retryable with one click; the manual
stays `processing_failed` and is **not** searchable. Model missing → error text includes the
exact `ollama pull <model>` command.
**Sec** Embedding text is data, not instruction — no injection risk here, but log **counts,
never chunk text** (manual content may be OEM-confidential).

---
### Workflow H — Qdrant indexing
**T** Embeddings ready.
**S**
1. Ensure collection `manual_chunks__{model}__{dim}` exists with the right dim/metric; create
   payload indexes on `machine_model_id`, `manual_id`, `error_codes`, `page_number`,
   `is_deleted`, `chunk_type` (see `QDRANT_DESIGN.md`).
2. **Deterministic point IDs:** `uuid5(NAMESPACE_MANUAL, f"{manual_id}:{chunk_index}:{embedding_version}")`.
   This makes re-indexing idempotent — a retry overwrites rather than duplicating. **Critical.**
3. Upsert in batches of 128 **[A]**, `wait=true` on the final batch.
4. **Verify:** `count(filter: manual_id == X)` == `chunk_count`. Mismatch ⇒ job
   `failed: INDEX_VERIFICATION_FAILED` (never mark a partially indexed manual "Ready").
5. FastAPI reports completion; **Express** flips `manuals.processing_status = "ready"`,
   `indexed_chunk_count`, `indexed_at`, and the job to `completed`.

**Svc** FastAPI → Qdrant; Express finalises. **DB** `manuals`, `manual_processing_jobs`,
`audit_logs: manual.indexed`. **VDB** N points upserted into `manual_chunks`.
**UX** Manual becomes "Ready — searchable", chunk count shown; the model's machines lose the
"no manuals" banner.
**F** Qdrant down → `failed: QDRANT_UNAVAILABLE`, retryable; partial batches are harmless
because IDs are deterministic and the verification step gates completion. Dimension mismatch
→ hard fail with a clear "collection expects 768, model produced 1024" message.
**Sec** Qdrant not exposed on the host; **[R]** API key set even locally; payload contains
manual text (confidential) — the volume is part of the backup-exposure surface (§22 of the
security doc).

---
### Workflow I — Manual search (retrieval without generation)
**T** User uses the "Search manuals" screen (a deliberately separate, LLM-free feature).
**S** `GET /api/v1/manuals/search?q=&machineId=|modelId=&page=` → Express resolves and enforces
the filter → FastAPI `POST /internal/v1/search/manuals` → hybrid retrieval (§4.3) → returns
ranked chunks with page, section, snippet, score, manual title.
**Svc** Express → FastAPI → Qdrant (+Ollama for the query embedding).
**DB** none (**[R]** optionally a lightweight `search_events` log for evaluation).
**VDB** read-only. **UX** A result list with page links and highlighted terms.
**F** Ollama down → **degrade to lexical-only** and show "Semantic search unavailable — showing
keyword results." This is a genuinely useful degradation and a good demo point (AC-14).
**Sec** Filter is server-derived. `q` length-capped (512 chars **[A]**). Results restricted to
non-deleted manuals.

---
### Workflow J — Exact error-code troubleshooting *(the flagship path)*
**T** Technician selects machine `LINE2-INJ-03`, asks "E-041".
**S**
1. Express validates the conversation, resolves `machine → model`, loads machine context
   (model, type, manufacturer, install date, recent maintenance summary), loads the last N
   turns (default 6 **[A]**).
2. `POST /internal/v1/rag/answer` with `{query, machine_context, conversation_context,
   filters:{machine_model_id, machine_id}, options}`.
3. FastAPI: validate → classify query = `error_code` → extract `E-041` (regex family:
   `[A-Z]{1,4}[-_ ]?\d{2,5}`, `F\d+`, `Alarm \d+`, plus normalised variants).
4. Retrieval: ARM 1 exact `error_codes CONTAINS E-041` (filtered to the model) → typically
   1–3 high-precision fault-code chunks; ARM 3 dense for surrounding procedure text; ARM 2
   lexical for the literal string. RRF fuse.
5. Parallel: `incident_history` search filtered `machine_id == this` (then widen to
   `machine_model_id`), plus a direct Mongo query for incidents with `error_code == "E-041"`
   on this machine — exact beats fuzzy for codes here too.
6. Parallel: maintenance records for this machine within the last 90 days **[A]**.
7. Assemble context in priority order (§`RAG_PIPELINE.md` §7), token-budgeted.
8. Prompt → Ollama with `format: json` → parse against the response schema.
9. **Citation validation:** every `manual_evidence[].chunk_id` must be in the supplied context;
   `page_number` must equal that chunk's real page; a claim whose citation fails is dropped and
   the answer is downgraded.
10. Confidence: multi-signal (exact code hit = strong). Refusal gate evaluated.
11. FastAPI returns the structured response + `context_chunk_ids` + timings.
12. Express re-validates against the schema, persists the user and assistant `messages`,
    updates the conversation, and returns it.

**Svc** all. **DB** `conversations`, `messages` (with `retrieval_trace` for debuggability).
**VDB** read-only. **UX** Four evidence lanes; corrective steps with safety warnings first;
page links; "Log this as an incident" CTA prefilled with the code.
**F** No chunk with that code → **do not fall back to the LLM's memory**; return
`answer_status: "insufficient_evidence"` and suggest checking the code format / uploading the
fault-code supplement. Ollama down → return retrieval results with
`answer_status: "generation_unavailable"` (the UI still shows the manual excerpts — genuinely
useful, and it satisfies AC-14).
**Sec** Prompt injection defences (retrieved text delimited and declared untrusted);
model filter is server-side; message content sanitised on render (no raw HTML).

---
### Workflow K — Natural-language symptom troubleshooting
**T** "The hydraulic pump is whining and the platen is drifting down slowly."
**S** As J, but: classification = `symptom`; no code extracted; ARM 1 is skipped (or attempts
symptom→code mapping via fault-code chunk descriptions **[R]** — a nice touch: match symptom
text against the *description* column of fault-code chunks to *propose* likely codes);
dense retrieval dominates; k raised to 24 before rerank; a cross-encoder reranker (if enabled)
matters most here. Confidence starts lower; the threshold for "answered" requires ≥ 2
independent supporting chunks **[R]**.
**UX** Ranked probable causes, each with its own citation, ordered by evidence strength, and an
explicit "checks to perform in this order" list.
**F** Vague query ("it's broken") → clarification response asking for the observed symptom,
the code on the HMI, and when it started. Low top score → refusal or a hedged answer with
`confidence: low` and a prominent limitations block.
**Sec** As J; also cap query length and strip control characters.

---
### Workflow L — Ambiguous error-code troubleshooting
**T** "What does E-041 mean?" with **no machine selected**, or a machine whose model has
multiple manuals with conflicting definitions, or the user names a model that maps to several
physical machines.
**S**
1. Machine/model detection: from conversation binding → explicit mention in the text
   (fuzzy-match against known asset tags/model names) → user default. If still absent →
   query Qdrant *unfiltered but grouped by `machine_model_id`* to see **how many distinct
   models define this code**.
2. If ≥ 2 distinct models define it with different meanings → return
   `answer_status: "clarification_required"` with a `clarification_question` and an options
   list: `[{machine_model_id, label:"Toshiba EC180SX — Servo overload"}, {…"Door interlock"}]`.
   **Show the divergent meanings** — this is what makes the disambiguation feel intelligent
   rather than obstructive.
3. If exactly one model defines it and the user has one machine of that model → **[R]** answer,
   but state the assumption explicitly in `limitations` ("Assumed machine LINE2-INJ-03, the
   only Toshiba EC180SX registered").
4. The user's choice is persisted on the conversation so follow-ups inherit it.

**Svc** all. **DB** `conversations.machine_id` set on resolution; a clarification assistant
message stored. **VDB** read-only (an unfiltered *aggregate* probe, never used to answer).
**UX** A compact chooser, not a wall of text.
**F** Zero models define the code → `insufficient_evidence` with "This code does not appear in
any indexed manual. 4 models are indexed. Check the code or upload the manual."
**Sec** The unfiltered probe returns **only** aggregated model names/counts, never chunk text —
otherwise it becomes a cross-machine information leak.

---
### Workflow M — Unsupported-question refusal
**T** Out-of-scope ("what's the weather"), in-scope but unindexed ("how do I calibrate the
laser?" with no laser manual), or a prompt-injection attempt.
**S**
1. Guardrail classifier (cheap, pre-retrieval): if the query is clearly not about
   machines/maintenance → immediate `refused_out_of_scope`, no retrieval, no LLM call.
2. Otherwise retrieve; compute gate signals: `top_score`, `score_gap`, `n_supporting`,
   `exact_code_hit`, `coverage`. If `top_score < MIN_SCORE` (default 0.45 cosine **[A]**) or
   `n_supporting == 0` → `insufficient_evidence`.
3. The refusal response is **still a full structured object**: `issue_summary` (what was
   understood), empty `corrective_steps`, populated `limitations` (what was searched: which
   models, how many manuals, how many chunks scanned, best score), and a concrete
   `suggested_next_action` (upload manual X / contact a senior technician / log an incident).

**Svc** Express, FastAPI (retrieval; LLM optionally skipped — a refusal needs no generation,
which also makes it fast and deterministic **[R]**).
**DB** the refusal is persisted as an assistant message with `answer_status`.
**VDB** read-only. **UX** A calm, informative refusal panel — **not** an error toast. Explicitly
show the evidence that *was* found and why it was rejected.
**F** n/a — this is the failure path. **Sec** An injection attempt is logged
(`security.prompt_injection_suspected`) with the pattern matched, and answered with a refusal.

---
### Workflow N — Follow-up conversation
**T** "And if that doesn't work?" / "What torque for those bolts?"
**S**
1. Load the last N turns. Classify as follow-up (pronouns/ellipsis/short length).
2. **Query rewriting**: a small LLM call (or template) turns it into a standalone query using
   prior *user* turns and the resolved entities (machine, code) — **prior assistant answers are
   used for coreference only, never as evidence** (resolves contradiction **X4**).
3. Re-retrieve with the rewritten query (**always re-retrieve**; never reuse the previous
   context blindly — that is how stale/wrong grounding propagates).
4. Machine/model context is inherited from the conversation and cannot be silently changed; if
   the user names a different machine, the system **confirms the switch** explicitly.
5. Answer as J/K.

**Svc** all. **DB** `messages` append; `conversations.updated_at`, `turn_count`.
**VDB** read-only. **UX** Threaded chat; the machine context is pinned and visible at all times
(a small chip: "Context: LINE2-INJ-03 · Toshiba EC180SX"), so the user always knows the scope.
**F** Rewriting fails → use the raw query and flag lower confidence. Context window overflow →
keep the last 3 turns + a rolling summary **[R]**.
**Sec** Conversation ownership enforced (`conversation.user_id == req.user.id` unless
manager/admin). Injection can arrive in turn 5 as easily as turn 1 — re-scan every turn.

---
### Workflow O — Incident creation
**T** From a conversation ("Log this as an incident"), or standalone from the machine page.
**S**
1. `POST /api/v1/incidents` `{machine_id (required if known), error_code?, symptom_text,
   started_at, severity, conversation_id?}`.
2. Status initialised to `open`. `resolution_status: "unresolved"`,
   `resolution_confirmed: false`.
3. If created from a conversation, **snapshot the AI suggestion** into
   `ai_suggestions[]` — stored as a *suggestion*, explicitly not as an action, with the
   `message_id`, the model name, and the confidence at the time. This is the concrete
   implementation of "an AI suggestion is not a confirmed repair" (MUST-22).
4. No vector is written yet — an open incident has no verified knowledge to contribute.

**Svc** Express, Mongo. **DB** `incidents` insert; `conversations.incident_ids` push;
`audit_logs`. **VDB** none (deliberately).
**UX** Incident appears on the machine timeline as "Open".
**F** No machine known → **[R]** allow creation with `machine_id: null` +
`unlinked_reason`, but mark it `needs_linking` and exclude it from history retrieval until
linked (an unlinked incident cannot be safely reused as evidence).
**Sec** Role `incident:create`; `machine_id` existence validated; free text stored as text and
escaped on render.

---
### Workflow P — Technician records the actual corrective action
**T** Technician did something on the machine.
**S**
1. `POST /api/v1/incidents/:id/actions` `{action_text, parts_replaced[], tools?, duration_min,
   outcome: "worked"|"no_change"|"partial"|"made_worse", performed_at, followed_ai_suggestion:
   bool, deviation_reason?}`.
2. Appended to `incident_actions` (a **separate collection**, `source_type:
   "technician_action"`) — never merged into the AI suggestion array. This separation is a
   confirmed requirement (MUST-16).
3. Incident moves `open → in_progress`. Multiple actions are expected and ordered.
4. `followed_ai_suggestion` + `deviation_reason` gives you a genuinely valuable evaluation
   signal: **how often the AI was actually right**, measured against reality. **[R]** Put this
   number on a demo slide.

**Svc** Express, Mongo. **DB** `incident_actions` insert; `incidents.updated_at`, status;
`audit_logs`. **VDB** none yet (an action on an unresolved incident is not yet evidence).
**UX** A chronological action log on the incident page, each entry attributed and timestamped.
**F** Action on a closed incident → `409` unless the user is a manager (who may reopen).
**Sec** Only the assigned technician, a manager, or an admin may add actions **[A]**; edits
allowed within 24 h **[A]**, after which a correction must be a new entry (append-only
history preserves the truth of what was believed when).

---
### Workflow Q — Incident confirmation (resolution)
**T** The technician (or manager, per `INCIDENT_CONFIRMATION_MODE`) closes the incident.
**S**
1. `POST /api/v1/incidents/:id/resolve` `{resolution_status, root_cause_text,
   effective_action_id, confirmation_note, verified_by_test: bool}`.
2. Server enforces: `resolution_status ∈ {resolved_confirmed, temporarily_resolved,
   unresolved, recurring}`; **`resolved_confirmed` requires** at least one
   `incident_action` with `outcome: "worked"`, a non-empty `root_cause_text`, and an explicit
   confirmation flag from the client. There is no automatic, inferred, or timeout-based path
   to `resolved_confirmed` (MUST-23, AC-10).
3. Set `resolution_confirmed: true`, `confirmed_by`, `confirmed_at`, `resolved_at`.
4. **Now** build the incident summary text (deterministic template, *not* LLM-written **[R]** —
   an LLM summary would inject inference into the evidence corpus; if you do use an LLM for
   fluency, store both and embed the template version).
5. Embed and upsert into `incident_history` with payload including `resolution_status` and
   `resolution_confirmed` (Workflow R uses these for ranking).
6. **[R]** Recurrence check: same machine + same code + a previous confirmed resolution within
   90 days → flag both incidents `recurring: true` and surface a warning ("this fix did not
   hold last time").

**Svc** Express → FastAPI (embed+upsert) → Qdrant.
**DB** `incidents` update; `audit_logs: incident.resolved`.
**VDB** **1 point upserted** into `incident_history` (ID = `uuid5(NS_INCIDENT, incident_id)`,
so re-confirmation overwrites rather than duplicating).
**UX** Incident shows a green "Confirmed resolved" badge with who/when; the machine timeline
updates; a toast: "This resolution is now available to future troubleshooting."
**F** Embedding fails → the incident is **still resolved in Mongo** (source of truth) and a
`pending_vector_sync: true` flag is set; a reconciler retries. Never block a business action
on the derived index.
**Sec** Confirmation is a privileged, audited action. `confirmed_by` cannot be spoofed (taken
from the JWT, never the body).

---
### Workflow R — Similar incident retrieval
**T** Any troubleshooting query (runs in parallel with manual retrieval).
**S**
1. Build the query embedding once and reuse it for both collections **[R]** (saves an Ollama
   round trip).
2. Search `incident_history` with a tiered filter:
   - **Tier 1** `machine_id == this machine` (highest relevance — same physical asset)
   - **Tier 2** `machine_model_id == this model, machine_id != this`
   - **Tier 3 [U, off by default]** same `machine_type`, different model — only with an explicit
     visible warning (contradiction **X2**)
3. Plus a deterministic Mongo lookup: incidents on this machine with the exact same
   `error_code`, regardless of vector score (recency-ordered) — exact match must never be
   missed because of an embedding quirk.
4. **Rank** with an explicit, inspectable formula:
   `final = 0.55·similarity + 0.25·status_weight + 0.12·tier_weight + 0.08·recency_decay`
   where `status_weight`: `resolved_confirmed 1.0` · `temporarily_resolved 0.5` ·
   `recurring 0.45` · `unresolved 0.25` · unconfirmed-but-claimed `0.3`; `tier_weight`
   1.0/0.7/0.4; `recency_decay = exp(-age_days/180)` **[A — tune]**.
5. Take the top 3–5; every one carries its status into the response so the UI can render
   "CONFIRMED FIX" vs "ATTEMPTED — DID NOT WORK" differently. **A failed fix is valuable
   evidence** ("we already tried resetting; it didn't hold") — surface it, never hide it.

**Svc** FastAPI → Qdrant + Express → Mongo. **DB** read-only. **VDB** read-only.
**UX** The "Previous incidents on this machine" lane, colour-coded by status.
**F** Empty history → the lane shows "No prior incidents recorded for this machine" (honest,
and it nudges the user to log one). Qdrant down → the whole query fails loudly; do not silently
answer without history when history is a claimed feature.
**Sec** History is plant-wide by design **[A1]**; if multi-tenancy is ever added this filter
becomes security-critical, so implement it as a mandatory filter object from day one.

---
### Workflow S — Maintenance record creation
**T** Manual entry after service (**[U]** CMMS import is out of MVP scope — A7).
**S** `POST /api/v1/maintenance` `{machine_id, type: preventive|corrective|calibration|
inspection|part_replacement|software_update, performed_at, performed_by, description,
parts_replaced[{part_number, name, qty}], measurements[{name, value, unit}], next_due_at?,
work_order_ref?}` → validate machine, `performed_at` not in the future (**[R]** allow a small
skew), insert.
**Svc** Express, Mongo. **DB** `maintenance_records` insert; `machines.last_maintenance_at`
updated (denormalised for fast display); `audit_logs`.
**VDB** **[R]** none in MVP — maintenance is retrieved by *structured* query (machine + time
window + part number + type), not by semantic similarity, which is both cheaper and more
correct. Optional later: embed the free-text description for symptom matching.
**UX** Appears on the machine timeline interleaved with incidents — the timeline is where the
"maintenance caused this" insight becomes visually obvious.
**F** Unknown machine → 422. Future date → 422.
**Sec** Any authenticated non-viewer may create; edits restricted (see the role matrix).

---
### Workflow T — Maintenance-aware troubleshooting
**T** A troubleshooting query on a machine that has maintenance history.
**S**
1. Retrieve maintenance records for the machine: (a) all within `MAINT_WINDOW_DAYS` (default
   90 **[A]**), (b) any record whose `parts_replaced` intersects part numbers mentioned in the
   retrieved manual chunks or the query, (c) any record referencing the same error code, (d)
   the most recent calibration/inspection regardless of age.
2. Compute a **temporal-proximity flag**, not a causal claim: `days_between(maintenance,
   incident_start)`. `≤ 7 days` → `proximity: "high"`; `≤ 30` → `"medium"`; else `"low"`.
3. Pass into the prompt as a clearly labelled, **explicitly non-causal** block with a hard
   instruction: *"These are maintenance events. Temporal proximity is NOT causation. You may
   note a possible correlation ONLY with hedged language and ONLY when the manual or incident
   history independently links the component to this fault. You must not state that
   maintenance caused the fault."*
4. The response's `maintenance_context[]` entries carry `{record_id, type, performed_at,
   days_before_incident, parts_replaced, relevance_reason, correlation_strength:
   none|possible|noted_by_manual}`.
5. **[R]** Rule-based enrichment (deterministic, no LLM): if a replaced part appears in the
   manual's cause list for the detected code, set `correlation_strength:
   "noted_by_manual"` and cite the manual page. This is a *grounded* correlation, and it is
   the most impressive thing in the whole feature — the machine noticed something a human
   would have to cross-reference two documents to find.

**Svc** Express (Mongo query) → FastAPI (prompt) → Ollama. **DB** read-only.
**VDB** read-only. **UX** A separate "Maintenance context" lane, visually distinct, with the
standing caption *"Timing correlation only — not established as a cause."*
**F** No maintenance records → the lane is simply absent (no filler text).
**Sec** Output-validation rule: reject/rewrite an answer whose `probable_causes` cites a
maintenance record as its *sole* evidence with a causal verb (see `RAG_PIPELINE.md` §12).

---
### Workflow U — Manual re-indexing
**T** Admin clicks "Re-index"; or the embedding model/chunking version changed; or a job
previously failed at a late stage.
**S**
1. `POST /api/v1/manuals/:id/reindex` `{scope: "full"|"embed_only"|"index_only", reason}`.
2. Create a new `manual_processing_jobs` doc (jobs are never mutated in place — you keep a
   full processing history, which is exactly what "failed jobs must be traceable" (MUST-25)
   requires).
3. **Blue/green within the collection:** upsert new points with the new
   `embedding_version` in the ID, then delete points matching
   `manual_id == X AND embedding_version != new` — the manual is never un-searchable during
   re-index. (Full-collection swap is only needed for a *dimension* change; see
   `QDRANT_DESIGN.md` §7.)
4. Re-run only the needed stages: `embed_only` reuses `chunks.jsonl`, `full` re-extracts.
5. Verify counts, then flip `manuals.embedding_version` / `chunking_version`.

**Svc** Express → FastAPI → Ollama/Qdrant. **DB** new job doc; `manuals` version fields.
**VDB** upsert new + delete stale. **UX** "Re-indexing (searchable with the previous version
meanwhile)".
**F** Failure mid-way → old points remain, manual stays usable, job marked failed. **This
fail-safe ordering (add-then-remove) is deliberate.**
**Sec** Admin/manager only; audited with the reason string; **[R]** rate-limited (re-indexing
is the most expensive operation in the system and is a self-DoS vector).

---
### Workflow V — Manual deletion
**T** Admin/manager deletes a manual.
**S**
1. `DELETE /api/v1/manuals/:id` (optionally `?purge_files=true`).
2. **Order matters (fail-safe):** ① mark `manuals.is_deleted = true, deleted_at, deleted_by`
   → the manual is immediately excluded from all searches by Express's filter; ② delete Qdrant
   points by filter `manual_id == X` (synchronous, verified with a follow-up count == 0);
   ③ enqueue file cleanup (default: **retain** `original.pdf` for 30 days **[R, A]** so
   accidental deletion is recoverable); ④ audit.
3. If step ② fails, the manual remains flagged deleted (invisible) and a
   `pending_vector_purge` flag drives a reconciler retry. **Soft-delete-first ordering
   guarantees MUST-24 even if Qdrant is unavailable** — because the Express-side filter also
   excludes deleted manual IDs. Belt and braces: chunks also carry `is_deleted` in their
   payload for defence in depth.
4. Prior citations in old conversations are preserved as text but marked "source manual
   deleted" on render — do not rewrite history.

**Svc** Express → FastAPI → Qdrant, fs. **DB** `manuals` soft delete; `audit_logs`.
**VDB** all points for that manual deleted. **UX** Manual disappears from the list; a
confirmation dialog states the number of chunks that will stop being searchable.
**F** Qdrant down → deletion still "succeeds" from the user's perspective (invisible) with a
visible system warning + reconciler retry.
**Sec** Deletion is a high-value audit event: actor, manual, chunk count, timestamp. Prevent
deletion of a manual currently being processed (or cancel that job first).

---
### Workflow W — Failed processing recovery
**T** A job is `failed`; or the app restarted while a job was `running`; or a job is stuck.
**S**
1. **On boot**, Express runs a reconciler: any job in `running`/`queued` with
   `heartbeat_at` older than `STALE_JOB_MINUTES` (default 15 **[A]**) → `failed` with
   `error_code: STALE_ABANDONED`, and the manual's status set to `processing_failed`.
   Workers write a heartbeat every 10 s **[A]**.
2. Reconciler also fixes derived-state drift: manuals `ready` with 0 Qdrant points; manuals
   deleted but with points present (`pending_vector_purge`); incidents with
   `pending_vector_sync`.
3. Failed jobs are visible on an admin "Processing" page with the stage, error code, message,
   a truncated stack (admin only), and page/chunk counters.
4. **Retry** = create a *new* job resuming from the last successful stage (artefacts on disk
   make resumption cheap: if `chunks.jsonl` exists, skip extraction/OCR).
5. Retry policy: automatic retry only for **transient** classes (`OLLAMA_UNAVAILABLE`,
   `QDRANT_UNAVAILABLE`, timeouts) — max 3, exponential backoff 30 s/2 m/8 m **[A]**.
   Deterministic failures (`PDF_CORRUPT`, `PDF_ENCRYPTED`, `NO_TEXT_EXTRACTED`) are **never**
   auto-retried; they need a human.
6. **Cancellation:** a cooperative flag checked between stages and every N pages; state →
   `cancelled`, partial vectors purged by `manual_id`.
7. **Duplicate prevention:** a unique partial index on `manual_processing_jobs
   (manual_id) where status in ('queued','running')` — the database refuses a second live job
   for the same manual. Simple and airtight.

**Svc** Express (reconciler, in-process interval), FastAPI (workers), Mongo, Qdrant, fs.
**DB** job status transitions; `manuals.processing_status`; `audit_logs`.
**VDB** possible cleanup of partial points. **UX** Clear failure card with a plain-language
cause and a Retry button; the manual is never silently "Ready" when it is not
(AC-15).
**F** The reconciler itself failing must not crash the app — wrap and log.
**Sec** Stack traces to admins only; error messages to other roles are sanitised (a file path
in an error message is an information leak).

---

## 6. Cross-cutting concerns

| Concern | Approach |
|---|---|
| Correlation IDs | `X-Request-Id` generated at Express, propagated to FastAPI, logged everywhere, returned in error bodies and shown in the UI's error card. Makes demo debugging survivable. |
| Logging | Structured JSON (`pino` / `structlog`). **Never log**: passwords, tokens, full prompts with retrieved content, chunk text. **Do log**: counts, scores, IDs, timings, model names. |
| Config | One `.env`, schema-validated at boot in both services; fail fast on a missing secret. |
| Time | Everything stored UTC; rendered in the browser's local timezone (user is in Asia/Kolkata). |
| Versioning | `EMBEDDING_VERSION`, `CHUNKING_VERSION`, `PROMPT_VERSION` recorded on every artefact — this is how you explain "why did the answer change?" |
| Health | `/api/v1/health` aggregates Mongo, Qdrant, Ollama (models present), FastAPI, disk free, job queue depth. Degraded ≠ down: report per-dependency status. |
| Backups | `infra/backup.sh`: `mongodump` + Qdrant snapshot API + `tar` of `storage/`. Restore script tested once in Phase 11. Backups contain confidential manual text → `chmod 600`, and say so in the docs. |
| Testing | Vitest/Jest (Express), pytest (FastAPI), a golden-set retrieval harness, and ~6 Playwright end-to-end paths **[R]**. |

## 7. Verdict on the proposed separation

**Your Express/FastAPI/Mongo/Qdrant/filesystem split is correct and I am adopting it.** The
five changes I recommend, all small:

1. **FastAPI writes job progress directly to `manual_processing_jobs` only** (§3.4), with a
   least-privilege Mongo user — instead of a chatty callback.
2. **Citation validation is enforced twice** — authoritatively in FastAPI, re-asserted in
   Express before persistence (§3.3).
3. **Retrieval is hybrid, not vector-only** (§4.3) — mandatory for error codes.
4. **Maintenance retrieval is a structured Mongo query, not a vector search** (Workflow S) —
   cheaper and more correct; no third Qdrant collection in the MVP.
5. **Run Mongo as a single-node replica set** so transactions are available for the few
   multi-document operations (manual delete, incident resolve) — free in Compose.

Plus one addition to the stack, which I consider justified: **an Nginx container** to serve the
built frontend and proxy `/api`, giving a single demo URL and removing CORS entirely. It is
configuration, not architecture.
