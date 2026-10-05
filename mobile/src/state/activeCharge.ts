import { createStore, useStore } from '@/lib/store';
import { kv, KEYS } from '@/lib/storage';

/** The charge the driver is following (for the floating session pill and resuming after a restart). */
export interface ActiveCharge {
  kind: 'charge' | 'roaming';
  id: string;
  siteName: string;
  startedAt: number;
}

export const activeChargeStore = createStore<{ current: ActiveCharge | null }>({ current: null });

export async function hydrateActiveCharge() {
  const saved = await kv.get<ActiveCharge>(KEYS.activeCharge);
  // Older than 24 h: certainly over; the history shows it.
  if (saved && Date.now() - saved.startedAt < 24 * 3600_000) activeChargeStore.set({ current: saved });
}

export function setActiveCharge(c: ActiveCharge | null) {
  activeChargeStore.set({ current: c });
  if (c) void kv.set(KEYS.activeCharge, c);
  else void kv.remove(KEYS.activeCharge);
}

export const useActiveCharge = () => useStore(activeChargeStore, (s) => s.current);
