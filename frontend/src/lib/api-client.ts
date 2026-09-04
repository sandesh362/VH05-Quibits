/**
 * Centralised API client.
 *
 * Every network call in the app goes through here. Rules:
 *  - Only relative URLs. The browser never addresses FastAPI, Qdrant, Mongo or Ollama.
 *  - Always unwraps the shared envelope and normalises failures into ApiClientError.
 */
import {
  isApiFailure,
  type ApiErrorCode,
  type ApiResponse,
  type HealthResponse,
  type PaginationMeta,
  type PublicUser,
  type ReadinessResponse,
  type SystemInfoResponse,
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
}

type TokenGetter = () => string | null;
let tokenGetter: TokenGetter = () => null;

export function setAuthTokenGetter(getter: TokenGetter): void {
  tokenGetter = getter;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface EnvelopeMeta {
  requestId: string;
  timestamp: string;
  pagination?: PaginationMeta;
}

async function request<T>(
  path: string,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body, headers }: RequestOptions = {},
): Promise<{ data: T; meta?: EnvelopeMeta; status: number }> {
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
    throw new ApiClientError(
      parsed.error.code,
      parsed.error.message,
      response.status,
      parsed.error.requestId,
    );
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

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: string;
  messageType: string;
  content: string;
  status: string;
  sources: Array<{
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
  }>;
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
}

export interface MaintenanceRecord {
  id: string;
  machineId: string;
  machineModelId: string;
  maintenanceType: string;
  title: string;
  description: string | null;
  performedAt: string;
  performedBy: string | null;
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

export interface MaintenanceListQuery {
  machineId?: string;
  machineModelId?: string;
  maintenanceType?: string;
  partNumber?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
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
  displayName: string | null;
  machineModelId: string;
  modelSnapshot: { manufacturer: string; modelName: string; machineType: string } | null;
}

export interface MachineModelRecord {
  id: string;
  manufacturer: string;
  modelName: string;
  machineType: string;
}

export interface ManualRecord {
  id: string;
  title: string;
  documentVersion: string | null;
  machineModelId: string | null;
  machineId: string | null;
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

export const apiClient = {
  getHealth: (options?: RequestOptions) => dataOf<HealthResponse>('/health', options),
  getReadiness: (options?: RequestOptions) =>
    dataOf<ReadinessResponse>('/ready', { timeoutMs: 20_000, ...options }),
  getSystemInfo: (options?: RequestOptions) => dataOf<SystemInfoResponse>('/system/info', options),

  login: (email: string, password: string) =>
    dataOf<{ accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }>(
      '/auth/login',
      { method: 'POST', body: { email, password } },
    ),
  me: () => dataOf<{ user: PublicUser }>('/auth/me'),
  logout: (refreshToken?: string) =>
    dataOf<{ loggedOut: boolean }>('/auth/logout', { method: 'POST', body: { refreshToken } }),

  listMachines: () => request<MachineRecord[]>('/machines?limit=100'),

  listMaintenance: (query: MaintenanceListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.machineId) params.set('machineId', query.machineId);
    if (query.machineModelId) params.set('machineModelId', query.machineModelId);
    if (query.maintenanceType) params.set('maintenanceType', query.maintenanceType);
    if (query.partNumber) params.set('partNumber', query.partNumber);
    if (query.search) params.set('search', query.search);
    if (query.sortBy) params.set('sortBy', query.sortBy);
    if (query.sortOrder) params.set('sortOrder', query.sortOrder);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return request<MaintenanceRecord[]>(`/maintenance${qs ? `?${qs}` : ''}`);
  },

  createMaintenance: (body: Record<string, unknown>) =>
    dataOf<{ maintenanceRecord: MaintenanceRecord }>('/maintenance', { method: 'POST', body }),

  getManualChunk: (manualId: string, chunkId: string) =>
    dataOf<{ chunk: ManualChunk }>(`/manuals/${manualId}/chunks/${chunkId}`),

  listProcessingJobs: () =>
    request<ProcessingJob[]>('/manual-processing-jobs?limit=50'),

  retryProcessingJob: (jobId: string) =>
    dataOf<{ jobId: string }>(`/manual-processing-jobs/${jobId}/retry`, {
      method: 'POST',
      body: {},
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
  listModels: () => request<MachineModelRecord[]>('/machine-models?limit=100'),
  listUsers: () =>
    dataOf<{ users: Array<{ id: string; username: string; fullName: string; role: string }> }>(
      '/users',
    ),
  listManuals: (machineModelId?: string) =>
    request<ManualRecord[]>(
      `/manuals?limit=100${machineModelId ? `&machineModelId=${machineModelId}` : ''}`,
    ),

  listConversations: (query = '') =>
    request<ConversationSummary[]>(`/conversations${query ? `?${query}` : ''}`),
  getConversation: (id: string) => dataOf<{ conversation: ConversationSummary }>(`/conversations/${id}`),
  createConversation: (body: Record<string, unknown>) =>
    dataOf<{ conversation: ConversationSummary }>('/conversations', { method: 'POST', body }),
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
  listActions: (id: string) => request<TechnicianActionRecord[]>(`/conversations/${id}/actions?limit=100`),
  recordAction: (id: string, body: Record<string, unknown>) =>
    dataOf<{ action: TechnicianActionRecord }>(`/conversations/${id}/actions`, { method: 'POST', body }),
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

  // --- Incidents ------------------------------------------------------------
  listIncidents: (query: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return request<IncidentRecord[]>(`/incidents${qs ? `?${qs}` : ''}`);
  },
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
  createIncidentFromConversation: (conversationId: string, body: Record<string, unknown>) =>
    dataOf<{ incident: IncidentRecord; importedActions: number }>(
      `/conversations/${conversationId}/create-incident`,
      { method: 'POST', body },
    ),
};

export { BASE_URL as apiBaseUrl };
