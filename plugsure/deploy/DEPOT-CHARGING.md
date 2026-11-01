# Depot charging (v1.44.0)

For fleets that must leave charged — buses, delivery vans, taxis. At a depot site the load manager plans each session
by its departure: it charges off-peak when there is time, and first when there is not.

It is set up under **Assets & energy → Depot charging**. Viewing it needs `smartcharging:read`; changing it needs
`smartcharging:write`.

## Setting it up

1. **The site.** It must already have load management (a site limit or a feeder). Then switch on *Depot scheduling*
   for it in the Sites table on the page. Switched off, the site is planned as before.
2. **The vehicles.** Add each vehicle:
   - its name and plate;
   - the card it charges with (one vehicle per card);
   - its fleet account, if any;
   - its battery size;
   - its usual departure (HH:MM, the site's time);
   - a target: the kWh to deliver, or a state of charge with the battery size.

   A session started with the card gets the vehicle's next departure: the next time it is due that is at least 30
   minutes away.

## Where a departure comes from

The first of these that applies:

1. **Set here.** On the page, *Change* or *Set departure* on a session. The departure must be 5 minutes to 7 days
   ahead, with the energy the session must deliver in all.
2. **The car.** An OCPP 2.x car that sends its charging needs: its departure time, energy request or target state of
   charge.
3. **The vehicle.** The vehicle's usual departure and target, found through the card.

A session at a depot site without any of these is planned as usual. It is listed under *Charging without a departure*.

## The plan

Every control-loop run gives each session with a departure one state:

| State | When | What the load manager does |
| --- | --- | --- |
| **ready** | the energy is delivered | holds it at its minimum |
| **on track** | there is time | gives it at least the power it needs, plus 15 %. The tighter the deadline, the higher its priority |
| **deferred** | it is the grid's peak hours now, and the off-peak hours before the departure are enough (with 20 % to spare) | holds it at its minimum until off-peak |
| **at risk** | it needs more than 98 % of the power it can take | gives it its full power, first |
| **missed** | the departure has passed and the energy is not delivered | charges it first |

Peak hours are the site tariff's (default 17:00–22:00).

The page shows each session's *Ready by* time at the power it now has. It is marked *late* if that is after the
departure.

A session that turns *at risk* raises **fleet.vehicle_not_ready** once. Route it under Governance → Alert routing. It
is resolved when the session is ready.

## API

- `GET /v1/depot`
- `PUT /v1/depot/sites/{siteId}` with `{enabled}`
- `PUT /v1/depot/sessions/{sessionId}/departure` with `{departureAt, neededKwh}`
- `GET`, `POST /v1/fleet-vehicles`
- `PUT /v1/fleet-vehicles/{id}` (with `{archive: true}` to archive)

Every change is audited (`depot.*`, `fleet_vehicle.saved`).
