// PlugSure v1.3 — promotions and memberships, end to end.
//
// Part A, in a developer sandbox on real OCPP sessions: a membership plan for a
// fleet account (member price, included kWh, no service fee), a happy-hour
// promotion limited to one use per customer; sessions for a member card and a
// non-member card; the discounts on the receipts, included kWh used up, the
// promotion's limits and statistics; the membership fee on the fleet invoice
// and in the e-Faktur file.
//
// Part B, in the operator's test tenant (the driver app does not show
// sandboxes): a plan offered in the app and a code-only promotion; a driver's
// quote with and without the code and the membership; buying and renewing a
// 30-day pass by QRIS (mock). Both are switched off at the end.
//
// Needs E2E_DATABASE_URL (the runtime role).
//
//     npx tsx tools/e2e/pricing-e2e.mts
//
// NEVER point this at production.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000, every = 700): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}
let cookie = '';
const ops = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(API + path, {
    method,
    headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
};
let KEY = '';
const sb = (method: string, path: string, body?: unknown) => http(method, path, body, { authorization: `Bearer ${KEY}` });
const pg = process.env.E2E_DATABASE_URL ? new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL }) : null;
if (pg) await pg.connect();
let sandboxId = '';
const cleanup: Array<() => Promise<unknown>> = [];
const localHhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const contract: string[] = [];
let cc: (path: string, method: string, status: string, body: unknown) => void = () => {};
const sumLines =(lines: any[], pred: (l: any) => boolean) => lines.filter(pred).reduce((a, l) => a + l.amountIdr, 0);

try {
  if (!pg) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  const spec = (await http('GET', '/openapi.json')).data;
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  ajv.addFormat('binary', true);
  ajv.addSchema({ $id: 'spec', components: spec.components });
  cc = (path, method, status, body) => {
    const s = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
    if (!s) { contract.push(`no documented ${status} schema for ${method} ${path}`); return; }
    const v = ajv.compile(JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"spec#/components/')));
    if (!v(body)) contract.push(`${method} ${path}: ${v.errors.slice(0, 3).map((e: any) => `${e.instancePath} ${e.message}`).join('; ')}`);
  };
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  for (const s of (await ops('GET', '/v1/sandboxes')).data.sandboxes ?? []) if (/E2E/.test(s.name)) await ops('DELETE', `/v1/sandboxes/${s.id}`);
  const sbx = await ops('POST', '/v1/sandboxes', { name: 'Pricing E2E' });
  KEY = sbx.data.apiKey; sandboxId = sbx.data.id;
  const DC = sbx.data.chargePoints.find((c: any) => c.current === 'DC').identity as string;
  check('setup: a sandbox with virtual chargers', login.status === 200 && sbx.status === 201, sbx.data);

  // ================================================================ Part A — sandbox
  const acct = (await sb('GET', '/v1/fleet-accounts')).data.accounts.find((a: any) => a.name === 'Sandbox Logistik');
  const plan = await sb('POST', '/v1/subscription-plans', {
    name: 'Armada Plus', monthlyFeeIdr: 150000, memberRateIdr: 2000, includedKwh: 1, waiveSessionFees: true, description: 'Fleet membership',
  });
  const badPlan = await sb('POST', '/v1/subscription-plans', { name: 'Bad', monthlyFeeIdr: 1000, energyDiscountPercent: 150 });
  check('plans: created; an impossible discount refused (422)', plan.status === 201 && plan.data.member_rate_idr === 2000 && badPlan.status === 422, { plan: plan.data, bad: badPlan.data });
  const member = await sb('POST', '/v1/subscriptions', { planId: plan.data.id, subscriberKind: 'fleet_account', fleetAccountId: acct.id, billing: 'invoice' });
  const twice = await sb('POST', '/v1/subscriptions', { planId: plan.data.id, subscriberKind: 'fleet_account', fleetAccountId: acct.id });
  const looseCard = await sb('POST', '/v1/subscriptions', { planId: plan.data.id, subscriberKind: 'card', cardUid: 'SANDBOX-RFID-0001', billing: 'invoice' });
  check('members: a fleet account enrolled (billed on its invoice); one live membership each; a card on no account cannot be invoice-billed',
    member.status === 201 && member.data.status === 'active' && twice.status === 409 && looseCard.status === 422, { m: member.data, t: twice.status, l: looseCard.data });
  const now = new Date();
  const promo = await sb('POST', '/v1/promotions', {
    name: 'Happy hour', kind: 'energy_percent', value: 10, audience: 'everyone', maxPerCustomer: 1,
    timeFrom: localHhmm(new Date(now.getTime() - 3600_000)), timeTo: localHhmm(new Date(now.getTime() + 3 * 3600_000)), stacksWithMembership: true,
  });
  const badPromo = await sb('POST', '/v1/promotions', { name: 'x', kind: 'energy_percent', value: 0 });
  check('promotions: a happy hour created; a zero-value offer refused', promo.status === 201 && promo.data.time_from && badPromo.status === 422, { p: promo.data, b: badPromo.data });

  const listDc = async () => { const d = (await sb('GET', `/v1/sessions?identity=${DC}`)).data; return Array.isArray(d) ? d : []; };
  const charge = async (connectorId: number, idTag: string, kwh: number) => {
    const before = new Set((await listDc()).map((s: any) => s.id));
    await until(() => sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'tap-card', connectorId, idTag, kwh }), (r) => r.status === 200, 30_000, 1500);
    const s = await until(async () => (await listDc()).find((x: any) => !before.has(x.id) && x.ended_at && x.total_idr != null), (x) => !!x, 60_000, 1200);
    if (!s) throw new Error(`no rated session for ${idTag}`);
    const detail = await sb('GET', `/v1/sessions/${s.id}`);
    cc('/v1/sessions/{id}', 'get', '200', detail.data);
    return detail.data;
  };
  await until(() => sb('GET', '/v1/charge-points'), (r) => Array.isArray(r.data) && r.data.find((c: any) => c.ocpp_identity === DC)?.online, 30_000);

  // S1: member card — member price, 1 kWh included, service fee waived, plus the happy hour on top.
  const s1 = await charge(1, 'SANDBOX-FLEET-0002', 2);
  const l1 = s1.lines as any[];
  const e1 = s1.energy_wh / 1000;
  const memberLines = l1.filter((l) => l.adjustment?.source === 'subscription');
  const promoLines = l1.filter((l) => l.adjustment?.source === 'promotion');
  const energyNet = sumLines(l1, (l) => l.kind === 'energy');
  const afterMember = Math.round(e1 * 2000) - Math.round(Math.min(1, e1) * (Math.round(e1 * 2000) / e1));
  check(`member session (${e1} kWh): energy at Rp 2,000/kWh, 1 kWh included, service fee waived, happy hour 10% on top`,
    memberLines.length === 3 && promoLines.length === 1 && sumLines(l1, (l) => l.kind === 'session' || l.kind === 'admin') === 0
      && Math.abs(energyNet - (afterMember - Math.round(afterMember * 0.1))) <= 3,
    { lines: l1.map((l) => [l.kind, l.description, l.amountIdr]), expected: afterMember - Math.round(afterMember * 0.1) });
  check('member session: PBJT-TL is on the discounted energy, PPN on the discounted price',
    s1.pbjt_idr === Math.round((energyNet * 1000) / 10000) && s1.subtotal_idr === l1.reduce((a, l) => a + l.amountIdr, 0), { pbjt: s1.pbjt_idr, energyNet, sub: s1.subtotal_idr });
  const use1 = (await pg.query(`SELECT used_kwh::float8 AS u FROM subscription_usage WHERE subscription_id = $1`, [member.data.id])).rows[0];
  check('member session: 1 kWh of the included allowance used', Math.abs((use1?.u ?? 0) - Math.min(1, e1)) < 0.001, use1);

  // S2: non-member card — happy hour only. S3: same card again — the one-use limit.
  const s2 = await charge(2, 'SANDBOX-RFID-0001', 1);
  const s3 = await charge(2, 'SANDBOX-RFID-0001', 1);
  const p2 = (s2.lines as any[]).filter((l) => l.adjustment?.source === 'promotion');
  check('non-member: the happy hour applies once; the second session pays full price (one per customer)',
    p2.length === 1 && !(s2.lines as any[]).some((l) => l.adjustment?.source === 'subscription') && !(s3.lines as any[]).some((l) => l.adjustment),
    { s2: (s2.lines as any[]).map((l) => [l.description, l.amountIdr]), s3: (s3.lines as any[]).filter((l) => l.adjustment) });

  // S4: member again — included kWh used up, the happy hour already used by this card.
  const s4 = await charge(1, 'SANDBOX-FLEET-0002', 1.5);
  const a4 = (s4.lines as any[]).filter((l) => l.adjustment);
  check('member again: member price and no service fee, but the included kWh are used up and the happy hour was used',
    a4.length === 2 && a4.every((l) => l.adjustment.source === 'subscription') && !a4.some((l) => /included/.test(l.description)), a4.map((l) => l.description));
  const receipt = await sb('GET', `/v1/sessions/${s1.id}/receipt`);
  check('the tax receipt shows the membership and promotion lines', receipt.status === 200 && receipt.text.includes('Armada Plus') && receipt.text.includes('Happy hour'), receipt.status);
  const stats = await sb('GET', `/v1/promotions/${promo.data.id}`);
  cc('/v1/promotions/{id}', 'get', '200', stats.data);
  cc('/v1/subscriptions', 'post', '201', member.data);  const discountGiven = [...l1, ...(s2.lines as any[])].filter((l) => l.adjustment?.source === 'promotion').reduce((a, l) => a - l.amountIdr, 0);
  check('promotion statistics: 2 uses by 2 customers, and the discount given', stats.data.redemptions === 2 && stats.data.customers === 2 && Number(stats.data.discount_idr) === discountGiven, stats.data);

  // Membership fee on the fleet invoice (last month) and in the e-Faktur file.
  await pg.query(`UPDATE cdr SET issued_at = ((date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '5 days') AT TIME ZONE 'Asia/Jakarta') WHERE org_id = $1`, [sandboxId]);
  // In force for the whole of last month (70 days back always covers it).
  await pg.query(`UPDATE subscription SET started_at = started_at - interval '70 days' WHERE id = $1`, [member.data.id]);
  // Part of a month: a card of the account enrolled 10 days before last month ended is billed for those 10 days.
  const cardMember = await sb('POST', '/v1/subscriptions', { planId: plan.data.id, subscriberKind: 'card', cardUid: 'SANDBOX-FLEET-0002', billing: 'invoice' });
  await pg.query(`UPDATE subscription SET started_at = ((date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '10 days') AT TIME ZONE 'Asia/Jakarta') WHERE id = $1`, [cardMember.data.id]);
  const cur = (await sb('GET', '/v1/fleet-billing/periods/2000-01')).data.current as string;
  const [y, m] = cur.split('-').map(Number);
  const prev = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
  const daysPrev = new Date(Date.UTC(y!, m! - 1, 0)).getUTCDate();
  const cardFee = Math.round((150000 * 10) / daysPrev);
  const cardTotal = cardFee + Math.round(Math.round((cardFee * 11) / 12) * 0.12);
  const st = await sb('GET', `/v1/fleet-accounts/${acct.id}/statement?period=${prev}`);
  cc('/v1/fleet-accounts/{id}/statement', 'get', '200', st.data);
  const fee = st.data.fees?.find((f: any) => f.subscriber === 'fleet account');
  const partFee = st.data.fees?.find((f: any) => /^card SANDBOX-FLEET-0002/.test(f.subscriber));
  check('fleet invoice: the membership fee with PPN (DPP 11/12, 12%) is on the month\'s statement',
    st.data.fees?.length === 2 && fee?.feeIdr === 150000 && fee.dppIdr === 137500 && fee.ppnIdr === 16500 && st.data.totals.feesIdr === 166500 + cardTotal
      && st.data.totals.totalIdr === st.data.totals.ownTotalIdr + st.data.totals.roamingIdr + 166500 + cardTotal, { fees: st.data.fees, t: st.data.totals });
  check(`fleet invoice: a membership in force part of the month is billed for its days (10 of ${daysPrev}: Rp ${cardFee})`,
    partFee?.feeIdr === cardFee && partFee.days === 10 && partFee.daysInPeriod === daysPrev && new RegExp(`10 of ${daysPrev} days`).test(partFee.subscriber) && partFee.totalIdr === cardTotal, partFee);
  await sb('PUT', `/v1/fleet-accounts/${acct.id}`, { taxIdKind: 'TIN', taxId: '0012345678901000' });
  await sb('PUT', '/v1/fleet-billing/settings', {
    npwp: '0987654321098765', nitku: '0987654321098765000000', address: 'Jakarta',
    efaktur: { itemOpt: 'A', itemCode: '000000', unitCode: 'UM.0033', feeItemOpt: 'B', feeItemCode: '000000', feeUnitCode: 'UM.0033', confirmed: true },
  });
  const inv = await sb('POST', '/v1/fleet-invoices', { fleetAccountId: acct.id, period: prev });
  const again = await sb('GET', `/v1/fleet-accounts/${acct.id}/statement?period=${prev}`);
  const xml = (await sb('GET', `/v1/fleet-billing/periods/${prev}/efaktur.xml`)).text;
  check('fleet invoice: issued with the fee; the fee is not billed twice; the e-Faktur file has a services line for it',
    inv.status === 201 && inv.data.totals.feesIdr === 166500 + cardTotal && again.data.status === 'issued' && /Keanggotaan Armada Plus/.test(xml) && /<Opt>B<\/Opt>/.test(xml) && /<VAT>16500<\/VAT>/.test(xml),
    { inv: inv.status, xml: xml.slice(0, 200) });

  // ================================================================ Part B — driver app (operator's tenant)
  const appPlan = await ops('POST', '/v1/subscription-plans', { name: `E2E Pass ${Date.now().toString().slice(-5)}`, monthlyFeeIdr: 49000, energyDiscountPercent: 15, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${appPlan.data.id}`, { active: false, offeredInApp: false }));
  cleanup.push(async () => {
    for (const s of (await ops('GET', `/v1/subscriptions?planId=${appPlan.data.id}`)).data.subscriptions ?? []) if (s.status === 'active') await ops('POST', `/v1/subscriptions/${s.id}/cancel`);
  });
  const code = `E2E${Date.now().toString().slice(-6)}`;
  const codePromo = await ops('POST', '/v1/promotions', { name: 'E2E code offer', kind: 'energy_percent', value: 25, audience: 'code', code, maxPerCustomer: 1 });
  cleanup.push(() => ops('PUT', `/v1/promotions/${codePromo.data.id}`, { active: false }));
  const dev = (await http('POST', '/d/v1/device')).data.deviceToken as string;
  const d = (method: string, path: string, body?: unknown) => http(method, '/d' + path, body, { authorization: `Bearer ${dev}` });
  const guestView = await d('GET', '/v1/memberships');
  check('app: plans offered in the app are listed; buying needs a phone sign-in',
    guestView.data.signedIn === false && guestView.data.plans.some((p: any) => p.id === appPlan.data.id && p.totalIdr === 49000 + Math.round(Math.round(49000 * 11 / 12) * 0.12))
      && (await d('POST', '/v1/memberships', { planId: appPlan.data.id })).status === 422, guestView.data.plans?.map((p: any) => p.name));
  const phone = `0815${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const otp = await d('POST', '/v1/otp/send', { phone });
  await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  const stations = (await http('GET', '/d/v1/stations')).data.stations as any[];
  const conn = stations.flatMap((s) => s.connectors).find((c: any) => c.available || c.status === 'Available' || c.status === 'Offline')?.connectorId ?? stations[0].connectors[0].connectorId;
  const q0 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 100000 });
  const qBad = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 100000, promoCode: 'NOSUCHCODE' });
  const qCode = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 100000, promoCode: code.toLowerCase() });
  check('quote: an unknown code is explained; the valid code (any case) buys more energy for the same rupiah',
    q0.status === 200 && /tidak dikenal/.test(qBad.data.codeProblem ?? '') && qCode.data.promotion === 'E2E code offer' && qCode.data.allowanceWh > q0.data.allowanceWh * 1.2,
    { q0: q0.data, bad: qBad.data?.codeProblem, code: qCode.data });
  const buy = await d('POST', '/v1/memberships', { planId: appPlan.data.id });
  const pending = await d('GET', `/v1/memberships/charges/${buy.data.chargeId}`);
  const paid = await d('POST', `/v1/memberships/charges/${buy.data.chargeId}/confirm-payment`);
  const view = await d('GET', '/v1/memberships');
  const mine = view.data.memberships?.find((x: any) => x.planId === appPlan.data.id);
  const days = mine ? (new Date(mine.periodEnd).getTime() - Date.now()) / 86_400_000 : 0;
  check('pass: QRIS charge for fee + PPN, pending until paid, then active for 30 days',
    buy.status === 200 && /^data:image\/svg/.test(buy.data.qr.qrImage) && buy.data.totalIdr === 49000 + buy.data.ppnIdr && pending.data.state === 'pending'
      && paid.status === 200 && mine?.status === 'active' && days > 29.9 && days <= 30.01, { buy: buy.data?.totalIdr, mine, days });
  const qMember = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 100000 });
  check('quote as a member: the plan is named and the same rupiah buys more energy', qMember.data.membership === appPlan.data.name && qMember.data.allowanceWh > q0.data.allowanceWh, qMember.data);
  const renew = await d('POST', '/v1/memberships', { planId: appPlan.data.id });
  await d('POST', `/v1/memberships/charges/${renew.data.chargeId}/confirm-payment`);
  const view2 = await d('GET', '/v1/memberships');
  const mine2 = view2.data.memberships?.find((x: any) => x.planId === appPlan.data.id);
  check('renewal: the next 30 days start when the current ones end (60 days in total)',
    Math.abs(new Date(renew.data.periodStart).getTime() - new Date(mine.periodEnd).getTime()) < 1000 && (new Date(mine2.periodEnd).getTime() - Date.now()) / 86_400_000 > 59.9, { renew: renew.data?.periodStart, end: mine2?.periodEnd });
  const other = await ops('POST', '/v1/subscription-plans', { name: `E2E Other ${Date.now().toString().slice(-5)}`, monthlyFeeIdr: 10000, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${other.data.id}`, { active: false, offeredInApp: false }));
  const quoteSwitch = (await d('GET', '/v1/memberships')).data.plans.find((p: any) => p.id === other.data.id)?.switch;
  check('another plan with the same operator: switching is quoted with the unused days credited (a cheaper plan: free, and it runs longer)',
    !!quoteSwitch && quoteSwitch.creditIdr > 90_000 && quoteSwitch.payTotalIdr === 0 && quoteSwitch.days > 30, quoteSwitch);
  const members = await ops('GET', `/v1/subscriptions?planId=${appPlan.data.id}`);
  check('console: the app member is listed with QRIS billing', members.data.subscriptions?.[0]?.billing === 'qris' && members.data.subscriptions[0].status === 'active', members.data.subscriptions?.[0]);
  const appHtml = await http('GET', '/app/');
  check('app: promo code, memberships and pass payment are in the web app', /Kode promo \(opsional\)/.test(appHtml.text) && /\/v1\/memberships/.test(appHtml.text) && /VIEWS\.mpay/.test(appHtml.text), appHtml.status);
  cc('/v1/subscriptions', 'get', '200', members.data);
  const plans = await ops('GET', '/v1/subscription-plans'); cc('/v1/subscription-plans', 'get', '200', plans.data);
  const promos = await ops('GET', '/v1/promotions'); cc('/v1/promotions', 'get', '200', promos.data);
  const upd = await ops('PUT', `/v1/promotions/${codePromo.data.id}`, { maxRedemptions: 100 }); cc('/v1/promotions/{id}', 'put', '200', upd.data);
  cc('/v1/subscription-plans', 'post', '201', appPlan.data);
  cc('/v1/promotions', 'post', '201', codePromo.data);
  check('contract: live pricing responses match the published schemas', contract.length === 0, contract);
  const audit = await ops('GET', '/v1/audit?limit=50');
  check('audit: plans and promotions are in the audit trail', ['subscription_plan.created', 'promotion.created'].every((a) => JSON.stringify(audit.data).includes(a)), audit.status);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const c of cleanup) await c().catch(() => {});
  if (sandboxId) await ops('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  if (pg) await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
