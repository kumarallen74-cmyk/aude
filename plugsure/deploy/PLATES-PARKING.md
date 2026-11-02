# Number-plate cameras and parking (v1.46.0)

**Assets & energy → Plates & parking.**

## Cameras

1. *Add a camera*: the site, what it sees (cars coming in, going out, or both), and when it opens the barrier (never,
   known cars, everyone). For a barrier, the controller's address (PlugSure POSTs
   `{"action": "open", "plate", "direction", "camera"}`) and, if it needs one, its Authorization header (stored
   sealed). The address goes through the outbound guard: no private or local addresses in production.
2. The camera's address is shown once: `https://<console>/v1/anpr/events/<key>`. Set the camera, or its software, to
   POST each read there as JSON:

   ```json
   {"plate": "B 1234 XYZ", "confidence": 93, "direction": "entry", "at": "2026-11-02T08:15:00Z"}
   ```

   `direction` and `at` are optional; a list of reads also works. Reads below 60 % confidence are recorded but do
   nothing. *New key* replaces the key.

## Stays and the fee

- An entry opens a stay; an exit closes it. Without a direction, a camera that sees both ways treats a plate with an
  open stay as leaving.
- **Site rules:** minutes free after charging ends, the fee per started hour after that (minor units; 0 for none),
  and the longest stay before an alert. Residents and staff (Private charging) do not pay the fee.
- A closed stay with a fee is settled as *Paid* or *Waive*. PlugSure does not collect the fee itself.
- A car parked longer than the longest stay raises `parking.overstay` once; route it in Govern → Alert routing.

## Known cars and plate start

Known cars are fleet vehicles (their plate in Depot charging) and residents or staff with a plate. With *A known car
starts charging when it plugs in* on, a known car with a card on file that arrived in the last 15 minutes starts the
charger it plugs into (the connector reports *Preparing*; PlugSure sends a remote start with that card). It happens
only when exactly one such car is waiting, so the wrong card is never used; otherwise the driver starts as usual.

## Privacy

Plates are personal data. Reads and stays are kept with the operator's other records; tell drivers in the car park's
signage that plates are read, and why.
