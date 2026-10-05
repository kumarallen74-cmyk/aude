// PlugSure Hub — the operator console's hub screens (WP H3), end to end against the real API.
//
// Every call the Hub screens (src/web/js/views/hub.js) and the tenant's "PlugSure Hub" card (roaming.js) make,
// in the order an operator makes them: onboard an external member (token A shown once), its handshake (a fake
// platform), activate with a reason (audited), approve a party, rate limits, body capture, agreements (create,
// flags, suspend/resume/end), the message log filters and a trace, the outbox and replay, party and connection
// lifecycle (alive check, rotate, suspend/resume, close), and the tenant view (membership, parties, agreements,
// self-join). Also: the console serves the Hub view, the menu is gated by features.hub, nothing returns a token.
//
// Runs after hub-e2e in CI (it uses the tenant hub-e2e joined; it joins it itself when run alone).
// Same prerequisites as hub-e2e: HUB_ENABLED=true, E2E_DATABASE_URL. The fake listens on E2E_HUB_CONSOLE_FAKE_PORT (9344).
//     npx tsx tools/e2e/hub-console-e2e.mts
// NEVER point this at production.
import { execSync } from 'node:child_process';
import pg from 'pg';
import { FakeParty } from './lib/ocpi-fakes.mts';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
const FAKE_PORT = Number(process.env.E2E_HUB_CONSOLE_FAKE_PORT ?? 9344);
if (!DB) { console.error('E2E_DATABASE_URL is required'); process.exit(2); }

const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const R2 = () => Array.from({ length: 2 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

let platCookieValue = '';
const platCookie = () => platCookieValue;
function session(keep = false) {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) { cookie = sc.split(';')[0]!; if (keep) platCookieValue = cookie; }
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d, text: t };
  };
}
const ops = session();
const plat = session(true);
const db = new pg.Client({ connectionString: DB });
const reasonOf = async (action: string, targetId: string) =>
  (await db.query(`SELECT after_state FROM audit_log WHERE action = $1 AND target_id = $2 AND org_id IS NULL ORDER BY id DESC LIMIT 1`, [action, targetId])).rows[0]?.after_state?.reason;

const PID = `K${R2()}`;
const PID2 = `L${R2()}`;
const XCP = new FakeParty({ name: 'CON', port: FAKE_PORT, prefix: '/con', roles: [{ role: 'CPO', country_code: 'MY', party_id: PID, name: `E2E Console CPO ${RUN}` }],
  modules: [['locations', 'SENDER'], ['sessions', 'SENDER'], ['cdrs', 'SENDER'], ['tokens', 'RECEIVER'], ['commands', 'RECEIVER'], ['hubclientinfo', 'RECEIVER']] });

let memberId = '';
try {
  await db.connect();
  await db.query(`SET app.rls_bypass = 'on'`);
  await XCP.start();

  // ═══════════════════════════════════════════ setup and the console itself
  check('setup: the operator signs in', (await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' })).status === 200);
  const emailP = `hub-console-${RUN.toLowerCase()}@plugsure.test`;
  const pwP = `Hub-Console-${RUN}-2026!`;
  execSync(`npx tsx src/db/create-admin.ts --email ${emailP} --name "Hub Console ${RUN}" --org-slug hub-console-${RUN.toLowerCase()} --org-name "Hub Console ${RUN}" --password '${pwP}' --platform-admin`,
    { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' });
  await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [emailP]);
  check('setup: a platform administrator signs in', (await plat('POST', '/v1/auth/login', { email: emailP, password: pwP })).status === 200);

  const meP = await plat('GET', '/v1/auth/me');
  const meO = await ops('GET', '/v1/auth/me');
  check('console: /v1/auth/me reports features.hub (the Hub menu and the tenant card are gated by it)', meP.data?.features?.hub === true && meO.data?.features?.hub === true, meP.data?.features);
  check('console: the Hub menu is for platform administrators only (permission platform:admin)', meP.data?.permissions?.includes('platform:admin') && !meO.data?.permissions?.includes('platform:admin'));
  const appJs = await (await fetch(`${API}/js/app.js`)).text();
  const hubJs = await fetch(`${API}/js/views/hub.js`);
  const hubSrc = await hubJs.text();
  check('console: the Hub view module is served and registered (app.js imports it)', hubJs.status === 200 && appJs.includes("'./views/hub.js'") && hubSrc.includes("registerView('hub'") && hubSrc.includes("perm: 'platform:admin'") && hubSrc.includes('features?.hub'));
  for (const p of ['/v1/hub/overview', '/v1/hub/members', '/v1/hub/agreements', '/v1/hub/messages', '/v1/hub/outbox', '/v1/hub/health', '/v1/hub/tenants', '/v1/roaming/hub']) {
    if (!hubSrc.includes(p) && !(await (await fetch(`${API}/js/views/roaming.js`)).text()).includes(p)) check(`console: a screen calls ${p}`, false);
  }
  check('console: a tenant operator cannot read the platform hub screens\' data (403)', (await ops('GET', '/v1/hub/members')).status === 403 && (await ops('GET', '/v1/hub/tenants')).status === 403);

  // ═══════════════════════════════════════════ the tenant card (Roaming → Partners)
  const orgId = meO.data.org.id as string;
  let th = await ops('GET', '/v1/roaming/hub');
  if (!th.data?.member) {
    await plat('POST', '/v1/hub/members/join-tenant', { org_id: orgId });
    th = await ops('GET', '/v1/roaming/hub');
  }
  check('tenant card: membership, its parties and the agreements list', th.status === 200 && !!th.data.member && Array.isArray(th.data.parties) && th.data.parties.length > 0 && Array.isArray(th.data.agreements), th.data);
  check('tenant card: no token, endpoint or versions URL is ever returned to the tenant', !/token|endpoints|versions_url/i.test(th.text), th.text.slice(0, 300));
  const selfJoin = await ops('POST', '/v1/roaming/hub/join');
  check('tenant card: "Join" follows HUB_SELF_JOIN (403 when off; idempotent when on)', th.data.selfJoin ? selfJoin.status === 200 && selfJoin.data.created === false : selfJoin.status === 403, selfJoin);
  const tenantEmsp = th.data.parties.find((p: any) => p.role === 'EMSP');

  // ═══════════════════════════════════════════ overview
  const ov = await plat('GET', '/v1/hub/overview');
  check('overview: members/parties by country, alerts and optional modules for the screen',
    ov.status === 200 && Array.isArray(ov.data.membersByCountry) && Array.isArray(ov.data.partiesByCountry) && Array.isArray(ov.data.alerts) && typeof ov.data.modules?.clearing === 'boolean'
      && ov.data.partiesByCountry.every((x: any) => /^[A-Z]{2}$/.test(x.country_code) && x.n > 0), ov.data);
  const tenants = await plat('GET', '/v1/hub/tenants');
  check('join a tenant: the picker lists tenants with a roaming identity and their membership', tenants.status === 200 && tenants.data.tenants.some((t: any) => t.id === orgId && t.member_id && (t.parties ?? []).length), tenants.data);

  // ═══════════════════════════════════════════ new external member → token A once → handshake
  const created = await plat('POST', '/v1/hub/members', { legal_name: `E2E Console CPO ${RUN}`, country_code: 'MY', billing_email: 'billing@console.test', contract_ref: `HUB-${RUN}` });
  memberId = created.data?.member?.id;
  check('new member: created onboarding, with its hub-only organisation', created.status === 201 && created.data.member.status === 'onboarding' && created.data.member.kind === 'external', created.data);
  const conn = await plat('POST', `/v1/hub/members/${memberId}/connections`, { reason: 'console e2e' });
  const tokenA = conn.data?.token as string;
  const connId = conn.data?.connection?.id as string;
  check('token A: shown once with the versions URL on the hub host', conn.status === 201 && tokenA?.length >= 32 && /\/hub\/ocpi\/versions$/.test(conn.data.versionsUrl), conn.data);
  const detail0 = await plat('GET', `/v1/hub/members/${memberId}`);
  check('token A: never returned again (member detail, connection list)', !detail0.text.includes(tokenA) && !(await plat('GET', '/v1/hub/connections')).text.includes(tokenA) && detail0.data.connections[0]?.state === 'pending');
  const reg = await XCP.registerWithHub(conn.data.versionsUrl, tokenA);
  check('handshake: the member registers with token A (the steps the token dialog lists)', reg.credentials.status === 200 && !!XCP.tokenToHub, reg.credentials.body);
  const detail1 = await until(() => plat('GET', `/v1/hub/members/${memberId}`), (r) => r.data?.connections?.[0]?.state === 'connected');
  const c1 = detail1.data.connections[0];
  check('member detail: the connection is connected, with endpoints and versions URL; its party is PLANNED',
    c1.state === 'connected' && Array.isArray(c1.endpoints) && c1.endpoints.length > 3 && c1.versions_url === XCP.versionsUrl && detail1.data.parties.every((p: any) => p.status === 'PLANNED'), detail1.data);

  const act = await plat('PATCH', `/v1/hub/members/${memberId}`, { action: 'activate', reason: `contract HUB-${RUN} signed` });
  check('activate (with a reason): the member is active and its party CONNECTED', act.status === 200 && act.data.member.status === 'active'
    && (await plat('GET', `/v1/hub/members/${memberId}`)).data.parties.every((p: any) => p.status === 'CONNECTED'), act.data);
  check('audit: the reason is kept with the action', (await reasonOf('hub.member_activate', memberId)) === `contract HUB-${RUN} signed`);
  const det = await plat('PATCH', `/v1/hub/members/${memberId}`, { tax_id: 'SST-123', open_roaming: false });
  check('details: billing details saved', det.status === 200 && det.data.member.tax_id === 'SST-123');

  // ═══════════════════════════════════════════ connection actions
  const party2 = await plat('POST', `/v1/hub/connections/${connId}/parties`, { role: 'CPO', country_code: 'SG', party_id: PID2, business_name: `E2E Console CPO SG ${RUN}`, reason: 'second country' });
  check('approve a party: added PLANNED to the connection', party2.status === 201 && party2.data.party.status === 'PLANNED' && party2.data.party.party_id === PID2, party2.data);
  const lim = await plat('PATCH', `/v1/hub/connections/${connId}`, { rate_limit_per_min: 300, realtime_limit_per_min: 900 });
  check('rate limits: saved', lim.status === 200 && lim.data.connection.rate_limit_per_min === 300 && lim.data.connection.realtime_limit_per_min === 900, lim.data);
  const badLim = await plat('PATCH', `/v1/hub/connections/${connId}`, { rate_limit_per_min: 0 });
  check('rate limits: an invalid value is refused with a message the dialog shows', badLim.status === 400 && /rate limits/.test(badLim.data.error), badLim);
  const cap = await plat('POST', `/v1/hub/connections/${connId}/capture`, { hours: 1, reason: 'support ticket' });
  const capOff = await plat('POST', `/v1/hub/connections/${connId}/capture`, { hours: 0 });
  check('body capture: on for an hour (audited with the reason), then off', cap.status === 200 && !!cap.data.captureBodiesUntil && capOff.status === 200 && capOff.data.captureBodiesUntil === null
    && (await reasonOf('hub.capture_on', connId)) === 'support ticket');
  const alive = await plat('POST', `/v1/hub/connections/${connId}/alive-check`, {});
  check('alive check: the member answers', alive.status === 200 && alive.data.checks?.[0]?.ok === true, alive.data);

  // ═══════════════════════════════════════════ agreements (list, matrix, dialog)
  const cpoParty = detail1.data.parties.find((p: any) => p.role === 'CPO');
  const ag = await plat('POST', '/v1/hub/agreements', { cpo_party_id: cpoParty.id, emsp_party_id: tenantEmsp.id, allow_commands: false, notes: `console e2e ${RUN}` });
  const agId = ag.data?.agreement?.id;
  check('new agreement: active at once, module flag off as chosen', ag.status === 201 && ag.data.agreement.status === 'active' && ag.data.agreement.allow_commands === false, ag.data);
  const same = await plat('POST', '/v1/hub/agreements', { cpo_party_id: cpoParty.id, emsp_party_id: tenantEmsp.id });
  check('new agreement: a second live one for the same pair is refused', same.status >= 400, same);
  const list = await plat('GET', '/v1/hub/agreements');
  check('agreements list (and matrix): party labels for both sides', list.data.agreements.some((a: any) => a.id === agId && a.cpo === `MY*${PID}` && a.emsp === `${tenantEmsp.country_code}*${tenantEmsp.party_id}`));
  const tag2 = await ops('GET', '/v1/roaming/hub');
  const ta = tag2.data.agreements.find((a: any) => a.id === agId);
  check('tenant card: the agreement shows with the counterparty\'s name and the modules', ta?.counterparty === `E2E Console CPO ${RUN}` && ta.we_are_emsp === true && ta.allow_commands === false, ta);
  const flags = await plat('PATCH', `/v1/hub/agreements/${agId}`, { allow_commands: true });
  check('agreement dialog: modules saved', flags.status === 200 && flags.data.agreement.allow_commands === true, flags.data);
  const sus = await plat('PATCH', `/v1/hub/agreements/${agId}`, { action: 'suspend', reason: 'unpaid invoices' });
  const res = await plat('PATCH', `/v1/hub/agreements/${agId}`, { action: 'resume' });
  check('agreement dialog: suspend (reason audited) and resume', sus.data?.agreement?.status === 'suspended' && res.data?.agreement?.status === 'active' && (await reasonOf('hub.agreement_suspend', agId)) === 'unpaid invoices');

  // ═══════════════════════════════════════════ message log, trace, outbox
  // The agreement made the tenant import the new CPO's locations through the hub (GET All, in-process).
  const msgs = await until(() => plat('GET', `/v1/hub/messages?party=${encodeURIComponent(`MY*${PID}`)}&module=locations`), (r) => r.data?.messages?.length > 0);
  check('message log: filtered by party and module', msgs.status === 200 && msgs.data.messages.length > 0
    && msgs.data.messages.every((m: any) => m.module === 'locations' && (m.from_party === `MY*${PID}` || m.to_party === `MY*${PID}`)), msgs.data.messages?.slice(0, 3));
  const cred = await plat('GET', `/v1/hub/messages?connection=${connId}&module=credentials`);
  check('message log: filtered by connection and module (the handshake)', cred.data?.messages?.length === 1 && cred.data.messages[0].method === 'POST', cred.data);
  const errs = await plat('GET', `/v1/hub/messages?connection=${connId}&status=ok&limit=5`);
  check('message log: filtered by connection and status', errs.status === 200 && errs.data.messages.every((m: any) => m.connection_id === connId && (m.http_status ?? 0) < 400));
  const corr = msgs.data.messages[0]?.correlation_id;
  const trace = await plat('GET', `/v1/hub/messages/trace/${encodeURIComponent(corr)}`);
  check('trace: every leg of the correlation id, in order (the request in, the legs out)', trace.status === 200 && trace.data.legs.length >= 2 && trace.data.legs.every((l: any) => l.correlation_id === corr)
    && trace.data.legs.some((l: any) => l.leg === 'in') && trace.data.legs.some((l: any) => l.leg === 'out'), trace.data);
  const ob = await plat('GET', `/v1/hub/outbox?connection=${connId}`);
  check('outbox: rows for the connection (ClientInfo after activation)', ob.status === 200 && Array.isArray(ob.data.rows) && ob.data.rows.every((r: any) => r.recipient_connection_id === connId), ob.data);
  const rep = await plat('POST', '/v1/hub/outbox/replay', { connection_id: connId, reason: 'endpoint fixed' });
  check('outbox: replay answers how many were queued again', rep.status === 200 && typeof rep.data.replayed === 'number', rep.data);
  const health = await plat('GET', '/v1/hub/health');
  check('health: the connection with its party statuses (overview and outbox backlog)', health.data.connections.some((c: any) => c.id === connId && c.parties?.CONNECTED >= 1));

  // ═══════════════════════════════════════════ party and connection lifecycle
  const ps = await plat('PATCH', `/v1/hub/parties/${cpoParty.id}`, { action: 'suspend', reason: 'fraud check' });
  const pr = await plat('PATCH', `/v1/hub/parties/${cpoParty.id}`, { action: 'resume' });
  check('party: suspend (reason audited) and resume', ps.data?.party?.status === 'SUSPENDED' && ps.data.party.admin_suspended === true && pr.data?.party?.admin_suspended === false
    && (await reasonOf('hub.party_suspend', cpoParty.id)) === 'fraud check', { ps: ps.data, pr: pr.data });
  const rot = await plat('POST', `/v1/hub/connections/${connId}/rotate`, { reason: 'yearly rotation' });
  const afterRot = (await plat('GET', `/v1/hub/connections/${connId}`)).data.connection;
  check('connection: rotate token (old token in its grace period, shown as such)', rot.status === 200 && afterRot.rotation_grace === true, { rot: rot.data, afterRot });
  const cs = await plat('POST', `/v1/hub/connections/${connId}/suspend`, { reason: 'maintenance' });
  const cr = await plat('POST', `/v1/hub/connections/${connId}/resume`, {});
  check('connection: suspend and resume', cs.status === 200 && cr.status === 200 && (await plat('GET', `/v1/hub/connections/${connId}`)).data.connection.state === 'connected');
  const end = await plat('PATCH', `/v1/hub/agreements/${agId}`, { action: 'end', reason: 'contract ended' });
  check('agreement: end', end.data?.agreement?.status === 'ended' && !(await ops('GET', '/v1/roaming/hub')).data.agreements.some((a: any) => a.id === agId));
  const close = await plat('POST', `/v1/hub/connections/${connId}/close`, { reason: 'offboarding' });
  const closed = (await plat('GET', `/v1/hub/members/${memberId}`)).data;
  check('connection: close (reason audited); its parties SUSPENDED', close.status === 200 && closed.connections[0].state === 'closed' && closed.parties.every((p: any) => p.status === 'SUSPENDED')
    && (await reasonOf('hub.connection_close', connId)) === 'offboarding', closed);
  const term = await plat('PATCH', `/v1/hub/members/${memberId}`, { action: 'terminate', reason: 'console e2e done' });
  check('member: terminate', term.status === 200 && term.data.member.status === 'terminated', term.data);
  memberId = '';

  // ═══════════════════════════════════════════ clearing screens (Hub → Clearing; Roaming → PlugSure Hub)
  // On the ledger hub-e2e and hub-clearing-e2e leave behind (CI runs them first).
  const cov = await plat('GET', '/v1/hub/clearing/overview');
  check('clearing overview: ledger by currency and status, held flags, disputes, runs, outstanding, fee invoices',
    cov.status === 200 && ['cdrs', 'held', 'disputes', 'runs', 'outstanding', 'feeInvoices'].every((k) => Array.isArray(cov.data[k])), cov.data);
  check('the Hub screens find the clearing module (Clearing tab shown)', (await plat('GET', '/v1/hub/overview')).data?.modules?.clearing === true);
  const p1 = await plat('GET', '/v1/hub/clearing/cdrs?limit=2');
  const p2 = p1.data?.next_cursor ? await plat('GET', `/v1/hub/clearing/cdrs?limit=2&cursor=${encodeURIComponent(p1.data.next_cursor)}`) : null;
  check('ledger: keyset paging with next_cursor (Load more), counterparty names on rows',
    p1.status === 200 && p1.data.cdrs.length === 2 && !!p2 && p2.data.cdrs.length > 0 && !p2.data.cdrs.some((c: any) => p1.data.cdrs.some((x: any) => x.id === c.id))
      && p1.data.cdrs.every((c: any) => 'cpo_member_name' in c && 'emsp_member_name' in c), { p1: p1.data, p2: p2?.data });
  const filt = await plat('GET', '/v1/hub/clearing/cdrs?status=accepted,credited&currency=MYR&unsettled=false');
  check('ledger: status (several), currency filters', filt.status === 200 && filt.data.cdrs.every((c: any) => ['accepted', 'credited'].includes(c.status) && c.currency === 'MYR'));
  const one1 = p1.data.cdrs[0];
  const cdet = await plat('GET', `/v1/hub/clearing/cdrs/${one1.id}`);
  check('CDR drawer: detail with body, routing, disputes and credit links', cdet.status === 200 && !!cdet.data.cdr.body && 'routing' in cdet.data.cdr && Array.isArray(cdet.data.disputes) && Array.isArray(cdet.data.related));
  // A platform dispute on a pending CDR, a note, then withdrawn (the CDR is pending again).
  const pend = (await plat('GET', '/v1/hub/clearing/cdrs?status=pending&limit=50')).data?.cdrs?.find((c: any) => !c.credit && new Date(c.dispute_deadline) > new Date());
  if (pend) {
    const dsp = await plat('POST', `/v1/hub/clearing/cdrs/${pend.id}/dispute`, { reason: 'amount', message: 'console e2e: platform dispute', claimed_minor: 1 });
    const did = dsp.data?.dispute?.id;
    const note = await plat('POST', `/v1/hub/clearing/disputes/${did}/notes`, { note: 'evidence: console e2e' });
    const ddet = await plat('GET', `/v1/hub/clearing/disputes/${did}`);
    const wd = await plat('POST', `/v1/hub/clearing/disputes/${did}/withdraw`, { note: 'console e2e: withdrawn' });
    const after = await plat('GET', `/v1/hub/clearing/cdrs/${pend.id}`);
    check('dispute drawer: raise (platform), add a note, history, withdraw → the CDR is pending again',
      dsp.status === 201 && note.status === 200 && ddet.data?.notes?.some((n: any) => n.body === 'evidence: console e2e') && wd.data?.dispute?.status === 'withdrawn' && after.data?.cdr?.status === 'pending',
      { dsp: dsp.data, wd: wd.data, after: after.data?.cdr?.status });
  } else check('dispute drawer: a pending CDR to dispute (hub-e2e leaves some)', false, 'none pending');
  const dl = await plat('GET', '/v1/hub/clearing/disputes?status=open,accepted,rejected,escalated');
  check('disputes: live filter', dl.status === 200 && dl.data.disputes.every((d: any) => ['open', 'accepted', 'rejected', 'escalated'].includes(d.status)));

  // Commission: a fee plan created and edited; agreement and member terms set and reset.
  const fp = await plat('POST', '/v1/hub/clearing/fee-plans', { name: `Console e2e ${RUN}`, currency: 'SGD', cpo_bps: 150, cpo_fixed_minor: 10, emsp_bps: 0, emsp_fixed_minor: 5, effective_from: '2026-01-01' });
  const fpe = await plat('PATCH', `/v1/hub/clearing/fee-plans/${fp.data?.feePlan?.id}`, { cpo_max_minor: 500, notes: 'edited' });
  check('fee plans: create and edit (amounts in minor units of the plan currency)', fp.status === 201 && fpe.data?.feePlan?.cpo_max_minor === 500 && fpe.data.feePlan.cpo_bps === 150, { fp: fp.data, fpe: fpe.data });
  const ags = await plat('GET', '/v1/hub/clearing/agreements');
  const ag0 = ags.data?.agreements?.find((a: any) => a.status === 'active');
  if (ag0) {
    const t1 = await plat('PUT', `/v1/hub/clearing/agreements/${ag0.id}/terms`, { dispute_days: 21, fee_plans: { SGD: fp.data.feePlan.id } });
    const t2 = await plat('PUT', `/v1/hub/clearing/agreements/${ag0.id}/terms`, { dispute_days: ag0.dispute_days ?? null, fee_plans: { SGD: ag0.fee_plans?.SGD ?? null } });
    check('agreement terms: dispute window and a plan per currency, then reset', t1.data?.dispute_days === 21 && t1.data.fee_plans?.SGD?.feePlanId === fp.data.feePlan.id && t2.status === 200, { t1: t1.data, t2: t2.data });
  }
  const mt = await plat('PUT', `/v1/hub/clearing/members/${created.data.member.id}/terms`, { fee_plans: { SGD: fp.data.feePlan.id } });
  const mtg = await plat('GET', `/v1/hub/clearing/members/${created.data.member.id}/terms`);
  check('member terms: set and read back', mt.status === 200 && mtg.data?.fee_plans?.SGD?.feePlanId === fp.data.feePlan.id, mtg.data);
  await plat('PUT', `/v1/hub/clearing/members/${created.data.member.id}/terms`, { fee_plans: { SGD: null } });

  // Entities: placeholders listed; an edit keeps the placeholder flag the screen shows.
  const ents = await plat('GET', '/v1/hub/clearing/entities');
  const sg = ents.data?.entities?.find((e: any) => e.country_code === 'SG');
  check('entities: three issuers with the placeholder flag', ents.status === 200 && ents.data.entities.length >= 3 && typeof sg?.placeholder === 'boolean', ents.data);
  if (sg) {
    const pe = await plat('PUT', '/v1/hub/clearing/entities/SG', { legal_name: sg.legal_name, address: sg.address, tax_id: sg.tax_id ?? undefined, invoice_prefix: sg.invoice_prefix, tax_registered: sg.tax_registered, placeholder: sg.placeholder });
    check('entities: edit saved (unchanged values)', pe.status === 200 && pe.data.entity.placeholder === sg.placeholder);
  }

  // Runs: a draft for an unused period, preview, void with a reason (audited); another finalised with a reason.
  const r1 = await plat('POST', '/v1/hub/clearing/runs', { currency: 'SGD', period: '2001-01' });
  const r1b = await plat('POST', '/v1/hub/clearing/runs', { currency: 'SGD', period: '2001-01' });
  const prv = await plat('POST', `/v1/hub/clearing/runs/${r1.data?.run?.id}/preview`, {});
  const vd = await plat('POST', `/v1/hub/clearing/runs/${r1.data?.run?.id}/void`, { reason: 'console e2e: wrong period' });
  check('settlement runs: draft created (201), the same again (200), preview, void with a reason (audited)',
    r1.status === 201 && r1b.status === 200 && r1b.data.run.id === r1.data.run.id && prv.status === 200 && vd.data?.run?.status === 'void'
      && (await reasonOf('hub.settlement_run_void', r1.data.run.id)) === 'console e2e: wrong period', { r1: r1.data, vd: vd.data });
  const r2 = await plat('POST', '/v1/hub/clearing/runs', { currency: 'SGD', period: '2001-02' });
  const fin = await plat('POST', `/v1/hub/clearing/runs/${r2.data?.run?.id}/finalise`, { reason: 'console e2e: empty period' });
  const fin2 = await plat('POST', `/v1/hub/clearing/runs/${r2.data?.run?.id}/finalise`, { reason: 'again' });
  check('settlement runs: finalise with a reason (audited); twice returns it unchanged',
    fin.data?.run?.status === 'finalised' && fin2.data?.alreadyFinalised === true && (await reasonOf('hub.settlement_run_finalised', r2.data.run.id)) === 'console e2e: empty period', { fin: fin.data, fin2: fin2.data });
  const runs = await plat('GET', '/v1/hub/clearing/runs?status=finalised');
  const real = runs.data?.runs?.find((r: any) => r.cdr_count > 0);
  const rd = real ? await plat('GET', `/v1/hub/clearing/runs/${real.id}`) : null;
  check('run drawer: a finalised run with positions, statements and fee invoices', !!rd && rd.data.positions.length > 0 && rd.data.statements.length > 0, rd?.data);

  // Documents: statement HTML / PDF / CSV, fee invoice HTML / PDF.
  const doc = async (path: string) => { const r = await fetch(API + path, { headers: { cookie: platCookie() } }); return { status: r.status, type: r.headers.get('content-type') ?? '', len: (await r.arrayBuffer()).byteLength }; };
  const stmt = rd?.data.statements[0];
  if (stmt) {
    const [h, pdf, c] = await Promise.all([doc(`/v1/hub/clearing/statements/${stmt.id}/html`), doc(`/v1/hub/clearing/statements/${stmt.id}/pdf`), doc(`/v1/hub/clearing/statements/${stmt.id}/csv`)]);
    check('documents: statement as HTML, PDF and CSV', h.status === 200 && /html/.test(h.type) && pdf.status === 200 && /pdf/.test(pdf.type) && pdf.len > 500 && c.status === 200 && /csv/.test(c.type), { h, pdf, c });
  }
  const lcsv = await doc('/v1/hub/clearing/cdrs.csv?currency=MYR');
  check('ledger CSV export with the screen\'s filters', lcsv.status === 200 && /csv/.test(lcsv.type) && lcsv.len > 50, lcsv);
  const inv = (await plat('GET', '/v1/hub/clearing/fee-invoices')).data?.feeInvoices?.[0];
  if (inv) {
    const [h, pdf] = await Promise.all([doc(`/v1/hub/clearing/fee-invoices/${inv.id}/html`), doc(`/v1/hub/clearing/fee-invoices/${inv.id}/pdf`)]);
    check('documents: fee invoice as HTML and PDF', h.status === 200 && pdf.status === 200 && /pdf/.test(pdf.type), { h, pdf });
    const paid = await plat('POST', `/v1/hub/clearing/fee-invoices/${inv.id}/paid`, { paid_at: new Date().toISOString().slice(0, 10), reference: 'console e2e' });
    check('fee invoice: "Mark paid" (or 409 once paid)', inv.status === 'issued' ? paid.data?.feeInvoice?.status === 'paid' : paid.status === 409, paid);
  }
  const pos = await plat('GET', '/v1/hub/clearing/positions');
  const pays = await plat('GET', '/v1/hub/clearing/payments');
  check('positions and payments lists (with member names)', pos.status === 200 && pays.status === 200 && pos.data.positions.every((p: any) => 'payer_member_name' in p) && pays.data.payments.every((y: any) => 'payer_member_name' in y));
  const done = pos.data.positions.find((p: any) => ['paid', 'confirmed', 'nothing_due'].includes(p.status));
  if (done) {
    const wo = await plat('POST', `/v1/hub/clearing/positions/${done.id}/write-off`, { note: 'console e2e' });
    check('write-off: refused on a settled position (the screen offers it only on open ones)', wo.status === 409, wo);
  }

  // The tenant's PlugSure Hub tab.
  const sum = await ops('GET', '/v1/roaming/hub/clearing/summary');
  check('tenant: clearing summary (own CDRs per side, disputes, positions, bank details)', sum.status === 200 && !!sum.data.member && Array.isArray(sum.data.cdrs) && Array.isArray(sum.data.positions), sum.data);
  const mine = await ops('GET', '/v1/roaming/hub/clearing/cdrs?side=emsp');
  check('tenant ledger: one side only, never another member\'s CDR', mine.status === 200 && mine.data.cdrs.every((c: any) => c.side === 'emsp'));
  const tf = await ops('GET', '/v1/roaming/hub/clearing/fee-plans');
  check('tenant: its commission terms per currency', tf.status === 200 && ['IDR', 'MYR', 'SGD'].every((c) => c in tf.data.feePlans));
  const tdocs = await Promise.all(['statements', 'fee-invoices', 'positions', 'payments', 'disputes'].map((x) => ops('GET', `/v1/roaming/hub/clearing/${x}`)));
  check('tenant: statements, fee invoices, positions, payments and disputes', tdocs.every((r) => r.status === 200));
  const bank = await ops('PUT', '/v1/roaming/hub/clearing/bank-details', { bank_details: 'Bank Console E2E, PT Nusantara Charge, 123-456-789' });
  check('tenant: bank details saved (shown back in the summary)', bank.status === 200 && (await ops('GET', '/v1/roaming/hub/clearing/summary')).data.member.bank_details?.includes('123-456-789'));
  check('tenant: the platform clearing API is refused', (await ops('GET', '/v1/hub/clearing/overview')).status === 403);

  // An external member's console (hub-only organisation): menus limited by org.hubOnly; its member clearing API.
  const hubOnlyOrg = (await db.query(`SELECT o.slug FROM organisation o JOIN hub_member m ON m.org_id = o.id WHERE o.hub_only ORDER BY m.created_at DESC LIMIT 1`)).rows[0]?.slug;
  if (hubOnlyOrg) {
    const email = `hub-console-member-${RUN.toLowerCase()}@plugsure.test`;
    execSync(`npx tsx src/db/create-admin.ts --email ${email} --name "Hub Console Member" --org-slug ${hubOnlyOrg} --password '${pwP}'`, { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' });
    await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [email]);
    const mem = session();
    await mem('POST', '/v1/auth/login', { email, password: pwP });
    const meM = await mem('GET', '/v1/auth/me');
    check('hub-only organisation: /v1/auth/me says org.hubOnly (the console shows its hub page, users and API keys only)', meM.data?.org?.hubOnly === true && meO.data?.org?.hubOnly === false, meM.data?.org);
    const ms = await mem('GET', '/v1/roaming/hub/clearing/summary');
    check('hub-only organisation: its member clearing summary', ms.status === 200 && !!ms.data.member);
    // review180: enforced by the server, not only by the console's menus.
    const allowed = await Promise.all(['/v1/users', '/v1/api-keys', '/v1/roaming', '/v1/meta', '/v1/roaming/hub'].map((p) => mem('GET', p)));
    check('hub-only organisation: users, API keys, its roaming header and hub routes are allowed', allowed.every((r) => r.status === 200), allowed.map((r) => r.status));
    const refused = await Promise.all([mem('GET', '/v1/charge-points'), mem('GET', '/v1/sites'), mem('GET', '/v1/sandboxes'), mem('GET', '/v1/roaming/partners'),
      mem('PUT', '/v1/roaming/party', { countryCode: 'MY', partyId: 'HOX', businessName: 'Hub-only' }), mem('GET', '/v1/hub/overview')]);
    check('hub-only organisation: the CSMS API (charge points, sites, sandboxes, roaming partners and identity) is refused with 403 hub_only',
      refused.slice(0, 5).every((r) => r.status === 403 && r.data?.code === 'hub_only') && refused[5]!.status === 403, refused.map((r) => [r.status, r.data?.code]));
    const key = await mem('POST', '/v1/api-keys', { name: `hub-only ${RUN}`, permissions: ['roaming:read'], scopeType: 'org', scopeId: null, rateLimitPerMin: null });
    if (key.status === 200 || key.status === 201) {
      const viaKey = async (p: string) => (await fetch(API + p, { headers: { authorization: `Bearer ${key.data.key}` } })).status;
      const [k1, k2] = [await viaKey('/v1/roaming/hub/clearing/summary'), await viaKey('/v1/charge-points')];
      check('hub-only organisation: its API key reaches the member clearing API and nothing of the CSMS', k1 === 200 && k2 === 403, [k1, k2]);
    } else {
      check('hub-only organisation: it can issue an API key', false, key);
    }
  }
} catch (e) {
  check('suite ran without crashing', false, (e as Error).stack ?? String(e));
} finally {
  if (memberId) await plat('PATCH', `/v1/hub/members/${memberId}`, { action: 'terminate' }).catch(() => null);
  await XCP.stop().catch(() => null);
  await db.end().catch(() => null);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
