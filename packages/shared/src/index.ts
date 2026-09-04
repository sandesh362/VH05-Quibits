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
  incidentMemory: boolean;
  maintenanceHistory: boolean;
}

/** Phase 1: nothing is implemented yet. Flipped on as phases land. */
export const PHASE_1_FEATURES: SystemFeatureFlags = {
  authentication: false,
  manualUpload: false,
  documentProcessing: false,
  ocr: false,
  embeddings: false,
  vectorSearch: false,
  ragAnswers: false,
  incidentMemory: false,
  maintenanceHistory: false,
};

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
