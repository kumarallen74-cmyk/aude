// PlugSure v1.3 — iOS Live Activities for white-label apps, end to end.
//
// A stand-in for Apple's push service (HTTP/2, provider tokens checked with the
// operator's public key) listens where the stack is told APNs is. Charging
// sessions are set up in the database; the gateway's Live Activity pass (every
// 5 s) does the rest. Checked:
//   - the app registers an activity's update token for its charge (validation:
//     brand, token, whose charge);
//   - the first update goes at once (priority 10), with the content-state the
//     app's ChargingAttributes decodes, on the liveactivity push type and topic;
//   - nothing is sent while nothing changes; a real change after 30 s at priority 5;
//   - push-to-start (iOS 17.2+): a charge started without the app gets an
//     activity started by PlugSure — once, with attributes and an alert; the app
//     then registers its update token and it is updated like the others;
//   - the cost so far while charging, rising with the energy, kept on "finished"
//     and replaced by the final cost;
//   - the end: "finished" at once, then the end with the rated cost and a
//     dismissal date; a dismissed activity (410) is dropped; one closed on the
//     phone is not sent to again; the console counts them.
//
// Needs E2E_DATABASE_URL (the runtime role) and APNS_URL_* pointing at ports
// 9296/9297 (the test harness sets them).
//     npx tsx tools/e2e/live-activity-e2e.mts
// NEVER point this at production.
import { createServer } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import pg from 'pg';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 800)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString().slice(-6);
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

// ─────────────────────────────────────────── the stand-in for APNs
const operatorKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = operatorKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEAM = 'L' + RUN.padStart(9, '0');
const KEY_ID = 'Q' + RUN.padStart(9, '0');
const BUNDLE = `id.nusacharge.la${RUN}`;
const tok = (p: string) => (p + RUN + 'f'.repeat(64)).slice(0, 64);
const LA_A = tok('a0'), START_B = tok('b0'), LA_B = tok('b1'), LA_C = tok('c0');
const known: Record<string, number | [number, string]> = { [LA_A]: 200, [START_B]: 200, [LA_B]: 200, [LA_C]: [410, 'Unregistered'] };
type Hit = { token: string; headers: Record<string, unknown>; body: any; status: number; at: number };
const hits: Hit[] = [];
const fake = (port: number) => new Promise<ReturnType<typeof createServer>>((res, rej) => {
  const server = createServer((req, reply) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const token = String(req.headers[':path']).split('/').pop()!;
      const [h, p, s] = String(req.headers.authorization ?? '').replace(/^bearer /, '').split('.');
      const ok = !!s && verify('sha256', Buffer.from(`${h}.${p}`), { key: operatorKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
      const answer = (status: number, reason?: string) => {
        if (port === 9296) hits.push({ token, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, status, at: Date.now() });
        reply.writeHead(status, { 'apns-id': `la-${hits.length}` }); reply.end(reason ? JSON.stringify({ reason }) : '');
      };
      if (!ok) return answer(403, 'InvalidProviderToken');
      const a = known[token];
      if (a === undefined) return answer(400, 'BadDeviceToken');
      if (Array.isArray(a)) return answer(a[0], a[1]);
      answer(a);
    });
  });
  server.once('error', rej);
  server.listen(port, '127.0.0.1', () => res(server));
});
const hitsFor = (token: string) => hits.filter((h) => h.token === token);
/** Pushes Apple accepted. A refused one (a key replaced within the gateway's 30 s credential cache,
 * resent at once with the new key) reaches no phone and spends none of the activity's budget. */
const sentTo = (token: string) => hitsFor(token).filter((h) => h.status === 200);

const db = process.env.E2E_DATABASE_URL ? new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }) : null;
const servers: Array<{ close: () => void }> = [];
const cleanup: Array<() => Promise<unknown>> = [];
try {
  if (!db) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  await db.connect();
  servers.push(await fake(9296), await fake(9297));

  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const existing = await ops('GET', '/v1/driver-app');
  if (existing.data.brand) await ops('DELETE', `/v1/driver-app?confirm=${existing.data.brand.slug}`);
  const SLUG = `la-${RUN}`;
  await ops('PUT', '/v1/driver-app', { appName: `NusaCharge ${RUN}`, slug: SLUG, accentColor: '#ff8a00', iosTeamId: TEAM, iosBundleId: BUNDLE });
  const key = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: P8 });
  const org = key.data.brand.orgId as string;
  check('setup: the brand’s APNs key is accepted', key.status === 200 && key.data.brand.apnsCheckOk === true, key.data.brand);

  // Three cards, three charges on the operator's charger (the database stands in for the charger).
  // Three idle connectors (one active session per connector).
  const places = (await db.query(
    `SELECT c.id AS connector, cp.id AS cp, s.id AS site, s.name AS site_name FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $1 AND s.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM charging_session x WHERE x.connector_uuid = c.id AND x.state = 'active')
      LIMIT 3`, [org])).rows;
  const place = places[0];
  const tokens: string[] = [];
  for (const x of ['A', 'B', 'C']) {
    await ops('POST', '/v1/tokens', { uid: `LA${x}${RUN}`, holderName: `Live ${x}`, accountType: 'retail' });
    tokens.push((await db.query(`SELECT id FROM token WHERE uid = $1`, [`LA${x}${RUN}`])).rows[0].id);
  }
  const device = async () => (await (await fetch(`${API}/d/v1/device`, { method: 'POST' })).json()).deviceToken as string;
  const devId = async (t: string) => (await (await fetch(`${API}/d/v1/me`, { headers: { authorization: `Bearer ${t}` } })).json()).deviceId as string;
  const phones = [await device(), await device(), await device()];
  const devs = [await devId(phones[0]!), await devId(phones[1]!), await devId(phones[2]!)];
  const session = async (i: number, agoS: number, energyWh: number, soc: number | null) => {
    const started = new Date(Date.now() - agoS * 1000);
    const s = (await db.query(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, energy_wh, token_id, state, soc_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING id`,
      [org, places[i].site, places[i].connector, places[i].cp, `la-e2e-${RUN}-${i}`, started, energyWh, tokens[i], soc])).rows[0].id as string;
    const c = (await db.query(
      `INSERT INTO driver_charge (device_id, org_id, connector_uuid, token_id, mode, created_at, session_id) VALUES ($1,$2,$3,$4,'prepaid',$5,$6) RETURNING id`,
      [devs[i], org, places[i].connector, tokens[i], new Date(started.getTime() - 60_000), i === 1 ? null : s])).rows[0].id as string;
    cleanup.push(() => db.query(`DELETE FROM live_activity_push_start WHERE session_id = $1`, [s]), () => db.query(`DELETE FROM live_activity WHERE session_id = $1 OR charge_id = $2`, [s, c]),
      () => db.query(`DELETE FROM cdr WHERE session_id = $1`, [s]), () => db.query(`DELETE FROM driver_charge WHERE id = $1`, [c]),
      () => db.query(`DELETE FROM meter_value WHERE session_id = $1`, [s]), () => db.query(`DELETE FROM charging_session WHERE id = $1`, [s]));
    return { s, c };
  };
  const A = await session(0, 90, 4000, 35);
  const reg = (phone: string, body: unknown, path = '/d/v1/live-activities', brand: string | null = SLUG) => fetch(`${API}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json', ...(brand ? { 'x-driver-brand': brand } : {}) }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

  // ─────────────────────────────────────────── the app's activity
  const noBrand = await reg(phones[0]!, { ref: A.c, token: LA_A }, '/d/v1/live-activities', null);
  const badTok = await reg(phones[0]!, { ref: A.c, token: 'nope' });
  const notMine = await reg(phones[1]!, { ref: A.c, token: LA_A });
  const ok = await reg(phones[0]!, { ref: A.c.toUpperCase(), token: LA_A.toUpperCase() });
  check('app: an activity’s token is registered for the phone’s own charge (not from the PlugSure app, not a bad token, not someone else’s charge)',
    noBrand.status === 409 && badTok.status === 422 && notMine.status === 422 && ok.status === 200, { noBrand, badTok, notMine, ok });
  const first = (await until(() => sentTo(LA_A), (h) => h.length >= 1, 15_000))[0];
  const aps = first?.body?.aps ?? {};
  check('update: the first one goes at once — liveactivity push type and topic, priority 10, the charge’s figures as the app decodes them, a stale date',
    !!first && first.headers['apns-push-type'] === 'liveactivity' && first.headers['apns-topic'] === `${BUNDLE}.push-type.liveactivity` && first.headers['apns-priority'] === '10'
      && aps.event === 'update' && aps['content-state']?.status === 'charging' && aps['content-state'].energyWh === 4000 && aps['content-state'].socPercent === 35
      && Number.isInteger(aps['content-state'].startedAt) && aps['stale-date'] - aps.timestamp === 180,
    first ? { h: first.headers, aps } : 'no push');

  await sleep(9_000);
  check('update: nothing more while nothing changes (Apple’s budget)', sentTo(LA_A).length === 1, sentTo(LA_A).length);
  await db.query(`UPDATE charging_session SET energy_wh = 6000, soc_percent = 44 WHERE id = $1`, [A.s]);
  await db.query(`INSERT INTO meter_value (session_id, ts, measurand, value, unit) VALUES ($1, now(), 'Power.Active.Import', 45000, 'W')`, [A.s]);
  const second = (await until(() => sentTo(LA_A), (h) => h.length >= 2, 45_000))[1];
  check('update: a real change is sent after 30 s, at low priority (5): energy, power and battery',
    !!second && second.headers['apns-priority'] === '5' && second.at - first!.at >= 29_000 && second.body.aps['content-state'].energyWh === 6000
      && second.body.aps['content-state'].powerW === 45000 && second.body.aps['content-state'].socPercent === 44,
    second ? { dt: second.at - first!.at, cs: second.body.aps['content-state'], p: second.headers['apns-priority'] } : 'no second update');
  const e1 = aps['content-state']?.estimateIdr, e2 = second?.body?.aps?.['content-state']?.estimateIdr;
  check('cost so far: carried while charging (priced as the charge record will be), rising with the energy, no final cost yet',
    Number.isInteger(e1) && Number.isInteger(e2) && e2 > e1 && aps['content-state'].costIdr === null, { e1, e2 });

  // ─────────────────────────────────────────── push-to-start
  const B = await session(1, 40, 2500, null);
  const st = await reg(phones[1]!, { token: START_B }, '/d/v1/live-activities/start-token');
  const started = (await until(() => hitsFor(START_B), (h) => h.length >= 1, 15_000))[0];
  const sa = started?.body?.aps ?? {};
  check('push-to-start: a charge under way without the app gets its activity started by PlugSure — attributes for ChargingAttributes, an alert, the charge as ref',
    st.status === 200 && !!started && sa.event === 'start' && sa['attributes-type'] === 'ChargingAttributes' && sa.attributes?.ref === B.c && sa.attributes.appName === `NusaCharge ${RUN}`
      && sa.attributes.site === places[1].site_name && /^#[0-9a-f]{6}$/.test(sa.attributes.accentHex) && sa.alert?.title === 'Pengisian dimulai' && sa['content-state']?.energyWh === 2500
      && started!.headers['apns-priority'] === '10',
    started ? sa : 'no start');
  await sleep(11_000);
  check('push-to-start: sent once only', hitsFor(START_B).length === 1, hitsFor(START_B).length);
  const regB = await reg(phones[1]!, { ref: B.c, token: LA_B });
  const bFirst = (await until(() => hitsFor(LA_B), (h) => h.length >= 1, 15_000))[0];
  const counts = await ops('GET', '/v1/driver-app');
  check('push-to-start: the app then gives the started activity’s token, and it is updated like the others; the console counts 2 active, 1 phone that allows push-to-start',
    regB.status === 200 && bFirst?.body?.aps?.event === 'update' && counts.data.liveActivities?.active === 2 && counts.data.liveActivities?.pushToStart === 1,
    { regB, b: bFirst?.body, counts: counts.data.liveActivities });

  // ─────────────────────────────────────────── the end
  await db.query(`UPDATE charging_session SET state = 'ended', ended_at = now(), energy_wh = 12500 WHERE id = $1`, [A.s]);
  const fin = (await until(() => sentTo(LA_A), (h) => h.length >= 3, 15_000))[2];
  check('end: the moment the session ends, "finished" at once (priority 10), no power, the final energy',
    fin?.body?.aps?.event === 'update' && fin.headers['apns-priority'] === '10' && fin.body.aps['content-state'].status === 'finished'
      && fin.body.aps['content-state'].powerW === null && fin.body.aps['content-state'].energyWh === 12500 && Number.isInteger(fin.body.aps['content-state'].endedAt),
    fin?.body);
  const finE = fin?.body?.aps?.['content-state']?.estimateIdr;
  await db.query(
    `INSERT INTO cdr (session_id, org_id, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
     VALUES ($1,$2,'[]'::jsonb,27000,1000,2700,24750,1200,2970,31450,'{}'::jsonb)`, [A.s, org]);
  await db.query(`UPDATE charging_session SET state = 'rated' WHERE id = $1`, [A.s]);
  const end = (await until(() => sentTo(LA_A), (h) => h.length >= 4, 15_000))[3];
  const aRow = (await db.query(`SELECT state, sent_count FROM live_activity WHERE charge_id = $1`, [A.c])).rows[0];
  check('end: once rated, the activity ends with the cost (Rp 31.450) and stays 30 minutes on the lock screen',
    end?.body?.aps?.event === 'end' && end.body.aps['content-state'].costIdr === 31450 && end.body.aps['dismissal-date'] - end.body.aps.timestamp === 1800 && aRow.state === 'ended' && aRow.sent_count === 4,
    { end: end?.body, aRow });
  check('cost so far: kept on "finished" until the charge is rated, then replaced by the final cost (never both)',
    Number.isInteger(finE) && finE > 0 && end?.body?.aps?.['content-state']?.estimateIdr === null && end.body.aps['content-state'].costIdr === 31450,
    { finE, end: end?.body?.aps?.['content-state'] });
  await sleep(6_000);
  check('end: nothing is sent to an ended activity', sentTo(LA_A).length === 4, sentTo(LA_A).length);

  const keyNow = await ops('GET', '/v1/driver-app');
  const refusedHits = hits.filter((h) => h.status === 403).length;
  check('APNs key: still accepted in the console; a send refused with a key replaced within the 30 s cache never marks the new key refused',
    keyNow.data.brand?.apnsCheckOk === true, { apnsCheckOk: keyNow.data.brand?.apnsCheckOk, detail: keyNow.data.brand?.apnsCheckDetail, refusedHits });
  // ─────────────────────────────────────────── dismissed, and closed on the phone
  const C = await session(2, 60, 1000, null);
  await reg(phones[2]!, { ref: C.c, token: LA_C });
  const gone = await until(() => db.query(`SELECT state, last_error FROM live_activity WHERE charge_id = $1`, [C.c]).then((r) => r.rows[0]), (r) => r?.state === 'gone', 15_000);
  check('gone: an activity Apple says no longer exists (410) is dropped', gone?.state === 'gone' && /410/.test(gone.last_error), gone);
  const closed = await reg(phones[1]!, { ref: B.c }, '/d/v1/live-activities/ended');
  const bRow = (await db.query(`SELECT state FROM live_activity WHERE charge_id = $1 OR session_id = $2`, [B.c, B.s])).rows[0];
  const after = await ops('GET', '/v1/driver-app');
  check('closed on the phone: the activity is ended and not sent to again; the console counts none active',
    closed.status === 200 && bRow?.state === 'ended' && after.data.liveActivities?.active === 0, { closed, bRow, c: after.data.liveActivities });
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  if (db) {
    // In the order pushed: each session's dependants first, the session last.
    for (const f of cleanup) await f().catch(() => {});
    await db.query(`DELETE FROM live_activity_start_token WHERE token = $1`, [START_B]).catch(() => {});
    await db.end().catch(() => {});
  }
  const b = await ops('GET', '/v1/driver-app').catch(() => null);
  if (b?.data?.brand?.slug?.startsWith('la-')) await ops('DELETE', `/v1/driver-app?confirm=${b.data.brand.slug}`).catch(() => {});
  for (const s of servers) s.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
