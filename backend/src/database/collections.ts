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
  ActionResultStatus,
  ConversationStatus,
  Criticality,
  DocumentType,
  FixStatus,
  IncidentActionSourceType,
  IncidentEmbeddingStatus,
  IncidentSource,
  IncidentStatus,
  IssueStatus,
  JobStatus,
  JobType,
  MachineStatus,
  MachineType,
  MaintenanceType,
  ManualScope,
  MessageRole,
  MessageStatus,
  MessageType,
  Priority,
  ProcessingStatus,
  RootCauseStatus,
  Severity,
  SuggestedActionStatus,
  TechnicianActionStatus,
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
  /** Org is derived at creation; legacy rows without it resolve to the default org. */
  organization_id?: ObjectId | null;
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
  organization_id?: ObjectId | null;
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
  organization_id?: ObjectId | null;
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
  organization_id?: ObjectId | null;
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
// conversations / messages / conversation_actions  (Phase 5 chat)
// ---------------------------------------------------------------------------

export interface ConversationSnapshot {
  manufacturer?: string | null;
  model_name?: string | null;
  machine_type?: string | null;
  asset_tag?: string | null;
  display_name?: string | null;
}

export interface ManualSnapshot {
  title?: string | null;
  document_version?: string | null;
}

export interface IssueStatusChange {
  from: IssueStatus;
  to: IssueStatus;
  changed_by: ObjectId;
  confirmation_note: string | null;
  at: Date;
}

export interface ConversationDoc extends BaseDoc, SoftDeletable {
  _id: ObjectId;
  user_id: ObjectId;
  created_by: ObjectId;
  title?: string | null;
  machine_id?: ObjectId | null;
  machine_model_id?: ObjectId | null;
  manual_id?: ObjectId | null;
  manual_version?: string | null;
  scope_source?: string | null;
  machine_snapshot?: ConversationSnapshot | null;
  model_snapshot?: ConversationSnapshot | null;
  manual_snapshot?: ManualSnapshot | null;
  status: ConversationStatus;
  issue_status: IssueStatus;
  issue_summary?: string | null;
  error_codes: string[];
  symptoms: string[];
  operating_conditions: string[];
  attempted_actions: string[];
  confirmed_findings: string[];
  turn_count: number;
  message_count: number;
  last_message_at?: Date | null;
  started_at: Date;
  closed_at?: Date | null;
  closed_by?: ObjectId | null;
  archived_at?: Date | null;
  archived_by?: ObjectId | null;
  reopened_at?: Date | null;
  reopened_by?: ObjectId | null;
  issue_status_history: IssueStatusChange[];
  incident_ids: ObjectId[];
}

export interface MessageSource {
  source_id: string;
  chunk_id: string;
  manual_id: string;
  manual_title: string;
  manual_version: string | null;
  page_start: number;
  page_end: number;
  section_title: string | null;
  machine_model_id: string | null;
  excerpt?: string | null;
}

export interface SuggestedAction {
  id: string;
  description: string;
  source_ids: string[];
  status: SuggestedActionStatus;
}

export interface MessageDoc extends BaseDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  role: MessageRole;
  message_type: MessageType;
  sequence: number;
  content_text?: string | null;
  original_query?: string | null;
  normalized_query?: string | null;
  status: MessageStatus;
  sources: MessageSource[];
  retrieval_metadata?: Record<string, unknown> | null;
  machine_context?: Record<string, unknown> | null;
  suggested_actions: SuggestedAction[];
  clarification?: string | null;
  refusal_reason?: string | null;
  /**
   * The validated structured response. Stored ALONGSIDE `content_text`, never
   * instead of it - the structured form drives the UI, the text form stays
   * readable when the schema changes.
   */
  structured_response?: Record<string, unknown> | null;
  answer_status?: string | null;
  confidence?: string | null;
  created_by?: ObjectId | null;
  idempotency_key?: string | null;
  content_fingerprint?: string | null;
}

export interface ConversationActionDoc extends BaseDoc {
  _id: ObjectId;
  conversation_id: ObjectId;
  created_by: ObjectId;
  action: string;
  result?: string | null;
  status: TechnicianActionStatus;
  performed_at: Date;
  notes?: string | null;
  source_message_id?: ObjectId | null;
}

// ---------------------------------------------------------------------------
// organizations  (single-tenant today, but incidents are org-scoped so a
// future multi-tenant deployment does not require a data migration)
// ---------------------------------------------------------------------------

export interface OrganizationDoc extends BaseDoc {
  _id: ObjectId;
  name: string;
  slug: string;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// incidents
// ---------------------------------------------------------------------------

export interface IncidentTimelineEvent {
  _id: ObjectId;
  sequence: number;
  /** Stable event type code, e.g. `status_changed`, `action_recorded`. */
  type: string;
  at: Date;
  actor_id?: ObjectId | null;
  actor_username?: string | null;
  previous?: unknown;
  next?: unknown;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RootCauseHistoryEntry {
  at: Date;
  by: ObjectId;
  by_username?: string | null;
  from: RootCauseStatus;
  to: RootCauseStatus;
  note: string | null;
  text?: string | null;
}

/**
 * Root cause state. `confirmed` is reachable ONLY through the explicit
 * confirm endpoint; `rejected` only through the reject endpoint. AI output can
 * at most populate `suspected` via a conversation import, and even that is a
 * technician act (PATCH root-cause).
 */
export interface IncidentRootCause {
  text: string | null;
  status: RootCauseStatus;
  confirmation_note?: string | null;
  confirmed_by?: ObjectId | null;
  confirmed_at?: Date | null;
  rejected_by?: ObjectId | null;
  rejected_at?: Date | null;
  rejection_reason?: string | null;
  history: RootCauseHistoryEntry[];
}

export interface FixHistoryEntry {
  at: Date;
  by: ObjectId;
  by_username?: string | null;
  from: FixStatus | 'not_recorded';
  to: FixStatus;
  note: string | null;
}

/** A temporary or permanent fix. `confirmed` is a separate explicit act. */
export interface IncidentFix {
  description: string;
  result?: string | null;
  status: FixStatus;
  recorded_by: ObjectId;
  recorded_at: Date;
  confirmed_by?: ObjectId | null;
  confirmed_at?: Date | null;
  notes?: string | null;
  history: FixHistoryEntry[];
}

/** Metadata only - attachment bytes live on the local filesystem. */
export interface IncidentAttachmentMeta {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: ObjectId;
  uploaded_at: Date;
}

export interface IncidentDoc extends BaseDoc, SoftDeletable, Attributed {
  _id: ObjectId;
  incident_number: string;
  organization_id: ObjectId;
  title: string;
  description: string;
  source: IncidentSource;
  machine_id: ObjectId;
  machine_model_id: ObjectId;
  conversation_id?: ObjectId | null;
  manual_id?: ObjectId | null;
  manual_version?: string | null;
  reported_by: ObjectId;
  assigned_to?: ObjectId | null;
  severity: Severity;
  priority: Priority;
  status: IncidentStatus;
  issue_status: IssueStatus;
  symptoms: string[];
  /** Normalised (`E041` form) error codes; raw display text is kept in symptoms/description. */
  error_codes: string[];
  operating_conditions: string[];
  first_observed_at: Date;
  last_observed_at?: Date | null;
  root_cause: IncidentRootCause;
  temporary_fix?: IncidentFix | null;
  permanent_fix?: IncidentFix | null;
  resolution_summary?: string | null;
  resolved_by?: ObjectId | null;
  resolved_at?: Date | null;
  closed_by?: ObjectId | null;
  closed_at?: Date | null;
  reopened_by?: ObjectId | null;
  reopened_at?: Date | null;
  tags: string[];
  attachments: IncidentAttachmentMeta[];
  /** Server-built free text backing the structured search. */
  search_text: string;
  /** Mongo is authoritative for indexing state; Qdrant is a derived index. */
  embedding_status: IncidentEmbeddingStatus;
  qdrant_point_id?: string | null;
  embedding_error?: string | null;
  embedding_updated_at?: Date | null;
  /** Append-only chronological record. Historical events are never overwritten. */
  timeline: IncidentTimelineEvent[];
}

// ---------------------------------------------------------------------------
// incident_actions  (technician work AND AI suggestions, never conflated)
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
  /** Denormalised for org-scoped queries. Immutable once set. */
  organization_id: ObjectId;
  /**
   * `technician` = a human did it; `assistant_suggestion` = the AI suggested
   * it (NOT an action, and can never become confirmed); `manual` = copied
   * from a manual; `other`.
   */
  action_type: IncidentActionSourceType;
  description: string;
  performed_by?: ObjectId | null;
  source_message_id?: ObjectId | null;
  source_suggestion_id?: string | null;
  source_manual_id?: ObjectId | null;
  source_manual_version?: string | null;
  result?: string | null;
  result_status: ActionResultStatus;
  /** Only an explicit human confirmation sets this. AI can never confirm. */
  confirmed: boolean;
  confirmed_by?: ObjectId | null;
  confirmed_at?: Date | null;
  notes?: string | null;
  performed_at: Date;
  edited: boolean;
  edit_history: { at: Date; by: ObjectId; previous_description: string }[];
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
  organization_id: ObjectId;
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
  organizations: 'organizations',
  users: 'users',
  machineModels: 'machine_models',
  machines: 'machines',
  manuals: 'manuals',
  manualProcessingJobs: 'manual_processing_jobs',
  manualPages: 'manual_pages',
  manualChunks: 'manual_chunks',
  conversations: 'conversations',
  messages: 'messages',
  conversationActions: 'conversation_actions',
  incidents: 'incidents',
  incidentActions: 'incident_actions',
  maintenanceRecords: 'maintenance_records',
  auditLogs: 'audit_logs',
} as const;

export const collections = {
  organizations: (db: Db): Collection<OrganizationDoc> =>
    db.collection<OrganizationDoc>(COLLECTIONS.organizations),
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
  conversationActions: (db: Db): Collection<ConversationActionDoc> =>
    db.collection<ConversationActionDoc>(COLLECTIONS.conversationActions),
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
