import type { StartResult } from '@/api/types';
import { createStore, useStore } from '@/lib/store';
import { kv, KEYS } from '@/lib/storage';

/** The charge the driver is following (for the floating session pill and resuming after a restart). */
export interface ActiveCharge {
  kind: 'charge' | 'roaming';
  id: string;
  siteName: string;
  startedAt: number;
}

/**
 * The last answer to `POST /charge/:id/start` for a hosted charge: the start token the charger needs when the remote
 * start could not reach it, or why the start failed. Kept with the active charge so it survives an app restart.
 */
export interface StartRecord extends StartResult {
  chargeId: string;
  at: number;
}

export const activeChargeStore = createStore<{ current: ActiveCharge | null; start: StartRecord | null }>({ current: null, start: null });

export async function hydrateActiveCharge() {
  const [saved, start] = await Promise.all([kv.get<ActiveCharge>(KEYS.activeCharge), kv.get<StartRecord>(KEYS.lastStart)]);
  // Older than 24 h: certainly over; the history shows it.
  if (saved && Date.now() - saved.startedAt < 24 * 3600_000) activeChargeStore.set({ current: saved });
  if (start && Date.now() - start.at < 24 * 3600_000) activeChargeStore.set({ start });
}

export function setActiveCharge(c: ActiveCharge | null) {
  activeChargeStore.set({ current: c });
  if (c) void kv.set(KEYS.activeCharge, c);
  else {
    void kv.remove(KEYS.activeCharge);
    setStartRecord(null);
  }
}

export function setStartRecord(r: StartRecord | null) {
  activeChargeStore.set({ start: r });
  if (r) void kv.set(KEYS.lastStart, r);
  else void kv.remove(KEYS.lastStart);
}

export const useActiveCharge = () => useStore(activeChargeStore, (s) => s.current);
/** The last start answer for this charge (null for another charge, or none yet). */
export const useStartRecord = (chargeId: string | undefined) => useStore(activeChargeStore, (s) => (chargeId && s.start?.chargeId === chargeId ? s.start : null));
