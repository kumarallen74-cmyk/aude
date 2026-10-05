import { adminHostAllowed, isAdministrator, type AuthResult } from '../services/auth.js';

/**
 * What an authenticated console request may NOT do yet, decided from its credential alone
 * (api/server.ts calls this from the authentication preHandler). null = no hold.
 *
 * Order matters:
 *   1. CONSOLE_ADMIN_HOSTS — an administrator's session is refused outright on any other
 *      host (a cookie never crosses hosts, but a Bearer token can be replayed anywhere).
 *   2. A PENDING session (right password, second factor still to come) opens the code
 *      step and sign-out — nothing else, not even who-am-I. Before the password hold: a
 *      one-time password with two-step verification on still needs its code first.
 *   3. A one-time password opens only who-am-I, reference data, the password change and
 *      sign-out (unchanged since v1.3).
 *   4. An administrator without two-step verification (where it is required) opens only
 *      what enrolment needs — the grace path: the console loads after enrolment.
 */
export type SessionHold = { status: 403; body: { error: string; code: string } };

const is = (method: string, path: string, allowed: Array<[string, string]>) =>
  allowed.some(([m, p]) => m === method && p === path);

export function sessionHold(auth: AuthResult, method: string, path: string, host: unknown): SessionHold | null {
  if (auth.kind === 'session' && !adminHostAllowed(host) && isAdministrator(auth.principal)) {
    return {
      status: 403,
      body: { error: 'Administrator accounts sign in on the operations console address only.', code: 'admin_host_required' },
    };
  }
  if (auth.mfaPending) {
    if (!is(method, path, [['POST', '/v1/auth/mfa/verify'], ['POST', '/v1/auth/logout']])) {
      return { status: 403, body: { error: 'Enter the code from your authenticator app first.', code: 'mfa_required' } };
    }
    return null;
  }
  /**
   * A one-time password (issued at invitation or reset, and typically sent
   * over chat or e-mail) is good for ONE thing: choosing a real password.
   * Until the user has, the API serves only who-am-I, reference data, the
   * password change and sign-out. Before, only the console enforced this; the
   * one-time password worked indefinitely against the API itself.
   */
  if (auth.mustChangePassword) {
    if (!is(method, path, [['GET', '/v1/auth/me'], ['GET', '/v1/meta'], ['POST', '/v1/auth/change-password'], ['POST', '/v1/auth/logout']])) {
      return {
        status: 403,
        body: { error: 'Choose a new password first: your administrator issued a one-time password.', code: 'password_change_required' },
      };
    }
    return null;
  }
  if (auth.mfaEnrolmentRequired) {
    const allowed: Array<[string, string]> = [
      ['GET', '/v1/auth/me'], ['GET', '/v1/meta'], ['GET', '/v1/auth/mfa'],
      ['POST', '/v1/auth/mfa/enrol'], ['POST', '/v1/auth/mfa/enrol/confirm'],
      ['POST', '/v1/auth/change-password'], ['POST', '/v1/auth/logout'],
    ];
    if (!is(method, path, allowed)) {
      return {
        status: 403,
        body: {
          error: 'Set up two-step verification first: it is required for administrator accounts.',
          code: 'mfa_enrolment_required',
        },
      };
    }
  }
  return null;
}
