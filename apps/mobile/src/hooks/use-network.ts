/**
 * Network state.
 *
 * NetInfo (bundled in Expo Go) drives both the offline banner and React
 * Query's onlineManager, so queries refetch automatically when connectivity
 * returns.
 */
import { useEffect, useState } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

export interface NetworkState {
  /** True when the app should attempt network calls. */
  isOnline: boolean;
  /** True when a connection exists but no internet was verified. */
  isRestricted: boolean;
}

/** Subscribe React Query to NetInfo. Call once, in the root layout. */
export function useOnlineManager(): void {
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const reachable = state.isInternetReachable;
      onlineManager.setOnline(reachable === null ? (state.isConnected ?? false) : reachable);
    });
    return unsubscribe;
  }, []);
}

export function useNetwork(): NetworkState {
  const [state, setState] = useState<NetworkState>({ isOnline: true, isRestricted: false });

  useEffect(() => {
    let mounted = true;
    const apply = (next: NetInfoState) => {
      if (!mounted) return;
      const reachable = next.isInternetReachable;
      const connected = next.isConnected ?? false;
      setState({
        isOnline: reachable === null ? connected : reachable,
        isRestricted: connected && reachable === false,
      });
    };
    const unsubscribe = NetInfo.addEventListener(apply);
    void NetInfo.fetch().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return state;
}
