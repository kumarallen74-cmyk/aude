import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { persistAlert } from './alerts.js';

/**
 * Data privacy (v1.48.0), Govern → Privacy: what Indonesia's Personal Data Protection law (UU No. 27/2022, "UU
 * PDP") asks of a data controller, for the operator's drivers:
 *
 *   requests   a data subject's request — access, a copy (export), correction, erasure, objection — from the app,
 *              by e-mail or recorded in the console; due within the response time (default 3 × 24 hours), verified
 *              (who the person is), then done or rejected with the reason. Done: an export is the person's data as
 *              JSON; a correction changes the account's name or e-mail; an erasure deletes the account (as the app's
 *              own deletion does: blocked while a charge is unpaid or running); an objection withdraws consents
 *   consents   per driver and purpose (marketing, analytics, location): every grant and withdrawal is kept
 *   inventory  the personal data the operator holds, where, why and for how long
 *   retention  plates (parking and cameras), survey comments and closed support cases are cleared after the days set
 *   alerts     privacy.request_due: a request due within a day and not closed
 *
 * The law's text and the operator's own counsel decide; this is the record-keeping that shows what was done, when,
 * and by whom.
 */

export class PrivacyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const DUE_ALERT = 'privacy.request_due';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KINDS = ['access', 'export', 'correction', 'erasure', 'objection'] as const;
export const PURPOSES = ['marketing', 'analytics', 'location'] as const;

// ------------------------------------------------------------------ settings

const settingsOf = (r: any) => ({
  dpoName: r?.dpo_name ?? null, dpoEmail: r?.dpo_email ?? null, responseHours: r?.response_hours ?? 72,
  plateRetentionDays: r?.plate_retention_days ?? null, surveyCommentDays: r?.survey_comment_days ?? null, supportCaseDays: r?.support_case_days ?? null,
});

export async function settings(orgId: string) {
  return settingsOf(await S(() => one<any>(`SELECT * FROM privacy_settings WHERE org_id = $1`, [orgId])));
}

export async function saveSettings(orgId: string, b: Record<string, unknown>) {
  const cur = await settings(orgId);
  const int = (k: string, lo: number, hi: number, fallback: number | null) => {
    if (b[k] === undefined) return fallback;
    if (b[k] === null || b[k] === '') return null;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new PrivacyError(422, `${k} is ${lo} to ${hi}.`);
    return n;
  };
  const hours = int('responseHours', 24, 2160, cur.responseHours) ?? 72;
  const email = b.dpoEmail === undefined ? cur.dpoEmail : (b.dpoEmail ? String(b.dpoEmail).trim().toLowerCase() : null);
  if (email && !EMAIL_RE.test(email)) throw new PrivacyError(422, 'dpoEmail is not an e-mail address.');
  const vals = [orgId, b.dpoName === undefined ? cur.dpoName : (b.dpoName ? String(b.dpoName).slice(0, 120) : null), email, hours,
    int('plateRetentionDays', 7, 3650, cur.plateRetentionDays), int('surveyCommentDays', 30, 3650, cur.surveyCommentDays), int('supportCaseDays', 90, 3650, cur.supportCaseDays)];
  await S(() => query(
    `INSERT INTO privacy_settings (org_id, dpo_name, dpo_email, response_hours, plate_retention_days, survey_comment_days, support_case_days, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (org_id) DO UPDATE SET dpo_name = EXCLUDED.dpo_name, dpo_email = EXCLUDED.dpo_email, response_hours = EXCLUDED.response_hours,
       plate_retention_days = EXCLUDED.plate_retention_days, survey_comment_days = EXCLUDED.survey_comment_days, support_case_days = EXCLUDED.support_case_days, updated_at = now()`, vals));
  return settings(orgId);
}

// ------------------------------------------------------------------ requests

const reqOf = (r: any) => ({
  id: String(r.id), number: r.number, kind: r.kind, status: r.status, channel: r.channel, appDriverId: r.app_driver_id ?? null,
  subjectName: r.subject_name ?? null, subjectEmail: r.subject_email ?? null, subjectPhone: r.subject_phone ?? null, details: r.details ?? null,
  receivedAt: new Date(r.received_at).toISOString(), dueAt: new Date(r.due_at).toISOString(), overdue: !r.closed_at && new Date(r.due_at) < new Date(),
  verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null, verification: r.verification ?? null,
  closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, outcome: r.outcome ?? null, result: r.result ?? null,
});

export async function requests(orgId: string, q: Record<string, unknown> = {}) {
  const open = q.status !== 'all';
  return (await S(() => many<any>(`SELECT * FROM privacy_request WHERE org_id = $1 AND ($2 = false OR status IN ('new', 'verified')) ORDER BY (status IN ('new', 'verified')) DESC, due_at LIMIT 500`, [orgId, open]))).map(reqOf);
}

async function reqRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`SELECT * FROM privacy_request WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new PrivacyError(404, 'No such request.');
  return r;
}

export async function create(orgId: string, b: Record<string, unknown>, channel: 'app' | 'email' | 'console' | 'other' = 'console') {
  const kind = String(b.kind ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new PrivacyError(422, `kind is ${KINDS.join(', ')}.`);
  const ch = (['app', 'email', 'console', 'other'] as const).includes(String(b.channel ?? channel) as any) ? String(b.channel ?? channel) : channel;
  let driverId = b.appDriverId ? String(b.appDriverId) : null;
  const phone = b.subjectPhone ? String(b.subjectPhone).replace(/[^\d+]/g, '').slice(0, 20) : null;
  if (!driverId && phone) {
    // The number as the app stores it (the operator's country code when it starts with 0).
    const norm = (await import('../driver/identity.js')).normalisePhone(phone);
    if (norm) driverId = (await S(() => one<any>(`SELECT id FROM app_driver WHERE phone = $1 AND deleted_at IS NULL`, [norm])))?.id ?? null;
  }
  if (driverId && !UUID_RE.test(driverId)) throw new PrivacyError(422, 'No such driver.');
  const email = b.subjectEmail ? String(b.subjectEmail).trim().toLowerCase().slice(0, 200) : null;
  if (email && !EMAIL_RE.test(email)) throw new PrivacyError(422, 'subjectEmail is not an e-mail address.');
  if (!driverId && !email && !phone) throw new PrivacyError(422, 'Who is it: the driver, their phone number or their e-mail.');
  const s = await settings(orgId);
  const id = await S(() => tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_request:' || $1))`, [orgId]);
    const n = Number((await c.query(`SELECT count(*) AS n FROM privacy_request WHERE org_id = $1`, [orgId])).rows[0].n) + 1;
    return String((await c.query(
      `INSERT INTO privacy_request (org_id, number, kind, channel, app_driver_id, subject_name, subject_email, subject_phone, details, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(hours => $10)) RETURNING id`,
      [orgId, `PDP-${String(n).padStart(4, '0')}`, kind, ch, driverId, b.subjectName ? String(b.subjectName).slice(0, 120) : null, email, phone,
        b.details ? String(b.details).slice(0, 5000) : null, s.responseHours])).rows[0].id);
  }));
  return reqOf(await reqRow(orgId, id));
}

/** Who the person is has been checked (how: verification). A request made in the app by the signed-in driver is verified already. */
export async function verify(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await reqRow(orgId, id);
  if (r.status !== 'new') throw new PrivacyError(409, `The request is ${r.status}.`);
  const how = String(b.verification ?? '').trim().slice(0, 500);
  if (!how) throw new PrivacyError(422, 'verification: how the person\'s identity was checked.');
  const driver = b.appDriverId ? String(b.appDriverId) : r.app_driver_id;
  if (driver && !(UUID_RE.test(driver) && await S(() => one(`SELECT 1 FROM app_driver WHERE id = $1`, [driver])))) throw new PrivacyError(422, 'No such driver.');
  await S(() => query(`UPDATE privacy_request SET status = 'verified', verified_at = now(), verified_by = $2, verification = $3, app_driver_id = $4 WHERE id = $1`, [r.id, userId, how, driver]));
  return reqOf(await reqRow(orgId, id));
}

/** Everything held about a driver, as the person would receive it (the copy for access and export). */
export async function driverData(orgId: string, appDriverId: string) {
  const d = await S(() => one<any>(`SELECT id, phone, name, email, status, locale, created_at, last_seen_at, deleted_at FROM app_driver WHERE id = $1`, [appDriverId]));
  if (!d) throw new PrivacyError(404, 'No such driver.');
  const q = async (sql: string, params: unknown[] = [appDriverId, orgId]) => S(() => many<any>(sql, params)).catch(() => []);
  return {
    generatedAt: new Date().toISOString(), controller: (await S(() => one<any>(`SELECT name FROM organisation WHERE id = $1`, [orgId])))?.name ?? null,
    account: { phone: d.phone, name: d.name, email: d.email, status: d.status, language: d.locale, createdAt: d.created_at, lastSeenAt: d.last_seen_at, deletedAt: d.deleted_at },
    devices: await q(`SELECT created_at, last_seen_at FROM driver_device WHERE app_driver_id = $1`, [appDriverId]),
    charges: await q(`SELECT dc.created_at, dc.mode, dc.amount_minor, dc.currency, s.name AS site, cs.started_at, cs.ended_at, cs.energy_wh
      FROM driver_charge dc LEFT JOIN charging_session cs ON cs.id = dc.session_id LEFT JOIN site s ON s.id = cs.site_id WHERE dc.app_driver_id = $1 AND dc.org_id = $2 ORDER BY dc.created_at DESC LIMIT 2000`),
    payments: await q(`SELECT pi.created_at, pi.provider, pi.method, pi.state, pi.amount_authorised_minor, pi.amount_captured_minor, pi.refunded_minor, pi.currency
      FROM payment_intent pi JOIN driver_charge dc ON dc.payment_intent_id = pi.id WHERE dc.app_driver_id = $1 AND dc.org_id = $2 ORDER BY pi.created_at DESC LIMIT 2000`),
    savedCards: await q(`SELECT brand, last4, exp_month, exp_year, kind, channel, created_at, removed_at FROM driver_card WHERE app_driver_id = $1`, [appDriverId]),
    supportCases: await q(`SELECT c.number, c.subject, c.status, c.category, c.created_at, (SELECT json_agg(json_build_object('at', m.created_at, 'from', m.author, 'body', m.body) ORDER BY m.id)
      FROM support_message m WHERE m.case_id = c.id AND NOT COALESCE(m.internal, false)) AS messages FROM support_case c WHERE c.app_driver_id = $1 AND c.org_id = $2`),
    surveys: await q(`SELECT created_at, score, tags, comment FROM survey_response WHERE app_driver_id = $1 AND org_id = $2`),
    credit: await q(`SELECT created_at, kind, amount_minor, currency FROM driver_credit_entry WHERE app_driver_id = $1 AND org_id = $2`),
    consents: await q(`SELECT purpose, granted, source, at FROM privacy_consent WHERE app_driver_id = $1 AND org_id = $2 ORDER BY at`),
  };
}

/** Close a verified request: done (its action carried out) or rejected (with the reason). */
export async function close(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await reqRow(orgId, id);
  const outcome = String(b.outcome ?? '').trim().slice(0, 2000);
  if (b.action === 'reject') {
    if (!['new', 'verified'].includes(r.status)) throw new PrivacyError(409, `The request is ${r.status}.`);
    if (!outcome) throw new PrivacyError(422, 'outcome: why it is rejected (the person is told).');
    await S(() => query(`UPDATE privacy_request SET status = 'rejected', closed_at = now(), closed_by = $2, outcome = $3 WHERE id = $1`, [r.id, userId, outcome]));
    return reqOf(await reqRow(orgId, id));
  }
  if (b.action !== 'complete') throw new PrivacyError(422, 'action is complete or reject.');
  if (r.status !== 'verified') throw new PrivacyError(409, 'Verify who the person is first.');
  let result: Record<string, unknown> = {};
  const needDriver = () => { if (!r.app_driver_id) throw new PrivacyError(409, 'Link the request to the driver\'s account (verify it with the account) first.'); return r.app_driver_id as string; };
  if (r.kind === 'access' || r.kind === 'export') {
    const data = await driverData(orgId, needDriver());
    result = { sections: Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])) };
  } else if (r.kind === 'correction') {
    const did = needDriver();
    const name = b.name === undefined ? undefined : (b.name ? String(b.name).trim().slice(0, 120) : null);
    const email = b.email === undefined ? undefined : (b.email ? String(b.email).trim().toLowerCase() : null);
    if (email && !EMAIL_RE.test(email)) throw new PrivacyError(422, 'email is not an e-mail address.');
    if (name === undefined && email === undefined) throw new PrivacyError(422, 'name or email: the corrected values.');
    const before = await S(() => one<any>(`SELECT name, email FROM app_driver WHERE id = $1`, [did]));
    await S(() => query(`UPDATE app_driver SET name = CASE WHEN $2 THEN $3 ELSE name END, email = CASE WHEN $4 THEN $5 ELSE email END WHERE id = $1`,
      [did, name !== undefined, name ?? null, email !== undefined, email ?? null]));
    result = { changed: [...(name !== undefined ? ['name'] : []), ...(email !== undefined ? ['email'] : [])], before: { name: !!before?.name, email: !!before?.email } };
  } else if (r.kind === 'erasure') {
    const did = needDriver();
    const del = await import('../driver/account-deletion.js');
    const blockers = await del.deletionBlockers(did, null);
    if (blockers.length) throw new PrivacyError(409, `The account cannot be erased yet: ${blockers.map((x) => x.code.replace(/_/g, ' ')).join(', ')}. Settle these first (the law allows keeping what is needed for the payment).`);
    const d = await S(() => one<any>(`SELECT phone FROM app_driver WHERE id = $1 AND deleted_at IS NULL`, [did]));
    result = d ? { erased: await del.anonymise(did, d.phone, 'web') } : { erased: 'already deleted' };
  } else if (r.kind === 'objection') {
    const did = needDriver();
    const purposes = (Array.isArray(b.purposes) ? b.purposes : PURPOSES).map(String).filter((p) => (PURPOSES as readonly string[]).includes(p));
    for (const p of purposes) await S(() => query(`INSERT INTO privacy_consent (org_id, app_driver_id, purpose, granted, source, text_version) VALUES ($1,$2,$3,false,'console',$4)`, [orgId, did, p, r.number]));
    result = { withdrawn: purposes };
  }
  await S(() => query(`UPDATE privacy_request SET status = 'done', closed_at = now(), closed_by = $2, outcome = $3, result = $4 WHERE id = $1`, [r.id, userId, outcome || null, JSON.stringify(result)]));
  return reqOf(await reqRow(orgId, id));
}

// ------------------------------------------------------------------ the driver app

/** The operator a driver's request goes to: the brand's, else the one they last charged with. */
async function orgFor(appDriverId: string, brandOrg: string | null) {
  if (brandOrg) return brandOrg;
  const r = await S(() => one<any>(`SELECT org_id FROM driver_charge WHERE app_driver_id = $1 ORDER BY created_at DESC LIMIT 1`, [appDriverId]));
  if (!r) throw new PrivacyError(422, 'Belum ada operator yang menyimpan data Anda.');
  return r.org_id as string;
}

export async function driverRequest(appDriverId: string, brandOrg: string | null, b: Record<string, unknown>) {
  const orgId = await orgFor(appDriverId, brandOrg);
  const kind = String(b.kind ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new PrivacyError(422, 'Pilih jenis permintaan.');
  const open = await S(() => one<{ n: string }>(`SELECT count(*) AS n FROM privacy_request WHERE app_driver_id = $1 AND org_id = $2 AND status IN ('new', 'verified')`, [appDriverId, orgId]));
  if (Number(open?.n ?? 0) >= 3) throw new PrivacyError(429, 'Masih ada permintaan Anda yang sedang diproses.');
  const d = await S(() => one<any>(`SELECT name, email, phone FROM app_driver WHERE id = $1`, [appDriverId]));
  const r = await create(orgId, { kind, appDriverId, subjectName: d?.name ?? null, subjectEmail: d?.email && EMAIL_RE.test(d.email) ? d.email : null, subjectPhone: d?.phone ?? null,
    details: b.details ? String(b.details).slice(0, 2000) : null }, 'app');
  // Signed in with their phone number: who they are is known.
  await S(() => query(`UPDATE privacy_request SET status = 'verified', verified_at = now(), verification = $2 WHERE id = $1`, [Number(r.id), 'Signed in to the app with the account\'s phone number']));
  return { number: r.number, dueAt: r.dueAt };
}

export async function driverConsents(appDriverId: string, brandOrg: string | null) {
  const orgId = await orgFor(appDriverId, brandOrg).catch(() => null);
  if (!orgId) return { consents: PURPOSES.map((p) => ({ purpose: p, granted: false, at: null })) };
  const rows = await S(() => many<any>(`SELECT DISTINCT ON (purpose) purpose, granted, at FROM privacy_consent WHERE app_driver_id = $1 AND org_id = $2 ORDER BY purpose, at DESC`, [appDriverId, orgId]));
  return { consents: PURPOSES.map((p) => { const r = rows.find((x) => x.purpose === p); return { purpose: p, granted: !!r?.granted, at: r ? new Date(r.at).toISOString() : null }; }) };
}

export async function setDriverConsent(appDriverId: string, brandOrg: string | null, b: Record<string, unknown>) {
  const orgId = await orgFor(appDriverId, brandOrg);
  const purpose = String(b.purpose ?? '');
  if (!(PURPOSES as readonly string[]).includes(purpose)) throw new PrivacyError(422, 'Pilih jenis persetujuan.');
  await S(() => query(`INSERT INTO privacy_consent (org_id, app_driver_id, purpose, granted, source, text_version) VALUES ($1,$2,$3,$4,'app',$5)`,
    [orgId, appDriverId, purpose, b.granted === true, b.textVersion ? String(b.textVersion).slice(0, 40) : null]));
  return driverConsents(appDriverId, brandOrg);
}

export async function consentLog(orgId: string, q: Record<string, unknown> = {}) {
  const purpose = String(q.purpose ?? '');
  const rows = await S(() => many<any>(
    `SELECT c.purpose, c.granted, c.source, c.text_version, c.at, d.name, d.phone FROM privacy_consent c LEFT JOIN app_driver d ON d.id = c.app_driver_id
      WHERE c.org_id = $1 AND ($2 = '' OR c.purpose = $2) ORDER BY c.at DESC LIMIT 500`, [orgId, (PURPOSES as readonly string[]).includes(purpose) ? purpose : '']));
  const current = await S(() => many<any>(
    `SELECT purpose, count(*) FILTER (WHERE granted) AS granted, count(*) AS drivers FROM (SELECT DISTINCT ON (app_driver_id, purpose) app_driver_id, purpose, granted FROM privacy_consent
       WHERE org_id = $1 ORDER BY app_driver_id, purpose, at DESC) x GROUP BY purpose`, [orgId]));
  return {
    summary: PURPOSES.map((p) => { const c = current.find((x) => x.purpose === p); return { purpose: p, granted: Number(c?.granted ?? 0), drivers: Number(c?.drivers ?? 0) }; }),
    log: rows.map((r) => ({ purpose: r.purpose, granted: r.granted, source: r.source, textVersion: r.text_version ?? null, at: new Date(r.at).toISOString(),
      driver: r.name ?? (r.phone && !String(r.phone).startsWith('deleted:') ? `${String(r.phone).slice(0, 5)}…${String(r.phone).slice(-3)}` : 'deleted account') })),
  };
}

// ------------------------------------------------------------------ inventory and retention

/** The personal data held for the operator: where, why, how long, how much. */
export async function inventory(orgId: string) {
  const s = await settings(orgId);
  const n = async (sql: string) => Number((await S(() => one<{ n: string }>(sql, [orgId])).catch(() => null))?.n ?? 0);
  const ret = (days: number | null, otherwise: string) => (days ? `${days} days` : otherwise);
  return [
    { category: 'Driver accounts', data: 'Phone number, name, e-mail, language', where: 'app_driver', purpose: 'Signing in, receipts, support', basis: 'Contract', retention: 'Until the account is deleted',
      records: await n(`SELECT count(DISTINCT app_driver_id) AS n FROM driver_charge WHERE org_id = $1 AND app_driver_id IS NOT NULL`) },
    { category: 'Charging and payments', data: 'Sessions (time, place, energy), payments, saved cards (brand, last four)', where: 'charging_session, driver_charge, payment_intent', purpose: 'Billing, tax records', basis: 'Contract; legal obligation', retention: 'Kept for the tax and accounting periods (anonymised when the account is deleted)',
      records: await n(`SELECT count(*) AS n FROM driver_charge WHERE org_id = $1`) },
    { category: 'Vehicle plates', data: 'Plates read by cameras, parking stays', where: 'plate_event, parking_visit', purpose: 'Parking, barrier, overstay', basis: 'Legitimate interest', retention: ret(s.plateRetentionDays, 'Not cleared (set a retention)'),
      records: await n(`SELECT count(*) AS n FROM plate_event WHERE org_id = $1 AND plate <> '*'`) },
    { category: 'Residents, staff and hotel guests', data: 'Names, units, rooms, cards, plates', where: 'private_member, hotel_stay', purpose: 'Private charging, room charging', basis: 'Contract', retention: 'Until removed or checked out',
      records: (await n(`SELECT count(*) AS n FROM private_member WHERE org_id = $1 AND archived_at IS NULL`)) + (await n(`SELECT count(*) AS n FROM hotel_stay WHERE org_id = $1 AND status = 'in_house'`)) },
    { category: 'Support cases', data: 'Messages, name, contact', where: 'support_case, support_message', purpose: 'Answering the driver', basis: 'Contract', retention: ret(s.supportCaseDays, 'Not cleared (set a retention)'),
      records: await n(`SELECT count(*) AS n FROM support_case WHERE org_id = $1`) },
    { category: 'Survey comments', data: 'Scores and comments', where: 'survey_response', purpose: 'Improving the service', basis: 'Consent (answering is optional)', retention: ret(s.surveyCommentDays, 'Not cleared (set a retention)'),
      records: await n(`SELECT count(*) AS n FROM survey_response WHERE org_id = $1 AND comment IS NOT NULL`) },
    { category: 'Consents', data: 'Each grant and withdrawal', where: 'privacy_consent', purpose: 'Proof of consent', basis: 'Legal obligation', retention: 'Kept',
      records: await n(`SELECT count(*) AS n FROM privacy_consent WHERE org_id = $1`) },
  ];
}

/** Worker (daily): plates, survey comments and closed support cases past their retention are cleared; due requests alerted. */
export async function sweep(): Promise<{ plates: number; comments: number; cases: number; due: number }> {
  const out = { plates: 0, comments: 0, cases: 0, due: 0 };
  const orgs = await S(() => many<any>(`SELECT * FROM privacy_settings WHERE plate_retention_days IS NOT NULL OR survey_comment_days IS NOT NULL OR support_case_days IS NOT NULL`));
  for (const o of orgs) {
    if (o.plate_retention_days) {
      out.plates += (await S(() => query(`UPDATE plate_event SET plate = '*' WHERE org_id = $1 AND plate <> '*' AND seen_at < now() - make_interval(days => $2)`, [o.org_id, o.plate_retention_days]))).rowCount ?? 0;
      out.plates += (await S(() => query(`UPDATE parking_visit SET plate = '*' WHERE org_id = $1 AND plate <> '*' AND status <> 'open' AND entered_at < now() - make_interval(days => $2)`, [o.org_id, o.plate_retention_days]))).rowCount ?? 0;
    }
    if (o.survey_comment_days) {
      out.comments += (await S(() => query(`UPDATE survey_response SET comment = NULL WHERE org_id = $1 AND comment IS NOT NULL AND created_at < now() - make_interval(days => $2)`, [o.org_id, o.survey_comment_days]))).rowCount ?? 0;
    }
    if (o.support_case_days) {
      const ids = await S(() => many<any>(
        `UPDATE support_case SET customer_name = NULL, customer_email = NULL, customer_phone_masked = NULL, subject = 'Removed after the retention period'
          WHERE org_id = $1 AND status IN ('resolved', 'closed') AND subject <> 'Removed after the retention period' AND updated_at < now() - make_interval(days => $2) RETURNING id`,
        [o.org_id, o.support_case_days]));
      if (ids.length) await S(() => query(`UPDATE support_message SET body = '[removed after the retention period]' WHERE case_id = ANY($1::bigint[])`, [ids.map((r) => r.id)]));
      out.cases += ids.length;
    }
  }
  const due = await S(() => many<any>(
    `UPDATE privacy_request SET due_alerted_at = now() WHERE status IN ('new', 'verified') AND due_alerted_at IS NULL AND due_at < now() + interval '1 day'
     RETURNING id, org_id, number, kind, due_at`));
  for (const r of due) {
    await S(() => persistAlert({ orgId: r.org_id, kind: DUE_ALERT, severity: 'warning', targetType: 'privacy_request', targetId: String(r.id),
      message: `Privacy request ${r.number} (${r.kind}) is due ${new Date(r.due_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` } as any)).catch(() => null);
  }
  out.due = due.length;
  return out;
}
