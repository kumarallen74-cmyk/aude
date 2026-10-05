import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { handleLiveSessionData } from './liveSession';

/**
 * Android: FCM data messages arrive while the app is in the background or killed. expo-notifications hands them to
 * this headless task; `live_session` messages (§15.7) update the ongoing / Live Update notification. Defined at
 * module scope (required by TaskManager) and imported from the root layout.
 */
export const BACKGROUND_NOTIFICATION_TASK = 'plugsure-background-notification';

if (Platform.OS === 'android') {
  TaskManager.defineTask<{ data?: Record<string, unknown> } & Record<string, unknown>>(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const payload = (data.data ?? (data as { notification?: { data?: Record<string, unknown> } }).notification?.data ?? data) as Record<string, unknown>;
    handleLiveSessionData(payload);
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
