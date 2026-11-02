# The installation pipeline (v1.48.0)

**Assets & energy → Installations.** Each new site from the first survey to live.

## Stages

| Stage | Usual tasks (editable) |
|---|---|
| Survey | site visit and photos; parking bays and cable route; existing supply and panel capacity; landlord agreement in principle (optional) |
| Design | single-line diagram; layout and civil works drawing; load calculation and kVA; bill of materials and quotation |
| Permits | landlord or building management approval; local permits (PBG/SLF) and the SPKLU registration with ESDM (optional) |
| Grid (PLN) | application submitted; PLN survey and cost letter; connection fee paid; meter installed or power upgraded |
| Install | civil works and cabling; chargers mounted and wired; signage (optional); electrical inspection (SLO) |
| Commission | chargers onboarded and connected; a test charge on every connector; tariff and site published; handover to operations |

A project moves on only when its stage's required tasks are done (*Move to …*, with a note). It goes live only once the
site it became is linked; onboarding its chargers is the commission stage's work (Operate → Onboarding). Cancelling
needs the reason. Every move is in the project's history and the audit log.

## Links and dates

- **Candidate site:** the place scored in Demand & planning.
- **Capex project:** its budget, what has been spent and what is committed (Finance → Capex projects) show on the project.
- **Target go-live:** a project past it raises `install.overdue` (at most once a week; resolved at go-live).

## Documents

PDF, JPEG, PNG, Word, Excel or DWG up to 15 MB (the content must match the type), kept under `STORAGE_DIR/install`.
Keep that directory on a persistent volume and in the backup. *Remove* hides a document from the project; the file is
kept.
