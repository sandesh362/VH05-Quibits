/**
 * Domain endpoints (machines, models, manuals, incidents, actions,
 * conversations). One function per route; no ad-hoc URLs in screens.
 */
import type {
  IncidentActionView,
  IncidentListQuery,
  IncidentStatus,
  IncidentTimelineEventView,
  IncidentView,
  IssueStatus,
  MessageView,
  PublicUser,
  SimilarIncidentView,
} from '@itp/shared';
import { get, pageOf, patch, post, del, type Page } from './client';
import type {
  ConversationListItem,
  MachineModelView,
  MachineView,
  ManualView,
  PostMessageResponse,
} from './types';

// --- Machines ---------------------------------------------------------------

export interface ListMachinesQuery {
  search?: string;
  status?: string;
  machineModelId?: string;
  criticality?: string;
  site?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export const listMachines = (query: ListMachinesQuery = {}): Promise<Page<MachineView>> =>
  pageOf<MachineView>('/machines', { limit: 20, ...query });

export const getMachine = (id: string): Promise<MachineView> =>
  get<{ machine: MachineView }>(`/machines/${id}`).then((r) => r.machine);

export const machineTimeline = (
  id: string,
  query: { from?: string; to?: string; kind?: 'all' | 'maintenance' | 'incident'; limit?: number } = {},
): Promise<{ machine: unknown; events: Array<Record<string, unknown>> }> =>
  get(`/machines/${id}/timeline`, { query: { limit: 100, ...query } });

// --- Machine models ----------------------------------------------------------

export const listMachineModels = (query: { search?: string; page?: number; limit?: number } = {}): Promise<Page<MachineModelView>> =>
  pageOf<MachineModelView>('/machine-models', { limit: 20, ...query });

export const getMachineModel = (id: string): Promise<MachineModelView> =>
  get<{ machineModel: MachineModelView }>(`/machine-models/${id}`).then((r) => r.machineModel);

// --- Manuals ------------------------------------------------------------------

export const listManuals = (
  query: { machineId?: string; machineModelId?: string; search?: string; page?: number; limit?: number; processingStatus?: string } = {},
): Promise<Page<ManualView>> => pageOf<ManualView>('/manuals', { limit: 20, ...query });

export const getManual = (id: string): Promise<ManualView> =>
  get<{ manual: ManualView }>(`/manuals/${id}`).then((r) => r.manual);

export const listManualPages = (
  manualId: string,
  query: { page?: number; limit?: number } = {},
): Promise<Page<import('@itp/shared').ManualPageView>> =>
  pageOf(`/manuals/${manualId}/pages`, { limit: 5, ...query });

export const getManualChunk = (manualId: string, chunkId: string): Promise<import('@itp/shared').ManualChunkView> =>
  get<{ chunk: import('@itp/shared').ManualChunkView }>(`/manuals/${manualId}/chunks/${chunkId}`).then((r) => r.chunk);

// --- Incidents -----------------------------------------------------------------

export type { IncidentListQuery };

export const listIncidents = (query: IncidentListQuery = {}): Promise<Page<IncidentView>> =>
  pageOf<IncidentView>('/incidents', { limit: 20, ...query });

export const getIncident = (id: string): Promise<IncidentView> =>
  get<{ incident: IncidentView }>(`/incidents/${id}`).then((r) => r.incident);

export const createIncident = (body: Record<string, unknown>): Promise<IncidentView> =>
  post<{ incident: IncidentView }>('/incidents', body).then((r) => r.incident);

export const updateIncident = (id: string, body: Record<string, unknown>): Promise<IncidentView> =>
  patch<{ incident: IncidentView }>(`/incidents/${id}`, body).then((r) => r.incident);

export const changeIncidentStatus = (
  id: string,
  status: IncidentStatus,
  reason?: string,
): Promise<IncidentView> =>
  patch<{ incident: IncidentView }>(`/incidents/${id}/status`, { status, reason }).then((r) => r.incident);

export const changeIncidentIssueStatus = (
  id: string,
  issueStatus: IssueStatus,
  note?: string,
): Promise<IncidentView> =>
  patch<{ incident: IncidentView }>(`/incidents/${id}/issue-status`, { issueStatus, note }).then((r) => r.incident);

export const closeIncident = (id: string, resolutionSummary: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/close`, { resolutionSummary }).then((r) => r.incident);

export const reopenIncident = (id: string, reason: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/reopen`, { reason }).then((r) => r.incident);

export const cancelIncident = (id: string, reason: string): Promise<void> =>
  del(`/incidents/${id}`, { reason });

// Root cause
export const updateRootCause = (id: string, body: { text?: string; status?: 'unknown' | 'suspected'; note?: string }): Promise<IncidentView> =>
  patch<{ incident: IncidentView }>(`/incidents/${id}/root-cause`, body).then((r) => r.incident);

export const confirmRootCause = (id: string, note: string, text?: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/root-cause/confirm`, text ? { note, text } : { note }).then((r) => r.incident);

export const rejectRootCause = (id: string, reason: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/root-cause/reject`, { reason }).then((r) => r.incident);

export const rootCauseHistory = (id: string): Promise<Array<Record<string, unknown>>> =>
  get<{ history: Array<Record<string, unknown>> }>(`/incidents/${id}/root-cause/history`).then((r) => r.history);

// Fixes
export interface FixInput {
  description: string;
  result?: string;
  notes?: string;
}

export const recordTemporaryFix = (id: string, body: FixInput): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/temporary-fix`, body).then((r) => r.incident);

export const confirmTemporaryFix = (id: string, note: string, result?: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/temporary-fix/confirm`, result ? { note, result } : { note }).then((r) => r.incident);

export const recordPermanentFix = (id: string, body: FixInput): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/permanent-fix`, body).then((r) => r.incident);

export const confirmPermanentFix = (id: string, note: string, result?: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/incidents/${id}/permanent-fix/confirm`, result ? { note, result } : { note }).then((r) => r.incident);

export const fixHistory = (id: string): Promise<Array<Record<string, unknown>>> =>
  get<{ history: Array<Record<string, unknown>> }>(`/incidents/${id}/fixes/history`).then((r) => r.history);

// Timeline + similar
export const incidentTimeline = (id: string): Promise<IncidentTimelineEventView[]> =>
  get<{ timeline: IncidentTimelineEventView[] }>(`/incidents/${id}/timeline`).then((r) => r.timeline);

export const similarIncidents = (id: string): Promise<SimilarIncidentView[]> =>
  get<{ similar: SimilarIncidentView[] }>(`/incidents/${id}/similar`).then((r) => r.similar);

// --- Incident actions -------------------------------------------------------------

export const listIncidentActions = (
  incidentId: string,
  query: { page?: number; limit?: number; actionType?: string; confirmed?: boolean } = {},
): Promise<Page<IncidentActionView>> =>
  pageOf<IncidentActionView>(`/incidents/${incidentId}/actions`, { limit: 20, ...query });

export const createIncidentAction = (incidentId: string, body: Record<string, unknown>): Promise<IncidentActionView> =>
  post<{ action: IncidentActionView }>(`/incidents/${incidentId}/actions`, body).then((r) => r.action);

export const confirmIncidentAction = (incidentId: string, actionId: string, note: string): Promise<IncidentActionView> =>
  post<{ action: IncidentActionView }>(`/incidents/${incidentId}/actions/${actionId}/confirm`, { note }).then((r) => r.action);

// --- Conversations -------------------------------------------------------------------

export const listConversations = (
  query: { search?: string; page?: number; limit?: number; status?: string; machineId?: string } = {},
): Promise<Page<ConversationListItem>> =>
  pageOf<ConversationListItem>('/conversations', { limit: 20, ...query });

export const getConversation = (id: string): Promise<ConversationListItem> =>
  get<{ conversation: ConversationListItem }>(`/conversations/${id}`).then((r) => r.conversation);

export const createConversation = (body: {
  machineId?: string;
  machineModelId?: string;
  title?: string;
}): Promise<ConversationListItem> =>
  post<{ conversation: ConversationListItem }>('/conversations', body).then((r) => r.conversation);

export const listMessages = (
  conversationId: string,
  query: { page?: number; limit?: number } = {},
): Promise<Page<MessageView>> =>
  pageOf<MessageView>(`/conversations/${conversationId}/messages`, { limit: 50, ...query });

export const postMessage = (
  conversationId: string,
  content: string,
  clientRequestId: string,
): Promise<PostMessageResponse> =>
  post<PostMessageResponse>(
    `/conversations/${conversationId}/messages`,
    { content, clientRequestId },
    { headers: { 'idempotency-key': clientRequestId }, timeoutMs: 130_000, autoRetry: false },
  );

export const createIncidentFromConversation = (conversationId: string): Promise<IncidentView> =>
  post<{ incident: IncidentView }>(`/conversations/${conversationId}/create-incident`).then((r) => r.incident);

// --- Users -----------------------------------------------------------------------------

export const whoAmI = (): Promise<PublicUser> => get<{ user: PublicUser }>('/users/me').then((r) => r.user);
