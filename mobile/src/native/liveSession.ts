import { requireOptionalNativeModule } from 'expo';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '@/api/client';
import { brand } from '@/config';
import { formatMoney } from '@/lib/money';
import type { Snapshot } from '@/lib/sessionMachine';
import { kv, KEYS } from '@/lib/storage';
import { LIVE_ID } from './notifications';

/**
 * The charge on the lock screen (spec §12.2–12.3, contract §15.7).
 *
 * iOS — Live Activity (ActivityKit, iOS 16.2+) via the local Expo module `modules/live-activity` and the
 *   `ChargingWidgets` extension target (plugins/withLiveActivity). Content-state **version 2**: `costIdr` /
 *   `estimateIdr` are minor units of `currency`, which is always present. The activity's update token is registered
 *   with `POST /d/v1/live-sessions {platform:'ios', ref, token, contentVersion: 2}`; the server then pushes updates.
 *
 * Android — one ongoing notification per `ref`: `Notification.ProgressStyle` (Android 16 Live Update) through the local
 *   Expo module `modules/live-update` (Kotlin), else a sticky expo-notifications notification. The FCM token is
 *   registered with `POST /d/v1/live-sessions {platform:'android', ref, token}`; the server's `live_session` data
 *   messages are handled by `handleLiveSessionData` (foreground listener and the background notification task).
 *
 * When neither native module is in the binary (Expo Go, web) everything here is a no-op or the fallback.
 */
interface LiveActivityModule {
  isSupported(): boolean;
  start(attributes: Record<string, string>, state: Record<string, unknown>): Promise<string | null>;
  update(activityId: string, state: Record<string, unknown>, staleAfterSeconds: number): Promise<void>;
  end(activityId: string, state: Record<string, unknown>, dismissAfterSeconds: number): Promise<void>;
  addListener?(event: 'onPushToken', fn: (e: { activityId: string; token: string }) => void): { remove(): void };
}

export interface LiveUpdatePayload {
  title: string;
  text: string;
  /** Short chip text on Android 16 status bar (e.g. "45%" or "6.0 kWh"). */
  shortText: string | null;
  progress: number;
  progressMax: number;
  indeterminate: boolean;
  ongoing: boolean;
  url: string;
}

interface LiveUpdateModule {
  isSupported(): boolean;
  /** true when the platform renders Notification.ProgressStyle (Android 16+, API 36). */
  isProgressStyle(): boolean;
  show(ref: string, payload: LiveUpdatePayload): void;
  end(ref: string): void;
}

const liveActivity = Platform.OS === 'ios' ? requireOptionalNativeModule<LiveActivityModule>('PlugSureLiveActivity') : null;
const liveUpdate = Platform.OS === 'android' ? requireOptionalNativeModule<LiveUpdateModule>('PlugSureLiveUpdate') : null;

/** iOS content state v2 (§15.7). */
export function contentState(s: Snapshot, finished: boolean): Record<string, unknown> {
  const started = s.startedAt ? Math.floor(new Date(s.startedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    status: finished ? 'finished' : 'charging',
    energyWh: Math.round(s.energyKwh * 1000),
    powerW: s.powerKw != null ? Math.round(s.powerKw * 1000) : null,
    socPercent: s.socPercent,
    progressPct: s.progressPct,
    costIdr: finished && s.costFinal ? s.costMinor : null,
    estimateIdr: finished && s.costFinal ? null : s.costMinor,
    startedAt: started,
    endedAt: finished ? Math.floor(Date.now() / 1000) : null,
    currency: s.currency ?? 'IDR',
  };
}

/** The Android progress notification for a snapshot: SoC when known, else the prepaid allowance, else indeterminate. */
export function liveUpdatePayload(ref: string, kind: 'charge' | 'roaming', s: Snapshot, labels: { title: string; body: string }, finished: boolean): LiveUpdatePayload {
  const pct = s.socPercent ?? s.progressPct;
  return {
    title: labels.title,
    text: labels.body,
    shortText: pct != null ? `${Math.round(pct)}%` : `${s.energyKwh.toFixed(1)} kWh`,
    progress: pct != null ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
    progressMax: 100,
    indeterminate: pct == null && !finished,
    ongoing: !finished,
    url: `${brand.scheme}://session/${kind}/${ref}`,
  };
}

const activities = new Map<string, string>();
const registered = new Set<string>();

async function pushToken(): Promise<{ platform: string; token: string } | null> {
  return kv.get<{ platform: string; token: string }>(KEYS.pushToken);
}

async function registerAndroid(ref: string): Promise<void> {
  if (registered.has(ref)) return;
  const saved = await pushToken();
  if (saved?.platform !== 'android') return;
  registered.add(ref);
  await api.push.registerLiveSession('android', ref, saved.token).catch(() => registered.delete(ref));
}

export async function showLiveSession(ref: string, kind: 'charge' | 'roaming', s: Snapshot, labels: { title: string; body: string; appName: string; accentHex: string }, finished = false): Promise<void> {
  try {
    if (liveActivity?.isSupported()) {
      const state = contentState(s, finished);
      const existing = activities.get(ref);
      if (!existing && !finished) {
        const id = await liveActivity.start({ ref, site: s.siteName, connector: s.connectorLabel, appName: labels.appName, accentHex: labels.accentHex }, state);
        if (id) activities.set(ref, id);
      } else if (existing && !finished) {
        await liveActivity.update(existing, state, 180);
      } else if (existing && finished) {
        await liveActivity.end(existing, state, 30 * 60);
        activities.delete(ref);
        void api.push.liveSessionEnded(ref);
      }
      return;
    }
    if (Platform.OS !== 'android') return;
    if (liveUpdate?.isSupported()) {
      if (finished) liveUpdate.end(ref);
      else liveUpdate.show(ref, liveUpdatePayload(ref, kind, s, labels, finished));
    } else if (finished) {
      await Notifications.dismissNotificationAsync(LIVE_ID).catch(() => {});
    } else {
      await Notifications.scheduleNotificationAsync({
        identifier: LIVE_ID,
        content: { title: labels.title, body: labels.body, sticky: true, autoDismiss: false, priority: Notifications.AndroidNotificationPriority.LOW, data: { url: `/session/${kind}/${ref}` } },
        trigger: { channelId: 'live-session' },
      });
    }
    if (!finished) await registerAndroid(ref);
    else void api.push.liveSessionEnded(ref);
  } catch {
    /* lock-screen surfaces are best effort; the in-app session screen is the source of truth */
  }
}

/**
 * An FCM `live_session` data message (§15.7; all values are strings, empty = unknown) → the ongoing notification.
 * Called from the foreground listener and the background notification task (src/native/backgroundTasks.ts).
 */
export function handleLiveSessionData(data: Record<string, unknown>, lang = 'en'): boolean {
  // `session.started` (§15.6): Android's push-to-start — register this phone's FCM token for the charge's live updates.
  if (data.type === 'session.started' && typeof data.ref === 'string' && Platform.OS === 'android') {
    void registerAndroid(data.ref);
    return true;
  }
  if (data.type !== 'live_session' || typeof data.ref !== 'string') return false;
  const str = (k: string) => (typeof data[k] === 'string' && data[k] !== '' ? (data[k] as string) : null);
  const num = (k: string) => (str(k) != null && Number.isFinite(Number(str(k))) ? Number(str(k)) : null);
  const ref = data.ref;
  const kind = str('path') === 'roaming' ? 'roaming' : 'charge';
  const ended = str('event') === 'end' || str('status') === 'finished';
  const energy = (num('energyWh') ?? 0) / 1000;
  const cost = num('costMinor') ?? num('estimateMinor');
  const currency = str('currency') ?? 'IDR';
  const body = [`${energy.toFixed(energy >= 100 ? 1 : 2)} kWh`, num('powerW') != null ? `${Math.round(num('powerW')! / 1000)} kW` : null, cost != null ? formatMoney(cost, currency, lang) : null]
    .filter(Boolean)
    .join(' · ');
  const site = str('site') ?? '';
  const payload: LiveUpdatePayload = {
    title: ended ? `✓ ${site}` : site,
    text: body,
    shortText: num('socPercent') != null ? `${num('socPercent')}%` : `${energy.toFixed(1)} kWh`,
    progress: num('progress') ?? 0,
    progressMax: num('progressMax') ?? 100,
    indeterminate: str('progressIndeterminate') === '1',
    ongoing: str('ongoing') !== '0',
    url: `${brand.scheme}://session/${kind}/${ref}`,
  };
  if (Platform.OS === 'android' && liveUpdate?.isSupported()) {
    if (ended && !payload.ongoing) liveUpdate.end(ref);
    else liveUpdate.show(ref, payload);
  }
  return true;
}

/** Forward ActivityKit update tokens to the backend (call once at startup). */
export function watchLiveActivityTokens(): () => void {
  const sub = liveActivity?.addListener?.('onPushToken', (e) => {
    const ref = [...activities.entries()].find(([, id]) => id === e.activityId)?.[0];
    if (ref) void api.push.registerLiveSession('ios', ref, e.token).catch(() => {});
  });
  return () => sub?.remove();
}

export const liveActivitiesAvailable = () => !!liveActivity?.isSupported();
export const liveUpdatesAvailable = () => !!liveUpdate?.isSupported();
