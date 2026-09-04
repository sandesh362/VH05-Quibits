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
  }>;
  suggestedActions: Array<{ id: string; description: string; sourceIds: string[]; status: string }>;
  clarification: string | null;
  refusalReason: string | null;
  ragStatus: string | null;
  confidence: string | null;
  createdAt: string;
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
  listModels: () => request<MachineModelRecord[]>('/machine-models?limit=100'),
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
};

export { BASE_URL as apiBaseUrl };
