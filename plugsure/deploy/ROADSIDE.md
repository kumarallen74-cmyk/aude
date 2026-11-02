# Mobile and roadside charging (v1.49.0)

**Operate → Roadside.** Vans with a battery and a DC charger go to cars that cannot reach a charger.

## Set up

1. *Settings*: turn it on and set:
   - the call-out fee and the price per kWh;
   - the service radius from each van's base;
   - the most kWh one request may ask for;
   - the dispatch phone number, which drivers see in the app.
2. *Add a van*: its usable battery, its charger's power, its base and its technician.

The technician's phone, or the van's tracker, can report the van's position and the energy left with
`PUT /v1/roadside/vans/{id}` and `{lat, lon, kwhLeft}`. Without reports, the van is placed at its base, or where it
last finished a job.

## Requests

- **From the app** (Akun → Isi daya darurat): the driver's location, how much energy, the connector, the charge level
  and a landmark. The app shows the estimated cost first.
- **By phone**: *Take a request*, with the coordinates (from a shared location) and the same details.

A request is refused when it is outside every van's radius, or asks for more than the limit.

## Dispatch

A request's page lists the vans that can take it, nearest first:
- available;
- enough energy left;
- within the radius of their base.

*Send* assigns the van and sets the ETA: the distance at 30 km/h, plus 10 minutes. A van takes one request at a time.
The technician (or the desk) moves the request on: *On the way*, *Arrived, charging*, *Done* with the kWh delivered.
A request waiting 10 minutes without a van raises `roadside.unassigned` (critical): route it to the dispatch desk.

## Paying

When it is done, the price is the call-out fee plus the kWh delivered at the price per kWh.
- It is paid from the driver's credit, as far as the credit goes.
- The rest is collected on site (cash, QRIS, a card terminal) or invoiced, as recorded when the request is marked done.

The van's energy left goes down by the kWh delivered, plus 10 % for losses. Set it back to full after the van recharges.
