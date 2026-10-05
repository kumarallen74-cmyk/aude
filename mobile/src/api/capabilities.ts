import { kv, KEYS } from '@/lib/storage';

/**
 * Feature detection for driver-API endpoints that are specified but NOT built yet (spec §14, P1+: G9 ratings and
 * problem reports). A call that answers a Fastify "route not found" 404 / 405 / 501 marks the feature unsupported
 * for a while, so the UI degrades (WhatsApp hand-off) without hammering the server; after `TTL_MS` it probes again,
 * so a backend deploy is picked up without an app update. Everything in §15 (G1–G8) is called directly.
 */
export type Feature = 'ratings' | 'reports';

const TTL_MS = 6 * 60 * 60 * 1000;
let state: Partial<Record<Feature, { supported: boolean; at: number }>> = {};
let loaded = false;

export async function loadCapabilities(): Promise<void> {
  if (loaded) return;
  state = (await kv.get<typeof state>(KEYS.capabilities)) ?? {};
  loaded = true;
}

export function isUnsupported(f: Feature, now = Date.now()): boolean {
  const s = state[f];
  return !!s && !s.supported && now - s.at < TTL_MS;
}

export function isSupported(f: Feature): boolean {
  return state[f]?.supported === true;
}

export function mark(f: Feature, supported: boolean, now = Date.now()): void {
  const prev = state[f];
  if (prev && prev.supported === supported && now - prev.at < 60_000) return;
  state = { ...state, [f]: { supported, at: now } };
  void kv.set(KEYS.capabilities, state);
}

/** Test helper. */
export function resetCapabilities(): void {
  state = {};
  loaded = false;
}
