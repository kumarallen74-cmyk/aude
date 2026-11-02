# Residential and workplace charging (v1.46.0)

**Assets & energy → Private charging.**

## A group

1. *Add a group*: the site, residential (units are flats) or workplace (units are teams or cost centres), the billing
   (per unit, per cost centre, or free to members), the rate per kWh (empty: the charger tariff's amounts) and the
   monthly fee per unit. Amounts are in minor units.
2. **Chargers:** tick the site's chargers that belong to the group and *Save*. From then on:
   - they are not on the public map, and the driver app does not sell them;
   - at the charger, only a member's card starts a session (OCPP 1.6 `Authorize` answers `Blocked` to any other card,
     prepaid codes and roaming cards included).
   A charger belongs to one group at a time. Archiving the group makes its chargers public again.
3. **Units and members:** add the units, then members with their card number (a new number is added to RFID cards)
   and, for the plate cameras, their plate.

## Statements

After the month, choose it and *Draft*: one statement per unit that charged or pays a fee, from its members' cards
on the group's chargers in that month (UTC). Drafting again recalculates drafts and keeps issued ones. *Issue*, then
*Paid* when the unit has paid, or *Void*. The *.xlsx* has one row per unit. PlugSure does not send the statements or
collect the money: export them to the building's own billing.

## The manager's page

*Manager's link* makes a secret link, `https://<console>/building/<token>`, shown once. Send it to the building or
office manager. They see the chargers, the units with this month's energy, the members (only the last four digits of
the cards) and the statements, and can add or remove members and add units. Their changes are in the audit log
(`private_group.portal_*`). Making a new link stops the old one.

## API

`/v1/private-groups*`, `/v1/private-statements/{id}/{action}`, and `/v1/building/{token}` for the manager's page.
