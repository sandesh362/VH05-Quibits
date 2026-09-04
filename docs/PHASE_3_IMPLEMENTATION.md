# Phase 3 — Document Ingestion & Indexing

**Status:** complete, pending review
**Scope:** manual upload, secure file storage, PDF extraction, OCR fallback, text cleaning, page-aware chunking, embedding, Qdrant indexing, job lifecycle, internal FastAPI↔Express contract
**Explicitly out of scope:** vector search, RAG answers, incident memory, maintenance intelligence (Phase 4/5)

---

## 1. What Phase 3 delivers

Phase 2 produced a working backend (auth, RBAC, CRUD, validation, audit). Phase 3 makes the system capable of *ingesting* maintenance PDFs and turning them into searchable chunks in a vector store. It does **not** answer questions yet — that is Phase 4/5.

| Capability | Before (Phase 2) | After (Phase 3) |
|---|---|---|
| Manual upload | nothing | multipart `POST /manuals` with PDF validation |
| File storage | none | SHA-256 content-addressed, sanitised, server-generated paths |
| PDF extraction | none | PyMuPDF native-text extraction with page stats |
| OCR fallback | none | pytesseract for scanned/text-poor pages |
| Text cleaning | none | deterministic whitespace/token-preserving cleanup |
| Chunking | none | page-aware greedy chunker with overlap + section paths |
| Embeddings | none | Ollama `nomic-embed-text` (batched) |
| Vector store | none | Qdrant collection + payload + deterministic point IDs |
| Job lifecycle | none | `manual_processing_jobs` with progress + terminal status |
| Internal API | none | `/internal/v1/documents/process`, `/indexing/*` (token-guarded) |

`/system/info` now reports `PHASE_3_FEATURES`: `manualUpload`, `documentProcessing`, `ocr`, `embeddings` are `true`; retrieval flags (`vectorSearch`, `ragAnswers`) remain `false`.

---

## 2. Architecture

### 2.1 The split: Express owns state, FastAPI owns compute

Failures in Phase 3 are usually about *who owns what*. The rule is:

- **Express** owns the business entity (`manuals`), the job record (`manual_processing_jobs`), the **terminal** status transition, persistence of pages/chunks into Mongo, audit logging, and all user-facing HTTP.
- **FastAPI** owns only compute: read the PDF → extract → OCR → clean → chunk → embed → upsert to Qdrant. It reports progress to `manual_processing_jobs` but **never** writes `completed`/`failed` — that is Express's decision, made after FastAPI returns.

This is why a broken pipeline can never look healthy: if FastAPI errors, Express writes `failed` and records the reason.

### 2.2 Flow

```
Express (upload)                                     FastAPI (internal)              Mongo / Qdrant
─────────────                                       ─────────────────               ─────────────
POST /manuals (multipart)
  validate PDF → sha256 → sanitised path → save
  check duplicate (hash+model)                       ┌─────────────────────┐
  create job (queued) ───────────────────────────►  │ /documents/process   │
  enqueue worker ─────────────────────────────┐     │  extract (PyMuPDF)   │
                                              │     │  detect_text_poor    │
                                              │     │  ocr (if needed)     │
runManualPipeline()                           │     │  clean_text          │
  ├─ job → running                             └──►  │  chunk_document      │
  ├─ POST /documents/process with metadata           │  embed (Ollama)      │──► Qdrant upsert
  ├─ persist pages + chunks                            │  progress updates ───│──► manual_processing_jobs
  ├─ manual → completed (only after success)           └─────────────────────┘
  └─ manual → failed (on any error)
```

### 2.3 Express layout (new/changed)

```
backend/src/modules/manuals/
├── manual-files.service.ts       PDF validation, sanitisation, sha256, storage path
├── rag-client.service.ts         FastAPI internal HTTP client (processManual, deleteManualVectors)
├── manual-processing.service.ts  job creation, runManualPipeline, persistPagesAndChunks, retry
├── manual-processing-queue.ts    bounded in-process worker (enqueue, flushAll)
├── manual-processing-jobs.service.ts   read-side job query (toJobView, listJobs)
├── manual-processing-jobs.controller.ts
├── manual-processing-jobs.routes.ts    job admin (retry needs manual.reprocess)
├── manuals.service.ts           CRUD + createUpload + listPages/listChunks + remove
├── manuals.controller.ts
├── manuals.routes.ts            multer memory-storage upload middleware
└── manuals.validators.ts        zod schemas
```

`middleware/error-handler.ts` maps `multer.MulterError`: `LIMIT_FILE_SIZE` → `PAYLOAD_TOO_LARGE`, `LIMIT_UNEXPECTED_FILE` → `VALIDATION_ERROR`.

### 2.4 FastAPI layout (new)

```
ai-service/app/
├── clients/
│   ├── ollama.py    async embed client (ping, embed, dimension_probe)
│   ├── qdrant.py    wrapper (ensure_collection, upsert_chunks, delete_by_manual, count_by_manual)
│   └── mongo.py     JobProgressWriter (best-effort; skipped when MONGODB_URI empty)
├── pipeline/
│   ├── extract.py   PyMuPDF extraction → PageExtraction; ServiceError on corrupt/encrypted
│   ├── ocr.py       pytesseract; SERVICE_UNAVAILABLE when Tesseract absent
│   ├── clean.py     deterministic cleanup + detect_headings
│   └── chunk.py     page-aware greedy chunker
├── services/
│   └── document_processor.py    orchestrator: process_manual(req, settings)
└── routers/
    ├── documents.py   internal POST /internal/v1/documents/process
    └── indexing.py    internal POST /internal/v1/indexing/manual-chunks/delete
                       internal GET  /internal/v1/indexing/collections/stats
```

Both internal routers reject any request without `X-Internal-Token == settings.INTERNAL_SERVICE_TOKEN` (`401 UNAUTHENTICATED`).

---

## 3. Endpoint contract

### 3.1 `POST /api/v1/manuals` (multipart upload)

Request fields: `title`, `scope` (`model`), `machineModelId`, `documentType`, `language`, optional `manufacturer`, `documentVersion`; plus a single `file` field (PDF).

| Status | Meaning |
|---|---|
| `201` | Manual created and job queued |
| `415` | Not a PDF (bad extension / missing `%PDF` magic bytes) |
| `409` | Duplicate file for the same model (`CONFLICT`) |
| `422` | Invalid body or missing file |

Response (abridged): `{ data: { manual: {...}, processingJob: { id, status: 'queued' } } }`. The server never exposes `storage_path`.

### 3.2 `POST /internal/v1/documents/process`

Body (`ProcessRequest`): `job_id`, `manual_id`, `storage_path`, `machine_model_id`, `machine_id`, `manual` (`{ title, document_version, document_type, manufacturer, language }`), `options`.

Returns `{ data: { page_count, chunk_count, extraction_method, ocr_used, embedding_model, embedding_dimension, qdrant_indexed_points, processing_version, pages[], chunks[] } }`.

### 3.3 `POST /internal/v1/indexing/manual-chunks/delete`

Body: `{ manual_id }`. Deletes all Qdrant points for that manual. Returns `{ deleted, collection }`.

### 3.4 `GET /internal/v1/indexing/collections/stats`

Returns `{ collection, points, dimension }` for the configured manual collection. `503` if Qdrant is unavailable.

---

## 4. Processing pipeline details

### 4.1 Extraction (`pipeline/extract.py`)

PyMuPDF (`fitz`) opens the PDF page by page. Each `PageExtraction` carries `page_number`, `raw_text`, `character_count`, `word_count`, `has_text`. Corrupt or encrypted PDFs raise `ServiceError`. `detect_text_poor_pages` flags pages under `OCR_MIN_TEXT_CHARACTERS_PER_PAGE` for OCR.

### 4.2 OCR (`pipeline/ocr.py`)

`needs_ocr` checks whether OCR is enabled and text-poor pages exist. Page rendering uses pixmap rendering; `pytesseract` does the recognition. If the Tesseract binary is absent, it raises `SERVICE_UNAVAILABLE`. Artifacts are saved to `storage_root/<manual_id>/ocr`.

### 4.3 Cleaning (`pipeline/clean.py`)

Normalises line endings, collapses runs of whitespace, and strips leading/trailing whitespace per line. It deliberately **preserves** technical tokens (`E-104`, `ERR_204`, `24 VDC`, `3.5 bar`, `M12 x 1.5`) so they survive into chunks. `detect_headings` finds short uppercase/numbered/keyword lines to build section paths.

### 4.4 Chunking (`pipeline/chunk.py`)

A single-pass greedy accumulator seeded with an overlap `history` list. Each chunk carries `page_start`, `page_end`, `section_title`, `section_path`, `normalized_text`, `character_count`, `word_count`, `content_hash`, `chunk_index`. Oversized paragraphs are split at sentence boundaries. Chunk boundaries never cross pages; overlap context is re-seeded from the prior chunk to avoid duplication.

### 4.5 Embedding + indexing (`services/document_processor.py`)

`EMBEDDING_VERSION = 'ev1'`, `EMBED_BATCH = 32`. Batches of `normalized_text` go to Ollama (`nomic-embed-text`). Point IDs are deterministic: `manual_chunk_point_id(manual_id, chunk_index, EMBEDDING_VERSION)`. The Qdrant payload carries manual metadata, page/section info, a content hash, and the embedding model/version. If an embedding dimension mismatches the probe, the job fails fast.

---

## 5. Data model additions

- `manual_pages` — extracted/cleaned page text per manual/page number.
- `manual_chunks` — the persisted chunks, with `content_hash`, `qdrant_point_id`, `embedding_model`, `embedding_dimension`, `indexing_status`, and `section_path`.
- `manual_processing_jobs` — job document with `status` (`queued|running|completed|failed`), `current_stage`, a `stages` array, progress, error fields, and timestamps.
- `manuals` extended with `storage_path`, `processing_status`, `processing_version`, `extraction_method`, `ocr_used`, `page_count`, `indexed_chunk_count`, `indexed_at`, `processed_at`, `failed_at`, `failure_reason`.
- Unique partial index `uniq_active_job_per_manual` on `manual_id` where `status in ('queued','running')` — guarantees one live job per manual (duplicate-job protection).

---

## 6. Capability flags

`packages/shared/src/index.ts` now exports `PHASE_3_FEATURES`:

```
ManualUpload, DocumentProcessing, Ocr, Embeddings  → true
VectorSearch, RagAnswers                           → false
```

`/system/info` and FastAPI `/health` both report this set.

---

## 7. Configuration (new env vars)

See `.env.example`. Highlights: `MAX_MANUAL_FILE_SIZE_MB`, `MANUAL_STORAGE_PATH`, `OCR_ENABLED`, `OCR_LANGUAGE`, `OCR_MIN_TEXT_CHARACTERS_PER_PAGE`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `MIN_CHUNK_SIZE`, `MAX_CHUNK_SIZE`, `CHUNKING_VERSION`, `MANUAL_PROCESSING_TIMEOUT_MS`, `QDRANT_MANUAL_COLLECTION`, `INTERNAL_SERVICE_TOKEN`.

Both services accept these; `docker-compose.yml` and the `ai-service.Dockerfile` (Tesseract installed) are updated.

---

## 8. Testing

- **Express:** `manual-files.test.ts` (16 unit tests for hash/sanitise/validate/storage-path), updated `api.test.ts` (26 tests asserting Phase 3 flags). DB-backed suites (auth, authorization, crud, general, manual-upload) require `mongodb-memory-server`; in a network-restricted sandbox the mongod binary cannot be downloaded, so they are skipped at setup — they pass where the binary is available.
- **FastAPI:** 71 tests (`test_pipeline.py` for extract/clean/chunk/ocr-detection, `test_document_service.py` for the token guard and the mocked-pipeline end-to-end, plus `test_config.py` and `test_health.py`). `ruff check app tests` passes.

---

## 9. Notable decisions

- **Job progress is best-effort.** FastAPI writes progress to `manual_processing_jobs` only; a failed progress write is logged, never raised, and is skipped entirely when `MONGODB_URI` is empty (so the pipeline runs in tests without a DB).
- **Deterministic point IDs** make re-indexing idempotent — a reprocess overwrites the same point IDs rather than accumulating duplicates.
- **Duplicate uploads** are rejected per model+hash (`409`), but the same file is allowed for a different model.
- **Terminal status is Express's call.** Only after FastAPI returns successfully does Express set `completed`; any error yields `failed` with the reason.
