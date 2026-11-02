import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { xlsx } from './xlsx.js';

/**
 * Residential and workplace charging (v1.46.0), Assets & energy → Private charging.
 *
 *   group        an apartment building's or an office's chargers at a site: residential (units: flats) or workplace
 *                (units: teams or cost centres). Its chargers are private: only its members' cards start them, they
 *                leave the public map and the app does not sell them.
 *   units        a flat ("A-12") or a team ("Finance", with its cost centre); each with the address its statement goes to
 *   members      a person in a unit with their card (and, for the plate cameras, their plate)
 *   billing      per unit (residential), per cost centre (workplace) or none (free to members): each month, the energy
 *                the unit's cards drew on the group's chargers × the group's rate (or, without a rate, the charge records'
 *                totals), plus a monthly fee per unit. Statements are drafted, issued, then marked paid (or void).
 *   portal       the building or office manager's page, opened by a secret link (rotated from the console): units,
 *                members (add a card, remove one), this month's energy and the statements. No console account needed.
 */

export class PrivateError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// ------------------------------------------------------------------ authorisation (OCPP)

/**
 * Whether a card may start a private charger. null: the charger is not private. Members' cards only; prepaid claim
 * tokens and unknown or roaming cards are refused at a private charger.
 */
export async function privateCheck(chargePointId: string, tokenId: string | null): Promise<'allowed' | 'refused' | null> {
  const g = await S(() => one<{ group_id: string }>(
    `SELECT pg.group_id FROM private_group_charger pg JOIN private_group g ON g.id = pg.group_id WHERE pg.charge_point_id = $1 AND g.archived_at IS NULL`, [chargePointId]));
  if (!g) return null;
  if (!tokenId) return 'refused';
  const m = await S(() => one(
    `SELECT 1 FROM private_member m JOIN private_unit u ON u.id = m.unit_id WHERE m.token_id = $1 AND u.group_id = $2 AND m.archived_at IS NULL AND u.archived_at IS NULL`, [tokenId, g.group_id]));
  return m ? 'allowed' : 'refused';
}

// ------------------------------------------------------------------ groups

const groupOf = (g: any) => ({
  id: String(g.id), siteId: g.site_id, site: g.site_name ?? null, name: g.name, kind: g.kind, billing: g.billing, rateMinor: g.rate_minor == null ? null : Number(g.rate_minor),
  monthlyFeeMinor: Number(g.monthly_fee_minor), currency: g.currency, managerName: g.manager_name ?? null, managerEmail: g.manager_email ?? null,
  portalLinked: !!g.portal_token_hash, portalPrefix: g.portal_token_prefix ?? null, chargers: Number(g.chargers ?? 0), units: Number(g.units ?? 0), members: Number(g.members ?? 0),
});

const GROUP_SELECT = `SELECT g.*, s.name AS site_name,
    (SELECT count(*) FROM private_group_charger c WHERE c.group_id = g.id) AS chargers,
    (SELECT count(*) FROM private_unit u WHERE u.group_id = g.id AND u.archived_at IS NULL) AS units,
    (SELECT count(*) FROM private_member m JOIN private_unit u ON u.id = m.unit_id WHERE u.group_id = g.id AND m.archived_at IS NULL AND u.archived_at IS NULL) AS members
  FROM private_group g JOIN site s ON s.id = g.site_id`;

export async function groups(orgId: string) {
  return (await S(() => many<any>(`${GROUP_SELECT} WHERE g.org_id = $1 AND g.archived_at IS NULL ORDER BY g.name`, [orgId]))).map(groupOf);
}

async function groupRow(orgId: string, id: string | number) {
  const g = await S(() => one<any>(`${GROUP_SELECT} WHERE g.id = $1 AND g.org_id = $2 AND g.archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!g) throw new PrivateError(404, 'No such group.');
  return g;
}

export async function saveGroup(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await groupRow(orgId, id) : null;
  if (cur && b.archive === true) {
    await S(() => query(`DELETE FROM private_group_charger WHERE group_id = $1`, [cur.id]));
    await S(() => query(`UPDATE private_group SET archived_at = now(), portal_token_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 120);
  if (!name) throw new PrivateError(422, 'name is required.');
  const siteId = String(v('siteId', 'site_id') ?? '');
  const site = UUID_RE.test(siteId) ? await S(() => one<any>(`SELECT s.id, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2 AND s.archived_at IS NULL`, [siteId, orgId])) : null;
  if (!site) throw new PrivateError(422, 'No such site.');
  if (cur && cur.site_id !== siteId && Number(cur.chargers)) throw new PrivateError(409, 'Remove the group\'s chargers before moving it to another site.');
  const kind = String(v('kind', 'kind') ?? '');
  if (!['residential', 'workplace'].includes(kind)) throw new PrivateError(422, 'kind is residential or workplace.');
  const billing = String(v('billing', 'billing') ?? (kind === 'workplace' ? 'cost_centre' : 'per_unit'));
  if (!['per_unit', 'cost_centre', 'none'].includes(billing)) throw new PrivateError(422, 'billing is per_unit, cost_centre or none.');
  const rateRaw = v('rateMinor', 'rate_minor');
  const rate = rateRaw == null || rateRaw === '' ? null : Number(rateRaw);
  if (rate != null && !(Number.isSafeInteger(rate) && rate >= 0)) throw new PrivateError(422, 'rateMinor is a whole amount per kWh (minor units), or empty to bill the charge records.');
  const fee = Number(v('monthlyFeeMinor', 'monthly_fee_minor') ?? 0);
  if (!(Number.isSafeInteger(fee) && fee >= 0)) throw new PrivateError(422, 'monthlyFeeMinor is a whole amount.');
  const email = v('managerEmail', 'manager_email') ? String(v('managerEmail', 'manager_email')).trim().toLowerCase().slice(0, 200) : null;
  if (email && !EMAIL_RE.test(email)) throw new PrivateError(422, 'managerEmail is not an e-mail address.');
  const mgr = v('managerName', 'manager_name') ? String(v('managerName', 'manager_name')).slice(0, 120) : null;
  const vals = [orgId, siteId, name, kind, billing, rate, fee, site.currency, mgr, email];
  const r = cur
    ? await S(() => one<any>(`UPDATE private_group SET site_id = $2, name = $3, kind = $4, billing = $5, rate_minor = $6, monthly_fee_minor = $7, currency = $8, manager_name = $9, manager_email = $10 WHERE id = $11 AND org_id = $1 RETURNING id`, [...vals, cur.id]))
    : await S(() => one<any>(`INSERT INTO private_group (org_id, site_id, name, kind, billing, rate_minor, monthly_fee_minor, currency, manager_name, manager_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals));
  return groupOf(await groupRow(orgId, r.id));
}

/** The group's chargers (at its site; a charger is in one group at most). */
export async function setChargers(orgId: string, id: string, b: Record<string, unknown>) {
  const g = await groupRow(orgId, id);
  const ids = Array.isArray(b.chargePointIds) ? (b.chargePointIds as unknown[]).map(String) : null;
  if (!ids || ids.some((x) => !UUID_RE.test(x)) || ids.length > 200) throw new PrivateError(422, 'chargePointIds: the group\'s chargers.');
  const ok = ids.length ? await S(() => many<{ id: string }>(`SELECT id FROM charge_point WHERE id = ANY($1::uuid[]) AND site_id = $2`, [ids, g.site_id])) : [];
  if (ok.length !== ids.length) throw new PrivateError(422, 'Every charger must be at the group\'s site.');
  const taken = ids.length ? await S(() => many<{ charge_point_id: string }>(`SELECT charge_point_id FROM private_group_charger WHERE charge_point_id = ANY($1::uuid[]) AND group_id <> $2`, [ids, g.id])) : [];
  if (taken.length) throw new PrivateError(409, 'A charger is already in another group.');
  await S(() => tx(async (c) => {
    await c.query(`DELETE FROM private_group_charger WHERE group_id = $1`, [g.id]);
    for (const cp of ids) await c.query(`INSERT INTO private_group_charger (charge_point_id, group_id, org_id) VALUES ($1,$2,$3)`, [cp, g.id, orgId]);
  }));
  return detail(orgId, id);
}

// ------------------------------------------------------------------ units and members

export async function saveUnit(orgId: string, groupId: string, id: string | null, b: Record<string, unknown>) {
  const g = await groupRow(orgId, groupId);
  if (id && b.archive === true) {
    const r = await S(() => one(`UPDATE private_unit SET archived_at = now() WHERE id = $1 AND group_id = $2 AND archived_at IS NULL RETURNING id`, [Number(id) || 0, g.id]));
    if (!r) throw new PrivateError(404, 'No such unit.');
    await S(() => query(`UPDATE private_member SET archived_at = now() WHERE unit_id = $1 AND archived_at IS NULL`, [Number(id)]));
    return { id, archived: true };
  }
  const code = String(b.code ?? '').trim().slice(0, 40);
  if (!code) throw new PrivateError(422, g.kind === 'workplace' ? 'code is the team\'s cost centre.' : 'code is the unit (for example A-12).');
  const email = b.billingEmail ? String(b.billingEmail).trim().toLowerCase().slice(0, 200) : null;
  if (email && !EMAIL_RE.test(email)) throw new PrivateError(422, 'billingEmail is not an e-mail address.');
  const name = b.name ? String(b.name).slice(0, 120) : null;
  try {
    const r = id
      ? await S(() => one<any>(`UPDATE private_unit SET code = $3, name = $4, billing_email = $5 WHERE id = $1 AND group_id = $2 AND archived_at IS NULL RETURNING *`, [Number(id) || 0, g.id, code, name, email]))
      : await S(() => one<any>(`INSERT INTO private_unit (org_id, group_id, code, name, billing_email) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [orgId, g.id, code, name, email]));
    if (!r) throw new PrivateError(404, 'No such unit.');
    return { id: String(r.id), code: r.code, name: r.name ?? null, billingEmail: r.billing_email ?? null };
  } catch (e: any) {
    if (e?.code === '23505') throw new PrivateError(409, `There is already a unit ${code}.`);
    throw e;
  }
}

const normPlate = (p: unknown) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);

/** A member and their card: an existing card of the operator by its id or number, or a new card with that number. */
export async function saveMember(orgId: string, groupId: string, id: string | null, b: Record<string, unknown>) {
  const g = await groupRow(orgId, groupId);
  if (id && b.archive === true) {
    const r = await S(() => one(
      `UPDATE private_member m SET archived_at = now() FROM private_unit u WHERE m.id = $1 AND u.id = m.unit_id AND u.group_id = $2 AND m.archived_at IS NULL RETURNING m.id`, [Number(id) || 0, g.id]));
    if (!r) throw new PrivateError(404, 'No such member.');
    return { id, archived: true };
  }
  const unit = await S(() => one<any>(`SELECT id FROM private_unit WHERE id = $1 AND group_id = $2 AND archived_at IS NULL`, [Number(b.unitId) || 0, g.id]));
  if (!unit) throw new PrivateError(422, 'No such unit.');
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new PrivateError(422, 'name is required.');
  let tokenId: string | null = null;
  if (b.tokenId) {
    const t = await S(() => one<{ id: string }>(`SELECT id FROM token WHERE id = $1 AND org_id = $2`, [String(b.tokenId), orgId]));
    if (!t) throw new PrivateError(422, 'No such card.');
    tokenId = t.id;
  } else if (b.cardUid) {
    const uid = String(b.cardUid).trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20);
    if (uid.length < 4) throw new PrivateError(422, 'cardUid is the number on the card (at least 4 characters).');
    const t = await S(() => one<{ id: string; kind: string }>(`SELECT id, kind FROM token WHERE org_id = $1 AND uid = $2`, [orgId, uid]));
    if (t && t.kind !== 'rfid') throw new PrivateError(422, 'That number is not a charging card.');
    tokenId = t?.id ?? (await S(() => one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, holder_name, notes) VALUES ($1, 'rfid', $2, $3, $4) RETURNING id`,
      [orgId, uid, name, `Private charging: ${g.name}`])))!.id;
  }
  const plate = b.plate ? normPlate(b.plate) : null;
  try {
    const r = id
      ? await S(() => one<any>(
        `UPDATE private_member m SET unit_id = $3, name = $4, token_id = COALESCE($5, m.token_id), plate = $6 FROM private_unit u WHERE m.id = $1 AND u.id = m.unit_id AND u.group_id = $2 AND m.archived_at IS NULL RETURNING m.id`,
        [Number(id) || 0, g.id, unit.id, name, tokenId, plate]))
      : await S(() => one<any>(`INSERT INTO private_member (org_id, unit_id, name, token_id, plate) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, unit.id, name, tokenId, plate]));
    if (!r) throw new PrivateError(404, 'No such member.');
    return { id: String(r.id) };
  } catch (e: any) {
    if (e?.code === '23505') throw new PrivateError(409, 'That card already belongs to another member.');
    throw e;
  }
}

export async function detail(orgId: string, id: string) {
  const g = await groupRow(orgId, id);
  const chargers = await S(() => many<any>(
    `SELECT cp.id, COALESCE(cp.display_name, cp.ocpp_identity) AS name, cp.ocpp_identity, (pg.group_id IS NOT NULL AND pg.group_id = $2) AS mine, pg.group_id
       FROM charge_point cp LEFT JOIN private_group_charger pg ON pg.charge_point_id = cp.id WHERE cp.site_id = $1 AND cp.status <> 'decommissioned' ORDER BY 2`, [g.site_id, g.id]));
  const units = await S(() => many<any>(`SELECT * FROM private_unit WHERE group_id = $1 AND archived_at IS NULL ORDER BY code`, [g.id]));
  const members = await S(() => many<any>(
    `SELECT m.*, t.uid FROM private_member m JOIN private_unit u ON u.id = m.unit_id LEFT JOIN token t ON t.id = m.token_id WHERE u.group_id = $1 AND m.archived_at IS NULL ORDER BY m.name`, [g.id]));
  const month = new Date().toISOString().slice(0, 7);
  const usage = await unitUsage(g, month);
  return {
    ...groupOf(g),
    chargers: chargers.map((c) => ({ id: c.id, name: c.name, identity: c.ocpp_identity, inGroup: !!c.mine, inOtherGroup: !!c.group_id && !c.mine })),
    units: units.map((u) => ({ id: String(u.id), code: u.code, name: u.name ?? null, billingEmail: u.billing_email ?? null, thisMonth: usage.get(String(u.id)) ?? { sessions: 0, kwh: 0, energyMinor: 0 } })),
    members: members.map((m) => ({ id: String(m.id), unitId: String(m.unit_id), name: m.name, tokenId: m.token_id ?? null, card: m.uid ?? null, plate: m.plate ?? null })),
  };
}

// ------------------------------------------------------------------ billing

/** Per unit: sessions, kWh and the energy amount on the group's chargers by the unit's cards in a month (UTC month). */
async function unitUsage(g: any, month: string) {
  const rows = await S(() => many<any>(
    `SELECT u.id AS unit_id, count(cs.id) AS sessions, COALESCE(sum(cs.energy_wh), 0) AS wh, COALESCE(sum(d.total_minor), 0) AS total
       FROM private_unit u
       JOIN private_member m ON m.unit_id = u.id
       JOIN charging_session cs ON cs.token_id = m.token_id AND cs.charge_point_id IN (SELECT charge_point_id FROM private_group_charger WHERE group_id = $1)
       LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE u.group_id = $1 AND to_char(cs.started_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2 AND cs.state IN ('active', 'ended', 'rated')
      GROUP BY u.id`, [g.id, month]));
  const out = new Map<string, { sessions: number; kwh: number; energyMinor: number }>();
  for (const r of rows) {
    const kwh = Number(r.wh) / 1000;
    out.set(String(r.unit_id), { sessions: Number(r.sessions), kwh: Math.round(kwh * 1000) / 1000, energyMinor: g.billing === 'none' ? 0 : g.rate_minor != null ? Math.round(kwh * Number(g.rate_minor)) : Number(r.total) });
  }
  return out;
}

const stmtOf = (s: any) => ({
  id: String(s.id), unitId: String(s.unit_id), unit: s.code ?? null, unitName: s.unit_name ?? null, month: s.month, sessions: s.sessions, kwh: Number(s.kwh),
  energyMinor: Number(s.energy_minor), feeMinor: Number(s.fee_minor), amountMinor: Number(s.amount_minor), currency: s.currency, status: s.status,
  issuedAt: s.issued_at ? new Date(s.issued_at).toISOString() : null, paidAt: s.paid_at ? new Date(s.paid_at).toISOString() : null,
});

/** Draft (or redraft) a month's statements: one per unit that used the chargers or pays a fee. Issued ones stay. */
export async function draftStatements(orgId: string, id: string, monthRaw: unknown) {
  const g = await groupRow(orgId, id);
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new PrivateError(422, 'month is YYYY-MM.');
  if (g.billing === 'none') throw new PrivateError(409, 'This group does not bill its members.');
  const usage = await unitUsage(g, month);
  const units = await S(() => many<any>(`SELECT id FROM private_unit WHERE group_id = $1 AND archived_at IS NULL`, [g.id]));
  let n = 0;
  for (const u of units) {
    const use = usage.get(String(u.id)) ?? { sessions: 0, kwh: 0, energyMinor: 0 };
    const fee = Number(g.monthly_fee_minor);
    if (!use.sessions && !fee) continue;
    const r = await S(() => query(
      `INSERT INTO private_statement (org_id, group_id, unit_id, month, sessions, kwh, energy_minor, fee_minor, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (unit_id, month) DO UPDATE SET sessions = EXCLUDED.sessions, kwh = EXCLUDED.kwh, energy_minor = EXCLUDED.energy_minor, fee_minor = EXCLUDED.fee_minor, amount_minor = EXCLUDED.amount_minor
         WHERE private_statement.status = 'draft'`,
      [orgId, g.id, u.id, month, use.sessions, use.kwh, use.energyMinor, fee, use.energyMinor + fee, g.currency]));
    n += r.rowCount ?? 0;
  }
  return { month, drafted: n, statements: await statements(orgId, id, month) };
}

export async function statements(orgId: string, id: string, month?: string | null) {
  const g = await groupRow(orgId, id);
  const rows = await S(() => many<any>(
    `SELECT s.*, u.code, u.name AS unit_name FROM private_statement s JOIN private_unit u ON u.id = s.unit_id WHERE s.group_id = $1 AND ($2::text IS NULL OR s.month = $2) ORDER BY s.month DESC, u.code`, [g.id, month ?? null]));
  return rows.map(stmtOf);
}

/** issue | paid | void (a statement), or issue every draft of a month. */
export async function setStatement(orgId: string, stmtId: string, action: unknown) {
  const s = await S(() => one<any>(`SELECT * FROM private_statement WHERE id = $1 AND org_id = $2`, [Number(stmtId) || 0, orgId]));
  if (!s) throw new PrivateError(404, 'No such statement.');
  const a = String(action ?? '');
  const ok: Record<string, string[]> = { issue: ['draft'], paid: ['issued'], void: ['draft', 'issued'] };
  if (!ok[a]) throw new PrivateError(422, 'action is issue, paid or void.');
  if (!ok[a]!.includes(s.status)) throw new PrivateError(409, `A ${s.status} statement cannot be ${a === 'paid' ? 'marked paid' : a === 'issue' ? 'issued' : 'voided'}.`);
  const set = a === 'issue' ? `status = 'issued', issued_at = now()` : a === 'paid' ? `status = 'paid', paid_at = now()` : `status = 'void'`;
  const r = await S(() => one<any>(`UPDATE private_statement SET ${set} WHERE id = $1 RETURNING *`, [s.id]));
  return stmtOf(r);
}

export async function statementsXlsx(orgId: string, id: string, month: string) {
  const g = await groupRow(orgId, id);
  const rows = await statements(orgId, id, month);
  return xlsx([{ name: 'Statements', rows: [
    [`${g.name} · ${month}`], [],
    [g.kind === 'workplace' ? 'Cost centre' : 'Unit', 'Name', 'Sessions', 'kWh', `Energy (${g.currency})`, `Monthly fee (${g.currency})`, `Total (${g.currency})`, 'Status'],
    ...rows.map((r) => [r.unit, r.unitName ?? '', r.sessions, r.kwh, r.energyMinor, r.feeMinor, r.amountMinor, r.status]),
  ] }]);
}

// ------------------------------------------------------------------ the manager's portal

/** A new secret link for the manager's page (the old one stops working). Returned once. */
export async function rotatePortal(orgId: string, id: string) {
  const g = await groupRow(orgId, id);
  const token = `bld_${randomBytes(24).toString('base64url')}`;
  await S(() => query(`UPDATE private_group SET portal_token_hash = $2, portal_token_prefix = $3 WHERE id = $1`, [g.id, sha(token), token.slice(0, 8)]));
  return { token, path: `/building/${token}` };
}

async function groupByToken(token: string) {
  if (!/^bld_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new PrivateError(404, 'This link is not valid (any more).');
  const g = await S(() => one<any>(`SELECT * FROM private_group WHERE portal_token_hash = $1 AND archived_at IS NULL`, [sha(token)]));
  if (!g) throw new PrivateError(404, 'This link is not valid (any more).');
  return g;
}

export async function portalView(token: string) {
  const g = await groupByToken(token);
  const d = await detail(g.org_id, String(g.id));
  const org = await S(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [g.org_id]));
  return {
    operator: org?.name ?? null, name: d.name, kind: d.kind, site: d.site, billing: d.billing, currency: d.currency, rateMinor: d.rateMinor, monthlyFeeMinor: d.monthlyFeeMinor,
    chargers: d.chargers.filter((c) => c.inGroup).map((c) => ({ name: c.name })),
    units: d.units, members: d.members.map((m) => ({ ...m, card: m.card ? `…${m.card.slice(-4)}` : null, tokenId: undefined })),
    statements: (await statements(g.org_id, String(g.id))).slice(0, 60),
  };
}

/** The manager adds or removes a member (a card), or adds a unit. */
export async function portalChange(token: string, b: Record<string, unknown>) {
  const g = await groupByToken(token);
  const a = String(b.action ?? '');
  const r = await portalApply(g, a, b);
  const { writeAudit } = await import('./audit.js');
  await writeAudit({ orgId: g.org_id, actorType: 'system', actorId: `building:${g.portal_token_prefix ?? ''}`, action: `private_group.portal_${a}`, targetType: 'private_group', targetId: String(g.id), ip: null, after: { result: r } } as any);
  return r;
}

async function portalApply(g: any, a: string, b: Record<string, unknown>) {
  if (a === 'add_member') return saveMember(g.org_id, String(g.id), null, { unitId: b.unitId, name: b.name, cardUid: b.cardUid, plate: b.plate });
  if (a === 'remove_member') return saveMember(g.org_id, String(g.id), String(b.memberId ?? ''), { archive: true });
  if (a === 'add_unit') return saveUnit(g.org_id, String(g.id), null, { code: b.code, name: b.name, billingEmail: b.billingEmail });
  throw new PrivateError(422, 'action is add_member, remove_member or add_unit.');
}
