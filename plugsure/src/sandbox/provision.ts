import { randomBytes } from 'node:crypto';
import { one, many, query, outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';
import { issueApiKey } from '../services/auth.js';
import { SYSTEM_ROLES } from '../services/authz.js';
import * as sites from '../services/sites.js';
import { applyTopology, type EvseSpec } from '../services/chargepoints.js';
import { createTariff, assignTariff } from '../services/tariff-store.js';

/**
 * Developer sandboxes. A sandbox is a separate tenant (organisation) linked to
 * the operator that created it, pre-loaded with a Jakarta site, virtual
 * chargers, a legal tariff and RFID cards, and an API key with full operator
 * rights INSIDE the sandbox only. Its chargers run in the gateway (sandbox/fleet.ts).
 *
 * Isolation: the sandbox is its own org, so row-level security and every
 * org-scoped query keep it apart from the operator's real data, and the key
 * cannot see the parent. Sandbox sites never appear in the driver app or to
 * roaming partners, sandbox orgs cannot connect roaming partners, and their
 * chargers cannot be reached from the network.
 */

export const MAX_SANDBOXES_PER_ORG = 3;

export interface SandboxSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  createdBy: string | null;
  chargePoints: number;
  keys: Array<{ id: string; prefix: string; name: string; createdAt: string; lastUsedAt: string | null }>;
}

export class SandboxError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export async function listSandboxes(parentOrgId: string): Promise<SandboxSummary[]> {
  return outsideRequestScope(async () => {
    const rows = await many<any>(
      `SELECT o.id, o.name, o.slug, o.created_at, o.sandbox_created_by,
              (SELECT count(*)::int FROM charge_point cp JOIN site s ON s.id = cp.site_id
                WHERE s.org_id = o.id AND cp.status <> 'decommissioned') AS charge_points
         FROM organisation o
        WHERE o.sandbox_of_org_id = $1 AND o.archived_at IS NULL
        ORDER BY o.created_at`,
      [parentOrgId],
    );
    const keys = rows.length
      ? await many<any>(
          `SELECT id, org_id, prefix, name, created_at, last_used_at FROM api_key
            WHERE org_id = ANY($1::uuid[]) AND revoked_at IS NULL ORDER BY created_at`,
          [rows.map((r) => r.id)],
        )
      : [];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.sandbox_created_by,
      chargePoints: r.charge_points,
      keys: keys.filter((k) => k.org_id === r.id).map((k) => ({
        id: k.id, prefix: k.prefix, name: k.name, createdAt: new Date(k.created_at).toISOString(),
        lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
      })),
    }));
  });
}

export interface CreatedSandbox {
  id: string;
  name: string;
  slug: string;
  /** Shown once. */
  apiKey: string;
  siteId: string;
  chargePoints: Array<{ identity: string; connectors: number; current: 'AC' | 'DC'; maxPowerKw: number }>;
  tokens: Array<{ uid: string; status: string; holder: string }>;
}

export async function createSandbox(parentOrgId: string, label: string, createdBy: string): Promise<CreatedSandbox> {
  return outsideRequestScope(async () => {
    const parent = await one<{ name: string; sandbox_of_org_id: string | null }>(
      `SELECT name, sandbox_of_org_id FROM organisation WHERE id = $1`,
      [parentOrgId],
    );
    if (!parent) throw new SandboxError(404, 'organisation not found');
    if (parent.sandbox_of_org_id) throw new SandboxError(409, 'a sandbox cannot create sandboxes');
    const n = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM organisation WHERE sandbox_of_org_id = $1 AND archived_at IS NULL`,
      [parentOrgId],
    );
    if ((n?.n ?? 0) >= MAX_SANDBOXES_PER_ORG) {
      throw new SandboxError(409, `at most ${MAX_SANDBOXES_PER_ORG} sandboxes; delete one first`);
    }
    const clean = String(label ?? '').trim().slice(0, 60) || 'Integration';
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    const org = await one<{ id: string; name: string; slug: string }>(
      `INSERT INTO organisation (name, slug, pkp, sandbox_of_org_id, sandbox_created_by)
       VALUES ($1, $2, true, $3, $4) RETURNING id, name, slug`,
      [`${parent.name} — Sandbox: ${clean}`.slice(0, 200), `sandbox-${suffix.toLowerCase()}`, parentOrgId, createdBy],
    );
    const orgId = org!.id;
    try {
      const siteId = await sites.createSite(orgId, sites.siteInputFrom({
        name: 'Sandbox Hub — Kuningan, Jakarta Selatan',
        address: 'Jl. H.R. Rasuna Said Kav. 1, Kuningan, Jakarta Selatan',
        kabupatenKotaCode: '3174', lat: '-6.2297', lon: '106.8295',
        gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000',
      }));

      const chargers: Array<{ identity: string; model: string; evses: EvseSpec[]; current: 'AC' | 'DC'; maxPowerKw: number }> = [
        {
          identity: `SBX-${suffix}-DC60`, model: 'Sandbox DC 60', current: 'DC', maxPowerKw: 60,
          evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC' as const, maxPowerW: 60_000, teraCertStatus: 'verified' as const, teraDueAt: inDays(365) }] })),
        },
        {
          identity: `SBX-${suffix}-AC22`, model: 'Sandbox AC 22', current: 'AC', maxPowerKw: 22,
          evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'sType2', currentKind: 'AC3' as const, maxPowerW: 22_000, teraCertStatus: 'verified' as const, teraDueAt: inDays(365) }] }],
        },
      ];
      for (const c of chargers) {
        const cp = await one<{ id: string }>(
          `INSERT INTO charge_point (site_id, ocpp_identity, status, adopted_at, commissioned_at, display_name,
                                     vendor, model, serial, firmware, ocpp_version, virtual)
           VALUES ($1,$2,'offline',now(),now(),$3,'PlugSure',$4,$2,'1.0.0','ocpp1.6',true) RETURNING id`,
          [siteId, c.identity, `${c.model} (virtual)`, c.model],
        );
        await applyTopology(cp!.id, c.evses);
      }

      const tariff = await createTariff({
        orgId,
        name: 'Sandbox public tariff',
        plnScheme: 'layanan_khusus',
        plnBaseRate: 1645,
        plnMultiplier: 1.5,
        pricingModel: 'flat',
        appliesToMaxPowerW: 22_000,
        ppnApplies: true,
        components: [
          { kind: 'energy', rate: 2400, touBlock: 'ANY' },
          { kind: 'session', rate: 5000, touBlock: 'ANY' },
        ] as never,
        createdBy,
      });
      if (tariff.ok && tariff.tariffId) await assignTariff(tariff.tariffId, 'org', orgId);

      const tokens = [
        { uid: 'SANDBOX-RFID-0001', status: 'Accepted', holder: 'Budi Santoso', account: 'retail', fleet: null },
        { uid: 'SANDBOX-FLEET-0002', status: 'Accepted', holder: 'Sandbox Logistik — Unit 2', account: 'fleet', fleet: 'Sandbox Logistik' },
        { uid: 'SANDBOX-BLOCKED-0003', status: 'Blocked', holder: 'Lost card', account: 'retail', fleet: null },
      ];
      for (const t of tokens) {
        await query(
          `INSERT INTO token (org_id, kind, uid, status, holder_name, account_type, fleet_name)
           VALUES ($1,'rfid',$2,$3,$4,$5,$6) ON CONFLICT (org_id, uid) DO NOTHING`,
          [orgId, t.uid, t.status, t.holder, t.account, t.fleet],
        );
      }

      const key = await issueApiKey({ orgId, name: 'sandbox key', permissions: SYSTEM_ROLES.org_owner! });
      logger.info({ sandbox: orgId, parent: parentOrgId }, 'developer sandbox created');
      return {
        id: orgId,
        name: org!.name,
        slug: org!.slug,
        apiKey: key.key,
        siteId,
        chargePoints: chargers.map((c) => ({ identity: c.identity, connectors: c.evses.length, current: c.current, maxPowerKw: c.maxPowerKw })),
        tokens: tokens.map((t) => ({ uid: t.uid, status: t.status, holder: t.holder })),
      };
    } catch (e) {
      // A half-built sandbox is removed from view rather than left behind.
      await query(`UPDATE organisation SET archived_at = now() WHERE id = $1`, [orgId]).catch(() => {});
      throw e;
    }
  });
}

/** A new key for a sandbox; the old ones stop working at once. */
export async function rotateSandboxKey(parentOrgId: string, sandboxId: string): Promise<{ apiKey: string }> {
  return outsideRequestScope(async () => {
    await mustOwn(parentOrgId, sandboxId);
    await query(`UPDATE api_key SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL`, [sandboxId]);
    const key = await issueApiKey({ orgId: sandboxId, name: 'sandbox key', permissions: SYSTEM_ROLES.org_owner! });
    return { apiKey: key.key };
  });
}

/** Delete a sandbox: keys revoked, virtual chargers stopped, the tenant archived. */
export async function deleteSandbox(parentOrgId: string, sandboxId: string): Promise<void> {
  await outsideRequestScope(async () => {
    await mustOwn(parentOrgId, sandboxId);
    await query(`UPDATE api_key SET revoked_at = now() WHERE org_id = $1 AND revoked_at IS NULL`, [sandboxId]);
    await query(
      `UPDATE charge_point cp SET status = 'decommissioned' FROM site s WHERE s.id = cp.site_id AND s.org_id = $1 AND cp.virtual`,
      [sandboxId],
    );
    await query(`UPDATE site SET archived_at = COALESCE(archived_at, now()) WHERE org_id = $1`, [sandboxId]);
    await query(`UPDATE organisation SET archived_at = now() WHERE id = $1`, [sandboxId]);
  });
}

async function mustOwn(parentOrgId: string, sandboxId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sandboxId)) throw new SandboxError(404, 'sandbox not found');
  const r = await one(`SELECT 1 FROM organisation WHERE id = $1 AND sandbox_of_org_id = $2 AND archived_at IS NULL`, [sandboxId, parentOrgId]);
  if (!r) throw new SandboxError(404, 'sandbox not found');
}

/** The sandbox this organisation IS, if it is one. */
export async function sandboxInfo(orgId: string): Promise<{ id: string; name: string; parentName: string } | null> {
  return outsideRequestScope(async () =>
    one<{ id: string; name: string; parentName: string }>(
      `SELECT o.id, o.name, p.name AS "parentName" FROM organisation o JOIN organisation p ON p.id = o.sandbox_of_org_id
        WHERE o.id = $1 AND o.archived_at IS NULL`,
      [orgId],
    ),
  );
}

export async function isSandboxOrg(orgId: string): Promise<boolean> {
  return !!(await sandboxInfo(orgId));
}
