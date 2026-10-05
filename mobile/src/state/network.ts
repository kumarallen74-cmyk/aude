import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/** Connectivity: NetInfo feeds TanStack Query's onlineManager (paused queries resume on reconnect). */
let online = true;
const subs = new Set<() => void>();

export function startNetworkWatch(): () => void {
  return NetInfo.addEventListener((s) => {
    const next = s.isConnected !== false && s.isInternetReachable !== false;
    if (next !== online) {
      online = next;
      onlineManager.setOnline(next);
      subs.forEach((f) => f());
    }
  });
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => online,
    () => true,
  );
}

/** Test hook. */
export function setOnlineForTest(v: boolean) {
  online = v;
  subs.forEach((f) => f());
}
