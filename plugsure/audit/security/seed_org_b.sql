-- Second, completely independent tenant: "Rival Charge" (ORG B).
-- Nothing links it to the seeded org A.
INSERT INTO organisation (name, slug, npwp, pkp, iuptlu_number, licence_scheme)
VALUES ('Rival Charge Indonesia','rival-charge','09.876.543.2-100.000', true,'IUPTLU-2025-999999','POPO')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO site (org_id, name, address, kabupaten_kota_code, timezone,
                  grid_tariff_group, connected_kva, phases, spklu_id, pbjt_rate_bps)
SELECT o.id,'Rival Secret Depot Surabaya','Jl. Rahasia 1','3578','Asia/Jakarta',
       'B-3/TM', 250.00, 3, '01.POPO.20.3578.001', 750
FROM organisation o WHERE o.slug='rival-charge'
ON CONFLICT DO NOTHING;

INSERT INTO charge_point (site_id, ocpp_identity, vendor, model, firmware, ocpp_version, status)
SELECT s.id,'RIVAL-DC180-XYZ-001','Rival','DC180','1.2.3','ocpp1.6','online'
FROM site s JOIN organisation o ON o.id=s.org_id WHERE o.slug='rival-charge'
ON CONFLICT (ocpp_identity) DO NOTHING;

INSERT INTO evse (charge_point_id, evse_id, max_power_w)
SELECT cp.id, 1, 180000 FROM charge_point cp WHERE cp.ocpp_identity='RIVAL-DC180-XYZ-001'
ON CONFLICT DO NOTHING;

INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, phases,
                       status, meter_serial, tera_status)
SELECT e.id, 1, 'cCCS2','DC',180000,3,'Charging','RIVAL-METER-SECRET-001','verified'
FROM evse e JOIN charge_point cp ON cp.id=e.charge_point_id
WHERE cp.ocpp_identity='RIVAL-DC180-XYZ-001'
ON CONFLICT DO NOTHING;

INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w, strategy, curtailed)
SELECT s.id, 200000, 20000, 'fair_share', false
FROM site s JOIN organisation o ON o.id=s.org_id WHERE o.slug='rival-charge'
ON CONFLICT (site_id) DO NOTHING;

-- A commercially sensitive session belonging to ORG B
INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key,
                              ocpp_transaction_id, state, started_at, ended_at,
                              meter_start_wh, meter_stop_wh, energy_wh, duration_s, payment_mode)
SELECT o.id, s.id, c.id, cp.id, 'RIVAL-SECRET-SESSION-1','990001','rated',
       now()-interval '2 hour', now()-interval '1 hour', 0, 84000, 84000, 3600, 'postpaid'
FROM organisation o
 JOIN site s ON s.org_id=o.id
 JOIN charge_point cp ON cp.site_id=s.id
 JOIN evse e ON e.charge_point_id=cp.id
 JOIN connector c ON c.evse_uuid=e.id
WHERE o.slug='rival-charge'
ON CONFLICT (idem_key) DO NOTHING;

INSERT INTO webhook_endpoint (org_id, url, secret, events)
SELECT o.id,'https://rival.example/hook','whsec_RIVAL_SUPER_SECRET','{session.ended}'
FROM organisation o WHERE o.slug='rival-charge';

INSERT INTO alert (org_id, severity, kind, message)
SELECT o.id,'critical','rival_internal','ORG B internal alert: Surabaya depot breaker trip'
FROM organisation o WHERE o.slug='rival-charge';
