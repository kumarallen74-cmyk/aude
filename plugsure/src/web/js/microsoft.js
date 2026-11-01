/**
 * "Sign in with Microsoft" in the console (v1.6.0): the button, and what the server's
 * redirect back from Microsoft (/?ms=<code>) means for the person.
 *
 * The button is a plain link to /v1/auth/microsoft/start: the browser goes to Microsoft and
 * comes back to the callback, which sets the session cookie and redirects to the console.
 * No script takes part in the sign-in itself.
 */

/** Microsoft's four-square mark, drawn inline (an image, not script: allowed by the CSP). */
export const MS_MARK = `<svg viewBox="0 0 21 21" width="21" height="21" aria-hidden="true" focusable="false">
  <rect x="0" y="0" width="10" height="10" fill="#f25022"/><rect x="11" y="0" width="10" height="10" fill="#7fba00"/>
  <rect x="0" y="11" width="10" height="10" fill="#00a4ef"/><rect x="11" y="11" width="10" height="10" fill="#ffb900"/></svg>`;

/** The official wording, "Sign in with Microsoft". */
export const msSignInButton = () =>
  `<a class="ms-signin" href="/v1/auth/microsoft/start" data-ms-signin>${MS_MARK}<span>Sign in with Microsoft</span></a>`;

/**
 * What each outcome code means. Refusals tell the person what to do; the reason in detail is
 * in the audit log for the administrator.
 */
const MESSAGES = {
  not_linked: 'Your organisation has not connected its Microsoft account to PlugSure. Sign in with your email and password, or ask your administrator to connect Microsoft sign-in.',
  no_user: 'Your Microsoft account is not linked to a PlugSure console user. Ask your administrator to invite you.',
  ambiguous: 'Your Microsoft account matches more than one PlugSure console user. Ask your administrator to check the users\' email addresses.',
  oid_conflict: 'This PlugSure console user is linked to a different Microsoft account. Ask your administrator to unlink it under Users & Roles if this is your account.',
  disabled: 'Your PlugSure console user is disabled. Ask your administrator.',
  locked: 'Your PlugSure console user is temporarily locked after failed sign-ins. Try again later.',
  admin_host: 'Administrator accounts sign in on the operations console address only.',
  wrong_host: 'Microsoft sign-in is not available on this console address.',
  personal_account: 'That is a personal Microsoft account. Sign in with your work account.',
  expired: 'That sign-in took too long or was already used. Please try again.',
  cancelled: 'Microsoft sign-in was cancelled.',
  consent: 'Your organisation\'s Microsoft administrator has to approve PlugSure before you can sign in with Microsoft. Ask them to grant consent (see the PlugSure administrator guide).',
  unavailable: 'Microsoft sign-in is not reachable just now. Try again in a minute, or sign in with your password.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  failed: 'Microsoft sign-in did not succeed. Please try again, or sign in with your password.',
  disabled_feature: 'Microsoft sign-in is not set up on this installation.',
  // Connecting the organisation's tenant (Users & Roles → Microsoft sign-in).
  linked: 'Your Microsoft tenant is connected. Your users can now sign in with Microsoft.',
  tenant_taken: 'That Microsoft tenant is already connected to another organisation on PlugSure. Contact PlugSure support if it should be yours.',
  already_linked: 'A different Microsoft tenant is already connected. Disconnect it first.',
  link_forbidden: 'You no longer have permission to manage users, so the tenant was not connected.',
  not_tenant_admin: 'To connect your Microsoft tenant, sign in at Microsoft with an administrator of that tenant (Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator). If your role is eligible through Privileged Identity Management, activate it first.',
  roles_missing: 'Microsoft did not say which administrator roles your account holds, so the tenant was not connected. The PlugSure platform operator has to enable the "Directory roles" claim in the app registration (see the administrator guide).',
  guest_account: 'That Microsoft account is a guest in this tenant. Use an account that belongs to the tenant itself.',
};

export const msMessage = (code) => MESSAGES[code] ?? MESSAGES.failed;

/**
 * The outcome the server put in the address (/?ms=<code>), once: it is removed from the address
 * bar at once, so a reload or a bookmark does not show it again.
 */
let taken = false;
export function takeMsOutcome() {
  if (taken) return null;
  taken = true;
  let consumed = null;
  try {
    const u = new URL(location.href);
    const code = u.searchParams.get('ms');
    if (code && /^[a-z_]{2,40}$/.test(code)) consumed = code;
    if (u.searchParams.has('ms')) {
      u.searchParams.delete('ms');
      history.replaceState(null, '', u.pathname + (u.searchParams.size ? `?${u.searchParams}` : '') + u.hash);
    }
  } catch { /* an old browser: no message */ }
  return consumed;
}

/**
 * Is the button offered on this console address? Fetched once, before sign-in, with whether the
 * deployment offers Malaysia and Singapore (the sign-in page's copy: signInMultiCountry()).
 */
let offered;
let multiCountry = false;
let samlOn = false;
export async function microsoftOffered() {
  if (offered !== undefined) return offered;
  try {
    const r = await fetch('/console-sign-in.json', { credentials: 'same-origin' });
    const j = r.ok ? await r.json() : {};
    offered = j.microsoft === true;
    multiCountry = j.multiCountry === true;
    samlOn = j.saml === true;
  } catch { offered = false; }
  return offered;
}
/** (v1.42.0) Whether some organisation offers SAML single sign-on (known once microsoftOffered() has answered). */
export const samlOffered = () => samlOn;
/** Whether the deployment offers Malaysia and Singapore (known once microsoftOffered() has answered). */
export const signInMultiCountry = () => multiCountry;

// ------------------------------------------------------------------ SAML single sign-on (v1.42.0)

/** What a refused SAML sign-in (/?sso=<code>) means for the person; the detail is in the audit log. */
const SSO_MESSAGES = {
  bad_email: 'Enter your work email address, then choose single sign-on.',
  no_sso: 'Single sign-on is not set up for your email domain. Sign in with your password, or ask your administrator.',
  not_enabled: 'Single sign-on is switched off for your organisation. Sign in with your password.',
  not_configured: 'Single sign-on is not available on this installation yet.',
  no_transaction: 'That sign-in took too long or was already used. Please try again.',
  wrong_browser: 'The sign-in was started in another browser or tab. Start it again here.',
  no_user: 'Your account is not a PlugSure console user yet. Ask your administrator to invite you.',
  no_role: 'None of your groups gives a PlugSure role. Ask your administrator.',
  domain_not_allowed: 'Your email domain is not allowed for this organisation\'s single sign-on.',
  disabled: 'Your PlugSure console user is disabled. Ask your administrator.',
  locked: 'Your PlugSure console user is temporarily locked. Try again later.',
  admin_host: 'Administrator accounts sign in on the operations console address only.',
  wrong_host: 'Single sign-on for your organisation is not available on this console address.',
  idp_refused: 'Your identity provider did not sign you in.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  failed: 'Single sign-on did not succeed. Please try again, or sign in with your password.',
};
export const ssoMessage = (code) => SSO_MESSAGES[code] ?? 'Single sign-on refused this sign-in. Ask your administrator to check the identity provider\'s set-up (the reason is in the audit log).';

let ssoTaken = false;
/** The outcome the server put in the address (/?sso=<code>), once (removed from the address bar). */
export function takeSsoOutcome() {
  if (ssoTaken) return null;
  ssoTaken = true;
  try {
    const u = new URL(location.href);
    const code = u.searchParams.get('sso');
    if (!u.searchParams.has('sso')) return null;
    u.searchParams.delete('sso');
    history.replaceState(null, '', u.pathname + (u.searchParams.size ? `?${u.searchParams}` : '') + u.hash);
    return code && /^[a-z_]{2,40}$/.test(code) ? code : null;
  } catch { return null; }
}
