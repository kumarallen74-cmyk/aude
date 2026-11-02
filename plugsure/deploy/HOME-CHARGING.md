# Home charging reimbursement (v1.47.0)

**Finance → Home charging.** Employees who charge a company car at home are paid back each month for the electricity.

## Set up

1. *Add an employee*: their name, payroll number and how their charging is measured:
   - **An OCPP charger PlugSure manages:** onboard the charger as usual (any site, for example "Home chargers"), then
     choose it here. Its sessions count, or only the sessions of the employee's card when one is chosen. The charger
     leaves the public map and the driver app does not sell it.
   - **Meter readings:** the employee (or you) records the kWh counter of the meter on their charger's circuit.
2. The rate: the employee's home electricity price per kWh in minor units (their tariff, for example PLN R-1 at
   1,444.70 rupiah per kWh), and, if the policy has one, a monthly cap.
3. *Page*: makes the employee's link, `https://<console>/home-charging/<token>`, shown once. The employee sees this
   month so far and their reimbursements; with a meter, they add a reading at the start of each month.

## Each month

1. Choose last month and *Draft*. OCPP: the kWh of the sessions that started in the month (UTC). Meter: the last
   reading in the month minus the last one before it; employees without both readings are listed and get nothing
   until they are added (draft again after).
2. *Approve* (needs `finance:approve`; a finance manager). Drafting again recalculates drafts and keeps approved ones.
3. *Payroll CSV*: the approved reimbursements by payroll number, for the payroll run. Mark them *Paid* once paid.

PlugSure does not pay employees itself, and does not decide how payroll treats the reimbursement for tax: that is for
the company and its tax adviser.

## API

`/v1/home-chargers*`, `/v1/home-reimbursements*` (payroll.csv, .xlsx), and `/v1/home-charging/{token}` for the
employee's page.
