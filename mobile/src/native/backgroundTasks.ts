import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { runtime } from '@/api/client';
import { handleLiveSessionData, liveRegistrationSettled } from './liveSession';

/**
 * Android: FCM data messages arrive while the app is in the background or killed. expo-notifications hands them to
 * this headless task (`data.data` = the FCM data map): `live_session` messages (§15.7) update the ongoing / Live Update
 * notification; the data-only `session.started` (a charge started outside the app) registers this phone for the
 * charge's live updates and puts the notification up. The task waits for that registration so the process is not
 * stopped mid-request. Defined at module scope (required by TaskManager) and imported from the root layout.
 */
export const BACKGROUND_NOTIFICATION_TASK = 'plugsure-background-notification';

if (Platform.OS === 'android') {
  TaskManager.defineTask<{ data?: Record<string, unknown> } & Record<string, unknown>>(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const payload = (data.data ?? (data as { notification?: { data?: Record<string, unknown> } }).notification?.data ?? data) as Record<string, unknown>;
    if (handleLiveSessionData(payload, runtime.lang)) await liveRegistrationSettled();
  });
}

export async function registerBackgroundNotificationTask(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch {
    /* Expo Go / no task manager in the binary */
  }
}
