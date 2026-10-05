# PlugSure CSMS v1.6.0 — release notes

**Date:** 2 October 2026
**Base:** v1.5.1

v1.6.0 adds **"Sign in with Microsoft"** (Microsoft Entra ID, OpenID Connect) to the operator
console. Nothing changes for anyone until the platform operator sets `MS_CLIENT_ID`.

**Upgrade:** `npm ci` (no dependency changes, but the lockfile carries the new version),
`npm run migrate` (migration **058**, additive). Optional: enable Microsoft sign-in following
[`deploy/MICROSOFT-SIGN-IN.md`](deploy/MICROSOFT-SIGN-IN.md). Details at the end.

## Sign in with Microsoft

**Who can sign in.**
- Each operator **organisation connects its own Entra tenant**: *Users & Roles → Microsoft
  sign-in → Connect Microsoft tenant* (user management, `user:write`). The administrator signs in
  at Microsoft with an account of the company's tenant and PlugSure records the tenant of that
  validated sign-in — a tenant id is never typed in. A tenant belongs to **one** organisation on
  the platform (another organisation is refused, without being told which one has it).
  Disconnecting removes every user's link and signs out every session opened with Microsoft.
- **No auto-provisioning.** Only people who already have a console user can sign in. Anyone else
  sees *"Your Microsoft account is not linked to a PlugSure console user. Ask your administrator
  to invite you."*; the refusal is audited and no account is created.
- **Matching.** Inside the organisation the tenant is connected to — and only there — the first
  sign-in matches the console user whose e-mail address is the Microsoft UPN
  (`preferred_username`) or `email` (case-insensitive; optionally restricted to *allowed
  domains*), then links the user to the Microsoft account's immutable ids (tenant id + object id).
  Later sign-ins use the link, so a changed address in Entra cannot move a sign-in onto another
  console user. Refused and audited: tenant not connected, unknown person, a user linked to a
  different Microsoft account, two users matching, disabled or locked users, personal Microsoft
  accounts, administrators on a host outside `CONSOLE_ADMIN_HOSTS`, another operator's accounts on
  an operator's own console address. *Users & Roles* tags linked users **Microsoft** and lets an
  administrator **unlink** one (their Microsoft sessions end).
- **Password sign-in stays** for everyone; there is no Microsoft-only mode.

**Sessions and two-step verification.** A Microsoft sign-in gets the same console session as a
password (cookie, 12-hour lifetime, idle timeout, stream revalidation, sign-out).
- If the ID token's `amr` contains `mfa` (Microsoft checked a second factor), the console's
  two-step verification counts as done for that session: no code step, no forced enrolment
  (`MS_TRUST_MFA_CLAIM=false` turns this off). Microsoft does not always include `amr` in v2.0
  ID tokens; without it the console behaves exactly as after a password: the authenticator-app
  code step for accounts that have one, forced enrolment for administrators under
  `CONSOLE_MFA_REQUIRED`.
- A Microsoft session is **not** held to the one-time-password change: it did not use the
  administrator-issued one-time password, which lapses by itself (`TEMP_PASSWORD_TTL_HOURS`) and
  still works for a password sign-in until then. Forcing a Microsoft user to invent a console
  password they never need would only create a second credential.
- A Microsoft sign-in leaves the password lockout counter alone (it proves nothing about who has
  been guessing the password); a locked account is refused.

**Protocol and hardening** (`src/services/microsoft-signin.ts`, built on `node:crypto`, no new
dependency).
- One multi-tenant app registration for the platform, authority
  `https://login.microsoftonline.com/organizations/v2.0`. Authorization code flow with **PKCE
  (S256)**, `state`, `nonce`, `response_mode=query`, scopes `openid profile email`.
- The sign-in transaction is kept **server-side** (`oidc_login_tx`: sha256 of state and nonce,
  the PKCE verifier sealed with `SECRETS_KEY`, ten minutes, consumed with `DELETE … RETURNING` —
  single use). The console's session cookie is `SameSite=Strict` and is not sent on the way back
  from Microsoft; instead a dedicated `ps_ms_tx` cookie (`HttpOnly`, `SameSite=Lax`, path
  `/v1/auth/microsoft/`, ten minutes) binds the transaction to the browser that started it, which
  stops login CSRF (someone else's callback link finishing their sign-in in your browser).
  `form_post` was not used: it would need a `SameSite=None` cookie.
- The code is redeemed server-side with the client secret and PKCE verifier through the outbound
  guard; the discovery document must name endpoints on the authority's own origin, so the client
  secret cannot be sent elsewhere. Outside development/test only Microsoft sign-in hosts are
  accepted as authority.
- The ID token is validated completely: RS256 only (no `none`, no HMAC), the key by `kid` from
  the JWKS (cached a day; an unknown `kid` re-fetches at most every five minutes), `iss` exactly
  `https://login.microsoftonline.com/<tid>/v2.0` for the token's own tenant (and the key's issuer),
  `aud` = client id (`azp` for several audiences), `exp` / `nbf` / `iat` with 60 s skew and `iat`
  no older than the transaction, `nonce`, `tid` and `oid` present, personal accounts
  (`9188040d-…`) refused.
- Start and return are rate limited per client address (`MS_SIGNIN_RATE_PER_MIN`, default 60).
  Codes, tokens and the secret are never logged; the audit log records start, success (`auth.login`
  with `method: microsoft`), each refusal with its reason (`auth.microsoft_refused`), first links
  (`user.microsoft_bound`), and the tenant connection (`org.microsoft_tenant_linked`,
  `…_link_failed`, `…_updated`, `…_unlinked`) and unlinks (`user.microsoft_unbound`).
- A half-configured feature (id without secret, unreadable secret file, non-Microsoft authority,
  missing or `http://` `PUBLIC_BASE_URL` in production) stops the API at start-up.

**Console.** *Sign in with Microsoft* button on the sign-in page (Microsoft's wording, mark and
colours; only when configured for that address), refusal messages on return; *Users & Roles →
Microsoft sign-in* (tenant id, who connected it, linked users, allowed domains, connect /
disconnect); the **Microsoft** tag and *Unlink Microsoft account* on users. No inline script (the
CSP stays `script-src 'self'`).

**API** (OpenAPI document and SDK regenerated): `GET /v1/auth/microsoft/start` and
`GET /v1/auth/microsoft/callback` (browser, unauthenticated, internal), `POST
/v1/auth/microsoft/link`, `GET|PUT|DELETE /v1/auth/microsoft/tenant`, `DELETE
/v1/users/:id/microsoft`; public `GET /console-sign-in.json`. `GET /v1/auth/me` adds
`user.signedInWith`, `user.mfaViaMicrosoft` and `features.microsoftSignIn`; `GET /v1/users` adds
`microsoft_bound` / `microsoft_bound_at`. All of them answer 404 while `MS_CLIENT_ID` is unset.

**Migration 058** (additive): `org_identity_provider` (RLS like every tenant table; unique
tenant), `app_user.ms_tenant_id / ms_object_id / ms_bound_at` (unique pair),
`auth_session.auth_method / idp_mfa`, `oidc_login_tx` (RLS).

## Security review fixes (before release)

An independent review of the feature found no critical or high issues; these were fixed:

- **Tenant squatting** (M1). Connecting a tenant now needs a **member** account of it holding
  **Global Administrator, Privileged Role Administrator, Cloud Application Administrator or
  Application Administrator**, read from the ID token's `wids` claim — the app registration must
  emit it (*Token configuration → Add groups claim → Directory roles*, i.e.
  `groupMembershipClaims: "DirectoryRole"`); without it the connection is refused as
  `roles_missing`. Guests (`acct` = 1, an `idp` naming another directory, `#EXT#` UPNs) are
  refused (`guest_account`), for connecting and for signing in. Every connection raises a
  `platform.microsoft_tenant_linked` alert for the platform operator, who can list all connected
  tenants and **release** one (*Users & Roles → Microsoft sign-in → All connected tenants*,
  `GET /v1/platform/microsoft-tenants`, `DELETE /v1/platform/microsoft-tenants/:tenantId`,
  platform administrators, audited in both organisations).
- **First-sign-in matching** (M2). The UPN alone decides; `email` is used only without a usable
  UPN and only when `xms_edov` says the tenant verified its domain (optional claim); `#EXT#`
  UPNs are never used. The sign-in that **creates** the link always asks for the console's own
  second factor (the code, or enrolment for an administrator), whatever `amr` says; later ones
  may rely on Microsoft's MFA. The panel warns while no allowed domains are set.
- **Cookie** (L1, L2). The browser-binding cookie is `__Host-ps_ms_tx` (Secure, host-only,
  `Path=/`) on https; `ps_ms_tx` on plain-http benches, where `__Host-` is impossible. A
  duplicated cookie binds nothing. It holds up to four sign-ins in progress, so a second tab no
  longer breaks the first. Abandoned transactions are also purged by the hourly retention worker.
- **API keys** (L3) can no longer change or disconnect the tenant (`PUT`/`DELETE
  /v1/auth/microsoft/tenant`): a signed-in administrator only, like connecting.
- **`MS_TRUST_MFA_CLAIM=false`** (L4) now applies at once to sessions already open: a session that
  rested on Microsoft's MFA for an account needing the console's factor ends (sign in again).
- **One-time passwords** (L5). A completed Microsoft sign-in ends an unused administrator-issued
  one-time password (marked expired, audited `user.one_time_password_ended`), so a password sent
  after a reset for a compromise is not left working.

## Console UI fixes

- **Oversized icons.** `icon()` (web/js/core.js) emitted SVGs with only a viewBox, and
  app.css sized icons only inside specific containers, so an icon anywhere else filled its
  box: the shield on Tariffs & Billing ("How pricing is regulated") and the link arrows on
  Integrations ("Managed on their own pages") rendered hundreds of pixels tall. Icons now
  carry class `ic` with a 1.15em default at zero specificity; every existing container
  rule still wins.
- **Unpadded cards** (text on the card edge) on Integrations, Onboarding → Certificate
  authority, Plug & Charge, Alert routing, Roaming, Statements and Console branding.
- **Undefined classes** now styled or corrected: `pre.code`, `table.table` → `table.t`,
  `.section-head`, `.spinner`; dashboard first-run icon no longer uses the close-button class.
- **Phone width:** Create tariff plan preview no longer covers the form; Plug & Charge
  cards stack; long values in callouts wrap (no sideways page scroll on Hardware quirks).
- **Sidebar** column is painted the full page height.
- Verified by a sweep of all 32 routes, their tabs, dialogs and drawers in dark and light
  at 1366×900 and 390×844: no oversized icons, no page overflow, no JS or CSP errors.

## Upgrade notes / actions for operators

1. Take a database backup. **`npm ci`**, then **`npm run migrate`** (058; on systemd
   `plugsure-migrate.service`). Nothing else is required: without `MS_CLIENT_ID` the console is
   unchanged.
2. **To offer Microsoft sign-in** (platform operator), see `deploy/MICROSOFT-SIGN-IN.md`:
   - Microsoft Entra admin center (entra.microsoft.com) → *Entra ID → App registrations → New
     registration*, **Multiple Entra ID tenants (multitenant)**, *Token configuration*: the **Directory roles** groups claim
     (required to connect tenants) and the optional ID-token claims `email`, `xms_edov`, `acct`;
     Web redirect URI **`<PUBLIC_BASE_URL>/v1/auth/microsoft/callback`**
     (plus one per further console address listed in `MS_SIGNIN_HOSTS`); a client secret
     (calendar its expiry — rotate by adding a second secret, updating
     `MS_CLIENT_SECRET_FILE`, then deleting the old one); optionally publisher verification.
   - Settings: `MS_CLIENT_ID`, `MS_CLIENT_SECRET_FILE` (or `MS_CLIENT_SECRET`), an `https://`
     `PUBLIC_BASE_URL`. The API needs outbound HTTPS to `login.microsoftonline.com`.
   - Restart the API.
3. **Each operator** who wants it: invite staff with the address of their Microsoft account, then
   an administrator clicks *Connect Microsoft tenant* and signs in at Microsoft as a tenant
   administrator (Global / Privileged Role / Cloud Application / Application Administrator), and
   sets the allowed e-mail domains. The platform operator checks the resulting alert. Their **Microsoft (Entra) administrator may
   have to grant admin consent** to PlugSure first (`AADSTS65001` / "Need admin approval").
   Recommended on their side: a Conditional Access policy requiring MFA for PlugSure, and
   *Assignment required* on the enterprise application.
4. Caddy's console access log records the callback URL with its one-time code (single use, minutes,
   PKCE-bound, useless without the client secret). Filter it if your policy requires.

## Verification

- typecheck clean; migrations 001-058 applied to an empty database (twice: idempotent), then seed;
- unit and database tests on a fresh database: **982 passing, 0 failing** (928 + 54 new in
  `src/api/microsoft-signin.test.ts` —
  configuration, ID token checks one by one, the flow with a mock Entra ID on a local port,
  matching and isolation, two-step verification and holds, connecting / disconnecting, feature
  off; and the review fixes: tenant-admin proof and guests, the platform operator's alert and
  release, UPN-first matching and `xms_edov`, the binding sign-in's second factor, the cookie set
  and `__Host-` name, API keys refused, `MS_TRUST_MFA_CLAIM` at request time, one-time password
  ended, retention);
- e2e, split deployment as `plugsure_app`, in the CI job's order: isolation 45/45, pilot fixes
  27/27, field (quick) 132/132, console 106/106, white-label console 45/45, **Sign in with
  Microsoft 27/27** (new suite `npm run e2e:ms-login`, mock Entra ID; added to CI), API +
  sandbox contract 38/38;
- in a browser (headless Chromium): the button, a refusal message, connecting a tenant and signing
  in, with the mock provider on a different site (127.0.0.2) so the `SameSite=Lax` binding cookie
  and the `SameSite=Strict` session cookie were exercised across sites; light and dark theme.
