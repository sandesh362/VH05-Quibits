# DATA_MODEL.md

MongoDB 7 (Community), single-node **replica set** **[R]** so transactions are available.
Tags: **[C]** confirmed · **[A]** assumption · **[R]** recommendation · **[U]** unknown.

---

## 0. Conventions applied to every collection

| Convention | Rule |
|---|---|
| IDs | `_id: ObjectId`. References use `ObjectId`, suffixed `_id`. |
| Timestamps | `created_at`, `updated_at` (UTC `Date`), set by the data layer, never by the client. |
| Attribution | `created_by`, `updated_by` → `users._id`, taken from the JWT, **never** from the request body. |
| Soft delete | `is_deleted: bool = false`, `deleted_at`, `deleted_by`, `delete_reason?`. Every read filters `is_deleted: false` by default via a repository helper. |
| Naming | `snake_case` fields, plural lowercase collections. |
| Validation | JSON Schema validators at the collection level (`validationLevel: "moderate"`) **plus** application-level zod/joi. Belt and braces: schema validators catch bugs that bypass the service layer. |
| Enums | Stored as lowercase strings, never integers (readability in `mongosh` during a demo beats 3 bytes). |
| Versioning | Content-affecting docs carry `schema_version: int` for future migration. |
| Free text | Length-capped at the application layer (see each collection) to bound DoS and prompt size. |

**Denormalisation policy** (your instruction: avoid over-normalisation, avoid dangerous
duplication):
- **Allowed:** display-only snapshots (`model_snapshot`, `machine_snapshot`, `user_snapshot`)
  containing *only* human-readable labels, marked read-only, refreshed lazily. They must
  **never** be used as a query/filter key.
- **Forbidden:** duplicating anything used for authorization, retrieval filtering, or
  correctness. `machine_model_id` is always resolved by join/lookup, never trusted from a
  snapshot.
- **Rationale:** a stale label is a cosmetic bug; a stale filter key is a cross-machine
  contamination incident.

---

## 1. `users`

**Purpose** Accounts, roles, credentials, token invalidation.

| Field | Type | Req | Validation / notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `username` | string | ✓ | 3–32, `^[a-z0-9._-]+$`, unique (case-insensitive collation) |
| `email` | string | ✓ | RFC-ish, lowercased, unique |
| `password_hash` | string | ✓ | Argon2id encoded string. **Excluded from all default projections.** |
| `full_name` | string | ✓ | 1–100 |
| `role` | enum | ✓ | `admin \| manager \| technician \| viewer` |
| `is_active` | bool | ✓ | default `true`; deactivation instead of deletion |
| `must_change_password` | bool | ✓ | default `true` for admin-created accounts **[R]** |
| `token_version` | int | ✓ | default 0; incremented to invalidate all live access tokens |
| `refresh_tokens` | array\<obj\> | – | `{token_hash, family_id, issued_at, expires_at, user_agent_hash, revoked_at?}`; cap 5, oldest evicted |
| `failed_login_count` | int | – | reset on success |
| `locked_until` | Date | – | lockout window |
| `last_login_at` | Date | – | |
| `default_machine_id` | ObjectId | – | **[R]** technician convenience |
| `employee_code` | string | – | shop-floor identity **[A]** |
| `preferences` | object | – | `{locale, theme, timezone}` |
| `is_deleted`,`deleted_at`,`deleted_by` | – | – | standard |
| `created_at`,`updated_at`,`schema_version` | – | ✓ | standard |

**Relationships** referenced by nearly everything via `created_by`/`performed_by`/`confirmed_by`.

**Indexes**
```
{username:1} unique, collation {locale:"en", strength:2}
{email:1}    unique, collation {locale:"en", strength:2}
{role:1, is_active:1}
{"refresh_tokens.token_hash":1} sparse
```

**Business rules** ① The last active `admin` cannot be deactivated or demoted. ② Role change or
password change increments `token_version`. ③ Hard delete is never exposed (attribution
integrity). ④ Refresh tokens are stored **hashed**; reuse of a rotated token revokes the entire
`family_id`.

**Example**
```json
{
  "_id": "665f1a2b3c4d5e6f7a8b9c01",
  "username": "r.nair",
  "email": "r.nair@plant.local",
  "password_hash": "$argon2id$v=19$m=65536,t=3,p=1$...",
  "full_name": "Rajesh Nair",
  "role": "technician",
  "is_active": true, "must_change_password": false, "token_version": 2,
  "refresh_tokens": [{"token_hash":"9f2b...","family_id":"f1","issued_at":"2026-09-04T02:10:00Z","expires_at":"2026-09-11T02:10:00Z"}],
  "default_machine_id": "665f1a2b3c4d5e6f7a8b9c31",
  "employee_code": "EMP-2291",
  "preferences": {"locale":"en-IN","theme":"dark","timezone":"Asia/Kolkata"},
  "is_deleted": false,
  "created_at": "2026-08-01T06:00:00Z", "updated_at": "2026-09-04T02:10:00Z", "schema_version": 1
}
```

---

## 2. `machine_models`

**Purpose** The product/model definition. **The retrieval filter key** — architecturally the
most safety-critical identifier in the system.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `manufacturer` | string | ✓ | 1–100, trimmed |
| `model_name` | string | ✓ | 1–100 |
| `machine_type` | enum-ish string | ✓ | `cnc_lathe \| cnc_mill \| injection_moulder \| hydraulic_press \| conveyor \| compressor \| robot_arm \| packaging \| boiler \| pump \| other` **[A] — extend freely** |
| `aliases` | string[] | – | **[R]** e.g. `["EC-180SX","EC180 SX"]`; powers text detection (Workflow L) |
| `model_year` | int | – | 1950–2100 |
| `specifications` | object | – | free-form `{power_kw, voltage, tonnage, axes, control_system, ...}` |
| `default_language` | string | – | BCP-47, default `en` **[U] Q1** |
| `notes` | string | – | ≤ 2000 |
| `manual_count` | int | – | **cached counter**, display only |
| `machine_count` | int | – | cached counter, display only |
| `indexed_chunk_count` | int | – | cached; drives the "no manuals indexed" banner |
| soft delete / timestamps | | ✓ | standard |

**Indexes**
```
{manufacturer:1, model_name:1} unique, collation strength 2, partialFilter {is_deleted:false}
{machine_type:1}
{aliases:1}
```

**Rules** ① Uniqueness is case-insensitive — near-duplicate models silently fragment the corpus
and are the top data-quality risk. ② Cannot be deleted while non-deleted machines or manuals
reference it (409 listing dependents). ③ Cached counters are eventually consistent and
display-only; **[R]** recomputed by the reconciler at boot. ④ Model **merge** is deferred
post-MVP; prevention is MVP.

**Example**
```json
{
  "_id": "665f1a2b3c4d5e6f7a8b9c21",
  "manufacturer": "Toshiba Machine",
  "model_name": "EC180SX",
  "machine_type": "injection_moulder",
  "aliases": ["EC-180SX", "EC180 SX", "EC180"],
  "model_year": 2016,
  "specifications": {"clamping_force_ton": 180, "screw_dia_mm": 45, "control_system": "V70"},
  "default_language": "en",
  "manual_count": 3, "machine_count": 2, "indexed_chunk_count": 4102,
  "is_deleted": false, "created_at": "2026-08-02T09:00:00Z", "updated_at": "2026-09-01T11:00:00Z",
  "created_by": "665f...c01", "schema_version": 1
}
```

---

## 3. `machines`

**Purpose** A physical asset on the floor. **[C]** Distinct from its model.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `asset_tag` | string | ✓ | unique, `^[A-Za-z0-9._-]{1,64}$`, **immutable after creation** **[R]** |
| `machine_model_id` | ObjectId | ✓ | → `machine_models`; must exist and not be deleted |
| `model_snapshot` | object | – | **display only** `{manufacturer, model_name, machine_type}` |
| `display_name` | string | – | "Injection Moulder 3 — Line 2" |
| `serial_number` | string | – | ≤ 100 |
| `location` | object | – | `{site, building, line, cell}` — all optional strings **[A]** |
| `status` | enum | ✓ | `operational \| down \| maintenance \| retired`, default `operational` |
| `installed_at` | Date | – | |
| `commissioned_at` | Date | – | |
| `criticality` | enum | – | `low \| medium \| high \| critical` **[R]** — useful for triage UX |
| `modifications` | array\<obj\> | – | `{date, description, performed_by, affects_manual_validity: bool}` **[R]** — see `RAG_PIPELINE.md` §11 |
| `last_maintenance_at` | Date | – | denormalised for list rendering |
| `open_incident_count` | int | – | cached counter |
| `notes` | string | – | ≤ 2000 |
| soft delete / timestamps / attribution | | ✓ | standard |

**Indexes**
```
{asset_tag:1} unique, partialFilter {is_deleted:false}
{machine_model_id:1, is_deleted:1}
{status:1}
{"location.line":1}
{serial_number:1} sparse
```

**Rules** ① Exactly one model. ② Cannot be deleted if incidents/maintenance exist → `retired`.
③ Changing `machine_model_id` is audited with a mandatory reason and warns that prior incidents
were recorded under the previous model. ④ `modifications[]` with
`affects_manual_validity: true` causes the RAG pipeline to add a standing limitation
("this machine has been modified; manual procedures may not apply exactly").

**Example**
```json
{
  "_id": "665f1a2b3c4d5e6f7a8b9c31",
  "asset_tag": "LINE2-INJ-03",
  "machine_model_id": "665f1a2b3c4d5e6f7a8b9c21",
  "model_snapshot": {"manufacturer":"Toshiba Machine","model_name":"EC180SX","machine_type":"injection_moulder"},
  "display_name": "Injection Moulder 3 — Line 2",
  "serial_number": "TM-EC180-2016-4471",
  "location": {"site":"Plant A","building":"B2","line":"Line 2","cell":"C-04"},
  "status": "down", "installed_at": "2017-03-15T00:00:00Z", "criticality": "high",
  "modifications": [{"date":"2024-06-01T00:00:00Z","description":"Retrofitted third-party temperature controller on barrel zone 3","performed_by":"665f...c01","affects_manual_validity": true}],
  "last_maintenance_at": "2026-08-29T10:30:00Z", "open_incident_count": 1,
  "is_deleted": false, "created_at": "2026-08-02T09:10:00Z", "updated_at": "2026-09-04T03:00:00Z", "schema_version": 1
}
```

---

## 4. `manuals`

**Purpose** Metadata and processing state for an uploaded document. Bytes live on disk; vectors
live in Qdrant; **this document is the join point**.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | also the storage directory name |
| `title` | string | ✓ | 1–300; defaults to the cleaned original filename |
| `scope` | enum | ✓ | `model \| machine` (default `model`) — resolves contradiction **X1** |
| `machine_model_id` | ObjectId | cond | required when `scope == "model"` |
| `machine_id` | ObjectId | cond | required when `scope == "machine"` |
| `document_type` | enum | ✓ | `operation \| maintenance \| service \| parts_catalog \| electrical_schematic \| troubleshooting \| safety \| installation \| other` |
| `document_version` | string | – | as printed, e.g. `"Rev C (2019-04)"` |
| `supersedes_manual_id` | ObjectId | – | **[R]** explicit version chain; never inferred |
| `is_current_version` | bool | ✓ | default `true`; superseded manuals get `false` and are **down-weighted, not deleted** |
| `language` | string | ✓ | BCP-47, default from the model **[U] Q1** |
| `original_filename` | string | ✓ | metadata **only** — never used to build a path |
| `storage_path` | string | ✓ | server-generated, relative to `storage/` |
| `file_size_bytes` | int | ✓ | ≤ `MAX_PDF_MB` |
| `sha256` | string | ✓ | duplicate detection |
| `mime_type` | string | ✓ | must be `application/pdf` |
| `page_count` | int | – | after extraction |
| `processing_status` | enum | ✓ | `queued \| processing \| ready \| failed \| cancelled` |
| `processing_summary` | object | – | `{text_pages, ocr_pages, low_conf_pages, chunk_count, fault_code_chunks, duration_ms, warnings[]}` |
| `ocr_applied` | bool | – | |
| `ocr_quality` | enum | – | `good \| partial \| poor \| n_a` |
| `indexed_chunk_count` | int | – | **verified** count in Qdrant |
| `indexed_at` | Date | – | |
| `embedding_model` | string | – | e.g. `nomic-embed-text` |
| `embedding_version` | string | – | e.g. `nomic-768-v1` — part of the point ID |
| `chunking_version` | string | – | e.g. `chunk-v1` |
| `extraction_version` | string | – | |
| `pending_vector_purge` | bool | – | set when a delete could not reach Qdrant |
| `uploaded_by` | ObjectId | ✓ | |
| soft delete / timestamps | | ✓ | standard |

**Indexes**
```
{machine_model_id:1, is_deleted:1, processing_status:1}
{machine_id:1, is_deleted:1} sparse
{sha256:1, machine_model_id:1} unique, partialFilter {is_deleted:false}
{processing_status:1, created_at:-1}
{title:"text"}                                  # admin search only
{pending_vector_purge:1} sparse
```

**Rules** ① Searchable **iff** `is_deleted == false AND processing_status == "ready" AND
indexed_chunk_count > 0`. ② Delete = soft in Mongo + **hard** purge in Qdrant (**[C]** MUST-24).
③ `document_version` never auto-supersedes; superseding is an explicit admin act (**X8**/§11 of
the RAG doc). ④ Exactly one of `machine_model_id`/`machine_id` per `scope` (enforced by the
JSON Schema validator with `oneOf`).

**Example**
```json
{
  "_id": "665f1a2b3c4d5e6f7a8b9c41",
  "title": "EC180SX Service & Troubleshooting Manual",
  "scope": "model", "machine_model_id": "665f1a2b3c4d5e6f7a8b9c21",
  "document_type": "troubleshooting", "document_version": "Rev C (2019-04)",
  "is_current_version": true, "language": "en",
  "original_filename": "EC180SX_Service_RevC.pdf",
  "storage_path": "manuals/665f1a2b3c4d5e6f7a8b9c41/original.pdf",
  "file_size_bytes": 48211944, "sha256": "3f8a...e21", "mime_type": "application/pdf",
  "page_count": 512, "processing_status": "ready",
  "processing_summary": {"text_pages": 470, "ocr_pages": 42, "low_conf_pages": 5,
                         "chunk_count": 1284, "fault_code_chunks": 73,
                         "duration_ms": 412300, "warnings": ["42 pages required OCR"]},
  "ocr_applied": true, "ocr_quality": "partial",
  "indexed_chunk_count": 1284, "indexed_at": "2026-09-02T12:41:00Z",
  "embedding_model": "nomic-embed-text", "embedding_version": "nomic-768-v1",
  "chunking_version": "chunk-v1", "extraction_version": "pymupdf-v1",
  "uploaded_by": "665f...c01", "is_deleted": false,
  "created_at": "2026-09-02T12:30:00Z", "updated_at": "2026-09-02T12:41:00Z", "schema_version": 1
}
```

---

## 5. `manual_processing_jobs`

**Purpose** Traceable, resumable, restart-safe processing. **[C]** MUST-25.
**Note:** jobs are **never mutated in place across runs** — each run is a new document, giving
a complete processing history.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | `job_id` |
| `manual_id` | ObjectId | ✓ | |
| `job_type` | enum | ✓ | `full_process \| reindex_full \| reindex_embed \| reindex_index \| ocr_only \| delete_vectors` |
| `status` | enum | ✓ | `queued \| running \| completed \| completed_with_warnings \| failed \| cancelled` |
| `current_stage` | enum | – | `extraction \| ocr \| cleaning \| chunking \| embedding \| indexing \| verification` |
| `stages` | array\<obj\> | ✓ | `{name, status, started_at, ended_at, progress:{current,total,unit}, metrics{}, warnings[], error?}` |
| `progress_percent` | int | – | 0–100, derived |
| `attempt` | int | ✓ | 1-based |
| `max_attempts` | int | ✓ | default 3 |
| `parent_job_id` | ObjectId | – | links a retry to the original — the traceability chain |
| `resume_from_stage` | string | – | set when disk artefacts allow skipping |
| `error` | object | – | `{code, message, stage, retryable: bool, occurred_at, stack?}` (stack admin-only) |
| `error_code` | enum | – | `PDF_CORRUPT \| PDF_ENCRYPTED \| OCR_UNAVAILABLE \| NO_TEXT_EXTRACTED \| OLLAMA_UNAVAILABLE \| EMBED_DIM_MISMATCH \| QDRANT_UNAVAILABLE \| INDEX_VERIFICATION_FAILED \| TIMEOUT \| STALE_ABANDONED \| CANCELLED_BY_USER \| DISK_FULL \| UNKNOWN` |
| `cancel_requested` | bool | ✓ | default false; cooperative |
| `heartbeat_at` | Date | – | worker writes every ~10 s; drives the stale reaper |
| `worker_id` | string | – | process/host identity |
| `queued_at`,`started_at`,`ended_at` | Date | – | |
| `duration_ms` | int | – | |
| `triggered_by` | ObjectId | ✓ | user |
| `trigger_reason` | string | – | required for re-index |
| `timestamps` | | ✓ | standard (no soft delete — jobs are history) |

**Indexes**
```
{manual_id:1, created_at:-1}
{manual_id:1} unique, partialFilter {status: {$in:["queued","running"]}}   # duplicate-job prevention
{status:1, heartbeat_at:1}                                                 # stale reaper
{status:1, created_at:-1}
{parent_job_id:1} sparse
```

**Rules** ① The partial unique index makes duplicate live jobs **structurally impossible** —
better than an application check. ② `heartbeat_at` older than `STALE_JOB_MINUTES` while
`running` ⇒ reaped to `failed/STALE_ABANDONED`. ③ Only *retryable* error codes auto-retry.
④ FastAPI may write **only** this collection (`SYSTEM_ARCHITECTURE.md` §3.4). ⑤ Terminal
transition to `completed` is performed by Express **after** verifying the Qdrant count.

**Example**
```json
{
  "_id":"665f...ja1","manual_id":"665f...c41","job_type":"full_process","status":"failed",
  "current_stage":"embedding","attempt":1,"max_attempts":3,
  "stages":[
    {"name":"extraction","status":"completed","progress":{"current":512,"total":512,"unit":"pages"},
     "metrics":{"text_poor_pages":42},"started_at":"2026-09-02T12:30:10Z","ended_at":"2026-09-02T12:33:02Z"},
    {"name":"ocr","status":"completed","progress":{"current":42,"total":42,"unit":"pages"},
     "metrics":{"mean_conf":71.4,"low_conf_pages":5}},
    {"name":"chunking","status":"completed","metrics":{"chunk_count":1284,"fault_code_chunks":73}},
    {"name":"embedding","status":"failed","progress":{"current":640,"total":1284,"unit":"chunks"}}
  ],
  "progress_percent":62,
  "error":{"code":"OLLAMA_UNAVAILABLE","message":"connect ECONNREFUSED 127.0.0.1:11434",
           "stage":"embedding","retryable":true,"occurred_at":"2026-09-02T12:38:40Z"},
  "error_code":"OLLAMA_UNAVAILABLE","cancel_requested":false,
  "heartbeat_at":"2026-09-02T12:38:40Z","worker_id":"ai-service-1",
  "queued_at":"2026-09-02T12:30:05Z","started_at":"2026-09-02T12:30:08Z","ended_at":"2026-09-02T12:38:41Z",
  "triggered_by":"665f...c01","created_at":"2026-09-02T12:30:05Z","updated_at":"2026-09-02T12:38:41Z","schema_version":1
}
```

---

## 6. `conversations`

**Purpose** A troubleshooting session with a **stable machine scope**.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `user_id` | ObjectId | ✓ | owner |
| `title` | string | – | auto-generated from the first query, editable |
| `machine_id` | ObjectId | – | **[C]** may be linked to a physical machine |
| `machine_model_id` | ObjectId | – | resolved from the machine, or chosen directly |
| `scope_source` | enum | – | `user_selected \| detected_from_text \| default_machine \| clarified` — audit of *how* scope was set |
| `machine_snapshot` | object | – | display only |
| `status` | enum | ✓ | `active \| archived` |
| `turn_count` | int | ✓ | default 0 |
| `rolling_summary` | string | – | **[R]** ≤ 1500 chars, regenerated every N turns |
| `last_message_at` | Date | – | list ordering |
| `incident_ids` | ObjectId[] | – | incidents created from this conversation |
| `context_switches` | array\<obj\> | – | `{at, from_machine_id, to_machine_id, reason}` — never switch silently |
| soft delete / timestamps | | ✓ | standard |

**Indexes** `{user_id:1, last_message_at:-1}` · `{machine_id:1, created_at:-1}` ·
`{status:1, is_deleted:1}`

**Rules** ① Ownership enforced; managers/admins may read all. ② Scope changes are recorded, never
implicit (**X4** / Workflow N). ③ Deleting a conversation does **not** delete incidents created
from it.

---

## 7. `messages`

**Purpose** Full, reproducible turn history including the validated response object and the
retrieval trace.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `conversation_id` | ObjectId | ✓ | |
| `role` | enum | ✓ | `user \| assistant \| system` |
| `sequence` | int | ✓ | monotonic per conversation |
| `content_text` | string | cond | required for `user`; for `assistant` it is the rendered summary |
| `structured_response` | object | cond | required for `assistant` — the **validated** response contract (`RAG_PIPELINE.md` §9) |
| `answer_status` | enum | – | denormalised from the response for cheap filtering/metrics |
| `confidence` | enum | – | `high \| medium \| low` |
| `query_analysis` | object | – | `{classification, error_codes[], rewritten_query, entities}` |
| `retrieval_trace` | object | – | `{arms:{exact:{n,ids},lexical:{...},dense:{...}}, fused_ids[], reranked_ids[], context_chunk_ids[], scores[], filter_used{}, timings_ms{}}` |
| `validation_report` | object | – | `{citations_total, citations_valid, dropped[], downgraded_claims, page_mismatches}` |
| `evidence_counts` | object | – | `{manual, historical, maintenance}` |
| `model_info` | object | – | `{generation_model, embedding_model, prompt_version, temperature, seed?}` |
| `token_usage` | object | – | `{prompt, completion}` if available |
| `latency_ms` | int | – | end-to-end |
| `feedback` | object | – | **[R]** `{rating: up\|down, reason, by, at}` |
| `error` | object | – | when generation failed |
| `created_at` | Date | ✓ | (no `updated_at` — messages are immutable except for `feedback`) |

**Indexes** `{conversation_id:1, sequence:1}` unique · `{conversation_id:1, created_at:1}` ·
`{answer_status:1, created_at:-1}` (metrics) · `{"feedback.rating":1}` sparse

**Rules** ① Messages are immutable (append-only), except `feedback`. ② The retrieval trace is
what lets you answer a judge's "how do you know it used the right source?" live. ③ **[R]** Cap
`retrieval_trace` size (store IDs and scores, not chunk text) — otherwise messages balloon.

**Example (assistant, abbreviated)**
```json
{
  "_id":"665f...m2","conversation_id":"665f...cv1","role":"assistant","sequence":2,
  "content_text":"E-041 indicates a servo overload on the injection axis…",
  "structured_response":{"answer_status":"answered","confidence":"high","detected_error_code":"E-041","...":"…"},
  "answer_status":"answered","confidence":"high",
  "query_analysis":{"classification":"error_code","error_codes":["E-041"],"rewritten_query":null},
  "retrieval_trace":{"arms":{"exact":{"n":2},"lexical":{"n":8},"dense":{"n":20}},
                     "context_chunk_ids":["c41:0417","c41:0418","c41:0902"],
                     "filter_used":{"machine_model_id":"665f...c21","is_deleted":false},
                     "timings_ms":{"embed":180,"search":95,"rerank":0,"llm":6420}},
  "validation_report":{"citations_total":4,"citations_valid":4,"dropped":[],"page_mismatches":0},
  "evidence_counts":{"manual":3,"historical":2,"maintenance":1},
  "model_info":{"generation_model":"qwen2.5:7b-instruct","embedding_model":"nomic-embed-text","prompt_version":"p-v1","temperature":0.15},
  "latency_ms":7120,"created_at":"2026-09-04T03:12:07Z"
}
```

---

## 8. `incidents`

**Purpose** A troubleshooting event on a physical machine, its AI suggestions (as
**suggestions**), and its resolution state. **[C]** The heart of machine memory.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `incident_number` | string | ✓ | human-friendly `INC-2026-000123`, unique **[R]** |
| `machine_id` | ObjectId | cond | **[C]** required whenever possible |
| `machine_model_id` | ObjectId | ✓ | resolved at creation; needed for model-tier retrieval even if the machine is later retired |
| `needs_linking` | bool | ✓ | `true` when `machine_id` is null; such incidents are **excluded from retrieval** |
| `unlinked_reason` | string | – | |
| `title` | string | ✓ | ≤ 200 |
| `error_code` | string | – | normalised uppercase, e.g. `E-041` |
| `error_code_raw` | string | – | as typed |
| `symptom_text` | string | ✓ | ≤ 4000 |
| `observed_at` | Date | ✓ | when the fault appeared |
| `reported_by` | ObjectId | ✓ | |
| `assigned_to` | ObjectId | – | |
| `severity` | enum | ✓ | `low \| medium \| high \| critical` |
| `downtime_minutes` | int | – | |
| `status` | enum | ✓ | `open \| in_progress \| resolved \| closed \| cancelled` (workflow state) |
| `resolution_status` | enum | ✓ | **[C]** `unresolved \| resolved_confirmed \| temporarily_resolved \| recurring` |
| `resolution_confirmed` | bool | ✓ | default `false`; **only** an explicit human act sets `true` |
| `confirmed_by` | ObjectId | cond | required when `resolution_confirmed` |
| `confirmed_at` | Date | cond | required when `resolution_confirmed` |
| `confirmation_method` | enum | – | `self \| supervisor` (`INCIDENT_CONFIRMATION_MODE`) |
| `confirmation_note` | string | – | |
| `verified_by_test` | bool | – | did the technician actually run the machine to verify? |
| `root_cause_text` | string | cond | **required** for `resolved_confirmed` |
| `effective_action_id` | ObjectId | – | → the `incident_actions` entry that worked |
| `resolved_at` | Date | – | |
| `ai_suggestions` | array\<obj\> | – | **[C] suggestions, never actions**: `{message_id, conversation_id, suggested_at, summary, top_causes[], confidence, generation_model, prompt_version, was_followed: bool\|null, outcome_if_followed}` |
| `conversation_ids` | ObjectId[] | – | |
| `related_incident_ids` | ObjectId[] | – | recurrence chains |
| `is_recurrence_of` | ObjectId | – | set by recurrence detection **[R]** |
| `recurrence_count` | int | – | |
| `tags` | string[] | – | |
| `vector_indexed` | bool | ✓ | default false |
| `vector_indexed_at` | Date | – | |
| `pending_vector_sync` | bool | – | set when the embed/upsert failed; drives the reconciler |
| `revisions` | array\<obj\> | – | corrections: `{at, by, reason, changed_fields, previous_values}` — **history is preserved, never overwritten** **[C]** |
| soft delete / timestamps | | ✓ | standard |

**Indexes**
```
{machine_id:1, observed_at:-1}
{machine_id:1, error_code:1, observed_at:-1}          # exact-code history lookup
{machine_model_id:1, resolution_status:1, observed_at:-1}
{incident_number:1} unique
{status:1, is_deleted:1}
{resolution_confirmed:1, vector_indexed:1}
{pending_vector_sync:1} sparse
{needs_linking:1} sparse
{symptom_text:"text", title:"text"}                    # lexical fallback
```

**Business rules (all [C] unless noted)**
1. `resolution_status = resolved_confirmed` **requires** `resolution_confirmed == true`,
   `confirmed_by`, `confirmed_at`, non-empty `root_cause_text`, and ≥ 1 action with
   `outcome == "worked"`. Enforced in the service layer **and** by the JSON Schema validator.
2. No timer, heuristic, or AI output may set `resolution_confirmed`.
3. `ai_suggestions` are never promoted into actions; only `incident_actions` records what was
   done.
4. Vectors are written **only** when `resolution_status != "unresolved"` **or** at least one
   action exists — i.e. when there is something real to learn from. Status travels with the
   vector.
5. Corrections append to `revisions`; the prior resolution status is preserved.
6. Soft delete + **hard** Qdrant point delete.
7. `needs_linking` incidents never appear as historical evidence.

**Example**
```json
{
  "_id":"665f...i7","incident_number":"INC-2026-000123",
  "machine_id":"665f...c31","machine_model_id":"665f...c21","needs_linking":false,
  "title":"E-041 servo overload during injection",
  "error_code":"E-041","error_code_raw":"e041","symptom_text":"Machine halts mid-injection, HMI shows E-041. Smell of hot oil near the servo pack.",
  "observed_at":"2026-09-04T02:41:00Z","reported_by":"665f...c01","assigned_to":"665f...c01",
  "severity":"high","downtime_minutes":95,
  "status":"resolved","resolution_status":"resolved_confirmed","resolution_confirmed":true,
  "confirmed_by":"665f...c01","confirmed_at":"2026-09-04T04:20:00Z","confirmation_method":"self",
  "confirmation_note":"Ran 20 cycles at full tonnage, no recurrence.","verified_by_test":true,
  "root_cause_text":"Servo cooling filter clogged with mould-release residue, causing drive over-temperature and overload trip.",
  "effective_action_id":"665f...a2","resolved_at":"2026-09-04T04:20:00Z",
  "ai_suggestions":[{"message_id":"665f...m2","conversation_id":"665f...cv1","suggested_at":"2026-09-04T03:12:07Z",
    "summary":"Check servo drive parameters and cooling filter","top_causes":["Drive parameter mismatch after replacement","Cooling filter restriction"],
    "confidence":"high","generation_model":"qwen2.5:7b-instruct","prompt_version":"p-v1","was_followed":true,"outcome_if_followed":"partial"}],
  "conversation_ids":["665f...cv1"],"related_incident_ids":["665f...i3"],"is_recurrence_of":"665f...i3","recurrence_count":2,
  "vector_indexed":true,"vector_indexed_at":"2026-09-04T04:20:03Z",
  "is_deleted":false,"created_at":"2026-09-04T02:45:00Z","updated_at":"2026-09-04T04:20:03Z","schema_version":1
}
```

---

## 9. `incident_actions`

**Purpose** **[C]** What a human actually did — stored **separately** from AI suggestions.
A separate collection (not an embedded array) because actions are independently queryable,
independently attributed, append-only, and can grow unbounded.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `incident_id` | ObjectId | ✓ | |
| `machine_id` | ObjectId | ✓ | denormalised for direct machine-level queries (safe: immutable link) |
| `sequence` | int | ✓ | order of actions within the incident |
| `action_text` | string | ✓ | ≤ 4000, what was done |
| `action_type` | enum | – | `inspection \| adjustment \| cleaning \| part_replacement \| reset \| software_change \| calibration \| escalation \| other` |
| `parts_replaced` | array\<obj\> | – | `{part_number, name, quantity}` |
| `tools_used` | string[] | – | |
| `outcome` | enum | ✓ | **[C]** `worked \| partial \| no_change \| made_worse \| unknown` |
| `outcome_note` | string | – | |
| `duration_minutes` | int | – | |
| `performed_by` | ObjectId | ✓ | from the JWT |
| `performed_at` | Date | ✓ | not in the future |
| `followed_ai_suggestion` | bool | – | **[R]** the AI-accuracy signal |
| `ai_message_id` | ObjectId | – | which suggestion |
| `deviation_reason` | string | – | why the technician did something else — *extremely* valuable data |
| `source_type` | enum | ✓ | constant `technician_action` (explicit, so it can never be confused with AI content) |
| `edited` | bool | – | true if edited within the 24 h **[A]** window |
| `edit_history` | array\<obj\> | – | `{at, by, previous_text}` |
| timestamps | | ✓ | (no soft delete — append-only truth) |

**Indexes** `{incident_id:1, sequence:1}` unique · `{machine_id:1, performed_at:-1}` ·
`{performed_by:1, performed_at:-1}` · `{"parts_replaced.part_number":1}` sparse ·
`{outcome:1}`

**Rules** ① Append-only; edits within 24 h retain `edit_history`, later corrections must be new
entries. ② `performed_by` from the token. ③ An action with `outcome: "worked"` is a
**prerequisite** for confirmed resolution. ④ Actions on closed incidents require manager
reopen.

---

## 10. `maintenance_records`

**Purpose** Planned/performed service history — the third evidence class. **[C]** Correlation
only, never causation.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `machine_id` | ObjectId | ✓ | always machine-scoped |
| `machine_model_id` | ObjectId | ✓ | denormalised for model-level queries |
| `maintenance_type` | enum | ✓ | `preventive \| corrective \| calibration \| inspection \| part_replacement \| software_update \| cleaning \| lubrication \| overhaul` |
| `title` | string | ✓ | ≤ 200 |
| `description` | string | – | ≤ 4000 |
| `performed_at` | Date | ✓ | **not in the future** |
| `performed_by` | ObjectId | – | internal user |
| `performed_by_external` | string | – | vendor/contractor name |
| `work_order_ref` | string | – | external CMMS reference |
| `parts_replaced` | array\<obj\> | – | `{part_number (uppercased/trimmed), name, quantity, serial?}` |
| `components_serviced` | string[] | – | e.g. `["servo_pack","hydraulic_filter"]` |
| `measurements` | array\<obj\> | – | `{name, value: number, unit, in_spec: bool?}` — enables real "drift" observations later |
| `duration_minutes` | int | – | |
| `downtime_minutes` | int | – | |
| `cost` | object | – | `{amount, currency}` **[R]** optional |
| `next_due_at` | Date | – | |
| `related_incident_id` | ObjectId | – | when maintenance arose from an incident |
| `notes` | string | – | |
| soft delete / timestamps / attribution | | ✓ | standard |

**Indexes**
```
{machine_id:1, performed_at:-1}                 # the primary RAG query
{machine_id:1, maintenance_type:1, performed_at:-1}
{"parts_replaced.part_number":1, performed_at:-1}
{machine_model_id:1, performed_at:-1}
{next_due_at:1} sparse
{description:"text", title:"text"}
```

**Rules** ① Retrieved by **structured query** (machine + window + part + type), not by vector
search (`SYSTEM_ARCHITECTURE.md` Workflow S). ② Updating a record updates
`machines.last_maintenance_at`. ③ Part numbers normalised on write, otherwise the
part-intersection logic in Workflow T silently fails.

**Example**
```json
{
  "_id":"665f...mr9","machine_id":"665f...c31","machine_model_id":"665f...c21",
  "maintenance_type":"part_replacement","title":"Servo drive unit replacement (injection axis)",
  "description":"Replaced failed servo drive on injection axis; parameters restored from backup dated 2025-11-02.",
  "performed_at":"2026-08-29T10:30:00Z","performed_by":"665f...c01","work_order_ref":"WO-2291",
  "parts_replaced":[{"part_number":"TM-SVD-45A","name":"Servo drive 45A","quantity":1,"serial":"SV-88213"}],
  "components_serviced":["servo_pack","injection_axis"],
  "measurements":[{"name":"drive_temp_after_run","value":58.2,"unit":"C","in_spec":true}],
  "duration_minutes":210,"downtime_minutes":240,"next_due_at":null,
  "is_deleted":false,"created_at":"2026-08-29T14:00:00Z","updated_at":"2026-08-29T14:00:00Z",
  "created_by":"665f...c01","schema_version":1
}
```

---

## 11. `audit_logs`

**Purpose** **[C]** Record important changes. Append-only.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `_id` | ObjectId | ✓ | |
| `at` | Date | ✓ | |
| `actor_id` | ObjectId | – | null for system actions |
| `actor_role` | string | – | role at the time (roles change; the log must not) |
| `actor_username` | string | – | snapshot, so the log reads correctly after a rename |
| `action` | string | ✓ | dotted: `manual.deleted`, `incident.resolved`, `auth.login.failure`, `user.role_changed`, `security.prompt_injection_suspected`, `manual.reindexed`, `machine.model_changed` |
| `entity_type` | string | – | `manual \| incident \| machine \| user \| …` |
| `entity_id` | ObjectId | – | |
| `outcome` | enum | ✓ | `success \| failure \| denied` |
| `severity` | enum | ✓ | `info \| notice \| warning \| security` |
| `request_id` | string | – | correlation across services |
| `ip` | string | – | **[R]** consider truncating/omitting; it is personal data |
| `user_agent_hash` | string | – | hashed, not raw |
| `changes` | object | – | `{field: {from, to}}` — **allowlisted fields only**, values truncated to 200 chars |
| `reason` | string | – | required for deletes, re-index, role changes, corrections |
| `metadata` | object | – | e.g. `{chunk_count: 1284, pattern:"ignore previous instructions"}` |

**Indexes** `{at:-1}` · `{entity_type:1, entity_id:1, at:-1}` · `{actor_id:1, at:-1}` ·
`{action:1, at:-1}` · `{severity:1, at:-1}`
**[R]** TTL index on `{at:1}` with `expireAfterSeconds = 365d` **applied only to
`severity: "info"`** via a partial index — security events are never auto-expired.

**Rules** ① No update/delete endpoints exist (**X9**). ② Never log secrets, passwords, tokens,
or manual content. ③ `changes` uses an allowlist per entity type — a blanket diff will
eventually leak something sensitive. ④ **[R]** Optional daily hash-chain checkpoint document
(`prev_hash`, `hash`) for tamper-evidence; documented honestly as tamper-*evident*, not
tamper-proof, without WORM storage.

---

## 12. Relationship diagram

```
users ─┬─(created_by / performed_by / confirmed_by)──► almost everything
       └─(default_machine_id)──► machines

machine_models ─1──n─► machines
       └──1──n─► manuals (scope="model")
                    └──1──n─► manual_processing_jobs
                    └──1──n─► [Qdrant manual_chunks points]

machines ─┬─1──n─► incidents ─1──n─► incident_actions
          │             └──1──1─► [Qdrant incident_history point]  (only when status is meaningful)
          ├─1──n─► maintenance_records
          ├─1──n─► conversations ─1──n─► messages
          └─(scope="machine")──n─► manuals

conversations ──n──n─► incidents  (via incidents.conversation_ids / conversations.incident_ids)
audit_logs ──(entity_type, entity_id)──► any
```

**Cardinality notes**
- A physical machine has exactly one model; a model has many machines. **[C]**
- Manuals attach to a model (default) or to a machine (exception, **X1**).
- An incident belongs to one machine (or is `needs_linking`) and always records
  `machine_model_id` so model-tier retrieval survives machine retirement.
- Conversations and incidents are many-to-many but low cardinality; ID arrays on both sides are
  acceptable and simpler than a join collection at this scale.

---

## 13. Consistency, transactions, and derived state

**Mongo is the single source of truth. Qdrant and the filesystem are derived.** Everything in
Qdrant must be rebuildable from Mongo + `storage/` (contradiction **X6**).

**Operations that touch multiple documents/systems**

| Operation | Approach |
|---|---|
| Manual upload | fs write → Mongo insert. If the Mongo insert fails, the temp file is deleted. |
| Manual delete | **Transaction** (`manuals` soft-delete + audit) → then Qdrant purge → then verify. Soft-delete-first ordering means a Qdrant failure cannot leave the manual searchable. |
| Incident resolve | **Transaction** (`incidents` update + `audit_logs`) → then embed+upsert (best effort, `pending_vector_sync` on failure). A derived-index failure never blocks a business fact. |
| Job completion | FastAPI writes stage progress; Express performs the terminal transition after count verification. |
| Counter caches | `manual_count`, `machine_count`, `open_incident_count`, `indexed_chunk_count` are best-effort; the boot reconciler recomputes them. Never used for correctness decisions. |

**The reconciler (boot + every 5 min **[A]**)** checks: stale jobs; manuals `ready` with 0
Qdrant points; deleted manuals with points present (`pending_vector_purge`); incidents with
`pending_vector_sync`; counter drift; orphaned `storage/tmp` directories. This single component
is what makes an eventually-consistent design safe without adding a broker.

---

## 14. Index creation, seeds, and validators

- **[R]** Indexes are created by an idempotent `ensureIndexes()` at Express boot (not by a
  migration framework — overkill for a greenfield hackathon project). Boot fails loudly if a
  unique index cannot be built because of existing duplicate data.
- **[R]** JSON Schema validators are applied by the same bootstrap, with
  `validationLevel: "moderate"` so pre-existing documents are never blocked.
- Seed data (Phase 1/12): 4 users (one per role), 3–4 machine models, 5–6 machines, 8–10
  maintenance records, 4–6 historical incidents in **mixed** resolution states (this mixture is
  what makes the demo's history lane convincing).
- **No migration code in this phase** **[C]**.

## 15. Field-level validation summary

| Rule | Where |
|---|---|
| String length caps on all free text (200/2000/4000) | App layer + JSON Schema |
| Enum membership | Both |
| `performed_at`/`observed_at` ≤ now + 5 min skew | App layer |
| `resolved_confirmed` invariant (§8 rule 1) | App layer + `$jsonSchema` conditional |
| `oneOf` on manual scope fields | `$jsonSchema` |
| ObjectId references exist and are not soft-deleted | App layer (Mongo cannot enforce FKs) |
| `asset_tag`/`part_number` charset | App layer, before any use in a filter |
| No `$`-prefixed or dotted keys from user input | Global sanitiser middleware (NoSQL-injection defence) |
