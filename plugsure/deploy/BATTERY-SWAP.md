# Two-wheeler battery swap (v1.49.0)

**Assets & energy → Battery swap.** Electric motorbike riders swap a flat pack for a charged one at a cabinet.

## Set up

1. *Settings*: turn battery swap on. Set the price per swap (paid from the rider's credit when there is no plan, or
   beyond what the plan includes), the charge at which a pack counts as ready (default 90 %), and the health below
   which a pack is flagged to retire (default 70 %).
2. *Add a cabinet*: its site, a code, a name and the number of slots. The cabinet's address is shown once:
   `https://<console>/v1/swap/cabinets/<key>`. *New key* replaces it.
3. *Riders & plans → Add a plan*: a monthly fee and the swaps it includes (empty: unlimited). A plan with a fee of 0
   and 0 swaps included is pay per swap.
4. Riders need credit for the fee and for paid swaps (Commercial → Driver credit: gift cards, vouchers, top-ups).

## The cabinet's controller

The controller POSTs JSON to its address:

- `{"type": "status", "slots": [{"slot": 1, "serial": "GSB-1001", "soc": 98, "soh": 94, "tempC": 32, "fault": null}]}`:
  every pack in its slots, at least every few minutes. Unknown serials are registered. Packs it stops reporting were
  taken out by hand and go to maintenance. A cabinet silent for 15 minutes raises `swap.cabinet_offline`.
- `{"type": "authorize", "riderCode": "SWP-…"}`: before opening a door. The answer says `allowed`, whether the swap is
  `included` or `paid` (and the amount), or why it is refused (no active plan, not enough credit, no charged pack).
- `{"type": "swap", "reference": "<the cabinet's own id>", "riderCode": "SWP-…", "batteryIn": {"serial", "soc",
  "slot"}, "batteryOut": {"serial", "soc"}}`: a swap done. Sending the same reference again returns the first answer.
  A refused swap answers 402.

The rider shows the code in the app (Akun → Tukar baterai motor). Depending on the cabinet, they type it or the
cabinet reads it.

## Packs

Each pack shows where it is: in a cabinet slot, with a rider, in maintenance or retired. It also shows its charge,
health, temperature and cycles (one per return).

- A pack reporting a fault, or below the retirement health, raises `swap.battery_attention`.
- *Maintenance* and *Retire* take a pack out of service. A pack back from maintenance returns to service when a cabinet
  reports it.

## Plans

Fees are paid from credit when the rider subscribes and at each monthly renewal. Without enough credit at renewal, or
when its plan has been archived, the subscription lapses and swaps stop until the rider subscribes again.
