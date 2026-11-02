# Warranty and RMA (v1.49.0)

**Maintain → Warranty & RMA.**

## Warranties

Each charger's warranty records:
- the manufacturer or supplier (Finance → Suppliers);
- the dates;
- what it covers: parts, labour, shipping, on-site service;
- the manufacturer's reference and the terms.

An extended warranty is another warranty, marked as an extension. A charger is:
- **covered**: more than 60 days left;
- **ending soon**: 60 days or less;
- **expired**;
- **no warranty recorded**.

`warranty.expiring` is raised once per warranty, 60 days before its end. Either extend the warranty, or plan for
repairs at cost.

## RMA cases

When a charger or a part goes back to its manufacturer, open a case with:
- the charger;
- what is returned and its serial number;
- the fault;
- optionally, its work order.

The case is **in warranty** or not depending on the charger's warranty on the day it is opened. The supplier defaults
to that warranty's.

| Step | Needs |
|---|---|
| requested | the request sent to the manufacturer |
| approved | the manufacturer's RMA number |
| shipped | the shipment's tracking number |
| replaced | the replacement's serial number. For a whole charger, it can replace the charger's serial number. |
| closed | |
| rejected (any step) | the reason |

- **History**: every step is recorded with who made it and a note.
- **Charges**: out of warranty, record what the manufacturer charges.
- **Stale cases**: a case waiting on the manufacturer (requested, approved or shipped) for 14 days raises `rma.stale`,
  then weekly until it moves on.
- **Money recovered**: the money from a warranty repair (parts, labour) is claimed on the case's work order (Finance →
  Maintenance costs → warranty claim), as before. The RMA case tracks the part itself.
