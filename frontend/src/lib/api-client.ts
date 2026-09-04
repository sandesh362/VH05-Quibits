/**
 * Centralised API client.
 *
 * Every network call in the app goes through here. Rules:
 *  - Only relative URLs. The browser never addresses FastAPI, Qdrant, Mongo or Ollama.
 *  - Always unwraps the shared envelope and normalises failures into ApiClientError.
 *  - Auth tokens are attached by the registered token getter (see lib/auth.tsx).
 *  - JSON via `request`/`dataOf`; multipart upload (manual PDF) via `uploadMultipart`
 *    with progress reporting, because `fetch` cannot report upload progress.
 *
 * Phase 9: full coverage of the Express API surface. The browser never invents
 * endpoints; every method here maps to a route in backend/src/modules.
 */
import {
  isApiFailure,
  type ApiErrorCode,
  type ApiResponse,
  type Criticality,
  type DocumentType,
  type HealthResponse,
  type MachineStatus,
  type MachineType,
  type MaintenanceType,
  type PaginationMeta,
  type ProcessingStatus,
  type PublicUser,
  type ReadinessResponse,
  type SystemInfoResponse,
  type UserRole,
} from '@itp/shared';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const RAG_TIMEOUT_MS = 130_000;

export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'TIMEOUT' | 'MALFORMED_RESPONSE',
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly details?: Array<{ field: string; issue: string }>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  get isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT' ||
      this.code === 'SERVICE_UNAVAILABLE' ||
      this.code === 'DEPENDENCY_UNAVAILABLE' ||
      (this.status !== undefined && this.status >= 500)
    );
  }

  /** Field-level issue for a form field, if the server returned one. */
  fieldError(field: string): string | undefined {
    return this.details?.find((d) => d.field === field || d.field.endsWith(`.${field}`))?.issue;
  }
}

type TokenGetter = () => string | null;
let tokenGetter: TokenGetter = () => null;

export function setAuthTokenGetter(getter: TokenGetter): void {
  tokenGetter = getter;
}

/**
 * Called whenever a request fails with 401 UNAUTHENTICATED. The auth provider
 * registers a handler that clears the stale session and routes to /login.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface EnvelopeMeta {
  requestId: string;
  timestamp: string;
  pagination?: PaginationMeta;
}

export interface ApiResult<T> {
  data: T;
  meta?: EnvelopeMeta;
  status: number;
}

async function request<T>(
  path: string,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body, headers }: RequestOptions = {},
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  const token = tokenGetter();
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiClientError('TIMEOUT', `Request timed out after ${timeoutMs / 1000}s.`);
    }
    throw new ApiClientError('NETWORK_ERROR', 'Cannot reach the API. Is the backend running?');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let parsed: ApiResponse<T> & { meta?: EnvelopeMeta };
  try {
    parsed = (await response.json()) as ApiResponse<T> & { meta?: EnvelopeMeta };
  } catch {
    throw new ApiClientError(
      'MALFORMED_RESPONSE',
      `The API returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (isApiFailure(parsed)) {
    const error = new ApiClientError(
      parsed.error.code,
      parsed.error.message,
      response.status,
      parsed.error.requestId,
      parsed.error.details,
    );
    if (response.status === 401) unauthorizedHandler?.();
    throw error;
  }

  if (parsed?.success !== true || parsed.data === undefined) {
    throw new ApiClientError(
      'MALFORMED_RESPONSE',
      'The API response did not match the expected format.',
      response.status,
    );
  }

  return { data: parsed.data, meta: parsed.meta, status: response.status };
}

async function dataOf<T>(path: string, options?: RequestOptions): Promise<T> {
  const result = await request<T>(path, options);
  return result.data;
}

/** Encode a query object, skipping empty/nullish values. */
export function toQueryString(query: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Multipart upload with progress (manual PDF). Uses XHR because fetch cannot
 * report upload progress. Timeout is generous: PDFs are processed AFTER
 * upload, but large files still take time to transfer on a local network.
 */
export interface UploadOptions {
  path: string;
  form: FormData;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  timeoutMs?: number;
}

export async function uploadMultipart<T>({
  path,
  form,
  signal,
  onProgress,
  timeoutMs = 120_000,
}: UploadOptions): Promise<ApiResult<T>> {
  const token = tokenGetter();
  return new Promise<ApiResult<T>>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}${path}`);
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.timeout = timeoutMs;
    xhr.responseType = 'json';

    const timer = setTimeout(() => {
      xhr.abort();
      reject(new ApiClientError('TIMEOUT', `Upload timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    const abortHandler = () => xhr.abort();
    signal?.addEventListener('abort', abortHandler);

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      const parsed = xhr.response as ApiResponse<T> & { meta?: EnvelopeMeta };
      if (!parsed || typeof parsed !== 'object') {
        reject(
          new ApiClientError(
            'MALFORMED_RESPONSE',
            `The API returned a non-JSON response (HTTP ${xhr.status}).`,
            xhr.status,
          ),
        );
        return;
      }
      if (isApiFailure(parsed)) {
        const error = new ApiClientError(
          parsed.error.code,
          parsed.error.message,
          xhr.status,
          parsed.error.requestId,
          parsed.error.details,
        );
        if (xhr.status === 401) unauthorizedHandler?.();
        reject(error);
        return;
      }
      resolve({ data: parsed.data, meta: parsed.meta, status: xhr.status });
    };

    xhr.onerror = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      reject(new ApiClientError('NETWORK_ERROR', 'Cannot reach the API. Is the backend running?'));
    };
    xhr.ontimeout = () => {
      clearTimeout(timer);
      reject(new ApiClientError('TIMEOUT', `Upload timed out after ${timeoutMs / 1000}s.`));
    };
    xhr.onabort = () => {
      clearTimeout(timer);
      if (!signal?.aborted) {
        reject(new ApiClientError('TIMEOUT', 'Upload was aborted.'));
      }
    };

    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Domain types (mirror the Express `*View` shapes; @itp/shared enums for values)
// ---------------------------------------------------------------------------

export interface ConversationSummary {
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
  status: string;
  issueStatus: string;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  incidentIds: string[];
  lastMessageAt: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageSource {
  sourceId: string;
  chunkId: string;
  manualId: string;
  manualTitle: string;
  manualVersion: string | null;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  excerpt: string | null;
  sourceType?: 'manual' | 'incident' | 'maintenance';
  incidentNumber?: string | null;
  maintenanceId?: string | null;
  daysBeforeIncident?: number | null;
  correlationStrength?: 'strong' | 'moderate' | 'weak' | null;
  causalClaim?: boolean;
  notedByManual?: boolean;
  notedByManualSourceId?: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: string;
  messageType: string;
  content: string;
  status: string;
  sources: MessageSource[];
  suggestedActions: Array<{ id: string; description: string; sourceIds: string[]; status: string }>;
  clarification: string | null;
  refusalReason: string | null;
  ragStatus: string | null;
  confidence: string | null;
  retrievalMetadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ManualChunk {
  id: string;
  manualId: string;
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
  indexingStatus: string;
}

export interface ManualPageRecord {
  id: string;
  manualId: string;
  pageNumber: number;
  width: number | null;
  height: number | null;
  ocrApplied: boolean;
  ocrConfidence: number | null;
  charCount: number | null;
}

export interface ProcessingJob {
  id: string;
  manualId: string;
  jobType: string;
  status: string;
  currentStage: string | null;
  stages: Array<{ name: string; status: string; progress: number | null; warnings: string[] }>;
  progressPercent: number;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  totalPages: number | null;
  processedPages: number;
  totalChunks: number | null;
  processedChunks: number;
  extractionMethod: string | null;
  ocrUsed: boolean;
  embeddingModel: string | null;
  machineModelId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MaintenanceRecord {
  id: string;
  machineId: string;
  machineModelId: string;
  machineLabel?: string | null;
  machineModelLabel?: string | null;
  maintenanceType: MaintenanceType | string;
  title: string;
  description: string | null;
  performedAt: string;
  performedBy: string | null;
  performedByName?: string | null;
  performedByExternal: string | null;
  workOrderRef: string | null;
  partsReplaced: Array<{ partNumber: string; name: string | null; quantity: number }>;
  componentsServiced: string[];
  measurements: Array<{ name: string; value: number; unit: string | null; inSpec: boolean | null }>;
  durationMinutes: number | null;
  downtimeMinutes: number | null;
  nextDueAt: string | null;
  relatedIncidentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MachineTimelineEvent {
  id: string;
  kind: 'maintenance' | 'incident';
  at: string;
  title: string;
  actorId: string | null;
  actorUsername: string | null;
  maintenanceType?: string | null;
  partsReplaced?: Array<{ partNumber: string; name: string | null }>;
  incidentId?: string | null;
  incidentNumber?: string | null;
  eventType?: string | null;
  previous?: unknown;
  next?: unknown;
  note?: string | null;
}

export interface TechnicianActionRecord {
  id: string;
  conversationId: string;
  createdBy: string;
  action: string;
  result: string | null;
  status: string;
  performedAt: string;
  notes: string | null;
  sourceMessageId: string | null;
  createdAt: string;
}

export interface MachineRecord {
  id: string;
  assetTag: string;
  machineModelId: string;
  modelSnapshot: { manufacturer: string; modelName: string; machineType: string } | null;
  displayName: string | null;
  serialNumber: string | null;
  location: { site?: string; area?: string; line?: string; position?: string } | null;
  status: MachineStatus | string;
  installedAt: string | null;
  commissionedAt: string | null;
  criticality: Criticality | string | null;
  notes: string | null;
  lastMaintenanceAt: string | null;
  openIncidentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MachineModelRecord {
  id: string;
  manufacturer: string;
  modelName: string;
  machineType: MachineType | string;
  aliases: string[];
  modelYear: number | null;
  specifications: Record<string, unknown> | null;
  defaultLanguage: string;
  notes: string | null;
  machineCount: number;
  manualCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManualRecord {
  id: string;
  title: string;
  description: string | null;
  manufacturer: string | null;
  scope: 'model' | 'machine' | string;
  machineModelId: string | null;
  machineId: string | null;
  machineModelLabel?: string | null;
  documentType: DocumentType | string;
  documentNumber: string | null;
  documentVersion: string | null;
  revision: string | null;
  isCurrentVersion: boolean;
  isActive: boolean;
  language: string;
  originalFilename: string;
  fileSizeBytes: number;
  sha256: string;
  mimeType: string;
  pageCount: number | null;
  processingStatus: ProcessingStatus | string;
  processingVersion: string | null;
  extractionMethod: string | null;
  ocrUsed: boolean;
  indexedChunkCount: number;
  indexedAt: string | null;
  processedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  isSearchable: boolean;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManualProcessingStatus {
  processingStatus: string;
  isSearchable: boolean;
  pageCount: number | null;
  indexedChunkCount: number;
  extractionMethod: string | null;
  ocrUsed: boolean;
  failureReason: string | null;
  latestJob: ProcessingJob | null;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: UserRole | string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Incidents (Phase 6)
// ---------------------------------------------------------------------------

export interface IncidentRecord {
  id: string;
  incidentNumber: string;
  organizationId: string;
  title: string;
  description: string;
  source: string;
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
  severity: string;
  priority: string;
  status: string;
  issueStatus: string;
  symptoms: string[];
  errorCodes: string[];
  operatingConditions: string[];
  firstObservedAt: string;
  lastObservedAt: string | null;
  rootCause: {
    text: string | null;
    status: string;
    confirmationNote: string | null;
    confirmedBy: string | null;
    confirmedAt: string | null;
    rejectedBy: string | null;
    rejectedAt: string | null;
    rejectionReason: string | null;
  };
  temporaryFix: {
    description: string;
    result: string | null;
    status: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
    notes: string | null;
    recordedBy: string;
    recordedAt: string;
  } | null;
  permanentFix: {
    description: string;
    result: string | null;
    status: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
    notes: string | null;
    recordedBy: string;
    recordedAt: string;
  } | null;
  resolutionSummary: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
  tags: string[];
  attachments: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number; uploadedBy: string; uploadedAt: string }>;
  embeddingStatus: string;
  embeddingError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentActionRecord {
  id: string;
  incidentId: string;
  organizationId: string;
  actionType: string;
  description: string;
  performedBy: string | null;
  sourceMessageId: string | null;
  sourceSuggestionId: string | null;
  sourceManualId: string | null;
  sourceManualVersion: string | null;
  result: string | null;
  resultStatus: string;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notes: string | null;
  performedAt: string;
  createdAt: string;
}

export interface SimilarIncidentRecord {
  incidentId: string;
  incidentNumber: string;
  title: string;
  machineId: string | null;
  machineModelId: string;
  status: string;
  issueStatus: string;
  severity: string;
  errorCodes: string[];
  symptoms: string[];
  rootCauseStatus: string;
  confirmedRootCause: string | null;
  confirmedFix: string | null;
  resolutionSummary: string | null;
  resolvedAt: string | null;
  createdAt: string;
  similarityScore: number;
  similarityReasons: string[];
  confirmed: boolean;
}

export interface IncidentTimelineEventRecord {
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

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const apiClient = {
  // --- Health / system ------------------------------------------------------
  getHealth: (options?: RequestOptions) => dataOf<HealthResponse>('/health', options),
  getReadiness: (options?: RequestOptions) =>
    dataOf<ReadinessResponse>('/ready', { timeoutMs: 20_000, ...options }),
  getSystemInfo: (options?: RequestOptions) => dataOf<SystemInfoResponse>('/system/info', options),

  // --- Auth / users ---------------------------------------------------------
  login: (email: string, password: string) =>
    dataOf<{ accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }>(
      '/auth/login',
      { method: 'POST', body: { email, password } },
    ),
  me: () => dataOf<{ user: PublicUser }>('/auth/me'),
  refresh: (refreshToken: string) =>
    dataOf<{ accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }>(
      '/auth/refresh',
      { method: 'POST', body: { refreshToken } },
    ),
  logout: (refreshToken?: string) =>
    dataOf<{ loggedOut: boolean }>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    dataOf<{ changed: boolean }>('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
  updateMe: (body: { fullName?: string }) =>
    dataOf<{ user: PublicUser }>('/users/me', { method: 'PATCH', body }),
  listUsers: () => dataOf<{ users: UserRecord[] }>('/users'),
  registerUser: (body: {
    username: string;
    email: string;
    password: string;
    fullName: string;
    role?: UserRole;
  }) => dataOf<{ user: UserRecord }>('/auth/register', { method: 'POST', body }),

  // --- Machines -------------------------------------------------------------
  listMachines: (query: Record<string, string | number | undefined> = {}) =>
    request<MachineRecord[]>(`/machines${toQueryString({ limit: 100, ...query })}`),
  getMachine: (id: string) => dataOf<{ machine: MachineRecord }>(`/machines/${id}`),
  createMachine: (body: Record<string, unknown>) =>
    dataOf<{ machine: MachineRecord }>('/machines', { method: 'POST', body }),
  updateMachine: (id: string, body: Record<string, unknown>) =>
    dataOf<{ machine: MachineRecord }>(`/machines/${id}`, { method: 'PATCH', body }),
  deleteMachine: (id: string, reason?: string) =>
    dataOf<{ deleted: boolean }>(`/machines/${id}`, {
      method: 'DELETE',
      body: reason ? { reason } : {},
    }),
  getMachineTimeline: (machineId: string, kind: 'all' | 'maintenance' | 'incident' = 'all') =>
    dataOf<{
      machine: {
        id: string;
        assetTag: string;
        displayName: string | null;
        modelLabel: string | null;
        openIncidentCount: number;
      };
      timeline: MachineTimelineEvent[];
    }>(`/machines/${machineId}/timeline?kind=${kind}&limit=100`),

  // --- Machine models -------------------------------------------------------
  listModels: (query: Record<string, string | number | undefined> = {}) =>
    request<MachineModelRecord[]>(`/machine-models${toQueryString({ limit: 100, ...query })}`),
  getModel: (id: string) => dataOf<{ machineModel: MachineModelRecord }>(`/machine-models/${id}`),
  createModel: (body: Record<string, unknown>) =>
    dataOf<{ machineModel: MachineModelRecord }>('/machine-models', { method: 'POST', body }),
  updateModel: (id: string, body: Record<string, unknown>) =>
    dataOf<{ machineModel: MachineModelRecord }>(`/machine-models/${id}`, {
      method: 'PATCH',
      body,
    }),
  deleteModel: (id: string, reason?: string) =>
    dataOf<{ deleted: boolean }>(`/machine-models/${id}`, {
      method: 'DELETE',
      body: reason ? { reason } : {},
    }),

  // --- Manuals --------------------------------------------------------------
  listManuals: (query: Record<string, string | number | undefined> = {}) =>
    request<ManualRecord[]>(`/manuals${toQueryString({ limit: 100, ...query })}`),
  getManual: (id: string) => dataOf<{ manual: ManualRecord }>(`/manuals/${id}`),
  uploadManual: (form: FormData, onProgress?: (percent: number) => void, signal?: AbortSignal) =>
    uploadMultipart<{ manual: ManualRecord; processingJob: { id: string; status: string } }>({
      path: '/manuals',
      form,
      onProgress,
      signal,
    }),
  updateManual: (id: string, body: Record<string, unknown>) =>
    dataOf<{ manual: ManualRecord }>(`/manuals/${id}`, { method: 'PATCH', body }),
  deleteManual: (id: string, reason?: string) =>
    dataOf<{ deleted: boolean }>(`/manuals/${id}`, {
      method: 'DELETE',
      body: reason ? { reason } : {},
    }),
  reprocessManual: (id: string, reason?: string) =>
    dataOf<{ processingJob: { id: string; status: string } }>(`/manuals/${id}/reprocess`, {
      method: 'POST',
      body: reason ? { reason } : {},
    }),
  getManualChunk: (manualId: string, chunkId: string) =>
    dataOf<{ chunk: ManualChunk }>(`/manuals/${manualId}/chunks/${chunkId}`),
  getManualProcessingStatus: (id: string) =>
    dataOf<ManualProcessingStatus>(`/manuals/${id}/processing-status`),
  listManualPages: (id: string) => request<ManualPageRecord[]>(`/manuals/${id}/pages?limit=1000`),
  listManualChunks: (id: string, query: Record<string, string | number | undefined> = {}) =>
    request<ManualChunk[]>(`/manuals/${id}/chunks${toQueryString({ limit: 50, ...query })}`),

  // --- Processing jobs ------------------------------------------------------
  listProcessingJobs: (query: Record<string, string | number | undefined> = {}) =>
    request<ProcessingJob[]>(`/manual-processing-jobs${toQueryString({ limit: 50, ...query })}`),
  retryProcessingJob: (jobId: string) =>
    dataOf<{ jobId: string }>(`/manual-processing-jobs/${jobId}/retry`, {
      method: 'POST',
      body: {},
    }),

  // --- Maintenance ----------------------------------------------------------
  listMaintenance: (query: Record<string, string | number | undefined> = {}) =>
    request<MaintenanceRecord[]>(`/maintenance${toQueryString(query)}`),
  getMaintenance: (id: string) =>
    dataOf<{ maintenanceRecord: MaintenanceRecord }>(`/maintenance/${id}`),
  createMaintenance: (body: Record<string, unknown>) =>
    dataOf<{ maintenanceRecord: MaintenanceRecord }>('/maintenance', { method: 'POST', body }),
  updateMaintenance: (id: string, body: Record<string, unknown>) =>
    dataOf<{ maintenanceRecord: MaintenanceRecord }>(`/maintenance/${id}`, {
      method: 'PATCH',
      body,
    }),

  // --- Conversations --------------------------------------------------------
  listConversations: (query: Record<string, string | number | undefined> | string = {}) =>
    request<ConversationSummary[]>(
      typeof query === 'string'
        ? `/conversations${query ? `?${query}` : ''}`
        : `/conversations${toQueryString({ limit: 100, ...query })}`,
    ),
  getConversation: (id: string) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}`),
  createConversation: (body: Record<string, unknown>) =>
    dataOf<{ conversation: ConversationSummary }>('/conversations', { method: 'POST', body }),
  updateConversation: (id: string, body: Record<string, unknown>) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}`, {
      method: 'PATCH',
      body,
    }),
  deleteConversation: (id: string) =>
    dataOf<{ deleted: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),
  listMessages: (id: string) => request<MessageRecord[]>(`/conversations/${id}/messages?limit=100`),
  sendMessage: (id: string, content: string, clientRequestId: string) =>
    dataOf<{
      message: MessageRecord;
      userMessage: MessageRecord;
      rag: {
        status: string;
        confidence: string | null;
        evidenceSufficient: boolean;
        sources: MessageRecord['sources'];
        warnings: string[];
        clarification: string | null;
        refusalReason: string | null;
      };
      conversation: { id: string; issueStatus: string; status: string; messageCount: number };
    }>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: { content, clientRequestId },
      timeoutMs: RAG_TIMEOUT_MS,
      headers: { 'Idempotency-Key': clientRequestId },
    }),
  listActions: (id: string) =>
    request<TechnicianActionRecord[]>(`/conversations/${id}/actions?limit=100`),
  recordAction: (id: string, body: Record<string, unknown>) =>
    dataOf<{ action: TechnicianActionRecord }>(`/conversations/${id}/actions`, {
      method: 'POST',
      body,
    }),
  updateIssueStatus: (id: string, body: Record<string, unknown>) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}/issue-status`, {
      method: 'PATCH',
      body,
    }),
  closeConversation: (id: string, confirmationNote?: string) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}/close`, {
      method: 'POST',
      body: confirmationNote ? { confirmationNote } : {},
    }),
  reopenConversation: (id: string, note?: string) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}/reopen`, {
      method: 'POST',
      body: note ? { note } : {},
    }),
  archiveConversation: (id: string) =>
    dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}/archive`, {
      method: 'POST',
      body: {},
    }),
  createIncidentFromConversation: (conversationId: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord; importedActions: number }>(
      `/conversations/${conversationId}/create-incident`,
      { method: 'POST', body },
    ),

  // --- Incidents ------------------------------------------------------------
  listIncidents: (query: Record<string, string | number | undefined> = {}) =>
    request<IncidentRecord[]>(`/incidents${toQueryString(query)}`),
  getIncident: (id: string) => dataOf<{ incident: IncidentRecord }>(`/incidents/${id}`),
  createIncident: (body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord }>('/incidents', { method: 'POST', body }),
  updateIncident: (id: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}`, { method: 'PATCH', body }),
  changeIncidentStatus: (id: string, status: string, reason?: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/status`, {
      method: 'PATCH',
      body: reason ? { status, reason } : { status },
    }),
  changeIssueStatus: (id: string, issueStatus: string, note?: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/issue-status`, {
      method: 'PATCH',
      body: note ? { issueStatus, note } : { issueStatus },
    }),
  closeIncident: (id: string, resolutionSummary: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/close`, {
      method: 'POST',
      body: { resolutionSummary },
    }),
  reopenIncident: (id: string, reason: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/reopen`, {
      method: 'POST',
      body: { reason },
    }),
  deleteIncident: (id: string, reason: string) =>
    dataOf<{ incident: { id: string; incidentNumber: string; status: string } }>(
      `/incidents/${id}`,
      { method: 'DELETE', body: { reason } },
    ),
  getIncidentTimeline: (id: string) =>
    dataOf<{ timeline: IncidentTimelineEventRecord[] }>(`/incidents/${id}/timeline`),
  listIncidentActions: (id: string) =>
    request<IncidentActionRecord[]>(`/incidents/${id}/actions?limit=100`),
  recordIncidentAction: (id: string, body: Record<string, unknown>) =>
    dataOf<{ action: IncidentActionRecord }>(`/incidents/${id}/actions`, { method: 'POST', body }),
  confirmIncidentAction: (id: string, actionId: string, note: string) =>
    dataOf<{ action: IncidentActionRecord }>(`/incidents/${id}/actions/${actionId}/confirm`, {
      method: 'POST',
      body: { note },
    }),
  updateRootCause: (id: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/root-cause`, {
      method: 'PATCH',
      body,
    }),
  confirmRootCause: (id: string, note: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/root-cause/confirm`, {
      method: 'POST',
      body: { note },
    }),
  rejectRootCause: (id: string, reason: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/root-cause/reject`, {
      method: 'POST',
      body: { reason },
    }),
  getRootCauseHistory: (id: string) =>
    dataOf<{
      history: Array<{
        at: string;
        by: string;
        byUsername: string | null;
        from: string;
        to: string;
        note: string | null;
        text: string | null;
      }>;
    }>(`/incidents/${id}/root-cause/history`),
  recordTemporaryFix: (id: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/temporary-fix`, {
      method: 'POST',
      body,
    }),
  confirmTemporaryFix: (id: string, note: string, result?: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/temporary-fix/confirm`, {
      method: 'POST',
      body: result ? { note, result } : { note },
    }),
  recordPermanentFix: (id: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/permanent-fix`, {
      method: 'POST',
      body,
    }),
  confirmPermanentFix: (id: string, note: string, result?: string) =>
    dataOf<{ incident: IncidentRecord }>(`/incidents/${id}/permanent-fix/confirm`, {
      method: 'POST',
      body: result ? { note, result } : { note },
    }),
  getSimilarIncidents: (id: string) =>
    dataOf<{ similar: SimilarIncidentRecord[] }>(`/incidents/${id}/similar`),
  reindexIncident: (id: string) =>
    dataOf<{ incident: { id: string; embeddingStatus: string } }>(`/incidents/${id}/reindex`, {
      method: 'POST',
    }),
};

export { BASE_URL as apiBaseUrl };
