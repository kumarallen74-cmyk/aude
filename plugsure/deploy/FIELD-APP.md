# The technician field app (v1.46.0)

**Maintain → Field.** Open the console on the technician's phone; add it to the home screen for a full-screen app.

## Set up

1. **Users:** give technicians the *field technician* role. It can work jobs (take, arrive, checklist, photos,
   parts, signature, finish) and ask a charger for its status. It cannot change chargers or plan jobs.
2. **Checklists** (*Checklists* on the Field page; needs `charge_point:write`): one per kind of job (corrective,
   preventive, warranty) or one for any job. Items are required unless marked *(optional)*. Tick *at least one photo*
   or *a signature* to require them before a job can be finished.
3. **Plan jobs:** open a work order in Field and choose *Plan*: the technician, the day and, if not the kind's, the
   checklist. Unassigned open jobs are offered to every technician.

## On site

- *Take this job* assigns it to me; *I have arrived* records the time and starts it.
- *Check now* asks the charger (OCPP TriggerMessage: StatusNotification and Heartbeat) and shows what it says.
- Photos are shrunk on the phone to at most 1600 px before they are sent. They are stored under
  `STORAGE_DIR/field` (keep it on a persistent volume and in the backup).
- Parts come from stock (Finance → Inventory): choose the part and the van or store it came from.
- The signature is drawn on the screen by the site contact or the customer, with their name.

## Without a signal

Changes made without a connection wait in the phone's browser and are sent when it is back (or on the next refresh).
Each change carries its own id: the server applies it once, so sending it twice does no harm. Clearing the browser's
data on the phone before they are sent loses them.

## API

`/v1/field/*` (OpenAPI tag *Chargers*). Photos are data URLs (`data:image/jpeg;base64,…`).
