# Hotels (v1.48.0)

**Commercial → Hotels.** Guests charge on their room; the hotel's staff start the cars.

## Set up

1. *Add a hotel*: its site, and where charges go:
   - **To the guest's folio:** the PMS's address. PlugSure POSTs each charge when the session ends:
     `{type: "folio_charge", reference, reservationRef, room, guestName, description, amountMinor, currency, kwh,
     sessionId, endedAt}`, signed `X-PlugSure-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>` with the shared
     secret. Any 2xx answer means posted. Failures are retried with back-off; after 10, the charge is *not posted*,
     `hotel.post_failed` is raised, and *Send again* retries it.
   - **On a monthly statement:** the hotel is billed for the month's charges (the statement and its spreadsheet).
2. The PMS's address is shown once: `https://<console>/v1/hotels/pms/<key>`. The PMS (or its interface) POSTs:
   - `{event: "check_in", room, guestName, reservationRef, arrivalOn, departureOn, plate}`
   - `{event: "check_out", reservationRef}` (or `room`)
   - `{event: "room_move", reservationRef, newRoom}`

   A repeated check-in for the same reservation is the same stay. Without a PMS link, check guests in and out in the
   console.
3. *Valet page*: makes the staff's link, `https://<console>/valet/<token>`, shown once. Open it on the valet's phone.

## Using it

The valet plugs the guest's car in, chooses the room and taps *Start* (the charger is started with the stay's own
guest card). *Stop* ends it. A guest's card stops working at check-out; a session still running then ends as usual and
is still charged to the stay.

The charge is the session's charge record (the site's tariff). The guest pays the hotel, and the hotel pays the
operator: through the folio, or on the statement.
