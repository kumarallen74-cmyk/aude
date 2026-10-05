import type { Http } from './http';
import { ApiError } from './http';

export type PushRegistration = 'registered' | 'needs_brand';

/**
 * §15.6 / §15.7 native push. iOS: APNs device token; Android: FCM registration token; both need a brand
 * (`X-Driver-Brand`, the PlugSure app sends `plugsure`) — 409 `no_brand` otherwise. Re-register at every launch.
 */
export const pushApi = (http: Http) => {
  const brandOnly = async (call: () => Promise<unknown>): Promise<PushRegistration> => {
    try {
      await call();
      return 'registered';
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return 'needs_brand';
      throw e;
    }
  };
  return {
    registerApns: (token: string, lang: string) => brandOnly(() => http.post('/v1/push/apns', { token, lang })),
    removeApns: (token: string) => http.post('/v1/push/apns/remove', { token }).catch(() => undefined),
    registerFcm: (token: string, lang: string) => brandOnly(() => http.post('/v1/push/fcm', { token, lang })),
    removeFcm: (token: string) => http.post('/v1/push/fcm/remove', { token }).catch(() => undefined),
    status: () => http.get<{ subscribed: boolean; webpush: number; apns: number; fcm: number }>('/v1/push'),

    /**
     * §15.7 live session for `ref` (hosted charge id, fleet session id or partner charge id). Android: the FCM token
     * (the server sends `live_session` data messages); iOS: the Live Activity's update token, content-state v2.
     */
    registerLiveSession: (platform: 'android' | 'ios', ref: string, token: string) =>
      brandOnly(() => http.post<{ ok: true; kind: 'charge' | 'session' | 'roaming' }>('/v1/live-sessions', { platform, ref, token, ...(platform === 'ios' ? { contentVersion: 2 } : {}) })),
    liveSessionEnded: (ref: string) => http.post('/v1/live-sessions/ended', { ref }).catch(() => undefined),
    /** iOS 17.2+ push-to-start token (any operator with the network brand). */
    registerLiveActivityStartToken: (token: string) => brandOnly(() => http.post('/v1/live-activities/start-token', { token })),
  };
};
