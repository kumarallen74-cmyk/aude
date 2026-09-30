import { pool, one, query } from './pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';
import { SYSTEM_ROLES } from '../services/authz.js';
import { seedQuirks } from '../ocpp/quirks.js';
import { issueApiKey } from '../services/auth.js';
import { hashPassword, generateTemporaryPassword, setUserRole, ensureSystemRoles } from '../services/users.js';

/**
 * Realistic Indonesian demo data:
 *  - a CPO tenant operating under its own IUPTLU
 *  - a Jakarta mall site on a 197 kVA TR connection (just under the 200 kVA cliff)
 *  - Autel AC and DC hardware
 *  - the regulated layanan khusus tariff at N = 1.5, plus a fast-charging service
 *    fee at the Rp 25,000 ceiling and a Rp 4,000 admin fee
 *  - one connector whose tera ulang has lapsed, to exercise the compliance block
 */

async function main() {
  await seedQuirks();

  // NOTE: ON CONFLICT (org_id, name) never fires for system roles — NULL org_id
  // is never equal to NULL in a unique index — so re-seeding used to insert a
  // duplicate of every role. ensureSystemRoles() upserts by lookup instead.
  await ensureSystemRoles();
  void SYSTEM_ROLES;

  const org = await one<{ id: string }>(
    `INSERT INTO organisation (name, slug, npwp, pkp, iuptlu_number, licence_scheme)
     VALUES ('Nusantara Charge Nusantara', 'nusantara-charge', '01.234.567.8-091.000', true,
             'IUPTLU-2025-000871', 'POSO')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const orgId = org!.id;

  await one(
    `INSERT INTO app_user (org_id, email, name) VALUES ($1,'ops@plugsure.com','Ops Team')
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [orgId],
  );

  // Kota Bekasi = 3275, which is also encoded in the SPKLU ID. PBJT is set per
  // kabupaten/kota — 5% here, not a national constant.
  // The seed must be safe to re-run. site has no natural unique key, so this
  // INSERT used to add another copy of the mall on every run (with the
  // chargers left on the first copy). Look it up by its SPKLU ID first.
  const siteA =
    (await one<{ id: string }>(
      `SELECT id FROM site WHERE org_id = $1 AND spklu_id = '01.POSO.20.3275.010' ORDER BY created_at LIMIT 1`,
      [orgId],
    )) ??
    (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, address, kabupaten_kota_code, lat, lon,
                         grid_tariff_group, connected_kva, phases, nominal_voltage_v, power_factor,
                         spklu_id, spklu_scheme, slo_number, slo_issued_at, slo_expires_at, pbjt_rate_bps)
       VALUES ($1, 'Summarecon Mall Bekasi — P2 Basement', 'Jl. Bulevar Ahmad Yani, Bekasi',
               '3275', -6.2246, 106.9998, 'L/TR', 197, 3, 400, 0.95,
               '01.POSO.20.3275.010', 'POSO', 'SLO/2025/JKT/00412', '2025-03-14', '2030-03-13', 500)
       RETURNING id`,
      [orgId],
    ));
  const siteAId = siteA!.id;

  await query(
    `INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w, strategy)
     VALUES ($1, $2, 20000, 'fair_share')
     ON CONFLICT (site_id) DO UPDATE SET ceiling_w = EXCLUDED.ceiling_w`,
    [siteAId, Math.round(197 * 1000 * 0.95)],
  );

  // --- hardware -----------------------------------------------------------

  const hardware: Array<{
    identity: string;
    vendor: string;
    model: string;
    firmware: string;
    connectors: Array<{
      no: number;
      type: string;
      current: 'AC' | 'DC';
      powerW: number;
      phases: number;
      meterSerial: string;
      accuracy: string;
      teraDue: string;
    }>;
  }> = [
    {
      identity: 'AUTEL-AC22-SMB-001',
      vendor: 'Autel',
      model: 'MaxiCharger AC Wallbox',
      firmware: 'V1.4.12',
      connectors: [
        {
          no: 1,
          type: 'sType2',
          current: 'AC',
          powerW: 22_000,
          phases: 3,
          meterSerial: 'MID-AC-77120345',
          accuracy: '1',
          teraDue: inDays(240),
        },
      ],
    },
    {
      identity: 'AUTEL-DC60-SMB-002',
      vendor: 'Autel',
      model: 'MaxiCharger DC Compact',
      firmware: 'V2.1.7',
      connectors: [
        {
          no: 1,
          type: 'cCCS2',
          current: 'DC',
          powerW: 40_000,
          phases: 3,
          meterSerial: 'MID-DC-88451102',
          accuracy: '0.5',
          teraDue: inDays(45), // due_soon → warning alert
        },
        {
          no: 2,
          type: 'cChaDeMo',
          current: 'DC',
          powerW: 40_000,
          phases: 3,
          meterSerial: 'MID-DC-88451103',
          accuracy: '0.5',
          teraDue: inDays(-12), // LAPSED → commercial sessions blocked
        },
      ],
    },
  ];

  for (const h of hardware) {
    const cp = await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, vendor, model, firmware, serial, ocpp_version, status)
       VALUES ($1,$2,$3,$4,$5,$2,'ocpp1.6','offline')
       ON CONFLICT (ocpp_identity) DO UPDATE SET vendor = EXCLUDED.vendor, model = EXCLUDED.model
       RETURNING id`,
      [siteAId, h.identity, h.vendor, h.model, h.firmware],
    );
    for (const c of h.connectors) {
      await query(
        `INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1,$2,$3)
         ON CONFLICT (charge_point_id, evse_id) DO NOTHING`,
        [cp!.id, c.no, c.powerW],
      );
      const e = await one<{ id: string }>(
        `SELECT id FROM evse WHERE charge_point_id = $1 AND evse_id = $2`,
        [cp!.id, c.no],
      );
      await query(
        `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w,
                                phases, meter_serial, meter_accuracy_class, tera_type_approval_no,
                                tera_last_at, tera_due_at)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (evse_uuid, connector_id) DO UPDATE
           SET meter_serial = EXCLUDED.meter_serial, tera_due_at = EXCLUDED.tera_due_at`,
        [
          e!.id,
          c.type,
          c.current,
          c.powerW,
          c.phases,
          c.meterSerial,
          c.accuracy,
          'PT-EVSE-2026-0148',
          inDays(-120),
          c.teraDue,
        ],
      );
    }
  }

  // --- tokens -------------------------------------------------------------

  for (const uid of ['ID-RFID-0001', 'ID-RFID-0002', 'FLEET-GRAB-0007']) {
    await query(
      `INSERT INTO token (org_id, kind, uid, status) VALUES ($1,'rfid',$2,'Accepted')
       ON CONFLICT (org_id, uid) DO NOTHING`,
      [orgId, uid],
    );
  }
  await query(
    `INSERT INTO token (org_id, kind, uid, status) VALUES ($1,'rfid','ID-RFID-BLOCKED','Blocked')
     ON CONFLICT (org_id, uid) DO NOTHING`,
    [orgId],
  );

  // --- tariff -------------------------------------------------------------
  // Layanan khusus at N = 1.5 → 1645 x 1.5 = Rp 2,467.50/kWh, the regulated ceiling.
  // Service fee at the Rp 25,000 fast-charging ceiling, plus a Rp 4,000 admin fee.

  // A re-run used to DELETE every tariff in the org: the operator's own tariffs
  // went too, and once a session referenced one the delete failed halfway and
  // left the org with no tariff at all. Now the seed tariff is created once and
  // anything else is left alone.
  const TARIFF_NAME = 'Public DC — layanan khusus N=1.5';
  const existingTariff = await one<{ id: string }>(
    `SELECT id FROM tariff WHERE org_id = $1 AND name = $2 ORDER BY created_at LIMIT 1`,
    [orgId, TARIFF_NAME],
  );
  const tariff =
    existingTariff ??
    (await one<{ id: string }>(
      `INSERT INTO tariff (org_id, name, pln_scheme, pln_base_rate, pln_multiplier)
       VALUES ($1, $2, 'layanan_khusus', 1645, 1.5)
       RETURNING id`,
      [orgId, TARIFF_NAME],
    ));

  // The Kepmen ESDM 182.K/2023 ceiling for fast charging is Rp 25,000 per
  // session and it covers the admin fee too, so the seed used to ship an illegal
  // Rp 29,000. The idle fee used to have no upper bound, which is how an
  // abandoned vehicle produced a Rp 6,692,360 invoice on a 60 kWh delivery.
  const comps: Array<[string, number, string, number, number, number | null, number]> = [
    // kind, rate, tou_block, from_kwh, from_minutes, to_minutes, sort
    ['energy', 2467.5, 'ANY', 0, 0, null, 0],
    ['session', 21_000, 'ANY', 0, 0, null, 1],
    ['admin', 4_000, 'ANY', 0, 0, null, 2],
    // Idle fee after a 15-minute grace period — an occupancy charge, not an
    // energy charge. Time-based ENERGY pricing is deliberately avoided: with EVSE
    // now classified as UTTP, kWh is the defensible basis of trade. Bounded at
    // 105 minutes → Rp 90,000 worst case, under the platform occupancy cap.
    ['idle', 1_000, 'ANY', 0, 15, 105, 3],
  ];
  if (!existingTariff) {
    for (const [kind, rate, tou, fromKwh, fromMin, toMin, sort] of comps) {
      await query(
        `INSERT INTO tariff_component (tariff_id, kind, rate, tou_block, from_kwh, from_minutes, to_minutes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tariff!.id, kind, rate, tou, fromKwh, fromMin, toMin, sort],
      );
    }
  }
  await query(
    `INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id, priority)
     SELECT $1, 'org', $2, 0
      WHERE NOT EXISTS (SELECT 1 FROM tariff_assignment
                         WHERE tariff_id = $1 AND scope_type = 'org' AND scope_id = $2 AND current_type IS NULL)`,
    [tariff!.id, orgId],
  );

  // --- an operator user with a real role, and an API key -------------------
  const user = await one<{ id: string }>(
    `SELECT id FROM app_user WHERE email = 'ops@plugsure.com'`,
  );
  // The console signs in with a password now. The seed user is a Super
  // Administrator with a known development password (override with
  // SEED_ADMIN_PASSWORD); production bootstraps its first admin with
  // `npm run create-admin` instead of seeding.
  const seedPassword = process.env.SEED_ADMIN_PASSWORD ?? generateTemporaryPassword();
  // A generated password is printed to the log below; in production it must be
  // rotated at first sign-in rather than living on in retained container logs.
  const mustChange = !isRelaxedEnv() && process.env.SEED_ADMIN_PASSWORD === undefined;
  if (user) {
    await query(`UPDATE app_user SET password_hash = $2, must_change_password = $3, status = 'active' WHERE id = $1`, [
      user.id,
      await hashPassword(seedPassword),
      mustChange,
    ]);
    await setUserRole(user.id, orgId, 'super_admin');
  }

  // Card metadata for the RFID centre.
  await query(
    `UPDATE token SET holder_name = v.holder, account_type = v.acct, fleet_name = v.fleet
       FROM (VALUES ('ID-RFID-0001','Budi Santoso','retail',NULL),
                    ('ID-RFID-0002','Siti Rahma','vip',NULL),
                    ('FLEET-GRAB-0007','Grab Fleet — Unit 7','fleet','Grab Indonesia'),
                    ('ID-RFID-BLOCKED','Lost card (reported stolen)','retail',NULL)) AS v(uid, holder, acct, fleet)
      WHERE token.org_id = $1 AND token.uid = v.uid`,
    [orgId],
  );
  await query(
    `INSERT INTO token (org_id, kind, uid, status, holder_name, account_type)
     VALUES ($1,'rfid','TECH-0001','Accepted','Field Technician (test card)','technician')
     ON CONFLICT (org_id, uid) DO NOTHING`,
    [orgId],
  );

  // One live seed key at a time: a re-run rotates it instead of piling up
  // working keys with full org-owner rights.
  await query(
    `UPDATE api_key SET revoked_at = now() WHERE org_id = $1 AND name = 'seed operator key' AND revoked_at IS NULL`,
    [orgId],
  );
  const key = await issueApiKey({
    orgId,
    name: 'seed operator key',
    permissions: SYSTEM_ROLES.org_owner!,
  });

  logger.info({ orgId, siteAId }, 'seed complete');
  logger.info('charge point identities: AUTEL-AC22-SMB-001, AUTEL-DC60-SMB-002');
  logger.info('─────────────────────────────────────────────────────────────');
  logger.info(`API key (shown once):  ${key.key}`);
  logger.info('Use it as:  Authorization: Bearer <key>');
  logger.info(`Console sign-in:  ops@plugsure.com  /  ${seedPassword}`);
  logger.info('─────────────────────────────────────────────────────────────');
  await pool.end();
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
