# SCIM user provisioning (v1.43.0)

An operator's identity provider can create, update and deactivate console users and give them roles from their groups.
This uses SCIM 2.0 (RFC 7643 / 7644); Okta, Microsoft Entra ID, Google Workspace, OneLogin and JumpCloud all support it.
When someone leaves, they lose access as soon as IT removes them: the account is deactivated and every session ends.

It is set up per organisation under **Users & Roles → Provisioning (SCIM)**. Viewing it needs `user:read`; changing it
needs `user:write`.

## Set-up

1. On the SCIM tab, select **Make a token**. It is shown once; only its hash is kept. A new token stops the old one at once.
2. At the identity provider, add a SCIM 2.0 app (Okta: *SCIM provisioning*; Entra ID: *Enterprise application →
   Provisioning*) with:
   - **SCIM base URL** (shown on the tab): `CONSOLE_PUBLIC_URL/scim/v2`, falling back to `PUBLIC_BASE_URL`;
   - **Authentication:** HTTP header, Bearer token: the token from step 1;
   - **User name:** the person's e-mail address.
3. Fill in **Groups → roles** on the tab (or leave it empty to use the SAML tab's list), switch provisioning on and save.
4. Assign the people and groups to the app at the identity provider and start provisioning.

Pair it with single sign-on (SAML or Microsoft): users created by SCIM have no password.

## What happens

- **Create:** a console user with that e-mail in the organisation is taken over and linked. Otherwise a new one is created,
  with no password.
- **Roles:** roles come only from groups. The first group in the list that the person belongs to decides the role; if none
  of their groups is listed, they have no role. The role follows group changes at once.
  - A group never gives an administrator role (`user:write` or `platform:*`) or a site-, owner- or fleet-limited role such
    as Site Host / Landlord. Give those in the Users tab.
- **Administrators are left alone:** provisioning never changes an administrator's role and never deactivates one, so a
  stolen token cannot lock the organisation out. An attempt is answered `400` (`mutability`).
- **Deactivate:** `active: false` or `DELETE` disables the account and ends every session. Nothing is removed: the history
  and the audit trail stay. `active: true` brings the account back.
- **Supported:**
  - Users and Groups: GET (with `filter=attr eq "value"` on userName, externalId or emails.value / displayName, externalId),
    POST, PUT, PATCH and DELETE;
  - `ServiceProviderConfig`, `ResourceTypes` and `Schemas`.
- **Not supported:** bulk operations, sorting, ETags and password changes.
- **Limits:** 600 requests a minute per address and at most 200 results per page.

## Audit

Each change is recorded with `via: scim`:

- `user.scim_provisioned`
- `user.scim_updated`
- `user.scim_deactivated`
- `group.scim_created`
- `group.scim_updated`
- `group.scim_deleted`

Token changes are recorded as `org.scim_token_rotated`, and settings changes as `org.scim_saved`.

## Rollback

`db/rollback/110_down.sql` drops the SCIM configuration, groups and links. Users already created stay, with the roles they
have.
