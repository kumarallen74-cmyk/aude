# Sign in with Microsoft (Microsoft Entra ID) — v1.6.0

Operator staff can sign in to the PlugSure console with their company Microsoft account
(Microsoft Entra ID, formerly Azure AD), over OpenID Connect.

All Microsoft-side steps below are done in the **Microsoft Entra admin center**,
<https://entra.microsoft.com>. No Azure subscription is needed. (The same pages also exist in
the Azure portal under *Microsoft Entra ID*; the menu names are the same.)

How it works, in short:

- **One app registration for the whole platform.** The platform operator (whoever runs this
  PlugSure installation) registers PlugSure once in the Microsoft Entra admin center as a *multi-tenant* app and sets three
  settings. Nothing else to install.
- **Each operator organisation connects its own Entra tenant.** An administrator of the operator
  clicks *Connect Microsoft tenant* in the console and signs in at Microsoft with an
  **administrator account of their company's tenant** (Global, Privileged Role, Cloud Application
  or Application Administrator). PlugSure records that tenant from the validated sign-in (nobody
  types a tenant id) and alerts the platform operator. A tenant can belong to one organisation
  only; the platform operator can release a wrongly connected one.
- **No auto-provisioning.** Only people who already have a console user (invited under *Users &
  Roles*) can sign in. Anyone else is refused with *"Your Microsoft account is not linked to a
  PlugSure console user. Ask your administrator to invite you."* and the refusal is in the audit log.
- **Password sign-in stays** for everyone, always.
- **Two-step verification:** when Microsoft reports that it checked a second factor (MFA), the
  console's own two-step verification is not asked again for that session. Otherwise the console
  asks for its authenticator-app code, or makes an administrator enrol, exactly as after a
  password (see *Two-step verification* below).

Part 1 is for the **platform operator** (Microsoft Entra admin center + server settings). Part 2 is for each
**operator's administrator** (and their Microsoft administrator).

---

## Part 1 — platform operator: register PlugSure in the Microsoft Entra admin center

You need a work account in *your own* Entra tenant (the PlugSure company tenant) with at least
the **Application Developer** role (or Cloud Application Administrator / Application
Administrator); a tenant where users may register apps also works. The registration lives there; customers' tenants only consent to it.

### 1. Register the application

1. Sign in at <https://entra.microsoft.com> with that account. If you belong to several tenants,
   check the tenant name top right (*Settings → Directories + subscriptions* to switch).
   Left menu: **Entra ID** → **App registrations** → **New registration**.
2. **Name:** `PlugSure CSMS` (customers see this name on Microsoft's sign-in and consent pages —
   use your product name).
3. **Supported account types:** **Multiple Entra ID tenants** (older screens: *Accounts in any
   organizational directory (Any Microsoft Entra ID tenant - Multitenant)*). Do **not** choose the option that includes personal Microsoft accounts:
   PlugSure refuses them anyway (`9188040d-…` tenant), and offering them only confuses people.
4. **Redirect URI (optional at this step):** select platform **Web**, value:

   ```
   https://<PUBLIC_BASE_URL host>/v1/auth/microsoft/callback
   ```

   e.g. `https://console.example.id/v1/auth/microsoft/callback`. It must match **exactly**
   (scheme, host, no trailing slash) the console address in `PUBLIC_BASE_URL`.
5. **Register**. On the app's **Overview** page copy the **Application (client) ID** →
   `MS_CLIENT_ID`. (The *Directory (tenant) ID* shown next to it is not needed.)

If you skipped the redirect URI, add it under **Manage → Authentication → Add Redirect URI →
Web** (on newer screens: *Redirect URI configuration* tab) → paste the value → **Configure**.

### 2. Further redirect URIs (only if you serve the console on more than one address)

The whole sign-in stays on one host (the browser-binding and session cookies are per host), so
each console address that should show the button needs its own redirect URI:

- an operator's own white-label console address (v1.5.0, *Console branding*), e.g.
  `https://console.nusantaracharge.id/v1/auth/microsoft/callback`;
- an office-only administrator address, if it differs from `PUBLIC_BASE_URL`.

Add each under **Manage → Authentication → Add Redirect URI → Web** (or *Web → Add URI* on the
older screen), and list the host names in
`MS_SIGNIN_HOSTS` (comma-separated). On any other address the button is not shown.

### 3. Token configuration and permissions

All of this is in the app registration (**Entra ID → App registrations → PlugSure CSMS**), menu
**Manage**:

- **Authentication:** leave *Access tokens* and *ID tokens* (implicit grant) **unticked** —
  PlugSure uses the authorization code flow with PKCE and a client secret.
- **API permissions:** **Manage → API permissions** → Microsoft Graph → *Delegated* → `openid`, `profile`, `email` (the
  registration usually starts with `User.Read`; it can stay or go — PlugSure does not call Graph).
  Do not add application permissions.
- **Directory roles (REQUIRED for connecting a tenant):** **Manage → Token configuration → Add
  groups claim →** tick **Directory roles** only (leave security groups unticked) → *Save*. In the
  manifest this is `"groupMembershipClaims": "DirectoryRole"`. It makes Entra put the `wids`
  claim — the ids of the account's tenant-wide directory roles — into the ID token. PlugSure
  only lets a tenant be connected by an account holding **Global Administrator, Privileged Role
  Administrator, Cloud Application Administrator or Application Administrator** in that
  tenant, read from `wids` (proof that the person may speak for the tenant: anyone else could
  claim a tenant for the wrong organisation and block its real owner). Microsoft documents
  `wids` under this setting, not as a default ID token claim: without it every connection is
  refused with *"Microsoft did not say which administrator roles your account holds"*
  (`roles_missing`). Roles that are only *eligible* in Privileged Identity Management must be
  activated before connecting. Ordinary sign-ins do not need `wids`.
- **Optional claims (recommended):** **Manage → Token configuration → Add optional claim →
  Token type: ID →** tick `email`, `xms_edov` and `acct` → **Add** (accept the prompt to add the
  Microsoft Graph `email` permission).
  - The first sign-in is matched by the **UPN** (`preferred_username`). The `email` claim is a
    free-text attribute and is used **only** when there is no usable UPN **and** `xms_edov` says
    the tenant verified the address's domain. It never outvotes a UPN.
  - `acct` lets PlugSure recognise **guest** accounts (`acct` = 1); they are refused, as are
    accounts whose `idp` names another directory and UPNs containing `#EXT#`.
- **About MFA in the token:** PlugSure counts Microsoft MFA only when the ID token's `amr` claim
  contains `mfa`. Microsoft does not always put `amr` into v2.0 ID tokens; when it is absent the
  console simply asks for its own code (safe default). Set `MS_TRUST_MFA_CLAIM=false` to always
  ask for the console's code; it takes effect at once, also for sessions already open (those that
  rested on Microsoft's MFA for an account that needs the console's factor end).

**Publisher verification (recommended):** many tenants allow their users to consent only to
apps of *verified publishers*. Verify the registration's publisher (**Manage → Branding & properties →
Publisher verification**, with your Microsoft Cloud Partner Program id) so that customers' staff
are not all sent to their Microsoft administrator.

### 4. Client secret (and its rotation)

1. **Manage → Certificates & secrets → Client secrets → New client secret.** Description
   `plugsure <date>`, **Expires** 12 or 24 months (the longest Microsoft offers) → **Add**.
2. Copy the **Value** column (not the *Secret ID*) at once — the Entra admin center shows it only
   now. Missed it? Delete that secret and create a new one. Never send it by chat or e-mail.
3. Put it on the server, preferably as a file readable only by the PlugSure user:

   ```sh
   install -m 0400 -o plugsure /dev/null /etc/plugsure/ms-client-secret
   printf '%s' '<the value>' > /etc/plugsure/ms-client-secret
   # /etc/plugsure/plugsure.env:
   MS_CLIENT_SECRET_FILE=/etc/plugsure/ms-client-secret
   ```

   (or `MS_CLIENT_SECRET=<value>` in the environment file; not both).

**Rotation** (put a reminder in the calendar a month before the expiry date — an expired secret
stops every Microsoft sign-in with `AADSTS7000222`):

1. Create a second client secret in the Entra admin center (both work side by side).
2. Write the new value into `/etc/plugsure/ms-client-secret`. The file is read at every sign-in,
   so no restart is needed (with `MS_CLIENT_SECRET` in the environment, restart the API instead).
3. Sign in with Microsoft once to check, then delete the old secret (**Certificates & secrets**, bin icon).

### 5. Server settings

| Variable | Required | Meaning |
|---|---|---|
| `MS_CLIENT_ID` | yes (turns the feature on) | Application (client) ID of the registration. Unset = feature off: no button, the routes answer 404. |
| `MS_CLIENT_SECRET` / `MS_CLIENT_SECRET_FILE` | one of them | The client secret, or a file holding it (read at each sign-in). |
| `PUBLIC_BASE_URL` | yes, `https://` | The console address; the redirect URI is built from it. |
| `MS_SIGNIN_HOSTS` | no | Further console host names that offer the button (each registered in the Entra admin center, step 2). |
| `MS_TRUST_MFA_CLAIM` | no, default `true` | `false`: Microsoft MFA never replaces the console's two-step verification. |
| `MS_SIGNIN_RATE_PER_MIN` | no, default `60` | Start + return requests per client address per minute (an office behind one NAT address: raise it if many people sign in at once). |
| `MS_AUTHORITY_BASE` | no | `https://login.microsoftonline.com` (default). Other Microsoft clouds: `https://login.microsoftonline.us`, `https://login.partner.microsoftonline.cn`. Outside development/test only Microsoft hosts are accepted. |

A half-configured feature (an id without a secret, a secret file that cannot be read, a
non-Microsoft authority or a missing/`http://` `PUBLIC_BASE_URL` in production) stops the API at
start-up with a message naming the problem.

**Network:** the API process must reach `https://login.microsoftonline.com` (HTTPS, outbound) for
discovery, signing keys and the code exchange. Staff browsers must reach Microsoft and the console
address (the console's office IP allow-list in `deploy/Caddyfile` is unaffected: Microsoft sends
the *browser* back, it never calls the console).

**Platform operator duties:** every tenant connection raises an alert *Microsoft tenant
connected* (kind `platform.microsoft_tenant_linked`) in the platform operator's organisation
(`OPS_ALERT_ORG_ID`, else the organisations of platform administrators, as for worker alerts).
Check that the organisation owns the tenant; if not, release it under *Users & Roles → Microsoft
sign-in → All connected tenants* (or `DELETE /v1/platform/microsoft-tenants/<tenant id>`): the
organisation's Microsoft links and sessions end and the owner can connect it.

**Browser cookie:** on https the sign-in's browser-binding cookie is `__Host-ps_ms_tx` (Secure,
host-only, `Path=/`, so a sibling sub-domain cannot plant one); on a plain-http bench, where
Secure cookies are impossible, it is `ps_ms_tx`. It holds up to four sign-ins in progress (tabs).

**Logs:** Caddy's access log records the return URL, which carries the one-time authorization
code. That code is single use, expires within minutes, is bound to PlugSure's PKCE verifier and is
useless without the client secret; PlugSure itself never logs codes or tokens.

Restart the API (`systemctl restart plugsure-api`). The sign-in page now shows **Sign in with
Microsoft**; *Users & Roles* has a **Microsoft sign-in** tab.

---

## Part 2 — an operator's administrator: connect your organisation's tenant

You need a console account with user management (Super Administrator) and, at Microsoft, an
administrator of your company's Entra tenant (one of the four roles below) — or that person next
to you for the connection step.

1. **Invite your staff first** (*Users & Roles → Invite user*) with the e-mail address of their
   Microsoft account (their UPN, e.g. `rina@yourcompany.co.id`). Microsoft sign-in never creates
   users.
2. *Users & Roles → Microsoft sign-in → **Connect Microsoft tenant**.* You are sent to Microsoft:
   sign in with an **administrator account of your company's tenant** — Global Administrator,
   Privileged Role Administrator, Cloud Application Administrator or Application Administrator,
   a member of the tenant, not a guest (activate the role first if it is PIM-eligible). Back in
   the console you see *connected* and the tenant id. The platform operator receives an alert
   for every connection.
3. **Admin consent.** If your company lets users consent to apps, nothing else is needed. Often it
   does not (or only for apps of *verified publishers*): Microsoft then shows *"Need admin
   approval"* (`AADSTS65001` / `AADSTS90094`) and the console says your Microsoft administrator
   has to approve PlugSure. The simplest way: let your **Global Administrator** (or Cloud
   Application / Application Administrator) click *Connect Microsoft tenant* themselves — give them
   a console account with user management for the moment, or sit with them — and tick
   **Consent on behalf of your organization** on Microsoft's consent page. Alternatively they open
   once, while signed in to Microsoft:

   ```
   https://login.microsoftonline.com/<your tenant id or domain>/v2.0/adminconsent?client_id=<MS_CLIENT_ID>&scope=openid%20profile%20email
   ```

   (the platform operator gives you the client id; after approving, Microsoft sends the browser to
   the console, which shows *took too long or was already used* — that is expected), then connect
   again. Afterwards the app appears in the Microsoft Entra admin center under *Entra ID → Enterprise
   applications → PlugSure CSMS*.
4. **Allowed domains — strongly recommended** (the panel warns while it is empty): only
   addresses in these domains are matched at a first sign-in. Without them any UPN of your
   tenant (including `*.onmicrosoft.com` and domains you do not use for staff) can be matched to
   a console user with that address.
5. Optional, in the Microsoft Entra admin center: *Entra ID → Enterprise applications → PlugSure CSMS → Properties → Assignment
   required = Yes* and assign the staff group, so only they can even start a sign-in.

### How people are matched

- First Microsoft sign-in: the console user **of your organisation** whose e-mail address equals
  the Microsoft account's UPN, ignoring case (the `email` claim only without a UPN and only if
  verified, see Part 1 step 3). That Microsoft account (its immutable object id) is then
  **linked** to the console user — the user list shows a **Microsoft** tag.
- **That first, linking sign-in always asks for the console's own second factor** — the
  authenticator-app code, or enrolment for an administrator — even when Microsoft did MFA: it was
  matched by an address alone, so the console vouches for the person once. Later sign-ins may
  rely on Microsoft's MFA.
- Later sign-ins use the link, not the address: renaming someone in Entra does not move their
  sign-in to another console user.
- Refused (and audited): a Microsoft account of another tenant, a person without a console user, a
  console user linked to a *different* Microsoft account, a disabled or locked user, an
  administrator on a host outside `CONSOLE_ADMIN_HOSTS`.
- *Users & Roles → user → Unlink Microsoft account*: removes the link (e.g. a re-created Entra
  account); their Microsoft sessions end; the next sign-in links afresh by address.
- *Disconnect Microsoft tenant*: every link is removed and everyone signed in with Microsoft is
  signed out. Password sign-in is unaffected.

### Two-step verification

| Sign-in | Console asks for |
|---|---|
| Microsoft, token says MFA (`amr` contains `mfa`) | nothing more — counts as two-step verification |
| Microsoft, no MFA in the token, user has an authenticator app | the six-digit code (as after a password) |
| Microsoft, no MFA in the token, administrator without an authenticator app (`CONSOLE_MFA_REQUIRED`) | enrolment before the console opens (as after a password) |
| Password | unchanged |

To rely on Microsoft MFA, require MFA for PlugSure with a Conditional Access policy in your tenant
(Microsoft Entra admin center → *Entra ID → Conditional Access → target the PlugSure CSMS app → Grant: require multifactor
authentication*).

**One-time passwords:** a user invited with a one-time password who signs in with Microsoft is not
made to choose a console password (they did not use it), and the completed Microsoft sign-in
**ends** that one-time password at once (audited as `user.one_time_password_ended`; *Users &
Roles* then shows *one-time password expired*): after a reset because an account was
compromised, a password sent over chat must not stay a way in. If the person needs a password,
reset it again.

---

## Troubleshooting

The console shows a short message; the precise reason is in the audit log (*Governance → Audit*,
actions `auth.microsoft_refused` and `org.microsoft_tenant_link_failed`) and the API log.

| Console message / audit reason | Cause | Fix |
|---|---|---|
| *not connected its Microsoft account* (`not_linked`) | The person's tenant is not connected to any organisation | Administrator: *Connect Microsoft tenant*. |
| *not linked to a PlugSure console user* (`no_user`) | No console user with that address in the organisation (or not in the allowed domains) | Invite them with the UPN of their Microsoft account; check *Allowed domains*. |
| *linked to a different Microsoft account* (`oid_conflict`) | The console user was linked to another Microsoft account | *Unlink Microsoft account* on the user, if this is really them. |
| *personal Microsoft account* (`personal_account`) | outlook.com / live.com account | Use the work account. |
| *took too long or was already used* (`expired`) | More than 10 minutes at Microsoft, the back button, two tabs, or a different browser/host than the one that started | Start again from the sign-in page. |
| *administrator has to approve PlugSure* (`consent`, `AADSTS65001`, `AADSTS90094`) | User consent disabled in the tenant | Admin consent, Part 2 step 3. |
| *did not succeed* (`failed`) with `AADSTS7000215` / `AADSTS7000222` in the audit detail | Wrong or expired client secret | Part 1 step 4. |
| `AADSTS50011` on Microsoft's page | Redirect URI mismatch | The redirect URI in the Entra admin center must equal `PUBLIC_BASE_URL` + `/v1/auth/microsoft/callback` (or the `MS_SIGNIN_HOSTS` host's). |
| `AADSTS700016` on Microsoft's page | Wrong `MS_CLIENT_ID`, or the app is not multi-tenant | Check the client id; *Supported account types* must be multitenant. |
| `AADSTS50105` on Microsoft's page | *Assignment required* is on and the user is not assigned | Assign them in the tenant's Enterprise application. |
| `tenant_taken` | That tenant is connected to another organisation | Ask the platform operator: *Users & Roles → Microsoft sign-in → All connected tenants → Release* (platform administrators; audited in both organisations), then connect again. |
| *sign in … with an administrator of that tenant* (`not_tenant_admin`) | The connecting account holds none of the four roles (or a PIM role not activated) | Connect with a Global / Privileged Role / Cloud Application / Application Administrator. |
| *Microsoft did not say which administrator roles* (`roles_missing`) | No `wids` in the ID token | Platform operator: add the *Directory roles* groups claim (Part 1 step 3). |
| *a guest in this tenant* (`guest_account`) | `acct` = 1, a foreign `idp`, or an `#EXT#` UPN | Use an account of the tenant itself. |
| *not reachable* (`unavailable`) | The API cannot reach login.microsoftonline.com | Outbound HTTPS from the API host; DNS. |
| *Too many sign-in attempts* (`rate_limited`) | `MS_SIGNIN_RATE_PER_MIN` per address | Wait a minute; raise it for a large office behind one NAT. |
