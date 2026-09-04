/**
 * @itp/shared - canonical API contracts shared by the Express API and the React app.
 *
 * PHASE 1 SCOPE: envelope, error codes, and health/readiness/system-info shapes only.
 * Domain contracts (RAG response, incidents, manuals) arrive in later phases.
 *
 * This package is the single source of truth for the wire format. If a shape
 * changes here, both the API and the web app fail to compile - which is the
 * entire reason it exists.
 */

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/** Every successful API response uses this envelope. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

/** Every failed API response uses this envelope. */
export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ResponseMeta {
  /** Correlation id, echoed in the X-Request-Id response header. */
  requestId: string;
  /** ISO-8601 UTC timestamp of when the response was generated. */
  timestamp: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  /** Field-level validation detail. Omitted when not applicable. */
  details?: ApiErrorDetail[];
  /** Present only when NODE_ENV !== 'production'. Never sent to prod clients. */
  stack?: string;
}

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Stable, machine-readable error codes. Clients branch on these, never on the
 * human-readable message.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'NOT_IMPLEMENTED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Default HTTP status for each error code. */
export const ERROR_STATUS_MAP: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
};

// ---------------------------------------------------------------------------
// Health / readiness
// ---------------------------------------------------------------------------

/**
 * ok       - dependency reachable and usable
 * degraded - reachable but not fully usable (e.g. Ollama up, model not pulled)
 * down     - unreachable or failing
 * disabled - intentionally not configured; excluded from the readiness verdict
 * unknown  - not probed yet
 */
export type DependencyStatus = 'ok' | 'degraded' | 'down' | 'disabled' | 'unknown';

/** Aggregate verdict for a service. */
export type ServiceStatus = 'ok' | 'degraded' | 'down';

export interface DependencyCheck {
  /** Stable identifier, e.g. "mongodb", "qdrant", "ollama", "rag-service". */
  name: string;
  status: DependencyStatus;
  /** Round-trip time of the probe in milliseconds. */
  latencyMs: number | null;
  /** Safe, human-readable detail. Never contains credentials or URIs with auth. */
  detail?: string;
  /** Sanitised error summary when status is 'down' or 'degraded'. */
  error?: string;
  /**
   * Whether this dependency is required for the service to be considered ready.
   * A non-required dependency being down yields 'degraded', not 'down'.
   */
  required: boolean;
  /** What still works when this dependency is unavailable. */
  impact?: string;
}

/** GET /api/v1/health and /internal/v1/health - process liveness only. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  /** Process uptime in seconds. */
  uptimeSeconds: number;
  timestamp: string;
}

/** GET /api/v1/ready and /internal/v1/ready - real dependency probes. */
export interface ReadinessResponse {
  status: ServiceStatus;
  service: string;
  /** True only when every `required` dependency reports 'ok'. */
  ready: boolean;
  checks: DependencyCheck[];
  /** Capabilities unavailable right now, e.g. ["rag_generation"]. */
  degradedCapabilities: string[];
  /** Total time spent probing dependencies. */
  durationMs: number;
  timestamp: string;
}

/** GET /api/v1/system/info - non-sensitive build and configuration facts. */
export interface SystemInfoResponse {
  service: string;
  version: string;
  environment: string;
  apiPrefix: string;
  nodeVersion?: string;
  pythonVersion?: string;
  platform: string;
  /** Implementation phase this build corresponds to. */
  phase: string;
  startedAt: string;
  uptimeSeconds: number;
  /**
   * Feature availability. Everything is false in Phase 1 - the UI reads this
   * instead of hardcoding assumptions about what exists.
   */
  features: SystemFeatureFlags;
  /** Names of configured dependencies. Never includes URLs, hosts or secrets. */
  configuredDependencies: string[];
}

export interface SystemFeatureFlags {
  authentication: boolean;
  manualUpload: boolean;
  documentProcessing: boolean;
  ocr: boolean;
  embeddings: boolean;
  vectorSearch: boolean;
  ragAnswers: boolean;
  incidentManagement: boolean;
  incidentMemory: boolean;
  maintenanceHistory: boolean;
}

/** Phase 1 baseline: nothing implemented. Retained for reference/tests. */
export const PHASE_1_FEATURES: SystemFeatureFlags = {
  authentication: false,
  manualUpload: false,
  documentProcessing: false,
  ocr: false,
  embeddings: false,
  vectorSearch: false,
  ragAnswers: false,
  incidentManagement: false,
  incidentMemory: false,
  maintenanceHistory: false,
};

/**
 * Phase 2: authentication and the data layer exist. Everything document- or
 * AI-related is still absent. `/system/info` reports THIS object, so the UI can
 * never claim a capability the backend does not have.
 */
export const PHASE_2_FEATURES: SystemFeatureFlags = {
  authentication: true,
  manualUpload: false,
  documentProcessing: false,
  ocr: false,
  embeddings: false,
  vectorSearch: false,
  ragAnswers: false,
  incidentManagement: false,
  incidentMemory: false,
  maintenanceHistory: false,
};

/**
 * Phase 3: manual upload, PDF processing, OCR, chunking and local embeddings
 * exist. Qdrant vectors are indexed but no search/retrieval or RAG answer
 * endpoint exists yet (that is Phase 4/5) - so `vectorSearch` and `ragAnswers`
 * stay false. `maintenanceHistory` reflects the Phase 2 data layer.
 */
export const PHASE_3_FEATURES: SystemFeatureFlags = {
  authentication: true,
  manualUpload: true,
  documentProcessing: true,
  ocr: true,
  embeddings: true,
  vectorSearch: false,
  ragAnswers: false,
  incidentManagement: false,
  incidentMemory: false,
  maintenanceHistory: true,
};

/**
 * Phase 4: retrieval (exact + semantic) and evidence-grounded RAG answers exist.
 * Incident memory and conversational multi-turn remain Phase 5+ so those flags
 * stay false. `maintenanceHistory` still reflects the Phase 2 data layer only.
 */
export const PHASE_4_FEATURES: SystemFeatureFlags = {
  authentication: true,
  manualUpload: true,
  documentProcessing: true,
  ocr: true,
  embeddings: true,
  vectorSearch: true,
  ragAnswers: true,
  incidentManagement: false,
  incidentMemory: false,
  maintenanceHistory: true,
};

/**
 * Phase 5: conversational troubleshooting on top of Phase 4 RAG.
 * Incident-memory retrieval and maintenance intelligence stay false.
 */
export const PHASE_5_FEATURES: SystemFeatureFlags = {
  authentication: true,
  manualUpload: true,
  documentProcessing: true,
  ocr: true,
  embeddings: true,
  vectorSearch: true,
  ragAnswers: true,
  incidentManagement: false,
  incidentMemory: false,
  maintenanceHistory: true,
};

/**
 * Phase 6: incident management, historical troubleshooting memory, and
 * historical incident evidence in RAG. Everything below is ON.
 */
export const PHASE_6_FEATURES: SystemFeatureFlags = {
  authentication: true,
  manualUpload: true,
  documentProcessing: true,
  ocr: true,
  embeddings: true,
  vectorSearch: true,
  ragAnswers: true,
  incidentManagement: true,
  incidentMemory: true,
  maintenanceHistory: true,
};

// ---------------------------------------------------------------------------
// Roles and authorization (Phase 2)
// ---------------------------------------------------------------------------

/** Flat RBAC, one role per user. See docs/PRODUCT_REQUIREMENTS.md 13.2. */
export const USER_ROLES = ['admin', 'manager', 'technician', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Capabilities are the unit of authorization. Routes declare a capability;
 * the policy map decides. Never scatter `if (role === 'admin')` in handlers.
 */
export const CAPABILITIES = [
  'machine_model.read', 'machine_model.create', 'machine_model.update', 'machine_model.delete',
  'machine.read', 'machine.create', 'machine.update', 'machine.delete',
  'manual.read', 'manual.create', 'manual.update', 'manual.delete', 'manual.reprocess',
  'manual_processing_job.read', 'manual_page.read', 'manual_chunk.read',
  'incident.read', 'incident.create', 'incident.update_any', 'incident.update_own',
  'incident.delete', 'incident.assign', 'incident.reopen', 'incident.close',
  'incident.root_cause_update', 'incident.root_cause_confirm', 'incident.root_cause_reject',
  'incident.fix_record', 'incident.fix_confirm',
  'incident.reindex',
  'incident_action.read', 'incident_action.create', 'incident_action.update',
  'incident_action.confirm',
  'maintenance.read', 'maintenance.create', 'maintenance.update_any', 'maintenance.update_own',
  'conversation.create', 'conversation.read_own', 'conversation.read_any', 'conversation.update_own',
  'user.read_self', 'user.update_self', 'user.read_all', 'user.create', 'user.update_role',
  'audit_log.read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Domain enums (Phase 2) - mirrored by zod validators and Mongo validators
// ---------------------------------------------------------------------------

export const MACHINE_STATUSES = ['operational', 'down', 'maintenance', 'retired'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

export const MACHINE_TYPES = [
  'cnc_lathe', 'cnc_mill', 'injection_moulder', 'hydraulic_press', 'conveyor',
  'compressor', 'robot_arm', 'packaging', 'boiler', 'pump', 'other',
] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MANUAL_SCOPES = ['model', 'machine'] as const;
export type ManualScope = (typeof MANUAL_SCOPES)[number];

export const DOCUMENT_TYPES = [
  'operation', 'maintenance', 'service', 'parts_catalog', 'electrical_schematic',
  'troubleshooting', 'safety', 'installation', 'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Set by the processing pipeline (Phase 3+), never by a metadata endpoint.
 *
 * The fine-grained `extracting_text` ... `indexing` states are reported while
 * a job is running so the UI can show the current stage. `uploaded` is the
 * state before a job is created; `completed` is the only terminal success
 * state (a manual is NOT `completed` unless extraction, OCR-if-needed,
 * cleaning, chunking, embedding AND indexing all succeeded).
 */
export const PROCESSING_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'extracting_text',
  'ocr_processing',
  'cleaning_text',
  'chunking',
  'embedding',
  'indexing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const JOB_TYPES = [
  'full_process', 'reindex_full', 'reindex_embed', 'reindex_index', 'ocr_only', 'delete_vectors',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'queued', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Phase 6 incident workflow statuses. Transitions are validated against an
 * explicit map (see docs/INCIDENT_LIFECYCLE.md) - arbitrary changes are
 * rejected by the API.
 */
export const INCIDENT_STATUSES = [
  'open', 'investigating', 'waiting_for_information', 'waiting_for_parts',
  'resolved', 'closed', 'reopened', 'cancelled',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** How an incident entered the system. */
export const INCIDENT_SOURCES = ['conversation', 'manual', 'import', 'other'] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Root cause is a confirmation axis of its own. `suspected` may be set by any
 * authorized technician (or imported from an AI suggestion); only an explicit
 * human confirmation moves it to `confirmed`, and only a human rejection moves
 * it to `rejected`.
 */
export const ROOT_CAUSE_STATUSES = ['unknown', 'suspected', 'confirmed', 'rejected'] as const;
export type RootCauseStatus = (typeof ROOT_CAUSE_STATUSES)[number];

/**
 * Where an incident action came from. `assistant_suggestion` entries are
 * suggestions, NEVER technician actions; only `technician` entries can be
 * confirmed as actual performed work.
 */
export const INCIDENT_ACTION_SOURCE_TYPES = [
  'technician', 'assistant_suggestion', 'manual', 'other',
] as const;
export type IncidentActionSourceType = (typeof INCIDENT_ACTION_SOURCE_TYPES)[number];

/**
 * Observed result of an action. Recording `successful` does NOT confirm the
 * result - confirmation is a separate explicit human act.
 */
export const ACTION_RESULT_STATUSES = [
  'not_tested', 'successful', 'unsuccessful', 'partially_successful',
  'inconclusive', 'temporary_improvement', 'worsened_condition',
] as const;
export type ActionResultStatus = (typeof ACTION_RESULT_STATUSES)[number];

/** Fix (temporary or permanent) confirmation lifecycle. */
export const FIX_STATUSES = ['recorded', 'confirmed', 'rejected'] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

/** Incident vector indexing state (Mongo authoritative over Qdrant). */
export const INCIDENT_EMBEDDING_STATUSES = [
  'not_indexed', 'pending', 'indexed', 'failed',
] as const;
export type IncidentEmbeddingStatus = (typeof INCIDENT_EMBEDDING_STATUSES)[number];

export const ACTION_OUTCOMES = ['worked', 'partial', 'no_change', 'made_worse', 'unknown'] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

export const ACTION_TYPES = [
  'inspection', 'adjustment', 'cleaning', 'part_replacement', 'reset',
  'software_change', 'calibration', 'escalation', 'other',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const MAINTENANCE_TYPES = [
  'preventive', 'corrective', 'calibration', 'inspection', 'part_replacement',
  'software_update', 'cleaning', 'lubrication', 'overhaul',
] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export const CONVERSATION_STATUSES = ['active', 'closed', 'archived'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const ISSUE_STATUSES = [
  'unknown',
  'investigating',
  'temporary_fix',
  'resolved',
  'unresolved',
  'recurring',
  'escalated',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statuses that require an explicit technician confirmation note. */
export const CONFIRMED_ISSUE_STATUSES = [
  'temporary_fix',
  'resolved',
  'unresolved',
  'recurring',
  'escalated',
] as const;

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_TYPES = [
  'question',
  'answer',
  'clarification',
  'refusal',
  'technician_note',
  'action_record',
  'system_notice',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = ['pending', 'completed', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const SUGGESTED_ACTION_STATUSES = [
  'suggested',
  'accepted',
  'attempted',
  'completed',
  'failed',
  'dismissed',
] as const;
export type SuggestedActionStatus = (typeof SUGGESTED_ACTION_STATUSES)[number];

export const TECHNICIAN_ACTION_STATUSES = [
  'planned',
  'attempted',
  'completed',
  'failed',
  'not_applicable',
] as const;
export type TechnicianActionStatus = (typeof TECHNICIAN_ACTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Pagination (Phase 2)
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Paginated list responses add `pagination` alongside `data`. */
export interface ApiPaginatedSuccess<T> extends ApiSuccess<T[]> {
  pagination: PaginationMeta;
}

export const PAGINATION_DEFAULT_PAGE = 1;
export const PAGINATION_DEFAULT_LIMIT = 20;
/** Hard ceiling: an unbounded list endpoint is a denial-of-service vector. */
export const PAGINATION_MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Auth wire shapes (Phase 2)
// ---------------------------------------------------------------------------

/** The safe user projection. `password_hash` can never appear here. */
export interface PublicUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginResponse extends AuthTokens {
  user: PublicUser;
}

// ---------------------------------------------------------------------------
// Manual processing domain (Phase 3)
// ---------------------------------------------------------------------------

/** A stage entry inside a manual processing job. */
export interface ManualProcessingStage {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string | null;
  endedAt: string | null;
  progress?: { current: number; total: number; unit: string } | null;
  warnings?: string[];
}

/** A manual processing job as returned over the API. */
export interface ManualProcessingJobView {
  id: string;
  manualId: string;
  jobType: JobType;
  status: JobStatus;
  currentStage: string | null;
  stages: ManualProcessingStage[];
  progressPercent: number;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  triggeredBy: string | null;
  machineModelId: string | null;
  totalPages: number | null;
  processedPages: number;
  totalChunks: number | null;
  processedChunks: number;
  extractionMethod: string | null;
  ocrUsed: boolean;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  retryCount: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A processed manual page (extracted text, not the raw PDF page image). */
export interface ManualPageView {
  id: string;
  manualId: string;
  pageNumber: number;
  rawText: string;
  cleanedText: string;
  characterCount: number;
  wordCount: number;
  hasText: boolean;
  extractionMethod: string;
  ocrUsed: boolean;
  ocrConfidence: number | null;
}

// ---------------------------------------------------------------------------
// Retrieval / RAG (Phase 4)
// ---------------------------------------------------------------------------

export type RagStatus =
  | 'answered'
  | 'retrieved'
  | 'clarification_required'
  | 'insufficient_evidence'
  | 'conflicting_evidence'
  | 'processing_unavailable'
  | 'generation_failed';

export type RagConfidence = 'high' | 'medium' | 'low';

export interface RagSourceView {
  sourceId: string;
  chunkId: string;
  manualId: string;
  manualTitle: string;
  manualVersion: string | null;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  machineModelId: string | null;
  /** Short excerpt of the retrieved chunk. Never a filesystem path. */
  excerpt?: string | null;
}

export interface SuggestedActionView {
  id: string;
  description: string;
  sourceIds: string[];
  status: SuggestedActionStatus;
}

export interface ConversationContextView {
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  operatingConditions: string[];
  attemptedActions: string[];
  confirmedFindings: string[];
}

export interface ConversationView {
  id: string;
  title: string | null;
  createdBy: string;
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  machineLabel: string | null;
  machineModelLabel: string | null;
  manualTitle: string | null;
  status: ConversationStatus;
  issueStatus: IssueStatus;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  lastMessageAt: string | null;
  messageCount: number;
  startedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: MessageRole;
  messageType: MessageType;
  content: string;
  originalQuery: string | null;
  normalizedQuery: string | null;
  status: MessageStatus;
  sources: RagSourceView[];
  retrievalMetadata: Record<string, unknown> | null;
  machineContext: Record<string, unknown> | null;
  suggestedActions: SuggestedActionView[];
  clarification: string | null;
  refusalReason: string | null;
  ragStatus: RagStatus | null;
  confidence: RagConfidence | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TechnicianActionView {
  id: string;
  conversationId: string;
  createdBy: string;
  action: string;
  result: string | null;
  status: TechnicianActionStatus;
  performedAt: string;
  notes: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RagAnswerView {
  status: RagStatus;
  answer: string | null;
  confidence: RagConfidence | null;
  evidenceSufficient: boolean;
  sources: RagSourceView[];
  warnings: string[];
  reason?: string;
  message?: string;
}

export interface ManualChunkView {
  id: string;
  manualId: string;
  machineModelId: string | null;
  machineId: string | null;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  sectionPath: string[] | null;
  text: string;
  normalizedText: string;
  characterCount: number;
  wordCount: number;
  contentHash: string;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  qdrantPointId: string | null;
  indexingStatus: 'pending' | 'embedded' | 'indexed';
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Incidents (Phase 6)
// ---------------------------------------------------------------------------

export interface IncidentRootCauseView {
  text: string | null;
  status: RootCauseStatus;
  confirmationNote: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface IncidentFixView {
  description: string;
  result: string | null;
  status: FixStatus;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface IncidentAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface IncidentTimelineEventView {
  id: string;
  sequence: number;
  type: string;
  at: string;
  actorId: string | null;
  actorUsername: string | null;
  previous?: unknown;
  next?: unknown;
  note: string | null;
  metadata?: Record<string, unknown>;
}

export interface IncidentView {
  id: string;
  incidentNumber: string;
  organizationId: string;
  title: string;
  description: string;
  source: IncidentSource;
  machineId: string;
  machineModelId: string;
  machineLabel?: string | null;
  machineModelLabel?: string | null;
  conversationId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  manualTitle?: string | null;
  reportedBy: string;
  reportedByName?: string | null;
  assignedTo: string | null;
  assignedToName?: string | null;
  severity: Severity;
  priority: Priority;
  status: IncidentStatus;
  issueStatus: IssueStatus;
  symptoms: string[];
  errorCodes: string[];
  operatingConditions: string[];
  firstObservedAt: string;
  lastObservedAt: string | null;
  rootCause: IncidentRootCauseView;
  temporaryFix: IncidentFixView | null;
  permanentFix: IncidentFixView | null;
  resolutionSummary: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
  tags: string[];
  attachments: IncidentAttachmentView[];
  embeddingStatus: IncidentEmbeddingStatus;
  embeddingError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentActionView {
  id: string;
  incidentId: string;
  organizationId: string;
  actionType: IncidentActionSourceType;
  description: string;
  performedBy: string | null;
  performedByName: string | null;
  sourceMessageId: string | null;
  sourceSuggestionId: string | null;
  sourceManualId: string | null;
  sourceManualVersion: string | null;
  result: string | null;
  resultStatus: ActionResultStatus;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notes: string | null;
  performedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SimilarIncidentView {
  incidentId: string;
  incidentNumber: string;
  title: string;
  machineId: string | null;
  machineModelId: string;
  status: IncidentStatus;
  issueStatus: IssueStatus;
  severity: Severity;
  errorCodes: string[];
  symptoms: string[];
  rootCauseStatus: RootCauseStatus;
  confirmedRootCause: string | null;
  confirmedFix: string | null;
  resolutionSummary: string | null;
  resolvedAt: string | null;
  createdAt: string;
  similarityScore: number;
  similarityReasons: string[];
  /** True when the incident has a confirmed root cause AND a confirmed fix. */
  confirmed: boolean;
}

export interface IncidentListQuery {
  machineId?: string;
  machineModelId?: string;
  status?: IncidentStatus;
  issueStatus?: IssueStatus;
  severity?: Severity;
  priority?: Priority;
  rootCauseStatus?: RootCauseStatus;
  errorCode?: string;
  tag?: string;
  reportedBy?: string;
  assignedTo?: string;
  source?: IncidentSource;
  createdFrom?: string;
  createdTo?: string;
  resolvedFrom?: string;
  resolvedTo?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isApiSuccess<T>(res: ApiResponse<T>): res is ApiSuccess<T> {
  return res.success === true;
}

export function isApiFailure<T>(res: ApiResponse<T>): res is ApiFailure {
  return res.success === false;
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const REQUEST_ID_HEADER = 'x-request-id';
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
