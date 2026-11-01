# SAML single sign-on for the console (v1.42.0)

Each operator can connect its own identity provider (Okta, Microsoft Entra ID, Google Workspace, OneLogin, ADFS, or any
other SAML 2.0 provider) so its staff sign in to the console with their work account. It is set up per organisation by that
organisation's administrator under **Users & Roles → Single sign-on (SAML)**. Nothing needs to be installed.

## What the platform needs

- `PUBLIC_BASE_URL` must be set (for example `https://console.plugsure.id`). PlugSure's SAML addresses are built from it.
  Without it, the SAML page says single sign-on is not available.
- PlugSure never calls the identity provider. The browser goes to the provider and comes back, so no outbound network rule
  is needed.
- The clocks must be right: assertions are accepted with three minutes of clock skew at most.

## PlugSure's details for the identity provider

The SAML page shows these, each with a copy button. `<org>` is the organisation's id.

| Identity provider field | Value |
|---|---|
| Entity ID / Audience URI / Identifier | `PUBLIC_BASE_URL/v1/auth/saml/<org>/metadata` |
| ACS URL / Reply URL / Single sign-on URL | `PUBLIC_BASE_URL/v1/auth/saml/<org>/acs` (HTTP-POST) |
| Name ID format | e-mail address (`urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`) |
| Metadata | the entity ID URL serves PlugSure's metadata XML, if the provider can import it |
| Signing | sign the assertion (or the whole response) with **RSA-SHA256** or stronger. SHA-1 is refused. |
| Encryption | off: encrypted assertions are refused |
| Sign-on | started from PlugSure's sign-in page (SP-initiated). IdP-initiated sign-on from a provider's app tile is refused, because it cannot be bound to a browser. |

Attributes:

- **E-mail:** `email`, `mail`, the Microsoft `…/claims/emailaddress` claim or `urn:oid:0.9.2342.19200300.100.1.3`; otherwise
  the Name ID, if it is an e-mail address.
- **Name:** `displayName`, or `givenName` with `surname`. Optional.
- **Groups:** only needed for automatic account set-up. The default names are `groups`, `group`, `memberOf` and the
  Microsoft groups claim. A different attribute name can be set on the page.

## What to enter in PlugSure

1. **The provider's entity ID (issuer)** and its **sign-on URL** (HTTP-Redirect binding, https).
2. **Its signing certificate** (PEM). Up to three can be kept, so a new certificate can be added before the provider
   switches over and the old one removed after.
3. **Allowed e-mail domains**, for example `example.co.id`. The sign-in page picks the organisation from the e-mail
   domain, so a domain can belong to only one organisation's single sign-on.
4. Optionally, **automatic account set-up** with **group → role** rows (below).
5. Turn it on and save. Then sign out and test with **Sign in with single sign-on (SSO)** on the sign-in page, using a
   work e-mail on an allowed domain.

## Accounts

- An account that has signed in before is found by its link to the Name ID.
- Otherwise, the console user with the same e-mail in the organisation is used, and linked from then on.
- Otherwise, if automatic set-up is on and the address is on an allowed domain, a new user is created with the role the
  person's groups map to (the first matching row). If no group maps, the sign-in is refused.
- **A group can never give an administrator role** (any `platform:*` permission, or `user:write`). A compromised or
  misconfigured identity provider therefore cannot create administrators. Invite administrators as before.
- Disabled and locked users stay refused. An administrator account still signs in only on the administration address.
- **Two-step verification:** the identity provider counts as the first factor. A user with an authenticator app still
  enters its code after coming back.
- Password sign-in keeps working for every user. The SAML connection does not turn it off.

## Security notes

- The signature is checked against the stored certificate only. A certificate inside the message is ignored. Only the
  signed parts of the message are read, which defends against signature wrapping.
- Each sign-in is a single-use transaction that lasts ten minutes. The response must answer PlugSure's own request
  (InResponseTo), and the browser that started the sign-in must be the one that finishes it (a `__Host-` cookie). This
  stops replayed and unsolicited assertions and login CSRF.
- Each refusal is in the audit log as `auth.saml_refused`, with the step and the reason. Assertions are never logged.
  New users are logged as `user.saml_provisioned`, and first-time links as `user.saml_linked`.

## When sign-in is refused

The sign-in page shows the reason; the audit log has the detail.

| Reason | Meaning |
|---|---|
| `not_enabled` | single sign-on is off for the organisation, or no organisation uses that e-mail domain |
| `bad_signature` / `weak_signature` / `unsigned` | the certificate does not match the provider's current one, the signature uses SHA-1, or nothing is signed |
| `wrong_issuer` / `wrong_audience` / `wrong_destination` / `not_confirmed` | the provider's entity ID, or PlugSure's entity ID or ACS URL, differ between the two sides |
| `no_transaction` | the sign-in was not started from PlugSure's sign-in page (IdP-initiated), was already used, or is older than ten minutes |
| `expired` | the assertion is outside its validity: check the clocks |
| `wrong_browser` | the sign-in was finished in a different browser, or with cookies blocked |
| `no_user` | there is no such console user and automatic set-up is off: invite the person, or turn it on |
| `no_role` | none of the person's groups is mapped to a role |
| `domain_not_allowed` | the e-mail is not on an allowed domain |

## Rollback

`db/rollback/109_down.sql` removes the SAML tables and ends single sign-on sessions: those users sign in with their
password again.
