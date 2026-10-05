import type { Http } from './http';
import type { Account, Me } from './types';

/** Guest device → phone OTP account → fleet (spec §2.1 Identity). */
export const identityApi = (http: Http) => ({
  /** `POST /d/v1/device` → a `psd_…` token, stored in secure storage. */
  issueDevice: () => http.post<{ deviceToken: string; deviceId: string }>('/v1/device'),
  me: () => http.get<Me>('/v1/me'),
  /** E.164 or local number; the server normalises (+62 default). `devCode` only on development servers. */
  sendOtp: (phone: string) => http.post<{ ok: true; devCode?: string }>('/v1/otp/send', { phone }),
  verifyOtp: (phone: string, code: string) => http.post<{ ok: true; account: Account }>('/v1/otp/verify', { phone, code }),
  setName: (name: string) => http.post<{ ok: true }>('/v1/account/name', { name }),
  fleetLogin: (orgSlug: string, rfidUid: string, pin: string) =>
    http.post<{ ok: true; fleet?: { uid: string; orgName?: string } }>('/v1/fleet/login', { orgSlug, rfidUid, pin }),
  signOut: () => http.post<{ ok: true }>('/v1/signout'),
});
