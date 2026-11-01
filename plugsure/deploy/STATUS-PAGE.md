# Public status page (v1.43.0)

Each operator can have a public page showing each site's live availability, current incidents, planned maintenance and
the last 14 days. Visitors can subscribe to e-mail updates.

It is set up under **Maintain → Status page**. Viewing it needs `site:read`; posting needs `site:write`.

- **Address:** `/status/<slug>` on the shared console (`CONSOLE_PUBLIC_URL`). On the operator's own approved console
  address it is also at `/status`. The page is off until switched on in Settings.
- **Public data:** `GET /v1/status/<slug>` returns site names and states (and, if shown, connector counts) and what the
  operator wrote in its incidents. It is cached for 30 seconds.
- **Site states:**
  - *working:* every connector online and not faulted (a connector in use counts as working);
  - *partly out of service:* some connectors are out;
  - *out of service:* none can be used;
  - *maintenance:* a planned window is on.

  A connector is out of service when it is offline, faulted, unavailable, or held for maintenance.
- **Incidents and maintenance:**
  - An incident moves through investigating → identified → monitoring → resolved. Planned maintenance moves through
    scheduled → in progress → completed (or cancelled).
  - Every update's message is public.
- **E-mail updates:**
  - Subscribing sends a confirmation link, and nothing else is sent until it is followed. Unconfirmed sign-ups are removed
    after 7 days.
  - Each update e-mail carries a one-click unsubscribe link.
  - Messages go through the operator's e-mail channel (Governance → Alert routing → Channels). Without one, subscribing
    answers that e-mail updates are not available.
  - At most 5 sign-ups a minute per address.

## Rollback

`db/rollback/110_down.sql` drops the page, its incidents and its subscribers.
