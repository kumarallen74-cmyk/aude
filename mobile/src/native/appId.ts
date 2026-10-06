import * as Application from 'expo-application';

/**
 * This build's own bundle id (iOS) / package (Android), e.g. `asia.plugsure.hub.preview` — sent as `appId` with every
 * push / Live Activity registration (POST /d/v1/push/apns|fcm, /live-activities, /live-activities/start-token,
 * /live-sessions) so the server uses it as the APNs topic for `.dev` / `.preview` builds. Undefined on web.
 */
export function appId(): string | undefined {
  try {
    return Application.applicationId || undefined;
  } catch {
    return undefined;
  }
}

/** `{ appId }` to spread into a registration body (empty when unknown, e.g. on web). */
export function appIdBody(): { appId?: string } {
  const id = appId();
  return id ? { appId: id } : {};
}
