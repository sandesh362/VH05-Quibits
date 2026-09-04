/**
 * Minimal data-fetching hook.
 *
 * Deliberately hand-rolled rather than pulling in TanStack Query: Phase 1 has
 * three read-only endpoints. A query library is justified in Phase 5 when
 * caching, invalidation and mutations appear.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from './api-client';

export type RequestState = 'idle' | 'loading' | 'success' | 'error';

export interface UseApiResult<T> {
  data: T | null;
  error: ApiClientError | null;
  state: RequestState;
  isLoading: boolean;
  /** True only for the first load, so refreshes do not blank the screen. */
  isInitialLoading: boolean;
  refetch: () => void;
  lastUpdated: Date | null;
}

/**
 * Run an async fetcher on mount, with manual refetch.
 *
 * @param fetcher    receives an AbortSignal; must honour it
 * @param deps       re-runs when these change
 * @param pollMs     optional polling interval
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  pollMs?: number,
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [state, setState] = useState<RequestState>('idle');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const hasLoadedOnce = useRef(false);
  const mounted = useRef(true);
  // Keep the fetcher in a ref so an inline arrow function does not retrigger.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const execute = useCallback(async (signal: AbortSignal) => {
    setState('loading');
    setError(null);

    try {
      const result = await fetcherRef.current(signal);
      if (signal.aborted || !mounted.current) return;

      setData(result);
      setState('success');
      setLastUpdated(new Date());
      hasLoadedOnce.current = true;
    } catch (caught) {
      if (signal.aborted || !mounted.current) return;

      setError(
        caught instanceof ApiClientError
          ? caught
          : new ApiClientError('NETWORK_ERROR', 'An unexpected error occurred.'),
      );
      setState('error');
      hasLoadedOnce.current = true;
    }
  }, []);

  const [refetchToken, setRefetchToken] = useState(0);
  const refetch = useCallback(() => setRefetchToken((n) => n + 1), []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void execute(controller.signal);

    let interval: ReturnType<typeof setInterval> | undefined;
    if (pollMs && pollMs > 0) {
      interval = setInterval(() => {
        if (mounted.current) void execute(controller.signal);
      }, pollMs);
    }

    return () => {
      mounted.current = false;
      controller.abort();
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execute, pollMs, refetchToken, ...deps]);

  return {
    data,
    error,
    state,
    isLoading: state === 'loading',
    isInitialLoading: state === 'loading' && !hasLoadedOnce.current,
    refetch,
    lastUpdated,
  };
}
