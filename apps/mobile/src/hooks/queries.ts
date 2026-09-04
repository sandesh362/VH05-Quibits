/**
 * React Query hooks.
 *
 * Every list/detail read goes through `fetchWithCache`: on success the
 * snapshot is cached (short TTL); on network failure the cached copy is
 * returned and clearly flagged (`cached: true`). If there is neither a
 * server answer nor a cache, the query errors and the UI shows the error
 * state with a retry.
 *
 * Mutations that are part of the supported offline workflow never talk to
 * the API directly - they enqueue an outbox op and immediately try to sync
 * (see useQueuedWrite).
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type {
  IncidentActionView,
  IncidentTimelineEventView,
  IncidentView,
  MessageView,
  SimilarIncidentView,
} from '@itp/shared';
import * as endpoints from '@/api/endpoints';
import type { ConversationListItem, MachineModelView, MachineView, ManualView, PostMessageResponse } from '@/api/types';
import { cacheGet, cachePut, CACHE_TTL_MS, pushRecent, readRecents, type RecentEntry } from '@/db/cache';
import { enqueueOp, getOp, listOps, type OutboxOp, type OutboxOpType } from '@/db/outbox';
import { lastSyncAt, syncNow } from '@/db/sync';
import { newId } from '@/lib/id';

export interface CachedData<T> {
  data: T;
  cached: boolean;
}

async function fetchWithCache<T>(
  userId: string,
  key: string,
  ttlMs: number,
  fetch: () => Promise<T>,
): Promise<CachedData<T>> {
  try {
    const data = await fetch();
    cachePut(userId, key, data, ttlMs);
    return { data, cached: false };
  } catch (error) {
    const cached = cacheGet<T>(userId, key);
    if (cached !== null) return { data: cached, cached: true };
    throw error;
  }
}

// --- Machines -----------------------------------------------------------------

export const qk = {
  machines: (filters: object) => ['machines', filters] as const,
  machine: (id: string) => ['machine', id] as const,
  machineModels: (search: string) => ['machine-models', search] as const,
  manualsForMachine: (machineId: string, modelId: string) => ['manuals', machineId, modelId] as const,
  manual: (id: string) => ['manual', id] as const,
  manualPages: (id: string, page: number) => ['manual-pages', id, page] as const,
  incidents: (filters: object) => ['incidents', filters] as const,
  incident: (id: string) => ['incident', id] as const,
  incidentActions: (id: string) => ['incident-actions', id] as const,
  incidentTimeline: (id: string) => ['incident-timeline', id] as const,
  similar: (id: string) => ['similar-incidents', id] as const,
  rootCauseHistory: (id: string) => ['root-cause-history', id] as const,
  conversations: (filters: object) => ['conversations', filters] as const,
  conversation: (id: string) => ['conversation', id] as const,
  messages: (id: string) => ['messages', id] as const,
  home: (userId: string) => ['home', userId] as const,
  sync: (userId: string) => ['sync', userId] as const,
  recents: (userId: string) => ['recents', userId] as const,
};

export interface MachineFilters {
  search?: string;
  status?: string;
  machineModelId?: string;
}

export function useMachines(userId: string, filters: MachineFilters) {
  return useInfiniteQuery({
    queryKey: qk.machines(filters),
    enabled: Boolean(userId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const page = await endpoints.listMachines({ ...filters, page: pageParam, limit: 20 });
      // Cache page 1 only: offline browsing shows the first screen.
      if (pageParam === 1) {
        cachePut(userId, `machines:${JSON.stringify(filters)}`, page, CACHE_TTL_MS.machines);
      }
      return page;
    },
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    retry: false,
  });
}

export function useMachine(userId: string, id: string) {
  return useQuery({
    queryKey: qk.machine(id),
    enabled: Boolean(userId && id),
    staleTime: 30_000,
    queryFn: () =>
      fetchWithCache(userId, `machine:${id}`, CACHE_TTL_MS.machines, () => endpoints.getMachine(id)),
    retry: false,
  });
}

export function useMachineModelSearch(userId: string, search: string) {
  return useQuery({
    queryKey: qk.machineModels(search),
    enabled: Boolean(userId) && search.trim().length >= 2,
    staleTime: 60_000,
    queryFn: () => endpoints.listMachineModels({ search: search.trim(), limit: 10 }),
    retry: false,
  });
}

/** Model-scope + machine-scope manuals for one machine, merged. */
export function useManualsForMachine(userId: string, machine: MachineView | undefined) {
  const machineId = machine?.id ?? '';
  const modelId = machine?.machineModelId ?? '';
  return useQuery({
    queryKey: qk.manualsForMachine(machineId, modelId),
    enabled: Boolean(userId && machineId),
    staleTime: 60_000,
    queryFn: () =>
      fetchWithCache(
        userId,
        `manuals:machine:${machineId}`,
        CACHE_TTL_MS.machines,
        async (): Promise<ManualView[]> => {
          const [byMachine, byModel] = await Promise.all([
            endpoints.listManuals({ machineId, limit: 50 }),
            modelId ? endpoints.listManuals({ machineModelId: modelId, limit: 50 }) : Promise.resolve({ items: [], pagination: { page: 1, limit: 0, total: 0, totalPages: 0 } }),
          ]);
          const seen = new Set<string>();
          return [...byMachine.items, ...byModel.items].filter((manual) =>
            seen.has(manual.id) ? false : (seen.add(manual.id), true),
          );
        },
      ),
    retry: false,
  });
}

export function useManual(userId: string, id: string) {
  return useQuery({
    queryKey: qk.manual(id),
    enabled: Boolean(userId && id),
    staleTime: 60_000,
    queryFn: () => fetchWithCache(userId, `manual:${id}`, CACHE_TTL_MS.machines, () => endpoints.getManual(id)),
    retry: false,
  });
}

export function useManualPages(userId: string, manualId: string, page: number) {
  return useQuery({
    queryKey: qk.manualPages(manualId, page),
    enabled: Boolean(userId && manualId),
    staleTime: 5 * 60_000,
    queryFn: () => endpoints.listManualPages(manualId, { page, limit: 5 }),
    retry: false,
  });
}

// --- Incidents ------------------------------------------------------------------

export interface IncidentFilters {
  search?: string;
  status?: string;
  severity?: string;
  priority?: string;
  issueStatus?: string;
  machineId?: string;
  assignedToMe?: boolean;
}

export function buildIncidentQuery(filters: IncidentFilters, userId: string): endpoints.IncidentListQuery {
  return {
    search: filters.search?.trim() || undefined,
    // Filter values come from typed ChoiceGroups; the widened `string` state
    // is narrowed back to the wire unions here (backend re-validates).
    status: filters.status as endpoints.IncidentListQuery['status'],
    severity: filters.severity as endpoints.IncidentListQuery['severity'],
    priority: filters.priority as endpoints.IncidentListQuery['priority'],
    issueStatus: filters.issueStatus as endpoints.IncidentListQuery['issueStatus'],
    machineId: filters.machineId || undefined,
    assignedTo: filters.assignedToMe ? userId : undefined,
    sortBy: 'updated_at',
    sortOrder: 'desc',
  };
}

export function useIncidents(userId: string, filters: IncidentFilters) {
  const query = buildIncidentQuery(filters, userId);
  return useInfiniteQuery({
    queryKey: qk.incidents(filters),
    enabled: Boolean(userId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const page = await endpoints.listIncidents({ ...query, page: pageParam, limit: 20 });
      if (pageParam === 1) {
        cachePut(userId, `incidents:${JSON.stringify(filters)}`, page, CACHE_TTL_MS.incidents);
      }
      return page;
    },
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    retry: false,
  });
}

export function useIncident(userId: string, id: string) {
  return useQuery({
    queryKey: qk.incident(id),
    enabled: Boolean(userId && id),
    staleTime: 15_000,
    queryFn: () =>
      fetchWithCache(userId, `incident:${id}`, CACHE_TTL_MS.incidents, () => endpoints.getIncident(id)),
    retry: false,
  });
}

export function useIncidentActions(userId: string, incidentId: string) {
  return useInfiniteQuery({
    queryKey: qk.incidentActions(incidentId),
    enabled: Boolean(userId && incidentId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const page = await endpoints.listIncidentActions(incidentId, { page: pageParam, limit: 50 });
      if (pageParam === 1) {
        cachePut(userId, `incident-actions:${incidentId}`, page, CACHE_TTL_MS.incidents);
      }
      return page;
    },
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    retry: false,
  });
}

export function useIncidentTimeline(userId: string, incidentId: string) {
  return useQuery({
    queryKey: qk.incidentTimeline(incidentId),
    enabled: Boolean(userId && incidentId),
    staleTime: 10_000,
    queryFn: () =>
      fetchWithCache<IncidentTimelineEventView[]>(
        userId,
        `incident-timeline:${incidentId}`,
        CACHE_TTL_MS.incidents,
        () => endpoints.incidentTimeline(incidentId),
      ),
    retry: false,
  });
}

export function useSimilarIncidents(userId: string, incidentId: string) {
  return useQuery({
    queryKey: qk.similar(incidentId),
    enabled: Boolean(userId && incidentId),
    staleTime: 60_000,
    queryFn: () =>
      fetchWithCache<SimilarIncidentView[]>(
        userId,
        `similar:${incidentId}`,
        CACHE_TTL_MS.incidents,
        () => endpoints.similarIncidents(incidentId),
      ),
    retry: false,
  });
}

export function useRootCauseHistory(userId: string, incidentId: string) {
  return useQuery({
    queryKey: qk.rootCauseHistory(incidentId),
    enabled: Boolean(userId && incidentId),
    staleTime: 30_000,
    queryFn: () => endpoints.rootCauseHistory(incidentId),
    retry: false,
  });
}

// --- Conversations ------------------------------------------------------------------

export function useConversations(userId: string, search: string) {
  return useInfiniteQuery({
    queryKey: qk.conversations({ search }),
    enabled: Boolean(userId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const page = await endpoints.listConversations({ search: search || undefined, page: pageParam, limit: 20 });
      if (pageParam === 1) {
        cachePut(userId, `conversations:${search}`, page, CACHE_TTL_MS.conversations);
      }
      return page;
    },
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    retry: false,
  });
}

export function useConversation(userId: string, id: string) {
  return useQuery({
    queryKey: qk.conversation(id),
    enabled: Boolean(userId && id),
    staleTime: 15_000,
    queryFn: () =>
      fetchWithCache<ConversationListItem>(
        userId,
        `conversation:${id}`,
        CACHE_TTL_MS.conversations,
        () => endpoints.getConversation(id),
      ),
    retry: false,
  });
}

export function useMessages(userId: string, conversationId: string) {
  return useInfiniteQuery({
    queryKey: qk.messages(conversationId),
    enabled: Boolean(userId && conversationId),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const page = await endpoints.listMessages(conversationId, { page: pageParam, limit: 50 });
      if (pageParam === 1) {
        cachePut(userId, `messages:${conversationId}`, page, CACHE_TTL_MS.conversations);
      }
      return page;
    },
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    retry: false,
  });
}

/** Optimistically append the user message, then reconcile with the response. */
export function useSendMessage(userId: string, conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation<PostMessageResponse, Error, { content: string }>({
    mutationFn: ({ content }) => postMessageSafe(conversationId, content),
    onMutate: async ({ content }) => {
      const key = qk.messages(conversationId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      const optimistic: MessageView = {
        id: `optimistic-${newId()}`,
        conversationId,
        role: 'user',
        messageType: 'question',
        content,
        originalQuery: content,
        normalizedQuery: null,
        status: 'pending',
        sources: [],
        retrievalMetadata: null,
        machineContext: null,
        suggestedActions: [],
        clarification: null,
        refusalReason: null,
        ragStatus: null,
        confidence: null,
        createdBy: userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as MessageView;
      queryClient.setQueryData(key, (old: { pages?: Array<{ items: MessageView[] }>; pageParams?: unknown[] } | undefined) => {
        if (!old?.pages?.length) return old;
        const pages = [...old.pages];
        const lastPage = pages[pages.length - 1]!;
        pages[pages.length - 1] = { ...lastPage, items: [...lastPage.items, optimistic] };
        return { ...old, pages };
      });
      return { previous, key };
    },
    onError: (_error, _vars, context) => {
      const ctx = context as { previous?: unknown; key: readonly unknown[] } | undefined;
      if (ctx?.previous !== undefined) queryClient.setQueryData(ctx.key, ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: qk.conversations({ search: '' }) });
    },
  });
}

async function postMessageSafe(conversationId: string, content: string): Promise<PostMessageResponse> {
  return endpoints.postMessage(conversationId, content, newId());
}

// --- Home overview -----------------------------------------------------------------

export interface HomeOverview {
  assignedOpen: number;
  investigating: number;
  waitingInfo: number;
  unresolvedIssues: number;
  recentIncidents: IncidentView[];
}

/**
 * Home counts come from the pagination metadata of limit=1 list queries -
 * real numbers from the real API, no invented dashboards.
 */
export function useHomeOverview(userId: string) {
  return useQuery({
    queryKey: qk.home(userId),
    enabled: Boolean(userId),
    staleTime: 30_000,
    queryFn: () =>
      fetchWithCache<HomeOverview>(
        userId,
        'home-overview',
        5 * 60_000,
        async () => {
          const [open, investigating, waitingInfo, unresolved, recent] = await Promise.all([
            endpoints.listIncidents({ assignedTo: userId, status: 'open', limit: 1 }),
            endpoints.listIncidents({ assignedTo: userId, status: 'investigating', limit: 1 }),
            endpoints.listIncidents({ assignedTo: userId, status: 'waiting_for_information', limit: 1 }),
            endpoints.listIncidents({ issueStatus: 'unresolved', limit: 1 }),
            endpoints.listIncidents({ limit: 5, sortBy: 'created_at', sortOrder: 'desc' }),
          ]);
          return {
            assignedOpen: open.pagination.total,
            investigating: investigating.pagination.total,
            waitingInfo: waitingInfo.pagination.total,
            unresolvedIssues: unresolved.pagination.total,
            recentIncidents: recent.items,
          };
        },
      ),
    retry: false,
  });
}

// --- Sync status ----------------------------------------------------------------------

export interface SyncStatus {
  ops: OutboxOp[];
  pending: number;
  failed: number;
  review: number;
  completed: number;
  lastSyncAt: string | null;
}

export function useSyncStatus(userId: string, hasPending: boolean) {
  return useQuery({
    queryKey: qk.sync(userId),
    enabled: Boolean(userId),
    queryFn: (): SyncStatus => {
      const ops = listOps(userId);
      return {
        ops,
        pending: ops.filter((op) => op.status === 'pending' || op.status === 'syncing').length,
        failed: ops.filter((op) => op.status === 'failed').length,
        review: ops.filter((op) => op.status === 'requires_review').length,
        completed: ops.filter((op) => op.status === 'completed').length,
        lastSyncAt: lastSyncAt(userId),
      };
    },
    refetchInterval: hasPending ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useRecents(userId: string, kind: 'machines' | 'incidents'): RecentEntry[] {
  const query = useQuery<RecentEntry[]>({
    queryKey: qk.recents(userId),
    enabled: Boolean(userId),
    queryFn: () => readRecents(userId, kind),
    staleTime: 10_000,
  });
  return query.data ?? [];
}

export function markMachineVisited(userId: string, machine: MachineView): void {
  pushRecent(userId, 'machines', {
    id: machine.id,
    label: machine.displayName ?? machine.assetTag,
    subtitle: machine.modelSnapshot?.modelName ?? undefined,
  });
}

export function markIncidentVisited(userId: string, incident: IncidentView): void {
  pushRecent(userId, 'incidents', {
    id: incident.id,
    label: `${incident.incidentNumber} — ${incident.title}`,
    subtitle: incident.machineLabel ?? undefined,
  });
}

// --- Queued writes --------------------------------------------------------------------

export type QueuedWriteResult =
  | { kind: 'completed'; op: OutboxOp }
  | { kind: 'queued'; op: OutboxOp }
  | { kind: 'failed'; op: OutboxOp }
  | { kind: 'review'; op: OutboxOp };

/**
 * Every supported offline-capable write flows through here: enqueue → sync
 * immediately → classify. The caller maps the result to UI copy; nothing is
 * ever reported as confirmed unless the server said so.
 */
export function useQueuedWrite(userId: string): UseMutationResult<QueuedWriteResult, Error, { type: OutboxOpType; payload: Record<string, unknown> }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ type, payload }) => {
      const op = enqueueOp({ userId, type, payload, idempotencyKey: newId() });
      await syncNow(userId, 'after-write');
      const stored = getOp(op.id);
      if (!stored) throw new Error('Queued operation disappeared from the local queue.');
      if (stored.status === 'completed') return { kind: 'completed', op: stored } as QueuedWriteResult;
      if (stored.status === 'requires_review') return { kind: 'review', op: stored } as QueuedWriteResult;
      if (stored.status === 'failed') return { kind: 'failed', op: stored } as QueuedWriteResult;
      return { kind: 'queued', op: stored } as QueuedWriteResult;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.sync(userId) });
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident'] });
      void queryClient.invalidateQueries({ queryKey: ['incident-actions'] });
      void queryClient.invalidateQueries({ queryKey: ['incident-timeline'] });
      void queryClient.invalidateQueries({ queryKey: qk.home(userId) });
    },
  });
}
