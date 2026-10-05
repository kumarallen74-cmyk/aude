import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api, runtime } from '@/api/client';
import { kv, KEYS } from '@/lib/storage';

/**
 * Native push: APNs device token on iOS, FCM token on Android — NOT Expo's push service (spec §12.1: the backend
 * owns delivery; each white-label build uses its operator's Firebase project / APNs key).
 */
export const CHANNELS = {
  charging: { name: 'Charging', importance: Notifications.AndroidImportance.HIGH },
  payments: { name: 'Payments', importance: Notifications.AndroidImportance.DEFAULT },
  reservations: { name: 'Reservations & queue', importance: Notifications.AndroidImportance.HIGH },
  account: { name: 'Account', importance: Notifications.AndroidImportance.LOW },
  promotions: { name: 'Promotions', importance: Notifications.AndroidImportance.LOW },
  'live-session': { name: 'Live charging session', importance: Notifications.AndroidImportance.LOW },
} as const;

export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Promise.all(
    Object.entries(CHANNELS).map(([id, ch]) =>
      Notifications.setNotificationChannelAsync(id, {
        name: ch.name,
        importance: ch.importance,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        showBadge: id !== 'live-session',
        enableVibrate: id !== 'live-session' && id !== 'promotions',
      }),
    ),
  );
}

/** Data-only messages that drive the live session (never shown as such: src/native/liveSession.ts handles them). */
const SILENT_TYPES = new Set(['live_session', 'session.started']);

const SILENT = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false } as const;

/** What a notification received in the foreground shows: nothing for data-only / live-session messages. */
export function foregroundPresentation(n: Notifications.Notification): Notifications.NotificationBehavior {
  const { title, body, data } = n.request.content;
  const type = (data as Record<string, unknown> | null | undefined)?.type;
  if (!title && !body) return SILENT;
  if (typeof type === 'string' && SILENT_TYPES.has(type)) return SILENT;
  const live = n.request.identifier === LIVE_ID;
  return { shouldShowBanner: !live, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
}

export function configureForegroundHandler(): void {
  Notifications.setNotificationHandler({ handleNotification: async (n) => foregroundPresentation(n) });
}

export const LIVE_ID = 'live-session';

export type PushResult = 'registered' | 'denied' | 'unsupported' | 'needs_brand' | 'error';

/** Tokens rotate: re-register at every launch when permission was already given (§15.6). Never prompts. */
export async function refreshPushRegistration(lang: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) await registerForPush(lang);
  } catch {
    /* best effort */
  }
}

export async function permissionStatus(): Promise<'granted' | 'denied' | 'undetermined'> {
  if (Platform.OS === 'web') return 'denied';
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
}

/** Ask (after the in-app pre-prompt) and register the native token with the backend. */
export async function registerForPush(lang: string): Promise<PushResult> {
  if (Platform.OS === 'web') return 'unsupported';
  try {
    let p = await Notifications.getPermissionsAsync();
    if (!p.granted && p.canAskAgain) {
      p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    }
    if (!p.granted) return 'denied';
    const tok = await Notifications.getDevicePushTokenAsync();
    watchPushTokenRotation();
    return await registerToken(tok.type, String(tok.data), lang);
  } catch {
    return 'error';
  }
}

async function registerToken(platform: string, token: string, lang: string): Promise<PushResult> {
  await kv.set(KEYS.pushToken, { platform, token });
  return platform === 'ios' ? await api.push.registerApns(token, lang) : await api.push.registerFcm(token, lang);
}

let tokenSub: { remove(): void } | null = null;

/**
 * APNs / FCM tokens rotate while the app runs (FCM onNewToken, APNs re-registration): re-register the new one at once
 * instead of waiting for the next launch. Installed once, after the first successful permission check.
 */
export function watchPushTokenRotation(): void {
  if (tokenSub || typeof Notifications.addPushTokenListener !== 'function') return;
  tokenSub = Notifications.addPushTokenListener((tok) => {
    const token = String(tok.data);
    if (!token || (tok.type !== 'ios' && tok.type !== 'android')) return;
    void (async () => {
      const saved = await kv.get<{ platform: string; token: string }>(KEYS.pushToken);
      if (saved?.platform === tok.type && saved.token === token) return;
      await registerToken(tok.type, token, runtime.lang).catch(() => undefined);
    })();
  });
}

export async function unregisterPush(): Promise<void> {
  const saved = await kv.get<{ platform: string; token: string }>(KEYS.pushToken);
  if (!saved) return;
  if (saved.platform === 'ios') await api.push.removeApns(saved.token);
  else await api.push.removeFcm(saved.token);
  await kv.remove(KEYS.pushToken);
  tokenSub?.remove();
  tokenSub = null;
}

/** The URL a tapped notification carries (`data.url`: universal link or PWA hash link). */
export function urlFromNotification(n: Notifications.Notification): string | null {
  const d = n.request.content.data as Record<string, unknown> | undefined;
  const url = d?.url ?? d?.link;
  return typeof url === 'string' ? url : null;
}
