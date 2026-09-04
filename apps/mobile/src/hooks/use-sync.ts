/**
 * Sync lifecycle: flush the outbox when connectivity returns, when the app
 * comes to the foreground, and on demand. After a run, domain queries are
 * invalidated so lists reflect the freshly-confirmed server state.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { useNetwork } from './use-network';
import { qk } from './queries';
import { pendingCount } from '@/db/sync';
import { initDatabase, resetStaleSyncing } from '@/db/database';
import { syncNow } from '@/db/sync';

export function useSyncEngine(userId: string | undefined): { syncNow: () => Promise<void>; pending: number } {
  const queryClient = useQueryClient();
  const { isOnline } = useNetwork();
  const syncingRef = useRef(false);
  const pendingRef = useRef(0);

  const run = useCallback(
    async (trigger: 'online' | 'foreground' | 'manual') => {
      if (!userId || syncingRef.current) return;
      syncingRef.current = true;
      try {
        initDatabase();
        resetStaleSyncing(userId);
        await syncNow(userId, trigger);
        pendingRef.current = pendingCount(userId);
        // Refresh anything that a completed op may have changed.
        await queryClient.invalidateQueries({ queryKey: ['incidents'] });
        await queryClient.invalidateQueries({ queryKey: ['incident'] });
        await queryClient.invalidateQueries({ queryKey: ['incident-actions'] });
        await queryClient.invalidateQueries({ queryKey: ['incident-timeline'] });
        await queryClient.invalidateQueries({ queryKey: qk.sync(userId) });
        await queryClient.invalidateQueries({ queryKey: qk.home(userId) });
      } finally {
        syncingRef.current = false;
      }
    },
    [userId, queryClient],
  );

  // On connectivity return.
  useEffect(() => {
    if (isOnline && userId) void run('online');
  }, [isOnline, userId, run]);

  // On foreground.
  useEffect(() => {
    if (!userId) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run('foreground');
    });
    return () => subscription.remove();
  }, [userId, run]);

  const syncNowManually = useCallback(async () => {
    await run('manual');
  }, [run]);

  return { syncNow: syncNowManually, pending: pendingRef.current };
}
