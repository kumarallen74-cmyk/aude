import { one, many, query, tx } from '../db/pool.js';
import { validateTariff, type Tariff, type TariffComponent, type RegulatoryFlag } from './tariff.js';
import { logger } from '../logger.js';

/**
 * Tariff resolution.
 *
 * Resolution order is most-specific-wins: connector > site > org.
 *
 * The tariff effective AT SESSION START is used, never "the current one" —
 * historical invoices must reproduce exactly as issued. The `at` parameter is
 * mandatory for that reason: making it optional is what let the caller silently
 * default to now() and retroactively re-price a session by 3.7x.
 */

export interface ResolvedTariff {
  tariff: Tariff;
  /** True when nothing was assigned and the regulated default was substituted. */
  fallback: boolean;
}

/** The regulated layanan khusus formula at the ceiling multiplier, energy only. */
function defaultTariff(): Tariff {
  return {
    id: 'default',
    name: 'Default (layanan khusus, N=1.5)',
    currency: 'IDR',
    plnScheme: 'layanan_khusus',
    plnMultiplier: 1.5,
    components: [],
  };
}

export async function loadTariffForConnector(
  connectorUuid: string,
  orgId: string,
  at: Date,
): Promise<ResolvedTariff> {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('loadTariffForConnector requires the effective instant (the session start)');
  }

  const row = await one<any>(
    `WITH scope AS (
        SELECT c.id AS connector_uuid, s.id AS site_id, s.org_id, c.current_type
          FROM connector c
          JOIN evse e ON e.id = c.evse_uuid
          JOIN charge_point cp ON cp.id = e.charge_point_id
          JOIN site s ON s.id = cp.site_id
         WHERE c.id = $1
     )
     SELECT t.*
       FROM tariff t
       JOIN tariff_assignment ta ON ta.tariff_id = t.id
       CROSS JOIN scope
      WHERE t.org_id = $2
        AND t.active_from <= $3
        AND (t.active_to IS NULL OR t.active_to > $3)
        AND (
          (ta.scope_type = 'connector' AND ta.scope_id = scope.connector_uuid) OR
          (ta.scope_type = 'site'      AND ta.scope_id = scope.site_id) OR
          (ta.scope_type = 'org'       AND (ta.scope_id IS NULL OR ta.scope_id = scope.org_id))
        )
        -- AC-only / DC-only assignments (migration 009). NULL = any current type,
        -- which is every assignment made before 009, so resolution is unchanged for them.
        AND (ta.current_type IS NULL OR ta.current_type = scope.current_type)
      ORDER BY CASE ta.scope_type WHEN 'connector' THEN 0 WHEN 'site' THEN 1 ELSE 2 END,
               -- Within a scope, an assignment that names the current type is more specific.
               CASE WHEN ta.current_type IS NULL THEN 1 ELSE 0 END,
               ta.priority DESC, t.active_from DESC
      LIMIT 1`,
    [connectorUuid, orgId, at],
  );

  if (!row) {
    // A tariff that has since been closed out is still the right tariff for a
    // session that ran while it was live — the window above uses `at`, not now().
    // Reaching here means nothing was ever assigned for that instant.
    logger.warn({ connectorUuid, orgId, at: at.toISOString() }, 'no tariff effective at session start');
    return { tariff: defaultTariff(), fallback: true };
  }

  return { tariff: await hydrate(row), fallback: false };
}

async function hydrate(row: any): Promise<Tariff> {
  const comps = await many<any>(
    `SELECT kind, rate, tou_block, day_mask, time_from, time_to,
            from_kwh, to_kwh, from_minutes, to_minutes, sort_order
       FROM tariff_component WHERE tariff_id = $1 ORDER BY sort_order, from_kwh`,
    [row.id],
  );

  return {
    id: row.id,
    name: row.name,
    currency: 'IDR',
    plnScheme: row.pln_scheme ?? 'none',
    plnBaseRate: row.pln_base_rate != null ? Number(row.pln_base_rate) : undefined,
    plnMultiplier: row.pln_multiplier != null ? Number(row.pln_multiplier) : undefined,
    // Absent on rows read before migration 009 ran; undefined means "applies".
    ppnApplies: row.ppn_applies === false ? false : undefined,
    components: comps.map(
      (c): TariffComponent => ({
        kind: c.kind,
        rate: Number(c.rate),
        touBlock: c.tou_block,
        dayMask: c.day_mask,
        timeFrom: c.time_from ?? undefined,
        timeTo: c.time_to ?? undefined,
        fromKwh: Number(c.from_kwh),
        toKwh: c.to_kwh != null ? Number(c.to_kwh) : undefined,
        fromMinutes: Number(c.from_minutes),
        toMinutes: c.to_minutes != null ? Number(c.to_minutes) : undefined,
        sortOrder: c.sort_order,
      }),
    ),
  };
}

export async function loadTariffById(tariffId: string): Promise<Tariff | null> {
  const row = await one<any>(`SELECT * FROM tariff WHERE id = $1`, [tariffId]);
  return row ? hydrate(row) : null;
}

// ------------------------------------------------------------------ writes

export interface TariffWriteInput {
  orgId: string;
  name: string;
  plnScheme?: 'curah' | 'layanan_khusus' | 'none';
  plnBaseRate?: number;
  plnMultiplier?: number;
  activeFrom?: Date;
  activeTo?: Date | null;
  components: TariffComponent[];
  /** Nameplate power of the connectors this tariff will serve, for ceiling checks. */
  appliesToMaxPowerW: number;
  createdBy?: string;
  description?: string | null;
  pricingModel?: 'flat' | 'tou' | 'tiered';
  ppnApplies?: boolean;
}

export interface TariffWriteResult {
  ok: boolean;
  tariffId?: string;
  flags: RegulatoryFlag[];
}

/**
 * Create a tariff, enforcing the regulatory ceiling AS A HARD CONSTRAINT.
 *
 * `validateTariff` existed but had no caller on any write path — and there was no
 * write path at all — so an illegal tariff could be inserted directly and would
 * bill at 5.5x the legal maximum with the violation merely annotated on the CDR.
 * This is the gate that was missing.
 */
export async function createTariff(input: TariffWriteInput): Promise<TariffWriteResult> {
  const draft: Tariff = {
    id: 'draft',
    name: input.name,
    currency: 'IDR',
    plnScheme: input.plnScheme ?? 'none',
    plnBaseRate: input.plnBaseRate,
    plnMultiplier: input.plnMultiplier,
    components: input.components,
    ppnApplies: input.ppnApplies,
  };

  const flags = validateTariff(draft, input.appliesToMaxPowerW);
  if (flags.some((f) => f.severity === 'violation')) {
    return { ok: false, flags };
  }

  // The tariff and its components are written together: a failure part-way
  // used to leave a tariff with only some of its prices, which could then be
  // assigned and would under-bill every session.
  const tariffId = await tx(async (db) => {
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO tariff (org_id, name, pln_scheme, pln_base_rate, pln_multiplier,
                             active_from, active_to, validated_at, validation, created_by,
                             description, pricing_model, ppn_applies)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          input.orgId,
          input.name,
          input.plnScheme ?? 'none',
          input.plnBaseRate ?? null,
          input.plnMultiplier ?? null,
          input.activeFrom ?? new Date(),
          input.activeTo ?? null,
          JSON.stringify(flags),
          input.createdBy ?? null,
          input.description ?? null,
          input.pricingModel ?? 'flat',
          input.ppnApplies !== false,
        ],
      )
    ).rows[0];
    if (!row) return null;

    for (const [i, c] of input.components.entries()) {
      await db.query(
        `INSERT INTO tariff_component
           (tariff_id, kind, rate, tou_block, day_mask, time_from, time_to,
            from_kwh, to_kwh, from_minutes, to_minutes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.id,
          c.kind,
          c.rate,
          c.touBlock ?? 'ANY',
          c.dayMask ?? 127,
          c.timeFrom ?? null,
          c.timeTo ?? null,
          c.fromKwh ?? 0,
          c.toKwh ?? null,
          c.fromMinutes ?? 0,
          c.toMinutes ?? null,
          c.sortOrder ?? i,
        ],
      );
    }
    return row.id;
  });

  return tariffId ? { ok: true, tariffId, flags } : { ok: false, flags };
}

/**
 * Attach a tariff to an org, a site, or a single connector.
 *
 * The regulatory ceiling depends on the CONNECTOR's nameplate power, and
 * `createTariff` validates against an `appliesToMaxPowerW` the CALLER supplies.
 * Nothing re-checked that at assignment time, so declaring `60000` (ultrafast,
 * Rp 57,000 ceiling) let a Rp 50,000 service fee be saved and then attached to a
 * 30 kW fast connector whose ceiling is Rp 25,000 — and because a ceiling breach
 * parked every session, every charge on that connector became permanently
 * unbillable. Validate against the connectors the tariff will actually price.
 */
export async function assignTariff(
  tariffId: string,
  scopeType: 'org' | 'site' | 'connector',
  scopeId: string | null,
  priority = 0,
  currentType: 'AC' | 'DC' | null = null,
): Promise<{ ok: boolean; flags: RegulatoryFlag[] }> {
  const tariff = await loadTariffById(tariffId);
  if (!tariff) throw new Error('tariff not found');

  // The most powerful connector in scope is the one with the tightest ceiling
  // it must satisfy... except that ceilings RISE with power, so the binding
  // constraint is the LEAST powerful connector that is still regulated.
  // An AC-only or DC-only assignment is validated against those connectors only.
  const row = await one<{ min_w: number | null; max_w: number | null }>(
    scopeType === 'connector'
      ? `SELECT c.max_power_w AS min_w, c.max_power_w AS max_w FROM connector c
          WHERE c.id = $1 AND ($2::text IS NULL OR c.current_type = $2)`
      : scopeType === 'site'
        ? `SELECT min(c.max_power_w) AS min_w, max(c.max_power_w) AS max_w
             FROM connector c JOIN evse e ON e.id = c.evse_uuid
             JOIN charge_point cp ON cp.id = e.charge_point_id
            WHERE cp.site_id = $1 AND ($2::text IS NULL OR c.current_type = $2)`
        : `SELECT min(c.max_power_w) AS min_w, max(c.max_power_w) AS max_w
             FROM connector c JOIN evse e ON e.id = c.evse_uuid
             JOIN charge_point cp ON cp.id = e.charge_point_id
             JOIN site s ON s.id = cp.site_id
            WHERE s.org_id = $1 AND ($2::text IS NULL OR c.current_type = $2)`,
    [scopeId, currentType],
  );

  const flags: RegulatoryFlag[] = [];
  for (const w of new Set([row?.min_w, row?.max_w].filter((x): x is number => x != null))) {
    for (const f of validateTariff(tariff, w)) {
      if (!flags.some((x) => x.code === f.code)) {
        flags.push({ ...f, message: `${f.message} (against a ${Math.round(w / 1000)} kW connector)` });
      }
    }
  }
  if (flags.some((f) => f.severity === 'violation')) return { ok: false, flags };

  // Re-assigning the same tariff to the same scope replaces the earlier row
  // rather than stacking duplicates the resolver would have to tie-break.
  //
  // The replace is one transaction, so a session starting mid-way never sees
  // the scope with no assignment (and falls back to the default tariff). The
  // advisory lock serialises two concurrent assigns of the same tariff to the
  // same scope: without it both DELETEs found nothing and both INSERTs landed.
  await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `tariff_assignment:${tariffId}:${scopeType}:${scopeId ?? ''}:${currentType ?? ''}`,
    ]);
    await c.query(
      `DELETE FROM tariff_assignment
        WHERE tariff_id = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3
          AND current_type IS NOT DISTINCT FROM $4`,
      [tariffId, scopeType, scopeId, currentType],
    );
    await c.query(
      `INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id, priority, current_type) VALUES ($1,$2,$3,$4,$5)`,
      [tariffId, scopeType, scopeId, priority, currentType],
    );
  });
  return { ok: true, flags };
}

export async function unassignTariff(assignmentId: string, orgId: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM tariff_assignment ta USING tariff t
      WHERE ta.id = $1 AND t.id = ta.tariff_id AND t.org_id = $2`,
    [assignmentId, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Archive: the tariff stops applying to NEW sessions from now on (active_to),
 * and stays attached to every historical session it priced, which keeps those
 * invoices reproducible. There is deliberately no delete.
 */
export async function archiveTariff(tariffId: string, orgId: string): Promise<boolean> {
  const r = await query(
    `UPDATE tariff SET status = 'archived', archived_at = now(), active_to = COALESCE(active_to, now())
      WHERE id = $1 AND org_id = $2 AND status = 'active'`,
    [tariffId, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listTariffs(orgId: string) {
  return many(
    `SELECT t.id, t.name, t.pln_scheme, t.pln_base_rate, t.pln_multiplier,
            t.active_from, t.active_to, t.validated_at, t.validation, t.status, t.description,
            t.pricing_model, t.ppn_applies, t.mdr_mode, t.archived_at, t.created_by,
            COALESCE((SELECT json_agg(json_build_object(
              'kind', tc.kind, 'rate', tc.rate, 'touBlock', tc.tou_block,
              'dayMask', tc.day_mask, 'timeFrom', tc.time_from, 'timeTo', tc.time_to,
              'fromKwh', tc.from_kwh, 'toKwh', tc.to_kwh,
              'fromMinutes', tc.from_minutes, 'toMinutes', tc.to_minutes
            ) ORDER BY tc.sort_order) FROM tariff_component tc WHERE tc.tariff_id = t.id), '[]') AS components,
            COALESCE((SELECT json_agg(json_build_object(
              'id', ta.id, 'scopeType', ta.scope_type, 'scopeId', ta.scope_id, 'priority', ta.priority,
              'currentType', ta.current_type,
              'scopeName', CASE ta.scope_type
                             WHEN 'site' THEN (SELECT s.name FROM site s WHERE s.id = ta.scope_id)
                             WHEN 'connector' THEN (SELECT cp.ocpp_identity || ' #' || e.evse_id
                                                      FROM connector c JOIN evse e ON e.id = c.evse_uuid
                                                      JOIN charge_point cp ON cp.id = e.charge_point_id
                                                     WHERE c.id = ta.scope_id)
                             ELSE 'All sites' END
            )) FROM tariff_assignment ta WHERE ta.tariff_id = t.id), '[]') AS assignments
       FROM tariff t
      WHERE t.org_id = $1
      ORDER BY t.status, t.active_from DESC`,
    [orgId],
  );
}
