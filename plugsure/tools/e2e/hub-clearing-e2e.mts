// PlugSure Hub clearing and settlement (WP H2) end-to-end test — design §11.3 steps 8–12, "H2 as built".
//
// Around the running hub (HUB_ENABLED=true, HUB_PUBLIC_URL=$E2E_HUB):
//   - an EXTERNAL member XCP  MY*C??  with a CPO and an eMSP role (a fake OCPI platform),
//   - an EXTERNAL member XEM  SG*E??  with an eMSP and a CPO role (a fake),
//   - the INTERNAL tenant (the seeded operator, its home eMSP party; in-process),
// each with a console login (the external members' hub-only organisations get one each), and:
//   CDRs routed (pushed, and pulled once more) → exactly one ledger row each → per-agreement dispute window and
//   commission → the eMSP disputes through the member API → the CPO accepts → credit CDR + corrected CDR →
//   dispute credited → a settlement run (draft, idempotent, finalised once) → statements for the CPO, the eMSP
//   and the internal tenant with bilateral netting and commission → fee invoices with tax → payments recorded and
//   confirmed through the member API → every balance zero. Isolation between members is checked on the way.
//
// The CDRs are back-dated (SQL) into a past month no run has used, so the run can be finalised now.
// Needs E2E_DATABASE_URL (runtime role). The fakes listen on E2E_HUB_CLEARING_FAKE_PORT .. +1 (9351-9352).
//     npx tsx tools/e2e/hub-clearing-e2e.mts
// NEVER point this at production.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { FakeParty, type Got } from './lib/ocpi-fakes.mts';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
const FAKE_PORT = Number(process.env.E2E_HUB_CLEARING_FAKE_PORT ?? 9351);
if (!DB) { console.error('E2E_DATABASE_URL is required'); process.exit(2); }

const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const R2 = () => Array.from({ length: 2 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

function session() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
    const ct = r.headers.get('content-type') ?? '';
    const buf = Buffer.from(await r.arrayBuffer());
    let d: any = ct.includes('application/pdf') ? buf : buf.toString();
    if (ct.includes('json')) { try { d = JSON.parse(d); } catch { /* text */ } }
    return { status: r.status, data: d, type: ct };
  };
  return call;
}
const ops = session();
const plat = session();
const xcpUser = session();
const xemUser = session();
const db = new pg.Client({ connectionString: DB });

function admin(email: string, slug: string, password: string, extra = '', orgName = '') {
  execSync(`npx tsx src/db/create-admin.ts --email ${email} --name "Clearing E2E" --org-slug ${slug} ${orgName ? `--org-name "${orgName}"` : ''} --password '${password}' ${extra}`,
    { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' });
}

const CPO_ID = `C${R2()}`;
const EMSP_ID = `E${R2()}`;
const both = (id: string, name: string, cc: string) => [{ role: 'CPO', country_code: cc, party_id: id, name }, { role: 'EMSP', country_code: cc, party_id: id, name }];
const mods: Array<[string, 'SENDER' | 'RECEIVER']> = [['cdrs', 'SENDER'], ['cdrs', 'RECEIVER'], ['sessions', 'SENDER'], ['sessions', 'RECEIVER'], ['locations', 'SENDER'], ['locations', 'RECEIVER'],
  ['tokens', 'SENDER'], ['tokens', 'RECEIVER'], ['hubclientinfo', 'RECEIVER']];
const XCP = new FakeParty({ name: 'XCP', port: FAKE_PORT, prefix: '/xcp', roles: both(CPO_ID, 'E2E Clearing CPO Sdn Bhd', 'MY'), modules: mods });
const XEM = new FakeParty({ name: 'XEM', port: FAKE_PORT + 1, prefix: '/xem', roles: both(EMSP_ID, 'E2E Clearing eMSP Pte Ltd', 'SG'), modules: mods });
const pXCP = { country_code: 'MY', party_id: CPO_ID };
const pXEM = { country_code: 'SG', party_id: EMSP_ID };
const ID = (n: string) => `HCL-${RUN}-${n}`;

/** A Malaysian CDR (MYR, location in Malaysia) from `cpo` for a driver of `emsp`. */
function cdr(cpo: { country_code: string; party_id: string }, emsp: { country_code: string; party_id: string; uid?: string; contract_id?: string }, id: string, excl: number, incl: number, extra: Record<string, unknown> = {}) {
  return {
    country_code: cpo.country_code, party_id: cpo.party_id, id, start_date_time: '2026-10-01T10:00:00Z', end_date_time: '2026-10-01T10:40:00Z', session_id: `S-${id}`,
    cdr_token: { country_code: emsp.country_code, party_id: emsp.party_id, uid: emsp.uid ?? `UID-${RUN}`, type: 'RFID', contract_id: emsp.contract_id ?? `${emsp.country_code}-${emsp.party_id}-${RUN}` },
    auth_method: 'WHITELIST',
    cdr_location: { id: `LOC-${RUN}`, name: 'Clearing Mall', address: 'Jalan 1', city: 'Kuala Lumpur', country: 'MYS', coordinates: { latitude: '3.158', longitude: '101.711' },
      evse_uid: `EVSE-${RUN}`, evse_id: `MY*${CPO_ID}*E1`, connector_id: '1', connector_standard: 'IEC_62196_T2_COMBO', connector_format: 'CABLE', connector_power_type: 'DC' },
    currency: 'MYR', charging_periods: [{ start_date_time: '2026-10-01T10:00:00Z', dimensions: [{ type: 'ENERGY', volume: 12.5 }] }],
    total_cost: { excl_vat: excl, incl_vat: incl }, total_energy: excl < 0 ? -12.5 : 12.5, total_time: 0.667, last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };
}
const ledger = async (id: string) => (await db.query(`SELECT * FROM hub_cdr WHERE cdr_id = $1`, [id])).rows;

let sgEntityBefore: any = null;
try {
  await db.connect();
  await db.query(`SET app.rls_bypass = 'on'`);
  for (const f of [XCP, XEM]) await f.start();

  // ═══════════════════════════════════════════ setup: members, logins, agreements, commission
  check('setup: the operator signs in', (await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' })).status === 200);
  const emailP = `hub-clearing-${RUN.toLowerCase()}@plugsure.test`;
  const pwP = `Hub-Clearing-${RUN}-2026!`;
  admin(emailP, `hub-clearing-${RUN.toLowerCase()}`, pwP, '--platform-admin', `Hub Clearing Platform ${RUN}`);
  await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [emailP]);
  check('setup: the platform administrator signs in', (await plat('POST', '/v1/auth/login', { email: emailP, password: pwP })).status === 200);
  check('setup: an operator cannot use the clearing admin API (403)', (await ops('GET', '/v1/hub/clearing/overview')).status === 403);
  for (const m of (await plat('GET', '/v1/hub/members?kind=external')).data?.members ?? []) {
    if (String(m.legal_name).startsWith('E2E Clearing') && m.status !== 'terminated') await plat('PATCH', `/v1/hub/members/${m.id}`, { action: 'terminate' });
  }
  // Earlier runs of this suite back-dated their CDRs: whatever of them was not settled is voided, so this run's period only holds its own.
  await db.query(`UPDATE hub_cdr SET status = 'void' WHERE cdr_id LIKE 'HCL-%' AND settlement_run_id IS NULL AND status <> 'void'`);

  let parties = (await ops('GET', '/v1/roaming/parties')).data?.parties ?? [];
  if (!parties.length) {
    await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'PLS', businessName: 'Nusantara Charge' });
    parties = (await ops('GET', '/v1/roaming/parties')).data?.parties ?? [];
  }
  const HOME = { country_code: parties[0]?.country_code as string, party_id: parties[0]?.party_id as string };
  const orgId = (await db.query(`SELECT org_id FROM ocpi_party WHERE country_code = $1 AND party_id = $2`, [HOME.country_code, HOME.party_id])).rows[0]?.org_id as string;
  const card = (await ops('POST', '/v1/tokens', { uid: `HCLCARD-${RUN}`, holderName: 'Clearing Driver', accountType: 'fleet', fleetName: 'Clearing Fleet' })).data;
  await ops('PUT', '/v1/roaming/cards', { ids: [card.id], shared: true });
  const cardRow = (await db.query(`SELECT uid, contract_id FROM token WHERE id = $1`, [card.id])).rows[0];
  check('setup: the tenant has a roaming identity and a shared card', !!HOME.party_id && !!cardRow?.contract_id, { HOME, cardRow });

  const mXcp = (await plat('POST', '/v1/hub/members', { legal_name: 'E2E Clearing CPO Sdn Bhd', country_code: 'MY' })).data.member;
  const cXcp = (await plat('POST', `/v1/hub/members/${mXcp.id}/connections`, {})).data;
  const mXem = (await plat('POST', '/v1/hub/members', { legal_name: 'E2E Clearing eMSP Pte Ltd', country_code: 'SG' })).data.member;
  const cXem = (await plat('POST', `/v1/hub/members/${mXem.id}/connections`, {})).data;
  const r1 = await XCP.registerWithHub(cXcp.versionsUrl, cXcp.token);
  const r2 = await XEM.registerWithHub(cXem.versionsUrl, cXem.token);
  const join = await plat('POST', '/v1/hub/members/join-tenant', { org_id: orgId });
  for (const m of [mXcp.id, mXem.id, join.data.member.id]) await plat('PATCH', `/v1/hub/members/${m}`, { action: 'activate' });
  check('setup: two external members (each CPO + eMSP) registered, the tenant joined, all active',
    r1.credentials.status === 200 && r2.credentials.status === 200 && join.status === 200, { r1: r1.credentials.body, r2: r2.credentials.body, j: join.data });
  const all = (await plat('GET', '/v1/hub/parties')).data.parties as any[];
  const P = (cc: string, pid: string, role: string) => all.find((p) => p.country_code === cc && p.party_id === pid && p.role === role);
  const xcpCpo = P('MY', CPO_ID, 'CPO'), xcpEmsp = P('MY', CPO_ID, 'EMSP'), xemCpo = P('SG', EMSP_ID, 'CPO'), xemEmsp = P('SG', EMSP_ID, 'EMSP'), pltEmsp = P(HOME.country_code, HOME.party_id, 'EMSP');
  const a1 = (await plat('POST', '/v1/hub/agreements', { cpo_party_id: xcpCpo.id, emsp_party_id: xemEmsp.id })).data.agreement;
  const a2 = (await plat('POST', '/v1/hub/agreements', { cpo_party_id: xemCpo.id, emsp_party_id: xcpEmsp.id })).data.agreement;
  const a3 = (await plat('POST', '/v1/hub/agreements', { cpo_party_id: xcpCpo.id, emsp_party_id: pltEmsp.id })).data.agreement;
  check('setup: agreements XCP→XEM, XEM→XCP and XCP→tenant are active', [a1, a2, a3].every((a) => a?.status === 'active'), [a1, a2, a3]);
  for (const [user, m, who] of [[xcpUser, mXcp, 'xcp'], [xemUser, mXem, 'xem']] as const) {
    const slug = (await db.query(`SELECT slug FROM organisation WHERE id = $1`, [m.org_id])).rows[0].slug as string;
    const email = `hub-clearing-${who}-${RUN.toLowerCase()}@plugsure.test`;
    admin(email, slug, pwP);
    await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [email]);
    check(`setup: a console login for the external member ${who.toUpperCase()} (its hub-only organisation)`, (await user('POST', '/v1/auth/login', { email, password: pwP })).status === 200);
  }

  // TODO(commercial) in production; here a commission on the XCP→XEM agreement: CPO 3 %, eMSP 1.00 per CDR, MYR; dispute window 7 days.
  const plan = await plat('POST', '/v1/hub/clearing/fee-plans', { name: `E2E Clearing MYR ${RUN}`, currency: 'MYR', cpo_bps: 300, emsp_fixed_minor: 100 });
  const badPlan = await plat('POST', '/v1/hub/clearing/fee-plans', { name: 'x', currency: 'MYR', cpo_bps: 9000 });
  const terms = await plat('PUT', `/v1/hub/clearing/agreements/${a1.id}/terms`, { dispute_days: 7, fee_plans: { MYR: plan.data.feePlan?.id } });
  const wrongCur = await plat('PUT', `/v1/hub/clearing/agreements/${a1.id}/terms`, { fee_plans: { SGD: plan.data.feePlan?.id } });
  check('commission: the platform creates a MYR plan and sets it, with a 7-day dispute window, on the XCP→XEM agreement',
    plan.status === 201 && badPlan.status === 400 && terms.status === 200 && terms.data.dispute_days === 7 && terms.data.fee_plans?.MYR?.feePlanId === plan.data.feePlan.id && wrongCur.status === 400,
    { plan: plan.data, terms: terms.data, wrongCur: wrongCur.data });
  const placeholder = (await plat('GET', '/v1/hub/clearing/fee-plans')).data.feePlans.filter((p: any) => p.is_default);
  check('commission: the default plans are zero placeholders, one per currency', placeholder.length >= 3 && placeholder.every((p: any) => p.cpo_bps === 0 && p.emsp_bps === 0 && Number(p.emsp_fixed_minor) === 0), placeholder);
  // The Singapore entity GST-registered for this run (its fee invoice then carries GST); restored at the end.
  sgEntityBefore = (await plat('GET', '/v1/hub/clearing/entities')).data.entities.find((e: any) => e.country_code === 'SG');
  const ent = await plat('PUT', '/v1/hub/clearing/entities/SG', { legal_name: sgEntityBefore.legal_name, address: sgEntityBefore.address, invoice_prefix: sgEntityBefore.invoice_prefix, tax_registered: true, placeholder: true, tax_id: 'M9-PLACEHOLDER' });
  check('entities: the PlugSure entities are placeholders; the SG one is set GST-registered for this run', sgEntityBefore?.placeholder === true && ent.status === 200 && ent.data.entity.tax_registered === true, ent.data);

  // ═══════════════════════════════════════════ CDRs routed → ledger (exactly once)
  const C1 = ID('C1');
  const c1 = cdr(pXCP, pXEM, C1, 15, 16.2);
  const p1 = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), c1, { from: pXCP, to: pXEM });
  const got1 = XEM.received((g: Got) => g.method === 'POST' && g.body?.id === C1);
  check('CDR: the CPO pushes a CDR to the eMSP through the hub (delivered)', [200, 201].includes(p1.status) && p1.body.status_code === 1000 && got1.length === 1,
    { body: p1.body, got: XEM.got.slice(-5).map((g) => `${g.method} ${g.path} ${g.body?.id ?? ''}`) });
  const l1 = (await until(() => ledger(C1), (r) => r.length > 0))[0];
  check('ledger: one row — pending, CPO / eMSP parties and members, agreement, MYR minor units incl/excl, energy, routing ids, raw CDR',
    l1?.status === 'pending' && l1.cpo_member_id === mXcp.id && l1.emsp_member_id === mXem.id && l1.agreement_id === a1.id && l1.currency === 'MYR'
      && Number(l1.total_excl_minor) === 1500 && Number(l1.total_incl_minor) === 1620 && Number(l1.energy_kwh) === 12.5 && l1.forward_state === 'delivered'
      && l1.routing?.correlation_id === p1.correlationId && l1.body?.id === C1 && l1.source === 'push', l1);
  check('ledger: the dispute window is the agreement\'s 7 days', !!l1 && new Date(l1.dispute_deadline).getTime() - new Date(l1.received_at).getTime() === 7 * 86_400_000, l1 && [l1.received_at, l1.dispute_deadline]);
  XCP.own.cdrs.push(c1);
  const pull = await XEM.call('GET', `${XEM.hubEp('cdrs', 'SENDER')}?date_from=2026-01-01T00:00:00Z`, undefined, { from: pXEM, to: pXCP });
  await sleep(800);
  check('ledger: the eMSP pulls the same CDR through the hub — still exactly one row', pull.status === 200 && pull.body.data?.some((x: any) => x.id === C1) && (await ledger(C1)).length === 1, { pull: pull.body, n: (await ledger(C1)).length });
  const changed = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), { ...c1, total_cost: { excl_vat: 99, incl_vat: 99 } }, { from: pXCP, to: pXEM });
  check('ledger: the same CDR id with other totals is refused (2001) and the ledger keeps the first', changed.body.status_code === 2001 && Number((await ledger(C1))[0].total_excl_minor) === 1500, changed.body);

  const C2 = ID('C2');
  const p2 = await XEM.call('POST', XEM.hubEp('cdrs', 'RECEIVER'), cdr({ country_code: 'SG', party_id: EMSP_ID }, { country_code: 'MY', party_id: CPO_ID, uid: `UID-${RUN}-XCP` }, C2, 5, 5.4), { from: pXEM, to: pXCP });
  const C3 = ID('C3');
  const p3 = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), cdr(pXCP, { ...HOME, uid: cardRow.uid, contract_id: cardRow.contract_id }, C3, 10, 10.8), { from: pXCP, to: HOME });
  const l2 = (await until(() => ledger(C2), (r) => r.length > 0))[0];
  const l3 = (await until(() => ledger(C3), (r) => r.length > 0))[0];
  check('CDR: the reverse direction (XEM as CPO → XCP as eMSP) and XCP → the internal tenant are routed and recorded (14-day default window)',
    [200, 201].includes(p2.status) && [200, 201].includes(p3.status) && l2?.status === 'pending' && l3?.status === 'pending' && l3.emsp_org_id === orgId && l3.forward_state === 'delivered'
      && new Date(l3.dispute_deadline).getTime() - new Date(l3.received_at).getTime() === 14 * 86_400_000,
    { l2: l2 && [l2.status, l2.forward_state, l2.flags], l3: l3 && [l3.status, l3.forward_state, l3.flags, l3.emsp_org_id, orgId, l3.received_at, l3.dispute_deadline] });

  // ═══════════════════════════════════════════ member views and isolation
  const xemList = (await xemUser('GET', '/v1/roaming/hub/clearing/cdrs')).data.cdrs ?? [];
  const xcpList = (await xcpUser('GET', '/v1/roaming/hub/clearing/cdrs?side=cpo')).data.cdrs ?? [];
  const pltList = (await ops('GET', '/v1/roaming/hub/clearing/cdrs')).data.cdrs ?? [];
  check('member API: each member lists its own CDRs with its side (XEM: C1 as eMSP, C2 as CPO; XCP as CPO: C1, C3)',
    xemList.some((c: any) => c.cdr_id === C1 && c.side === 'emsp') && xemList.some((c: any) => c.cdr_id === C2 && c.side === 'cpo') && !xemList.some((c: any) => c.cdr_id === C3)
      && xcpList.some((c: any) => c.cdr_id === C1) && xcpList.some((c: any) => c.cdr_id === C3) && !xcpList.some((c: any) => c.cdr_id === C2), { xemList: xemList.map((c: any) => c.cdr_id), xcpList: xcpList.map((c: any) => c.cdr_id) });
  check('isolation: the tenant sees its own CDR (C3) and not the others\' (list, detail → 404)',
    pltList.some((c: any) => c.cdr_id === C3) && !pltList.some((c: any) => c.cdr_id === C1 || c.cdr_id === C2) && (await ops('GET', `/v1/roaming/hub/clearing/cdrs/${l1.id}`)).status === 404, pltList.map((c: any) => c.cdr_id));
  const csv = await plat('GET', `/v1/hub/clearing/cdrs.csv?q=HCL-${RUN}`);
  check('admin: the ledger exports as CSV', csv.status === 200 && String(csv.data).split('\r\n').filter(Boolean).length === 4, String(csv.data).slice(0, 300));

  // ═══════════════════════════════════════════ dispute → credit CDR + corrected CDR
  const notMine = await xcpUser('POST', `/v1/roaming/hub/clearing/cdrs/${l1.id}/dispute`, { reason: 'amount', message: 'x' });
  const dsp = await xemUser('POST', `/v1/roaming/hub/clearing/cdrs/${l1.id}/dispute`, { reason: 'amount', message: 'The agreed tariff is RM 0.96/kWh: 12.00 + tax', claimed_minor: 1296 });
  check('dispute: only the eMSP disputes (the CPO → 404); the eMSP opens it within the window', notMine.status === 404 && dsp.status === 201 && dsp.data.dispute?.status === 'open', { notMine: notMine.data, dsp: dsp.data });
  const did = dsp.data.dispute.id;
  check('dispute: the CDR is disputed; the tenant cannot see the dispute', (await ledger(C1))[0].status === 'disputed' && (await ops('GET', `/v1/roaming/hub/clearing/disputes/${did}`)).status === 404);
  const wrongSide = await xemUser('POST', `/v1/roaming/hub/clearing/disputes/${did}/respond`, { action: 'accept' });
  const acc = await xcpUser('POST', `/v1/roaming/hub/clearing/disputes/${did}/respond`, { action: 'accept', note: 'Agreed: credit and re-issue at the agreed tariff.' });
  const ev = await xcpUser('POST', `/v1/roaming/hub/clearing/disputes/${did}/notes`, { note: 'Tariff sheet v3 attached by email.' });
  check('dispute: the eMSP cannot answer for the CPO; the CPO accepts and adds evidence', wrongSide.status === 404 && acc.status === 200 && acc.data.dispute.status === 'accepted' && ev.data.notes?.length === 3, { wrongSide: wrongSide.data, acc: acc.data, ev: ev.data });
  const C1CR = ID('C1CR'), C1N = ID('C1N');
  const pc = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), cdr(pXCP, pXEM, C1CR, -15, -16.2, { credit: true, credit_reference_id: C1 }), { from: pXCP, to: pXEM });
  const pn = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), cdr(pXCP, pXEM, C1N, 12, 12.96), { from: pXCP, to: pXEM });
  const dd = await until(() => xemUser('GET', `/v1/roaming/hub/clearing/disputes/${did}`), (r) => r.data?.dispute?.status === 'credited');
  const nw = (await until(() => ledger(C1N), (r) => r.length > 0))[0];
  const [o, cr] = [(await ledger(C1))[0], (await ledger(C1CR))[0]];
  check('credit: the credit CDR resolves the dispute (credited); the original is credited, the credit accepted with its fees reversed',
    [200, 201].includes(pc.status) && [200, 201].includes(pn.status) && dd.data.dispute.resolution === 'credited' && o.status === 'credited' && o.credited_by_cdr_id === cr?.id && cr?.status === 'accepted'
      && Number(cr.total_incl_minor) === -1620 && Number(o.fee_cpo_minor) === 45 && Number(o.fee_emsp_minor) === 100 && Number(cr.fee_cpo_minor) === -45 && Number(cr.fee_emsp_minor) === -100
      && nw?.status === 'pending',
    { o: o && [o.status, o.credited_by_cdr_id, o.fee_cpo_minor, o.fee_emsp_minor], cr: cr && [cr.id, cr.status, cr.total_incl_minor, cr.fee_cpo_minor, cr.fee_emsp_minor], nw: nw && [nw.status, nw.flags] });
  check('dispute: the history is kept as notes (raised, accepted, evidence, credited)',
    JSON.stringify(dd.data.notes.map((n: any) => `${n.side}:${n.kind}`)) === JSON.stringify(['emsp:raised', 'cpo:accepted', 'cpo:note', 'system:credited']), dd.data.notes);
  const ids = [C1, C1CR, C1N, C2, C3];
  const counts = (await db.query(`SELECT cdr_id, count(*)::int AS n FROM hub_cdr WHERE cdr_id = ANY($1) GROUP BY 1`, [ids])).rows;
  check('ledger: every CDR routed or pulled through the hub has exactly one row', counts.length === 5 && counts.every((r) => r.n === 1), counts);

  // ═══════════════════════════════════════════ settlement
  const used = new Set((await db.query(`SELECT period FROM hub_settlement_run WHERE currency = 'MYR' AND cycle = 'monthly' AND status <> 'void'`)).rows.map((r) => r.period));
  let PERIOD = '';
  for (let y = 2010; y < 2020 && !PERIOD; y++) for (let m = 1; m <= 12 && !PERIOD; m++) { const p = `${y}-${String(m).padStart(2, '0')}`; if (!used.has(p)) PERIOD = p; }
  // Received on the 3rd of that month (Kuala Lumpur), with their windows long past.
  await db.query(`UPDATE hub_cdr SET received_at = ($2 || '-03 10:00:00+08')::timestamptz + (row_number_hack.n || ' minutes')::interval,
                         dispute_deadline = ($2 || '-03 10:00:00+08')::timestamptz + interval '7 days'
                    FROM (SELECT id, row_number() OVER (ORDER BY received_at) AS n FROM hub_cdr WHERE cdr_id = ANY($1)) row_number_hack
                   WHERE hub_cdr.id = row_number_hack.id`, [ids, PERIOD]);
  const acc2 = await plat('POST', '/v1/hub/clearing/accept-due');
  const statuses = Object.fromEntries((await db.query(`SELECT cdr_id, status FROM hub_cdr WHERE cdr_id = ANY($1)`, [ids])).rows.map((r) => [r.cdr_id.replace(`HCL-${RUN}-`, ''), r.status]));
  check('settlement: once their windows pass, the CDRs are accepted (fees frozen); the credited pair stays paired',
    acc2.status === 200 && acc2.data.accepted >= 3 && statuses.C2 === 'accepted' && statuses.C3 === 'accepted' && statuses.C1N === 'accepted' && statuses.C1 === 'credited' && statuses.C1CR === 'accepted', { acc2: acc2.data, statuses });
  const run1 = await plat('POST', '/v1/hub/clearing/runs', { currency: 'MYR', period: PERIOD });
  const run2 = await plat('POST', '/v1/hub/clearing/runs', { currency: 'MYR', period: PERIOD });
  const runId = run1.data.run?.id;
  check('settlement: creating the run is idempotent (201 draft, then 200 the same draft)', run1.status === 201 && run2.status === 200 && run2.data.run.id === runId && run2.data.created === false && run1.data.run.status === 'draft', { r1: run1.data, r2: run2.data });
  const prev = (await plat('POST', `/v1/hub/clearing/runs/${runId}/preview`)).data.run?.preview;
  check('settlement: the draft preview shows 5 CDRs and two bilateral positions; nothing is stamped yet',
    prev?.cdrCount === 5 && prev.positions.length === 2 && (await db.query(`SELECT count(*)::int AS n FROM hub_cdr WHERE settlement_run_id = $1`, [runId])).rows[0].n === 0, prev);
  const bad = await plat('POST', '/v1/hub/clearing/runs', { currency: 'EUR', period: PERIOD });
  check('settlement: an unsupported currency is refused (no FX)', bad.status === 400, bad.data);
  const fin = await plat('POST', `/v1/hub/clearing/runs/${runId}/finalise`, {});
  const fin2 = await plat('POST', `/v1/hub/clearing/runs/${runId}/finalise`, {});
  check('settlement: finalised once; finalising again changes nothing', fin.status === 200 && fin.data.run.status === 'finalised' && fin.data.alreadyFinalised === false && fin2.data.alreadyFinalised === true, { fin: fin.data, fin2: fin2.data });
  const detail = (await plat('GET', `/v1/hub/clearing/runs/${runId}`)).data;
  const pos = (a: string, b: string) => detail.positions.find((p: any) => [p.member_a_id, p.member_b_id].sort().join() === [a, b].sort().join());
  const pXX = pos(mXcp.id, mXem.id), pXT = pos(mXcp.id, join.data.member.id);
  check('netting: XCP ⇄ XEM nets to 7.56 paid by XEM (12.96 − 5.40; the credited 16.20 offsets itself); the tenant pays XCP 10.80',
    Number(pXX?.net_minor) === 756 && pXX.payer_member_id === mXem.id && pXX.payee_member_id === mXcp.id && Number(pXT?.net_minor) === 1080 && pXT.payer_member_id === join.data.member.id, detail.positions);
  const st = (m: string) => detail.statements.find((s: any) => s.member_id === m);
  const sX = st(mXcp.id), sE = st(mXem.id), sT = st(join.data.member.id);
  check('statements: CPO / eMSP / internal tenant — receivables, payables, net and commission',
    [sX?.receivable_minor, sX?.payable_minor, sX?.net_minor, sX?.fee_net_minor].map(Number).join() === '2376,540,1836,36'
      && [sE?.receivable_minor, sE?.payable_minor, sE?.net_minor, sE?.fee_net_minor].map(Number).join() === '540,1296,-756,100'
      && [sT?.receivable_minor, sT?.payable_minor, sT?.net_minor, sT?.fee_net_minor].map(Number).join() === '0,1080,-1080,0', detail.statements);
  const invX = detail.feeInvoices.find((i: any) => i.member_id === mXcp.id), invE = detail.feeInvoices.find((i: any) => i.member_id === mXem.id);
  check('fee invoices: from the member\'s country entity with its tax — MY (not registered) 0.36 no tax; SG GST-registered 1.00 + GST 9 % = 1.09; none for the tenant (0 commission)',
    detail.feeInvoices.length === 2 && invX?.entity_country === 'MY' && invX.tax_scheme === 'NONE' && Number(invX.total_minor) === 36
      && invE?.entity_country === 'SG' && invE.tax_scheme === 'SG_GST' && Number(invE.tax_minor) === 9 && Number(invE.total_minor) === 109, detail.feeInvoices);

  // Documents through the member API (and isolation).
  const myStatements = (await xcpUser('GET', '/v1/roaming/hub/clearing/statements')).data.statements ?? [];
  const html = await xcpUser('GET', `/v1/roaming/hub/clearing/statements/${sX.id}/html`);
  const pdf = await xcpUser('GET', `/v1/roaming/hub/clearing/statements/${sX.id}/pdf`);
  const scsv = await xcpUser('GET', `/v1/roaming/hub/clearing/statements/${sX.id}/csv`);
  check('documents: the CPO reads its statement as HTML (not a tax invoice), PDF and CSV (one row per CDR)',
    myStatements.some((s: any) => s.id === sX.id) && html.status === 200 && String(html.data).includes('not a tax invoice') && String(html.data).includes('RM 18.36')
      && pdf.status === 200 && Buffer.isBuffer(pdf.data) && pdf.data.subarray(0, 5).toString() === '%PDF-' && String(scsv.data).trim().split('\r\n').length === 6,
    { s: myStatements.length, h: html.status, p: pdf.status, c: String(scsv.data).slice(0, 400) });
  check('isolation: a member cannot read another member\'s statement or fee invoice (404)',
    (await xemUser('GET', `/v1/roaming/hub/clearing/statements/${sX.id}`)).status === 404 && (await ops('GET', `/v1/roaming/hub/clearing/fee-invoices/${invE.id}/pdf`)).status === 404);
  const myInv = (await xemUser('GET', '/v1/roaming/hub/clearing/fee-invoices')).data.feeInvoices ?? [];
  const invHtml = await xemUser('GET', `/v1/roaming/hub/clearing/fee-invoices/${invE.id}/html`);
  check('documents: the eMSP reads its fee invoice (GST line; placeholder issuer flagged)', myInv.length === 1 && invHtml.status === 200 && String(invHtml.data).includes('GST 9%') && String(invHtml.data).includes('PLACEHOLDER'), String(invHtml.data).slice(0, 300));
  const tenantSt = (await ops('GET', '/v1/roaming/hub/clearing/statements')).data.statements ?? [];
  check('documents: the internal tenant has its statement (payable 10.80)', tenantSt.some((s: any) => s.id === sT.id && Number(s.payable_minor) === 1080), tenantSt);

  // ═══════════════════════════════════════════ payments → balances zero
  const today = new Date().toISOString().slice(0, 10);
  const xemPos = ((await xemUser('GET', `/v1/roaming/hub/clearing/positions?run=${runId}`)).data.positions ?? [])[0];
  check('payments: the eMSP sees what it owes (pay 7.56, due in 14 days)', xemPos?.direction === 'pay' && Number(xemPos.outstanding_minor) === 756 && xemPos.status === 'open', xemPos);
  const pay1 = await xemUser('POST', '/v1/roaming/hub/clearing/payments', { position_id: xemPos.id, amount_minor: 756, paid_at: today, reference: `TRF-${RUN}-1`, method: 'bank_transfer' });
  const conf1 = await xcpUser('POST', `/v1/roaming/hub/clearing/payments/${pay1.data.payment?.id}/confirm`);
  check('payments: the payer records the transfer; the payee confirms → confirmed, nothing outstanding',
    pay1.status === 201 && pay1.data.position.status === 'paid' && conf1.status === 200 && conf1.data.position.status === 'confirmed' && Number(conf1.data.position.net_minor) - Number(conf1.data.position.paid_minor) === 0, { pay1: pay1.data, conf1: conf1.data });
  const tPos = ((await ops('GET', `/v1/roaming/hub/clearing/positions?run=${runId}`)).data.positions ?? []);
  check('isolation: the tenant sees only its own position', tPos.length === 1 && tPos[0].id === pXT.id, tPos);
  const over = await ops('POST', '/v1/roaming/hub/clearing/payments', { position_id: pXT.id, amount_minor: 2000, paid_at: today, reference: 'too much' });
  const part = await ops('POST', '/v1/roaming/hub/clearing/payments', { position_id: pXT.id, amount_minor: 1000, paid_at: today, reference: `TRF-${RUN}-2` });
  const rest = await ops('POST', '/v1/roaming/hub/clearing/payments', { position_id: pXT.id, amount_minor: 80, paid_at: today, reference: `TRF-${RUN}-3` });
  check('payments: the tenant pays in two parts (overpaying refused); partially paid → paid',
    over.status === 409 && part.status === 201 && part.data.position.status === 'partially_paid' && Number(part.data.position.paid_minor) === 1000 && rest.data.position?.status === 'paid', { over: over.data, part: part.data, rest: rest.data });
  for (const p of [part, rest]) await xcpUser('POST', `/v1/roaming/hub/clearing/payments/${p.data.payment.id}/confirm`);
  for (const i of detail.feeInvoices) await plat('POST', `/v1/hub/clearing/fee-invoices/${i.id}/paid`, { paid_at: today, reference: `FEE-${RUN}` });
  const finalPos = (await plat('GET', `/v1/hub/clearing/positions?run=${runId}`)).data.positions ?? [];
  const finalInv = (await plat('GET', `/v1/hub/clearing/fee-invoices?run=${runId}`)).data.feeInvoices ?? [];
  check('balances: every position of the run is confirmed with nothing outstanding; the fee invoices are paid',
    finalPos.length === 2 && finalPos.every((p: any) => p.status === 'confirmed' && Number(p.outstanding_minor) === 0) && finalInv.every((i: any) => i.status === 'paid'), { finalPos, finalInv });
  const sum = (await xcpUser('GET', '/v1/roaming/hub/clearing/summary')).data;
  check('balances: the CPO\'s summary shows nothing outstanding', Array.isArray(sum.positions) && sum.positions.every((p: any) => Number(p.outstanding_minor) === 0), sum.positions);
  const audits = (await db.query(`SELECT action FROM audit_log WHERE action LIKE 'hub.%' AND target_id = ANY($1)`, [[did, runId, pay1.data.payment.id]])).rows.map((r) => r.action);
  check('audit: dispute, run and payment transitions are on the audit chains',
    ['hub.dispute_opened', 'hub.dispute_accepted', 'hub.settlement_run_finalised', 'hub.payment_recorded', 'hub.payment_confirmed'].every((a) => audits.includes(a)), [...new Set(audits)]);
} catch (e) {
  check('suite ran without crashing', false, (e as Error).stack ?? String(e));
} finally {
  if (sgEntityBefore) {
    await plat('PUT', '/v1/hub/clearing/entities/SG', { legal_name: sgEntityBefore.legal_name, address: sgEntityBefore.address, invoice_prefix: sgEntityBefore.invoice_prefix,
      tax_registered: sgEntityBefore.tax_registered, placeholder: sgEntityBefore.placeholder, tax_id: sgEntityBefore.tax_id ?? undefined }).catch(() => null);
  }
  for (const m of (await plat('GET', '/v1/hub/members?kind=external').catch(() => ({ data: {} }))).data?.members ?? []) {
    if (String(m.legal_name).startsWith('E2E Clearing') && m.status !== 'terminated') await plat('PATCH', `/v1/hub/members/${m.id}`, { action: 'terminate' }).catch(() => null);
  }
  for (const f of [XCP, XEM]) await f.stop().catch(() => null);
  await db.end().catch(() => null);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
