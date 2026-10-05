import { requireOptionalNativeModule } from 'expo';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api, runtime } from '@/api/client';
import { brand } from '@/config';
import { formatMoney } from '@/lib/money';
import type { Snapshot } from '@/lib/sessionMachine';
import { kv, KEYS, secret } from '@/lib/storage';
import { LIVE_ID } from './notifications';

/**
 * The charge on the lock screen (spec §12.2–12.3, contract §15.7).
 *
 * iOS — Live Activity (ActivityKit; the app targets iOS 16.4+) via the local Expo module `modules/live-activity` and
 *   the `ChargingWidgets` extension target (plugins/withLiveActivity). Content-state **version 2**: `costIdr` /
 *   `estimateIdr` are minor units of `currency`, which is always present; every number is an integer (Swift `Int`).
 *   The activity's update token is registered with `POST /d/v1/live-sessions {platform:'ios', ref, token,
 *   contentVersion: 2}`; the server then pushes updates. Activities outlive the app: at launch
 *   `watchLiveActivityTokens` adopts the running ones (`list`), and the native `start` reuses a running activity of the
 *   same ref, so a relaunch never shows a second one.
 *
 * Android — one ongoing notification per `ref`: `Notification.ProgressStyle` (Android 16 Live Update) through the local
 *   Expo module `modules/live-update` (Kotlin), else a sticky expo-notifications notification. The FCM token is
 *   registered with `POST /d/v1/live-sessions {platform:'android', ref, token}`; the server's `live_session` and
 *   `session.started` data messages are handled by `handleLiveSessionData` (foreground listener and the background
 *   notification task). The final state (`ongoing:'0'`) stays as a dismissible "finished" notification until
 *   `dismissAt`.
 *
 * When neither native module is in the binary (Expo Go, web) everything here is a no-op or the fallback.
 */
interface LiveActivityModule {
  isSupported(): boolean;
  /** Starts one, or adopts the running activity of the same `ref` (after a relaunch). */
  start(attributes: Record<string, string>, state: Record<string, unknown>): Promise<string | null>;
  update(activityId: string, state: Record<string, unknown>, staleAfterSeconds: number): Promise<void>;
  end(activityId: string, state: Record<string, unknown>, dismissAfterSeconds: number): Promise<void>;
  /** The running activities (the module also starts forwarding their tokens). Absent in older binaries. */
  list?(): Promise<{ id: string; ref: string }[]>;
  addListener?(event: 'onPushToken', fn: (e: PushTokenEvent) => void): { remove(): void };
}

/** `ref` = the activity's attributes.ref: the token can arrive before `start` resolved. */
interface PushTokenEvent {
  activityId: string;
  ref?: string;
  token: string;
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
  /** Auto-dismiss after this many ms (the final state); absent / null = stays. */
  timeoutAfterMs?: number | null;
}

interface LiveUpdateModule {
  isSupported(): boolean;
  /** true when the platform renders Notification.ProgressStyle (Android 16+, API 36). */
  isProgressStyle(): boolean;
  show(ref: string, payload: LiveUpdatePayload): void;
  end(ref: string): void;
}

/** How long the "finished" state stays when the server gives no `dismissAt` (as long as the Live Activity's). */
const FINISHED_DISMISS_S = 30 * 60;

const liveActivity = Platform.OS === 'ios' ? requireOptionalNativeModule<LiveActivityModule>('PlugSureLiveActivity') : null;
const liveUpdate = Platform.OS === 'android' ? requireOptionalNativeModule<LiveUpdateModule>('PlugSureLiveUpdate') : null;

/** A whole number or null: every number in the Swift ContentState is an `Int` (JSONDecoder rejects 41.5). */
const int = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) ? Math.round(v) : null);

/** iOS content state v2 (§15.7). */
export function contentState(s: Snapshot, finished: boolean): Record<string, unknown> {
  const started = s.startedAt ? Math.floor(new Date(s.startedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    status: finished ? 'finished' : 'charging',
    energyWh: Math.round(s.energyKwh * 1000),
    powerW: s.powerKw != null ? Math.round(s.powerKw * 1000) : null,
    socPercent: int(s.socPercent),
    progressPct: int(s.progressPct),
    costIdr: finished && s.costFinal ? int(s.costMinor) : null,
    estimateIdr: finished && s.costFinal ? null : int(s.costMinor),
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

/** Android: the "finished" state — not ongoing (dismissible), removed by the system after `seconds`. */
export function finishedPayload(p: LiveUpdatePayload, seconds: number): LiveUpdatePayload {
  return { ...p, ongoing: false, indeterminate: false, timeoutAfterMs: Math.max(1, Math.round(seconds)) * 1000 };
}

const activities = new Map<string, string>();
const registered = new Set<string>();
/** Android: refs with an ongoing notification posted by this process (only those get the "finished" state). */
const ongoing = new Set<string>();
let registering: Promise<void> = Promise.resolve();

/** Settles when the live-session registration started by the last `session.started` message is done (background task). */
export const liveRegistrationSettled = (): Promise<void> => registering;

async function pushToken(): Promise<{ platform: string; token: string } | null> {
  return kv.get<{ platform: string; token: string }>(KEYS.pushToken);
}

async function registerAndroid(ref: string): Promise<void> {
  if (registered.has(ref)) return;
  const saved = await pushToken();
  if (saved?.platform !== 'android') return;
  registered.add(ref);
  // In the headless background task the root layout (bootstrapAuth) never ran: load the device token here.
  if (!runtime.token) runtime.token = await secret.get(KEYS.deviceToken);
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
        await liveActivity.end(existing, state, FINISHED_DISMISS_S);
        activities.delete(ref);
        void api.push.liveSessionEnded(ref);
      }
      return;
    }
    if (Platform.OS !== 'android') return;
    if (liveUpdate?.isSupported()) {
      const payload = liveUpdatePayload(ref, kind, s, labels, finished);
      if (!finished) {
        ongoing.add(ref);
        liveUpdate.show(ref, payload);
      } else if (ongoing.delete(ref)) {
        liveUpdate.show(ref, finishedPayload(payload, FINISHED_DISMISS_S));
      } else {
        // A past session opened later: nothing of ours is on screen (a background-posted one is ended).
        liveUpdate.end(ref);
      }
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
 * An FCM `live_session` / `session.started` data message (§15.6–15.7; all values are strings, empty = unknown) → the
 * ongoing notification. Called from the foreground listener and the background notification task
 * (src/native/backgroundTasks.ts). Neither is ever shown as a notification of its own (notifications.ts
 * foregroundPresentation).
 */
export function handleLiveSessionData(data: Record<string, unknown>, lang = 'en'): boolean {
  const str = (k: string) => (typeof data[k] === 'string' && data[k] !== '' ? (data[k] as string) : null);
  const num = (k: string) => (str(k) != null && Number.isFinite(Number(str(k))) ? Number(str(k)) : null);
  // `session.started` (data-only on Android): a charge started anywhere (in the app, by RFID, on the web, on another
  // phone) — Android's push-to-start: register this phone's FCM token for the charge's live updates, and put the
  // ongoing notification up straight away when the message names the site (the first `live_session` replaces it).
  if (data.type === 'session.started' && typeof data.ref === 'string' && Platform.OS === 'android') {
    const site = str('site');
    if (site && liveUpdate?.isSupported()) {
      ongoing.add(data.ref);
      liveUpdate.show(data.ref, {
        title: site,
        text: str('connector') ?? '',
        shortText: null,
        progress: 0,
        progressMax: 100,
        indeterminate: true,
        ongoing: true,
        url: `${brand.scheme}://session/${str('path') === 'roaming' ? 'roaming' : 'charge'}/${data.ref}`,
      });
    }
    registering = registerAndroid(data.ref).catch(() => undefined);
    return true;
  }
  if (data.type !== 'live_session' || typeof data.ref !== 'string') return false;
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
  const soc = num('socPercent');
  const payload: LiveUpdatePayload = {
    title: ended ? `✓ ${site}` : site,
    text: body,
    shortText: soc != null ? `${Math.round(soc)}%` : `${energy.toFixed(1)} kWh`,
    progress: Math.round(num('progress') ?? 0),
    progressMax: Math.round(num('progressMax') ?? 100),
    indeterminate: str('progressIndeterminate') === '1',
    ongoing: str('ongoing') !== '0',
    url: `${brand.scheme}://session/${kind}/${ref}`,
  };
  if (Platform.OS === 'android' && liveUpdate?.isSupported()) {
    if (ended && !payload.ongoing) {
      // The "finished ✓" state stays until the server's dismissAt (Unix seconds), else 30 min.
      const dismissAt = num('dismissAt');
      liveUpdate.show(ref, finishedPayload(payload, dismissAt != null ? dismissAt - Date.now() / 1000 : FINISHED_DISMISS_S));
      ongoing.delete(ref);
      registered.delete(ref);
    } else {
      ongoing.add(ref);
      liveUpdate.show(ref, payload);
    }
  }
  return true;
}

/**
 * Forward ActivityKit update tokens to the backend and adopt the activities still running from a previous launch
 * (call once at startup).
 */
export function watchLiveActivityTokens(): () => void {
  const sub = liveActivity?.addListener?.('onPushToken', (e) => {
    const ref = e.ref || [...activities.entries()].find(([, id]) => id === e.activityId)?.[0];
    if (ref) void api.push.registerLiveSession('ios', ref, e.token).catch(() => {});
  });
  void adoptRunningActivities();
  return () => sub?.remove();
}

/** Map the Live Activities that survived an app kill by ref, so the session screen updates / ends them. */
export async function adoptRunningActivities(): Promise<void> {
  try {
    if (!liveActivity?.list || !liveActivity.isSupported()) return;
    for (const a of await liveActivity.list()) if (a.ref && !activities.has(a.ref)) activities.set(a.ref, a.id);
  } catch {
    /* best effort */
  }
}

export const liveActivitiesAvailable = () => !!liveActivity?.isSupported();
export const liveUpdatesAvailable = () => !!liveUpdate?.isSupported();
