/**
 * MongoDB document shapes and typed collection accessors.
 *
 * Field naming is `snake_case` to match docs/DATA_MODEL.md and what you see in
 * `mongosh`. The API speaks `camelCase`; module-level mappers translate at the
 * boundary. Keeping the two apart means a wire-format change never forces a
 * database migration.
 *
 * PHASE 2 SCOPE: fields needed now, plus the few forward-looking fields the
 * pipeline will populate later (`vector_indexed`, `processing_status`, ...).
 * Those are declared so Phase 3 does not have to migrate, but nothing in
 * Phase 2 sets them to anything other than their inert default.
 */
import type { Collection, Db, ObjectId } from 'mongodb';
import type {
  ActionOutcome,
  ActionType,
  ConversationStatus,
  Criticality,
  DocumentType,
  IncidentStatus,
  JobStatus,
  JobType,
  MachineStatus,
  MachineType,
  MaintenanceType,
  ManualScope,
  MessageRole,
  ProcessingStatus,
  ResolutionStatus,
  Severity,
  UserRole,
} from '@itp/shared';

// ---------------------------------------------------------------------------
// Shared field groups
// ---------------------------------------------------------------------------

/** Every collection carries these. Set by the data layer, never by a client. */
export interface BaseDoc {
  created_at: Date;
  updated_at: Date;
  schema_version: number;
}

/** Soft delete. Reads filter `is_deleted: false` through a repository helper. */
export interface SoftDeletable {
  is_deleted: boolean;
  deleted_at?: Date | null;
  deleted_by?: ObjectId | null;
  delete_reason?: string | null;
}

/** Attribution taken from the JWT, never from the request body. */
export interface Attributed {
  created_by?: ObjectId | null;
  updated_by?: ObjectId | null;
}

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface RefreshTokenEntry {
  token_hash: string;
  family_id: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at?: Date | null;
}

export interface UserDoc extends BaseDoc, SoftDeletable {
  _id: ObjectId;
  username: string;
  email: string;
  /**
   * Argon2id encoded string. Excluded from every default projection by
   * `USER_PUBLIC_PROJECTION`; there is no code path that returns it.
   */
  password_hash: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  /** Bumped on password/role change to invalidate every live access token. */
  token_version: number;
  refresh_tokens: RefreshTokenEntry[];
  failed_login_count: number;
  locked_until?: Date | null;
  last_login_at?: Date | null;
  employee_code?: string | null;
  preferences?: { locale?: string; theme?: string; timezone?: string } | null;
}

// ---------------------------------------------------------------------------
// machine_models
// ---------------------------------------------------------------------------

export interface MachineModelDoc extends BaseDoc, SoftDeletable, Attributed {
  _id: ObjectId;
  manufacturer: string;
  model_name: string;
  machine_type: MachineType;
  aliases: string[];
  model_year?: number | null;
  specifications?: Record<string, unknown> | null;
  default_language: string;
  notes?: string | null;
  /** Display-only cached counters. Never used as a query filter. */
  manual_count: number;
  machine_count: number;
  indexed_chunk_count: number;
}

// ---------------------------------------------------------------------------
// machines
// ---------------------------------------------------------------------------

export interface MachineLocation {
  site?: string | null;
  building?: string | null;
  line?: string | null;
  cell?: string | null;
}

/** Display-only label snapshot. Never a filter key - see DATA_MODEL.md 0. */
export interface ModelSnapshot {
  manufacturer: string;
  model_name: string;
  machine_type: MachineType;
}

export interface MachineDoc extends BaseDoc, SoftDeletable, Attributed {
  _id: ObjectId;
  /** Immutable after creation. */
  asset_tag: string;
  machine_model_id: ObjectId;
  model_snapshot?: ModelSnapshot | null;
  display_name?: string | null;
  serial_number?: string | null;
  location?: MachineLocation | null;
  status: MachineStatus;
  installed_at?: Date | null;
  commissioned_at?: Date | null;
  criticality?: Criticality | null;
  notes?: string | null;
  last_maintenance_at?: Date | null;
  open_incident_count: number;
}

// ---------------------------------------------------------------------------
// manuals  (metadata only - no bytes, no upload in Phase 2)
// ---------------------------------------------------------------------------

export interface ManualDoc extends BaseDoc, SoftDeletable {
  _id: ObjectId;
  title: string;
  description?: string | null;
  /** Display-only. May differ from the model's manufacturer (e.g. OEM vs brand). */
  manufacturer?: string | null;
  scope: ManualScope;
  machine_model_id?: ObjectId | null;
  machine_id?: ObjectId | null;
  document_type: DocumentType;
  document_number?: string | null;
  document_version?: string | null;
  revision?: string | null;
  supersedes_manual_id?: ObjectId | null;
  is_current_version: boolean;
  language: string;
  /** Metadata only. Never used to build a filesystem path. */
  original_filename: string;
  /** Server-generated, relative to MANUAL_STORAGE_PATH. Never returned to clients. */
  storage_path: string;
  file_size_bytes: number;
  sha256: string;
  mime_type: string;
  page_count?: number | null;
  /** Owned by the Phase 3 pipeline. Always `queued` when created here. */
  processing_status: ProcessingStatus;
  /** Pipeline/format version the manual was last processed with (reproduce/trace). */
  processing_version?: string | null;
  /** How text was obtained: `native` (text layer) | `ocr` | `mixed`. */
  extraction_method?: string | null;
  ocr_used?: boolean | null;
  indexed_chunk_count: number;
  indexed_at?: Date | null;
  processed_at?: Date | null;
  failed_at?: Date | null;
  failure_reason?: string | null;
  /** Distinguishes an active manual from one retired by metadata, not soft-delete. */
  is_active: boolean;
  uploaded_by: ObjectId;
}

// ---------------------------------------------------------------------------
// manual_processing_jobs  (model only - no worker exists in Phase 2)
// ---------------------------------------------------------------------------

export interface JobStage {
  name: string;
  status: string;
  started_at?: Date | null;
  ended_at?: Date | null;
  progress?: { current: number; total: number; unit: string } | null;
  warnings?: string[];
}

export interface ManualProcessingJobDoc extends BaseDoc {
  _id: ObjectId;
  manual_id: ObjectId;
  job_type: JobType;
  status: JobStatus;
  current_stage?: string | null;
  stages: JobStage[];
  progress_percent: number;
  attempt: number;
  /** User that requested the job (null for system/scheduled). */
  triggered_by?: ObjectId | null;
  machine_model_id?: ObjectId | null;
  /** Stable code for clients. The raw message stays internal. */
  error_code?: string | null;
  error_message?: string | null;
  error_details?: string | null;
  started_at?: Date | null;
  completed_at?: Date | null;
  failed_at?: Date | null;
  retry_count: number;
  total_pages?: number | null;
  processed_pages: number;
  total_chunks?: number | null;
  processed_chunks: number;
  extraction_method?: string | null;
  ocr_used?: boolean | null;
  embedding_model?: string | null;
  embedding_dimension?: number | null;
  created_by?: ObjectId | null;
}

// ---------------------------------------------------------------------------
// manual_pages  (page-level extracted text; source of truth for citations)
// ---------------------------------------------------------------------------

export interface ManualPageDoc extends BaseDoc {
  _id: ObjectId;
  manual_id: ObjectId;
  /** Actual PDF page number, 1-based. Never derived from a running counter. */
  page_number: number;
  /** Raw text exactly as the extractor/OCR produced it. Never mutated. */
  raw_text: string;
  cleaned_text: string;
  character_count: number;
  word_count: number;
  has_text: boolean;
  extraction_method: string;
  ocr_used: boolean;
  ocr_confidence?: number | null;
}

// ---------------------------------------------------------------------------
// manual_chunks  (retrieval unit; Mongo is authoritative, Qdrant is the index)
// ---------------------------------------------------------------------------

export type ChunkIndexingStatus = 'pending' | 'embedded' | 'indexed';

export interface ManualChunkDoc extends BaseDoc {
  _id: ObjectId;
  manual_id: ObjectId;
  machine_model_id?: ObjectId | null;
  machine_id?: ObjectId | null;
  chunk_index: number;
  page_start: number;
  page_end: number;
  section_title?: string | null;
  section_path?: string[] | null;
  text: string;
  normalized_text: string;
  character_count: number;
  word_count: number;
  content_hash: string;
  embedding_model?: string | null;
  embedding_dimension?: number | null;
  qdrant_point_id?: string | null;
  indexing_status: ChunkIndexingStatus;
}

// ---------------------------------------------------------------------------
// conversations / messages  (persistence only - no chat in Phase 2)
// ---------------------------------------------------------------------------

export interface ConversationDoc extends BaseDoc, SoftDeletable {
  _id: ObjectId;
  user_id: ObjectId;
  title?: string | null;
  machine_id?: ObjectId | null;
  machine_model_id?: ObjectId | null;
  scope_source?: string | null;
  status: ConversationStatus;
  turn_count: number;
  last_message_at?: Date | null;
  incident_ids: ObjectId[];
}

export interface MessageDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  role: MessageRole;
  sequence: number;
  content_text?: string | null;
  /**
   * The validated structured response (Phase 5). Stored ALONGSIDE
   * `content_text`, never instead of it - see docs/PHASE_2_IMPLEMENTATION.md
   * for why both are kept.
   */
  structured_response?: Record<string, unknown> | null;
  answer_status?: string | null;
  confidence?: string | null;
  created_at: Date;
  schema_version: number;
}

// ---------------------------------------------------------------------------
// incidents
// ---------------------------------------------------------------------------

/** AI output recorded as a SUGGESTION. Never promoted into an action. */
export interface AiSuggestion {
  message_id?: ObjectId | null;
  conversation_id?: ObjectId | null;
  suggested_at: Date;
  summary: string;
  top_causes: string[];
  confidence?: string | null;
  generation_model?: string | null;
  was_followed?: boolean | null;
}

/** Corrections append here; prior values are preserved, never overwritten. */
export interface IncidentRevision {
  at: Date;
  by: ObjectId;
  reason: string;
  changed_fields: string[];
  previous_values: Record<string, unknown>;
}

export interface IncidentDoc extends BaseDoc, SoftDeletable, Attributed {
  _id: ObjectId;
  incident_number: string;
  machine_id?: ObjectId | null;
  machine_model_id: ObjectId;
  /** True when unlinked to a machine. Such incidents are excluded from retrieval. */
  needs_linking: boolean;
  title: string;
  error_code?: string | null;
  error_code_raw?: string | null;
  symptom_text: string;
  observed_at: Date;
  reported_by: ObjectId;
  assigned_to?: ObjectId | null;
  severity: Severity;
  downtime_minutes?: number | null;
  status: IncidentStatus;
  resolution_status: ResolutionStatus;
  /** Only an explicit human act sets this true. No timer, heuristic, or AI. */
  resolution_confirmed: boolean;
  confirmed_by?: ObjectId | null;
  confirmed_at?: Date | null;
  confirmation_method?: 'self' | 'supervisor' | null;
  confirmation_note?: string | null;
  verified_by_test?: boolean | null;
  root_cause_text?: string | null;
  effective_action_id?: ObjectId | null;
  resolved_at?: Date | null;
  ai_suggestions: AiSuggestion[];
  conversation_ids: ObjectId[];
  related_incident_ids: ObjectId[];
  tags: string[];
  /** Phase 4+. Declared so the reconciler has a field to drive. */
  vector_indexed: boolean;
  revisions: IncidentRevision[];
}

// ---------------------------------------------------------------------------
// incident_actions  (append-only record of what a HUMAN did)
// ---------------------------------------------------------------------------

export interface PartReplaced {
  part_number: string;
  name?: string | null;
  quantity?: number | null;
  serial?: string | null;
}

export interface IncidentActionDoc extends BaseDoc {
  _id: ObjectId;
  incident_id: ObjectId;
  /** Denormalised for machine-level queries. Safe: the link is immutable. */
  machine_id?: ObjectId | null;
  sequence: number;
  action_text: string;
  action_type?: ActionType | null;
  parts_replaced: PartReplaced[];
  tools_used: string[];
  outcome: ActionOutcome;
  outcome_note?: string | null;
  duration_minutes?: number | null;
  performed_by: ObjectId;
  performed_at: Date;
  followed_ai_suggestion?: boolean | null;
  deviation_reason?: string | null;
  /** Constant `technician_action`, so it can never be confused with AI content. */
  source_type: 'technician_action';
  edited: boolean;
  edit_history: { at: Date; by: ObjectId; previous_text: string }[];
}

// ---------------------------------------------------------------------------
// maintenance_records
// ---------------------------------------------------------------------------

export interface MaintenanceMeasurement {
  name: string;
  value: number;
  unit?: string | null;
  in_spec?: boolean | null;
}

export interface MaintenanceRecordDoc extends BaseDoc, SoftDeletable, Attributed {
  _id: ObjectId;
  machine_id: ObjectId;
  machine_model_id: ObjectId;
  maintenance_type: MaintenanceType;
  title: string;
  description?: string | null;
  performed_at: Date;
  performed_by?: ObjectId | null;
  performed_by_external?: string | null;
  work_order_ref?: string | null;
  parts_replaced: PartReplaced[];
  components_serviced: string[];
  measurements: MaintenanceMeasurement[];
  duration_minutes?: number | null;
  downtime_minutes?: number | null;
  next_due_at?: Date | null;
  related_incident_id?: ObjectId | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// audit_logs  (append-only)
// ---------------------------------------------------------------------------

export interface AuditLogDoc {
  _id: ObjectId;
  at: Date;
  actor_id?: ObjectId | null;
  /** Snapshot: roles change, the log must not. */
  actor_role?: string | null;
  actor_username?: string | null;
  /** Dotted, e.g. `incident.resolution_confirmed`. */
  action: string;
  entity_type?: string | null;
  entity_id?: ObjectId | null;
  outcome: 'success' | 'failure' | 'denied';
  severity: 'info' | 'notice' | 'warning' | 'security';
  request_id?: string | null;
  /** Allowlisted fields only, values truncated. Never a blanket diff. */
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Collection registry
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  users: 'users',
  machineModels: 'machine_models',
  machines: 'machines',
  manuals: 'manuals',
  manualProcessingJobs: 'manual_processing_jobs',
  manualPages: 'manual_pages',
  manualChunks: 'manual_chunks',
  conversations: 'conversations',
  messages: 'messages',
  incidents: 'incidents',
  incidentActions: 'incident_actions',
  maintenanceRecords: 'maintenance_records',
  auditLogs: 'audit_logs',
} as const;

export const collections = {
  users: (db: Db): Collection<UserDoc> => db.collection<UserDoc>(COLLECTIONS.users),
  machineModels: (db: Db): Collection<MachineModelDoc> =>
    db.collection<MachineModelDoc>(COLLECTIONS.machineModels),
  machines: (db: Db): Collection<MachineDoc> => db.collection<MachineDoc>(COLLECTIONS.machines),
  manuals: (db: Db): Collection<ManualDoc> => db.collection<ManualDoc>(COLLECTIONS.manuals),
  manualProcessingJobs: (db: Db): Collection<ManualProcessingJobDoc> =>
    db.collection<ManualProcessingJobDoc>(COLLECTIONS.manualProcessingJobs),
  manualPages: (db: Db): Collection<ManualPageDoc> =>
    db.collection<ManualPageDoc>(COLLECTIONS.manualPages),
  manualChunks: (db: Db): Collection<ManualChunkDoc> =>
    db.collection<ManualChunkDoc>(COLLECTIONS.manualChunks),
  conversations: (db: Db): Collection<ConversationDoc> =>
    db.collection<ConversationDoc>(COLLECTIONS.conversations),
  messages: (db: Db): Collection<MessageDoc> => db.collection<MessageDoc>(COLLECTIONS.messages),
  incidents: (db: Db): Collection<IncidentDoc> => db.collection<IncidentDoc>(COLLECTIONS.incidents),
  incidentActions: (db: Db): Collection<IncidentActionDoc> =>
    db.collection<IncidentActionDoc>(COLLECTIONS.incidentActions),
  maintenanceRecords: (db: Db): Collection<MaintenanceRecordDoc> =>
    db.collection<MaintenanceRecordDoc>(COLLECTIONS.maintenanceRecords),
  auditLogs: (db: Db): Collection<AuditLogDoc> => db.collection<AuditLogDoc>(COLLECTIONS.auditLogs),
};

/** Never returns `password_hash`, `refresh_tokens`, or lockout internals. */
export const USER_PUBLIC_PROJECTION = {
  password_hash: 0,
  refresh_tokens: 0,
  failed_login_count: 0,
  locked_until: 0,
} as const;
