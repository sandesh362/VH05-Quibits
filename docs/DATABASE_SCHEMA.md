# Database Schema — Phase 2

MongoDB, single database (`MONGO_DB_NAME`, default `itp`). 11 domain collections plus one `counters` helper. All 51 indexes are created idempotently at startup by `ensureIndexes()` (`backend/src/database/indexes.ts`).

Document interfaces live in `backend/src/database/collections.ts` and are the authoritative field list; this document explains the shape and the reasoning.

---

## Conventions

| Convention | Rule |
|---|---|
| Field naming | `snake_case` in MongoDB, `camelCase` on the wire. Services translate at the boundary. |
| Timestamps | `created_at` / `updated_at` set by the data layer, never accepted from a request body. |
| Attribution | `created_by` / `updated_by` come from the verified JWT, never from the body. |
| Soft delete | `is_deleted`, `deleted_at`, `deleted_by`, `delete_reason`. Every read applies `is_deleted: false` via `liveFilter()`. |
| Versioning | `schema_version: 1` on every document, so a future migration can tell generations apart. |
| Case-insensitive uniqueness | Collation `{ locale: 'en', strength: 2 }` on identifier indexes. |

**Soft delete is opt-out, not opt-in.** `liveFilter()` adds the filter unless a caller explicitly passes `includeDeleted`. Forgetting the filter in one handler is exactly how deleted records reappear in a list, so the default is the safe one.

---

## Collections

### `users`

Accounts and credentials.

Key fields: `username`, `email`, `password_hash`, `full_name`, `role`, `is_active`, `must_change_password`, `token_version`, `refresh_tokens[]`, `failed_login_count`, `locked_until`, `last_login_at`.

- `password_hash` — Argon2id. Excluded by `USER_PUBLIC_PROJECTION` and never present in any view type.
- `token_version` — incremented on password change and logout-all. The value is embedded in each access token as `tv`; a mismatch rejects the token. This is what makes a stateless JWT revocable.
- `refresh_tokens[]` — SHA-256 hashes only, never the token itself. Each carries a `family_id`; presenting a rotated token revokes the entire family. Capped at 5.
- `locked_until` — set after `AUTH_MAX_FAILED_LOGINS` failures.

| Index | Purpose |
|---|---|
| `uniq_email_ci` (unique, CI, partial `is_deleted:false`) | Login lookup and uniqueness. Case-insensitive so `Bob@x.com` and `bob@x.com` are one account. Partial so a deleted user's email can be reused. |
| `uniq_username_ci` (unique, CI, partial) | Same, for usernames. |
| `role_active` | Answers "is this the last active admin?" without a collection scan. |
| `refresh_token_hash` | Refresh lookups query by hash; without this, every refresh scans all users. |

### `machine_models`

The product type (an "EC180SX"), not a physical asset.

Key fields: `manufacturer`, `model_name`, `machine_type`, `aliases[]`, `model_year`, `specifications`, `default_language`, `manual_count`, `machine_count`.

Duplicate prevention matters here beyond tidiness: this is the retrieval filter key in Phase 4, and two near-identical rows would split the manual corpus in half.

| Index | Purpose |
|---|---|
| `uniq_manufacturer_model_ci` (unique, CI, partial) | The identity of a model. |
| `machine_type` | Type filter on the list endpoint. |
| `aliases` (multikey) | Lets "EC-180SX" find a model stored as "EC180SX". |
| `live_recent` | Default list sort (`is_deleted` + `created_at`). |

### `machines`

Physical assets.

Key fields: `asset_tag` (**immutable**), `machine_model_id`, `model_snapshot`, `serial_number`, `location{site,area,line,position}`, `status`, `criticality`, `last_maintenance_at`, `open_incident_count`.

`model_snapshot` is denormalised for list rendering; `machine_model_id` is the source of truth. Changing the model requires an audited reason, because it changes which manuals apply.

| Index | Purpose |
|---|---|
| `uniq_asset_tag` (unique, CI, partial) | The shop-floor identifier. |
| `uniq_serial` (unique, partial `$type: 'string'`) | Optional but unique when present. Uses a partial filter **instead of** `sparse` — MongoDB rejects both together. |
| `by_model` | Referential check before deleting a model. |
| `by_status`, `by_line` | Dashboard filters. |
| `model_live_status` | Compound: the fleet-status-by-model view. |

### `manuals`

**Metadata only in Phase 2.** No file bytes are handled anywhere in this phase.

Key fields: `title`, `scope` (`model`|`machine`), `machine_model_id`, `machine_id`, `document_type`, `is_current_version`, `original_filename`, `storage_path`, `file_size_bytes`, `sha256`, `processing_status`, `indexed_chunk_count`.

- `storage_path` is **server-generated** (`manuals/<year>/<sha256>.pdf`) and never derived from the client filename — the classic path-traversal vector. It is never returned to a client.
- `processing_status` is owned by the Phase 3 pipeline. This phase writes `queued` once and the API refuses to change it.

| Index | Purpose |
|---|---|
| `uniq_content_per_model` (unique on `sha256` + `machine_model_id`, partial) | Stops the same PDF being registered twice for one model, which would double every retrieval hit later. |
| `status_recent` | The Phase 3 worker's queue query. |
| `manual_recent`, `live_recent` | List endpoints. |

### `manual_processing_jobs`

Declared and indexed; no Phase 2 endpoint writes to it. Each pipeline run is a **new document**, never a mutation of a previous run, so a failed reindex cannot erase the record of the successful one before it.

`uniq_active_job` is a partial unique index over `status ∈ {queued, running}`, preventing two concurrent jobs for the same manual.

### `conversations`

Container for a troubleshooting thread. No AI in Phase 2.

`scope_source` records **how** the scope was chosen (`user_selected_machine`, `user_selected_model`). Once Phase 4 can infer scope from question text, distinguishing an inferred scope from a chosen one is what makes bad retrieval debuggable.

Deleting a conversation does **not** delete incidents raised from it.

### `messages`

Append-only, immutable except for `feedback`. No `updated_at` — the field would be meaningless.

`uniq_conv_sequence` (unique on `conversation_id` + `sequence`) guarantees a total order within a thread.

Assistant messages must carry `structured_response` **alongside** `content_text`, not instead of it: the structured form drives the UI, the text form stays readable when the schema changes.

### `incidents`

Key fields: `incident_number`, `machine_id`, `machine_model_id`, `needs_linking`, `title`, `error_code` + `error_code_raw`, `symptom_text`, `severity`, `status`, `resolution_status`, `resolution_confirmed`, `confirmed_by/at`, `root_cause_text`, `effective_action_id`.

- `error_code` is normalised (uppercased, trimmed) for exact-match search; `error_code_raw` preserves what the operator actually saw on the HMI.
- `needs_linking` is true when an incident references only a model. A technician mid-breakdown is never blocked because the asset was not registered — but Phase 4 excludes unlinked incidents from retrieval, so the flag has consequences.
- `resolution_status` is a **separate axis** from `status`. See `PHASE_2_IMPLEMENTATION.md` §3.1.

| Index | Purpose |
|---|---|
| `uniq_incident_number` (unique) | The human-facing identifier. |
| `machine_timeline` | "What has gone wrong with this machine?" — the most common query. |
| `machine_code_history` | Machine + error code: the exact-match path for repeat faults. |
| `model_resolution_history` | Model + `resolution_status`: the Phase 4 retrieval filter. |
| `confirmed_unindexed` (partial) | Finds confirmed incidents not yet vectorised — the Phase 4 reconciliation sweep. |
| `needs_linking` | The data-quality backlog. |

### `incident_actions`

Append-only work log. **No soft delete, no hard delete** — the highest-value data the platform produces.

Edits allowed for 24 hours by the author; the previous text is pushed to `edit_history[]`. `performed_by` always comes from the JWT, so nobody can log work as someone else. `source_type` is the constant `technician_action`, so human-recorded work can never be confused with generated content.

| Index | Purpose |
|---|---|
| `uniq_incident_sequence` (unique) | Ordered log within an incident. |
| `by_part` | "Which machines needed this part?" |
| `by_outcome` | Feeds "what actually worked" in Phase 4. |

### `maintenance_records`

Structured query only in Phase 2 — no similarity search.

Part numbers are uppercased and trimmed on write, and the same normalisation is applied to query input, so `brg-7204` finds `BRG-7204`. Writes refresh `machines.last_maintenance_at` by recomputing the maximum from live records (correct under back-dating and soft deletion, unlike `$max` on write).

Indexes: `machine_history`, `machine_type_history`, `part_history`, `model_history`, `next_due` (partial), `live_recent`.

### `audit_logs`

Append-only. **No update or delete endpoint exists.**

Fields: `action`, `actor_id/username/role` (snapshotted, so the trail survives a rename), `entity_type`, `entity_id`, `outcome`, `severity`, `changes`, `reason`, `request_id`, `metadata`.

`changes` is built from a per-entity allowlist with 200-character truncation — an audit entry records *that* a field changed and roughly to what, not a full copy of the document. `reason` is required for deletes and role changes.

Audit writes never throw: a failed audit write is logged but does not fail the user's operation.

Indexes: `recent`, `entity_history`, `actor_history`, `action_history`, `severity_recent`.

### `counters`

Not a domain collection. Holds atomic sequence values (`incident:2026`, `incident_action:<id>`) incremented via `findOneAndUpdate` + `$inc` + `upsert`.

The naive alternative — `count() + 1` — produces duplicates under concurrency and reuses numbers after a delete. Neither is acceptable for an identifier people quote to each other.

---

## Index summary

| Collection | Indexes |
|---|---|
| users | 4 |
| machine_models | 4 |
| machines | 6 |
| manuals | 5 |
| manual_processing_jobs | 2 |
| conversations | 3 |
| messages | 2 |
| incidents | 7 |
| incident_actions | 5 |
| maintenance_records | 6 |
| audit_logs | 5 |
| **Total** | **51** (plus `_id` on each) |

Every index in `indexes.ts` carries a comment naming the query that justifies it. An index with no caller is a write-cost with no reader.
