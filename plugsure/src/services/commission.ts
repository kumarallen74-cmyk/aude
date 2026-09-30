import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import { estimateQrisMdrIdr } from './payments/provider.js';
import { DEFAULT_PLAN, computeStatement, normalisePlan, type ChargerInput, type Plan, type SiteInput, type Statement } from './commission-calc.js';

/**
 * Platform commission and fee statements — loading the month from the database.
 * The arithmetic is in commission-calc.ts.
 *
 * Which month a session belongs to: the month its CDR was ISSUED (rated), in
 * BILLING_TIMEZONE. A finalised month therefore never changes: a transaction a
 * charger uploads late is billed in the month it was rated.
 *
 * A draft for the current month projects the minimum and the private fee to the
 * end of the month (what will be due if nothing changes). Only a month that has
 * ended can be finalised.
 */

export const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function currentPeriod(now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}`;
}

// Compare NORMALISED plans: JSONB does not keep key order, so a stored copy of
// the published plan never string-matches the in-memory one.
const canonical = (p: Plan) => JSON.stringify((normalisePlan(p) as { plan: Plan }).plan);
const DEFAULT_CANON = canonical(DEFAULT_PLAN);
const isDefault = (p: Plan) => canonical(p) === DEFAULT_CANON;

/**
 * The plan in force for a month: the latest version effective on or before it.
 * Versions matter because a month must be billed at the rates agreed for that
 * month — re-pricing August because the contract changed on 27 September would
 * be wrong, and finalising late would silently apply the new rates.
 */
export async function planFor(orgId: string, period = currentPeriod(), ownerId: string | null = null): Promise<{ plan: Plan; custom: boolean; effectiveFrom: string | null; updatedAt: Date | null; ownPlan: boolean }> {
  // Two separate contracts: the organisation with the platform (ownerId null) and
  // an owner with the organisation. An owner without its own plan is on the
  // published rates — never on the plan the organisation agreed with the platform.
  const row = await one<{ plan: any; effective_from: string; updated_at: Date; own: boolean }>(
    `SELECT plan, to_char(effective_from, 'YYYY-MM') AS effective_from, updated_at, owner_id IS NOT NULL AS own
       FROM commercial_plan
      WHERE org_id = $1 AND effective_from <= ($2 || '-01')::date AND owner_id IS NOT DISTINCT FROM $3
      ORDER BY effective_from DESC LIMIT 1`,
    [orgId, period, ownerId],
  );
  if (!row) return { plan: DEFAULT_PLAN, custom: false, effectiveFrom: null, updatedAt: null, ownPlan: false };
  const n = normalisePlan(row.plan);
  const plan = 'plan' in n ? n.plan : DEFAULT_PLAN;
  return { plan, custom: !isDefault(plan), effectiveFrom: row.effective_from, updatedAt: row.updated_at, ownPlan: row.own };
}

export async function planHistory(orgId: string, ownerId: string | null = null) {
  const rows = await many<{ effective_from: string; plan: any; updated_at: Date }>(
    `SELECT to_char(effective_from, 'YYYY-MM') AS effective_from, plan, updated_at FROM commercial_plan
      WHERE org_id = $1 AND owner_id IS NOT DISTINCT FROM $2 ORDER BY effective_from DESC`,
    [orgId, ownerId],
  );
  return rows.map((r) => {
    const n = normalisePlan(r.plan);
    const plan = 'plan' in n ? n.plan : DEFAULT_PLAN;
    return { effectiveFrom: r.effective_from, plan, custom: !isDefault(plan), updatedAt: r.updated_at };
  });
}

/**
 * Set the plan from a month on (a new version, or a correction of that month's
 * version). `null` returns to the published rates from that month. A month
 * already finalised cannot be re-priced.
 */
export async function savePlan(orgId: string, raw: unknown, actor: string | null, effectiveFrom = currentPeriod(), ownerId: string | null = null) {
  if (!PERIOD_RE.test(effectiveFrom)) return { error: 'effectiveFrom must be YYYY-MM' };
  const last = await one<{ p: string | null }>(
    `SELECT to_char(max(period), 'YYYY-MM') AS p FROM commission_statement WHERE org_id = $1 AND owner_id IS NOT DISTINCT FROM $2`,
    [orgId, ownerId],
  );
  if (last?.p && effectiveFrom <= last.p) return { error: `Statements up to ${last.p} are final; a plan can take effect from the month after.` };
  const n = raw === null ? { plan: DEFAULT_PLAN } : normalisePlan(raw);
  if ('error' in n) return n;
  // "Published rates" is stored as a marker, not a copy, so the customer follows
  // the published rates if they change (normalisePlan({published:true}) = today's
  // defaults). A copy would freeze whatever was published on the day of the reset.
  const stored = raw === null ? { published: true } : n.plan;
  await query(
    `INSERT INTO commercial_plan (org_id, owner_id, effective_from, plan, updated_by) VALUES ($1, $5, ($2 || '-01')::date, $3, $4)
     ON CONFLICT (org_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from)
     DO UPDATE SET plan = EXCLUDED.plan, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [orgId, effectiveFrom, JSON.stringify(stored), actor, ownerId],
  );
  return { plan: n.plan, effectiveFrom };
}

export async function setSiteModel(siteId: string, model: string) {
  if (model !== 'public' && model !== 'private') return { error: 'model is public or private' };
  const r = await one<{ org_id: string; name: string }>(`UPDATE site SET billing_model = $2 WHERE id = $1 RETURNING org_id, name`, [siteId, model]);
  return r ? { site: r } : { error: 'not found' };
}

/**
 * Compute the statement for a month from live data: for the whole organisation
 * (ownerId undefined), for one owner's sites (ownerId), or for the sites that
 * have no owner (ownerId null — the operator's own sites).
 */
export async function draftStatement(orgId: string, period: string, ownerId?: string | null): Promise<Statement & { status: 'draft'; projected: boolean }> {
  const tz = config.billing.timeZone;
  const b = await one<{ start: Date; end: Date; days: number; now: Date }>(
    `SELECT (($1 || '-01')::date)::timestamp AT TIME ZONE $2 AS start,
            ((($1 || '-01')::date + interval '1 month'))::timestamp AT TIME ZONE $2 AS "end",
            EXTRACT(DAY FROM (($1 || '-01')::date + interval '1 month' - interval '1 day'))::int AS days,
            now() AS now`,
    [period, tz],
  );
  const start = new Date(b!.start).getTime(), end = new Date(b!.end).getTime();
  const monthMs = end - start;

  const { plan } = await planFor(orgId, period, ownerId ?? null);
  const scope = ownerId === undefined ? 'all' : ownerId === null ? 'none' : 'owner';
  const sites = await many<{ id: string; name: string; billing_model: 'public' | 'private' }>(
    `SELECT id, name, billing_model FROM site
      WHERE org_id = $1
        AND ($2 = 'all' OR ($2 = 'none' AND owner_id IS NULL) OR ($2 = 'owner' AND owner_id = $3::uuid))
      ORDER BY name`,
    [orgId, scope, ownerId ?? null],
  );
  const cps = await many<{ id: string; ocpp_identity: string; display_name: string | null; site_id: string; commissioned_at: Date | null; decommissioned_at: Date | null; status: string; dc: boolean }>(
    `SELECT cp.id, cp.ocpp_identity, cp.display_name, cp.site_id, cp.commissioned_at, cp.decommissioned_at, cp.status,
            EXISTS (SELECT 1 FROM evse e JOIN connector c ON c.evse_uuid = e.id WHERE e.charge_point_id = cp.id AND c.current_type = 'DC') AS dc
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $1`,
    [orgId],
  );
  const sessions = await many<{ charge_point_id: string; subtotal_idr: string; pbjt_idr: string; ppn_idr: string; total_idr: string; energy_wh: string; method: string | null; captured: string | null; paid_at: Date | null; needs_review: boolean }>(
    `SELECT cs.charge_point_id, d.subtotal_idr, d.pbjt_idr, d.ppn_idr, d.total_idr, cs.energy_wh,
            pi.method, pi.amount_captured_idr AS captured, pi.created_at AS paid_at, cs.needs_review
       FROM cdr d
       JOIN charging_session cs ON cs.id = d.session_id
       LEFT JOIN payment_intent pi ON pi.id = cs.payment_intent_id
      WHERE d.org_id = $1 AND d.issued_at >= $2 AND d.issued_at < $3`,
    [orgId, b!.start, b!.end],
  );

  const byCp = new Map<string, ChargerInput>();
  for (const c of cps) {
    // In service = commissioned, and not yet decommissioned, during the month.
    let frac = 0;
    if (c.commissioned_at && c.status !== 'pending_adoption') {
      const from = Math.max(start, new Date(c.commissioned_at).getTime());
      const to = Math.min(end, c.decommissioned_at ? new Date(c.decommissioned_at).getTime() : end);
      frac = to > from ? (to - from) / monthMs : 0;
    }
    byCp.set(c.id, {
      chargePointId: c.id, ocppIdentity: c.ocpp_identity, displayName: c.display_name, siteId: c.site_id,
      kind: c.dc ? 'DC' : 'AC', activeFraction: frac,
      sessions: 0, energyWh: 0, gtvIdr: 0, pbjtIdr: 0, ppnIdr: 0, grossIdr: 0, mdrIdr: 0, inReview: 0,
    });
  }
  for (const s of sessions) {
    const c = byCp.get(s.charge_point_id);
    if (!c) continue;
    c.sessions++;
    c.energyWh += Number(s.energy_wh ?? 0);
    c.gtvIdr += Number(s.subtotal_idr ?? 0);
    c.pbjtIdr += Number(s.pbjt_idr ?? 0);
    c.ppnIdr += Number(s.ppn_idr ?? 0);
    c.grossIdr += Number(s.total_idr ?? 0);
    if (s.needs_review) c.inReview++;
    if (s.method === 'qris') {
      // MDR is charged on what the driver paid (the prepaid amount), by the rules in force that day.
      const amount = Number(s.captured ?? s.total_idr ?? 0);
      c.mdrIdr += estimateQrisMdrIdr(amount, { onOrAfterOct2026: s.paid_at ? new Date(s.paid_at) >= new Date('2026-10-01T00:00:00+07:00') : undefined });
    }
  }
  // A charger with no service in the month and nothing sold does not appear.
  const chargers = [...byCp.values()].filter((c) => c.activeFraction > 0 || c.sessions > 0);
  const siteIn: SiteInput[] = sites.map((s) => ({ siteId: s.id, name: s.name, model: s.billing_model }));
  const st = computeStatement(plan, period, b!.days, siteIn, chargers, {
    ppnRateBps: config.tax.ppnRateBps, dppNum: config.tax.ppnDppNumerator, dppDen: config.tax.ppnDppDenominator,
  });
  return { ...st, status: 'draft', projected: new Date(b!.now).getTime() < end };
}

export async function orgInfo(orgId: string) {
  return one<{ id: string; name: string; slug: string; npwp: string | null; pkp: boolean }>(`SELECT id, name, slug, npwp, pkp FROM organisation WHERE id = $1`, [orgId]);
}

/**
 * The statement for a month: the frozen one if finalised, else a live draft.
 *   ownerId omitted  the organisation's statement from the platform
 *   ownerId given    the owner's statement from the organisation (issuer = the organisation)
 */
export async function statementFor(orgId: string, period: string, ownerId: string | null = null) {
  const fin = await one<{ number: string; data: any; finalised_at: Date }>(
    `SELECT number, data, finalised_at FROM commission_statement
      WHERE org_id = $1 AND period = ($2 || '-01')::date AND owner_id IS NOT DISTINCT FROM $3`,
    [orgId, period, ownerId],
  );
  const org = await orgInfo(orgId);
  const owner = ownerId
    ? await one<{ id: string; name: string; legal_name: string | null; npwp: string | null; pkp: boolean; address: string | null }>(
        `SELECT id, name, legal_name, npwp, pkp, address FROM site_owner WHERE id = $1 AND org_id = $2`, [ownerId, orgId])
    : null;
  const issuer = owner
    ? { name: org?.name ?? '', npwp: org?.npwp ?? null }
    : { name: config.billing.issuerName, npwp: config.billing.issuerNpwp || null };
  const billTo = owner
    ? { name: owner.legal_name || owner.name, npwp: owner.npwp, address: owner.address }
    : { name: org?.name ?? '', npwp: org?.npwp ?? null, address: null };
  if (fin) return { ...fin.data, status: 'final', number: fin.number, finalisedAt: fin.finalised_at, org, owner, issuer, billTo };
  return { ...(await draftStatement(orgId, period, ownerId ?? undefined)), number: null, org, owner, issuer, billTo };
}

export async function finalise(orgId: string, period: string, actor: string | null, ownerId: string | null = null) {
  if (period >= currentPeriod()) return { error: 'Only a month that has ended can be finalised.' };
  const org = await orgInfo(orgId);
  if (!org) return { error: 'organisation not found' };
  if (ownerId && !(await one(`SELECT 1 FROM site_owner WHERE id = $1 AND org_id = $2`, [ownerId, orgId]))) return { error: 'owner not found' };
  const st = await draftStatement(orgId, period, ownerId ?? undefined);
  const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  const number = `PSC-${period.replace('-', '')}-${code(org.slug) || org.id.slice(0, 8).toUpperCase()}${ownerId ? `-${ownerId.slice(0, 8).toUpperCase()}` : ''}`;
  const data = { ...st, status: 'final', projected: false };
  const row = await one<{ number: string }>(
    `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_idr, commission_idr, minimum_topup_idr, private_fee_idr,
                                       mdr_credit_idr, net_idr, ppn_idr, total_idr, owner_share_idr, data, finalised_by)
     VALUES ($1, $14, ($2 || '-01')::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $15, $12, $13)
     ON CONFLICT (org_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), period) DO NOTHING RETURNING number`,
    [orgId, period, number, st.totals.gtvIdr, st.totals.commissionIdr, st.totals.minimumTopUpIdr, st.totals.privateFeeIdr,
     st.totals.mdrCreditIdr, st.totals.netIdr, st.totals.ppnIdr, st.totals.totalIdr, JSON.stringify(data), actor, ownerId, st.totals.ownerShareIdr],
  );
  return row ? { number: row.number } : { error: 'already finalised' };
}

export async function listFinalised(orgId: string, ownerId: string | null = null) {
  return many(
    `SELECT to_char(period, 'YYYY-MM') AS period, number, gtv_idr, commission_idr, minimum_topup_idr, private_fee_idr,
            mdr_credit_idr, net_idr, ppn_idr, total_idr, owner_share_idr, finalised_at
       FROM commission_statement WHERE org_id = $1 AND owner_id IS NOT DISTINCT FROM $2 ORDER BY period DESC`,
    [orgId, ownerId],
  );
}

/**
 * Billing overview for the operator: every owner's month — charging units
 * (sessions, kWh) and amounts (gross, taxes, commission base, the owner's share
 * and the operator's share) — plus the operator's own sites (no owner), and totals.
 */
export async function ownersOverview(orgId: string, period: string) {
  const owners = await many<{ id: string; name: string; legal_name: string | null; archived_at: Date | null }>(
    `SELECT o.id, o.name, o.legal_name, o.archived_at FROM site_owner o
      WHERE o.org_id = $1 AND (o.archived_at IS NULL OR EXISTS (SELECT 1 FROM site s WHERE s.owner_id = o.id))
      ORDER BY o.name`,
    [orgId],
  );
  const pick = (st: any) => {
    const t = st.totals;
    return {
      status: st.status, number: st.number ?? null,
      sites: st.sites.length, chargers: st.sites.reduce((a: number, s: any) => a + s.chargers.length, 0),
      sessions: t.sessions, energyKwh: t.energyKwh, grossIdr: t.grossCollectedIdr, pbjtIdr: t.pbjtIdr, ppnIdr: t.ppnCollectedIdr,
      baseIdr: t.gtvIdr, mdrIdr: t.mdrEstimateIdr, ownerShareIdr: t.ownerShareIdr, platformShareIdr: t.platformShareIdr,
      platformPpnIdr: t.ppnIdr, invoiceTotalIdr: t.totalIdr, warnings: st.warnings.length,
    };
  };
  const rows = [];
  for (const o of owners) {
    const st = await statementFor(orgId, period, o.id);
    // "Own plan" = rates that differ from the published ones (a reset to published rates is not one).
    const { custom } = await planFor(orgId, period, o.id);
    rows.push({ ownerId: o.id, name: o.name, legalName: o.legal_name, archived: !!o.archived_at, customPlan: custom, ...pick(st) });
  }
  // The operator's own sites: everything after taxes and MDR is the operator's.
  const own = await draftStatement(orgId, period, null);
  const ot = own.totals;
  const operatorOwn = {
    sites: own.sites.length, chargers: own.sites.reduce((a, s) => a + s.chargers.length, 0),
    sessions: ot.sessions, energyKwh: ot.energyKwh, grossIdr: ot.grossCollectedIdr, pbjtIdr: ot.pbjtIdr, ppnIdr: ot.ppnCollectedIdr,
    baseIdr: ot.gtvIdr, mdrIdr: ot.mdrEstimateIdr, ownerShareIdr: 0, platformShareIdr: ot.gtvIdr - ot.mdrEstimateIdr,
  };
  const all = [...rows, operatorOwn];
  const sum = (k: string) => Math.round(all.reduce((a, r: any) => a + Number(r[k] ?? 0), 0) * 100) / 100;
  return {
    period,
    owners: rows,
    operatorOwn,
    totals: {
      sites: sum('sites'), chargers: sum('chargers'), sessions: sum('sessions'), energyKwh: sum('energyKwh'),
      grossIdr: sum('grossIdr'), pbjtIdr: sum('pbjtIdr'), ppnIdr: sum('ppnIdr'), baseIdr: sum('baseIdr'), mdrIdr: sum('mdrIdr'),
      ownerShareIdr: sum('ownerShareIdr'), platformShareIdr: sum('platformShareIdr'),
    },
  };
}

/** Platform overview: every customer organisation for one month. Runs unscoped (platform admin). */
export async function platformOverview(period: string) {
  const orgs = await many<{ id: string; name: string; slug: string }>(
    `SELECT o.id, o.name, o.slug FROM organisation o WHERE EXISTS (SELECT 1 FROM site s WHERE s.org_id = o.id) AND o.sandbox_of_org_id IS NULL ORDER BY o.name`,
  );
  const out = [];
  for (const o of orgs) {
    const s = await statementFor(o.id, period);
    const { custom } = await planFor(o.id, period);
    out.push({
      orgId: o.id, name: o.name, slug: o.slug, status: s.status, number: s.number, customPlan: custom,
      sites: s.sites.length, chargers: s.sites.reduce((a: number, x: any) => a + x.chargers.length, 0),
      warnings: s.warnings.length, totals: s.totals,
    });
  }
  return out;
}

// ─────────────────────────────────────────── exports

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function statementCsv(st: any): string {
  const head = ['Period', 'Site', 'Billing model', 'Tier', 'Charger', 'Identity', 'Type', 'Days in service', 'Sessions', 'Energy kWh',
    'Commission base (excl. PBJT, PPN)', 'PBJT', 'PPN collected', 'Gross collected', 'Commission', 'Minimum', 'Minimum top-up', 'Private platform fee', 'Fee', 'MDR estimate'];
  const rows = st.sites.flatMap((s: any) => s.chargers.map((c: any) => [
    st.period, s.name, s.model, s.tier ?? '', c.displayName ?? '', c.ocppIdentity, c.kind, c.activeDays, c.sessions, (c.energyWh / 1000).toFixed(3),
    c.gtvIdr, c.pbjtIdr, c.ppnIdr, c.grossIdr, c.commissionIdr, c.minimumIdr, c.topUpIdr, c.privateFeeIdr, c.feeIdr, s.model === 'public' ? c.mdrIdr : 0,
  ]));
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
const idr = (n: unknown) => 'Rp ' + new Intl.NumberFormat('id-ID').format(Math.round(Number(n ?? 0)));
const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function statementHtml(st: any): string {
  const [y, m] = String(st.period).split('-');
  const month = `${MONTHS[Number(m) - 1]} ${y}`;
  const t = st.totals;
  const dppFrac = `${config.tax.ppnDppNumerator}/${config.tax.ppnDppDenominator}`;
  const siteRows = st.sites.map((s: any) => `<tr>
    <td><b>${esc(s.name)}</b><div class="muted">${s.model === 'public' ? `Public · ${esc(s.tier)} tier` : 'Private · platform fee'} · ${s.chargers.length} charger${s.chargers.length === 1 ? '' : 's'}</div>
      ${s.warnings.map((w: string) => `<div class="warn">${esc(w)}</div>`).join('')}</td>
    <td class="n">${s.sessions}</td><td class="n">${idr(s.gtvIdr)}</td><td class="n">${s.model === 'public' ? pct(s.rateBps) : '—'}</td>
    <td class="n">${idr(s.commissionIdr)}</td><td class="n">${idr(s.minimumTopUpIdr)}</td><td class="n">${idr(s.privateFeeIdr)}</td><td class="n"><b>${idr(s.feeIdr)}</b></td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Statement ${esc(st.number ?? `draft ${st.period}`)}</title>
<style>
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#f4f5f7}
  .page{max-width:900px;margin:24px auto;background:#fff;padding:32px 36px;border:1px solid #e3e6ea;border-radius:10px}
  h1{font-size:20px;margin:0}h2{font-size:15px;margin:22px 0 6px}.muted{color:#5b6470;font-size:12.5px}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{padding:7px 6px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5b6470}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .grand td{font-weight:700;font-size:16px;border-top:2px solid #111;border-bottom:0}
  .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
  .draft{background:#e0ecff;color:#1e3a8a;padding:8px 10px;border-radius:6px;margin-top:12px;font-size:12.5px}
  .warn{background:#fef3c7;color:#92400e;padding:6px 8px;border-radius:6px;margin-top:6px;font-size:12px}
  .note{margin-top:18px;font-size:11.5px;color:#5b6470}
  @media print{body{background:#fff}.page{border:0;margin:0;max-width:none}}
</style></head><body><div class="page">
<div class="head"><div><h1>Platform commission &amp; fee statement</h1>
<div class="muted">${esc(st.issuer?.name)}${st.issuer?.npwp ? ` · NPWP ${esc(st.issuer.npwp)}` : ''}</div></div>
<div class="muted" style="text-align:right">${st.number ? `No. ${esc(st.number)}` : 'DRAFT'}<br>Period: ${esc(month)}</div></div>
<p class="muted" style="margin-top:14px">To: <b style="color:#111">${esc(st.billTo?.name ?? st.org?.name)}</b>${(st.billTo?.npwp ?? st.org?.npwp) ? ` · NPWP ${esc(st.billTo?.npwp ?? st.org?.npwp)}` : ''}${st.billTo?.address ? `<br>${esc(st.billTo.address)}` : ''}</p>
${st.status !== 'final' ? `<div class="draft">Draft — figures change until the month is finalised.${st.projected ? ' Minimums and platform fees are projected to the end of the month.' : ''}</div>` : ''}
<h2>By site</h2>
<table><thead><tr><th>Site</th><th class="n">Sessions</th><th class="n">Commission base</th><th class="n">Rate</th><th class="n">Commission</th><th class="n">Minimum top-up</th><th class="n">Platform fee</th><th class="n">Fee</th></tr></thead>
<tbody>${siteRows || '<tr><td colspan="8" class="muted">No chargers in service this month.</td></tr>'}</tbody></table>
<h2>Summary</h2>
<table><tbody>
<tr><td>Gross collected from drivers (incl. PBJT-TL and PPN)</td><td class="n">${idr(t.grossCollectedIdr)}</td></tr>
<tr><td class="muted">less PBJT-TL collected for the regional government</td><td class="n muted">${idr(t.pbjtIdr)}</td></tr>
<tr><td class="muted">less PPN collected</td><td class="n muted">${idr(t.ppnCollectedIdr)}</td></tr>
<tr><td><b>Commission base</b> (energy, service, admin and idle fees)</td><td class="n"><b>${idr(t.gtvIdr)}</b></td></tr>
<tr><td>Commission</td><td class="n">${idr(t.commissionIdr)}</td></tr>
<tr><td>Minimum per charger — top-up where commission fell below it</td><td class="n">${idr(t.minimumTopUpIdr)}</td></tr>
<tr><td>Platform fee — private chargers</td><td class="n">${idr(t.privateFeeIdr)}</td></tr>
${t.mdrCreditIdr ? `<tr><td>Less payment processing (QRIS MDR, estimated) — covered by the commission</td><td class="n">− ${idr(t.mdrCreditIdr)}</td></tr>` : ''}
<tr><td><b>Fee before tax</b></td><td class="n"><b>${idr(t.netIdr)}</b></td></tr>
<tr><td class="muted">DPP nilai lain (${esc(dppFrac)} × fee)</td><td class="n muted">${idr(t.dppIdr)}</td></tr>
<tr><td>PPN ${config.tax.ppnRateBps / 100}% × DPP</td><td class="n">${idr(t.ppnIdr)}</td></tr>
<tr class="grand"><td>Total due</td><td class="n">${idr(t.totalIdr)}</td></tr>
</tbody></table>
${st.owner && t.ownerShareIdr != null ? `<h2>Shares of the commission base</h2>
<table><tbody>
<tr><td>Your share (commission base less the fee before tax${t.mdrEstimateIdr ? ' and payment processing' : ''})</td><td class="n"><b>${idr(t.ownerShareIdr)}</b></td></tr>
<tr><td>${esc(st.issuer?.name)} share (fee before tax)</td><td class="n">${idr(t.platformShareIdr)}</td></tr>
${t.mdrEstimateIdr ? `<tr><td class="muted">Payment processing (QRIS MDR, estimated)</td><td class="n muted">${idr(t.mdrEstimateIdr)}</td></tr>` : ''}
<tr><td class="muted">Charging units</td><td class="n muted">${Number(t.sessions).toLocaleString('id-ID')} sessions · ${Number(t.energyKwh).toLocaleString('id-ID', { maximumFractionDigits: 2 })} kWh</td></tr>
</tbody></table>` : ''}
<div class="note">
Commission base: the session subtotal — energy, service, admin and idle fees — excluding PBJT-TL and PPN. Sessions count in the month their charge record was issued.
Rates: ${st.plan.tiers.map((x: any) => `${esc(x.name)} ${x.upToIdr ? `below ${idr(x.upToIdr)}` : 'above'} ${pct(x.rateBps)}`).join(' · ')} (${st.plan.tierMode === 'whole' ? 'whole month at the tier reached' : 'each band at its own rate'}), per site.
Minimum ${idr(st.plan.minPerChargerAcIdr)} (AC) / ${idr(st.plan.minPerChargerDcIdr)} (DC) per charger per month, credited against that charger's commission; private chargers ${idr(st.plan.privateFeeAcIdr)} (AC) / ${idr(st.plan.privateFeeDcIdr)} (DC). ${st.plan.prorate ? 'Pro-rated by days in service.' : ''}
${t.pph23Idr ? `If you are a PPh 23 withholding agent, withhold 2% of the fee before tax (${idr(t.pph23Idr)}) and send us the bukti potong.` : ''}
This statement is not a tax invoice; the faktur pajak is issued separately.</div>
</div></body></html>`;
}
