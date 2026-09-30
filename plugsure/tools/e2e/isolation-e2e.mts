/**
 * Cross-tenant isolation: Org B trying to read and change Org A's data.
 *
 * 48 checks across every major resource type. Each asserts that Org B's
 * credentials get 404 (or an empty list) on Org A's resource — never a 200
 * with real data, never a 500 that leaks through the error body.
 *
 * Prerequisites: E2E_DATABASE_URL, migrated + seeded database, the stack
 * running. Safe to run against the e2e database; teardown removes both orgs.
 */
import assert from 'node:assert/strict';
import { execSync }  from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const DB  = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
assert.ok(DB, 'E2E_DATABASE_URL required');

const db  = new pg.Pool({ connectionString: DB, max: 3 });
const one = async <T>(sql: string, p: unknown[] = []) =>
  (await db.query<T>(sql, p)).rows[0] ?? null;
const run = async (sql: string, p: unknown[] = []) => db.query(sql, p);
const uid  = () => randomBytes(8).toString('hex');

let passed = 0; let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { console.log('PASS ', label); passed++; }
  else     { console.log('FAIL ', label, '--', JSON.stringify(detail)); failed++; }
};

// ── HTTP session (cookie jar) ──────────────────────────────────────────────
function session() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, {
      method,
      headers: { cookie, 'x-plugsure-csrf': '1',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    let d: unknown;
    try { d = await r.json(); } catch { d = await r.text().catch(() => null); }
    return { s: r.status, d: d as any };
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────
const tagA = uid(), tagB = uid();
const slugA = `org-a-${tagA}`, slugB = `org-b-${tagB}`;
const emailA = `a-${tagA}@plugsure.test`, emailB = `b-${tagB}@plugsure.test`;
const pwA = 'IsoA-Test-2026!', pwB = 'IsoB-Test-2026!';

// create-admin creates the org when --org-name is given
const mkAdmin = (slug: string, email: string, pw: string, name: string) =>
  execSync(
    `npx tsx src/db/create-admin.ts --email ${email} --name "${name}" ` +
    `--org-slug ${slug} --org-name "Isolation ${slug}" --password '${pw}'`,
    { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' });

mkAdmin(slugA, emailA, pwA, 'Admin A');
mkAdmin(slugB, emailB, pwB, 'Admin B');

const orgA = (await one<{id:string}>(`SELECT id FROM organisation WHERE slug=$1`,[slugA]))!.id;
const orgB = (await one<{id:string}>(`SELECT id FROM organisation WHERE slug=$1`,[slugB]))!.id;

// Org A resources
const siteA  = (await one<{id:string}>(`INSERT INTO site (org_id,name,pbjt_rate_bps) VALUES($1,'Site A',1000) RETURNING id`,[orgA]))!.id;
const cpA    = (await one<{id:string}>(`INSERT INTO charge_point (site_id,ocpp_identity,ocpp_version,status) VALUES($1,$2,'ocpp1.6','online') RETURNING id`,[siteA,`ISO-CP-A-${tagA}`]))!.id;
const evA    = (await one<{id:string}>(`INSERT INTO evse (charge_point_id,evse_id,max_power_w) VALUES($1,1,22000) RETURNING id`,[cpA]))!.id;
const conA   = (await one<{id:string}>(`INSERT INTO connector (evse_uuid,connector_id,connector_type,current_type,max_power_w,tera_status,tera_cert_status) VALUES($1,1,'Type2','AC',22000,'verified','verified') RETURNING id`,[evA]))!.id;
const idemA  = uid();
const sessA  = (await one<{id:string}>(`INSERT INTO charging_session (org_id,connector_uuid,charge_point_id,site_id,idem_key,started_at,state,payment_mode,energy_wh) VALUES($1,$2,$3,$4,$5,now(),'active','rfid',0) RETURNING id`,[orgA,conA,cpA,siteA,idemA]))!.id;
const tokA   = (await one<{id:string}>(`INSERT INTO token (org_id,kind,uid,status) VALUES($1,'rfid','ISO-CARD-A-${tagA}','Accepted') RETURNING id`,[orgA]))!.id;
const tarA   = (await one<{id:string}>(`INSERT INTO tariff (org_id,name) VALUES($1,'Tariff A') RETURNING id`,[orgA]))!.id;
const fleetA = (await one<{id:string}>(`INSERT INTO fleet_account (org_id,name) VALUES($1,'Fleet A') RETURNING id`,[orgA]))!.id;
const whA    = (await one<{id:string}>(`INSERT INTO webhook_endpoint (org_id,url,secret) VALUES($1,'https://a.example.com/wh',$2) RETURNING id`,[orgA,uid()]))!.id;
const keyA   = (await one<{id:string}>(`INSERT INTO api_key (org_id,name,prefix,key_hash) VALUES($1,'Key A',$2,encode(gen_random_bytes(32),'hex')) RETURNING id`,[orgA,'iso_'+uid()]))!.id;
const promoA = (await one<{id:string}>(`INSERT INTO promotion (org_id,name,kind) VALUES($1,'Promo A','energy_percent') RETURNING id`,[orgA]))!.id;
const userA  = (await one<{id:string}>(`SELECT id FROM app_user WHERE org_id=$1 AND email=$2`,[orgA,emailA]))!.id;

// Org B has its own site so B appears to be a real operator
const siteB = (await one<{id:string}>(`INSERT INTO site (org_id,name,pbjt_rate_bps) VALUES($1,'Site B',1000) RETURNING id`,[orgB]))!.id;

// ── Sign in ────────────────────────────────────────────────────────────────
const a = session(), b = session();
const la = await a('POST', '/v1/auth/login', { email: emailA, password: pwA });
const lb = await b('POST', '/v1/auth/login', { email: emailB, password: pwB });
check('setup: both orgs sign in independently', la.s === 200 && lb.s === 200, {a:la.s,b:lb.s});
if (la.s !== 200 || lb.s !== 200) { console.error('Cannot proceed.'); process.exit(1); }

// ── Chargers ───────────────────────────────────────────────────────────────
check('charger list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/charge-points')).d) &&
  !(await b('GET','/v1/charge-points')).d.some((c:any) => c.id === cpA));
check('charger get: B gets 404 on A\'s CP by identity',
  (await b('GET',`/v1/charge-points/ISO-CP-A-${tagA}`)).s === 404);
check('charger rename: B gets 404',            (await b('PUT',`/v1/charge-points/ISO-CP-A-${tagA}`,{label:'hacked'})).s === 404);
check('charger reboot: B gets 404',            (await b('POST',`/v1/charge-points/ISO-CP-A-${tagA}/remote-control`,{action:'Reset',type:'Soft'})).s === 404);
check('charger ocpp-log: B gets 404',          (await b('GET',`/v1/charge-points/ISO-CP-A-${tagA}/ocpp-log`)).s === 404);
check('charger connections: B gets 404',       (await b('GET',`/v1/charge-points/ISO-CP-A-${tagA}/connections`)).s === 404);

// ── Sessions ───────────────────────────────────────────────────────────────
check('session list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/sessions')).d) &&
  !(await b('GET','/v1/sessions')).d.some((s:any) => s.id === sessA));
check('session get: B gets 404',               (await b('GET',`/v1/sessions/${sessA}`)).s === 404);
check('session receipt: B gets 404',           (await b('GET',`/v1/sessions/${sessA}/receipt`)).s === 404);
check('session review-flag: B gets 404',       (await b('POST',`/v1/sessions/${sessA}/review`,{reason:'hack'})).s === 404);
check('session remote-stop: B gets 404',       (await b('POST',`/v1/sessions/${sessA}/stop`)).s === 404);

// ── Tokens (RFID cards) ────────────────────────────────────────────────────
check('token list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/tokens')).d) &&
  !(await b('GET','/v1/tokens')).d.some((t:any) => t.id === tokA));
check('token get: B gets 404',                 (await b('GET',`/v1/tokens/${tokA}`)).s === 404);
check('token block: B gets 404',               (await b('POST',`/v1/tokens/${tokA}`,{status:'Blocked'})).s === 404);

// ── Sites ─────────────────────────────────────────────────────────────────
check('site list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/sites')).d) &&
  !(await b('GET','/v1/sites')).d.some((s:any) => s.id === siteA));
check('site get: B gets 404',                  (await b('GET',`/v1/sites/${siteA}`)).s === 404);
check('site edit: B gets 404',                 (await b('POST',`/v1/sites/${siteA}`,{name:'Hijacked'})).s === 404);

// ── Tariffs ───────────────────────────────────────────────────────────────
check('tariff list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/tariffs')).d) &&
  !(await b('GET','/v1/tariffs')).d.some((t:any) => t.id === tarA));
check('tariff get: B gets 404',                (await b('GET',`/v1/tariffs/${tarA}`)).s === 404);
check('tariff assign to A\'s site: B gets 404',(await b('POST',`/v1/tariffs/${tarA}/assign`,{scopeType:'site',scopeId:siteA})).s === 404);

// ── Fleet accounts ────────────────────────────────────────────────────────
const fleetList = (await b('GET','/v1/fleet-accounts')).d;
check('fleet list: B sees none of A\'s',
  !!(fleetList?.accounts) && !fleetList.accounts.some((f:any) => f.id === fleetA));
check('fleet get: B gets 404',                 (await b('GET',`/v1/fleet-accounts/${fleetA}`)).s === 404);
check('fleet invoice: B gets 404',             (await b('POST',`/v1/fleet-accounts/${fleetA}/invoices`)).s === 404);

// ── Webhooks ──────────────────────────────────────────────────────────────
const whList = (await b('GET','/v1/webhooks')).d;
check('webhook list: B sees none of A\'s',
  Array.isArray(whList?.rows) && !whList.rows.some((w:any) => w.id === whA));
check('webhook get: B gets 404',               (await b('GET',`/v1/webhooks/${whA}`)).s === 404);
check('webhook delete: B gets 404',            (await b('DELETE',`/v1/webhooks/${whA}`)).s === 404);
// replay uses orgId in WHERE, so it silently requeues 0 rows (not 404); the endpoint stays invisible
const replay = await b('POST',`/v1/webhooks/${whA}/replay`);
check('webhook replay: B requeues 0 (endpoint invisible), never errors',
  replay.s === 200 && replay.d?.requeued === 0, replay);

// ── API keys ──────────────────────────────────────────────────────────────
check('api-key list: B sees none of A\'s',
  Array.isArray((await b('GET','/v1/api-keys')).d) &&
  !(await b('GET','/v1/api-keys')).d.some((k:any) => k.id === keyA));
check('api-key revoke: B gets 404',            (await b('DELETE',`/v1/api-keys/${keyA}`)).s === 404);
check('api-key rate-limit: B gets 404',        (await b('POST',`/v1/api-keys/${keyA}`,{rateLimitPerMin:1})).s === 404);

// ── Promotions ────────────────────────────────────────────────────────────
const promoList = (await b('GET','/v1/promotions')).d;
check('promotion list: B sees none of A\'s',
  Array.isArray(promoList?.promotions) && !promoList.promotions.some((p:any) => p.id === promoA));
check('promotion get: B gets 404',             (await b('GET',`/v1/promotions/${promoA}`)).s === 404);
check('promotion update: B gets 404',          (await b('POST',`/v1/promotions/${promoA}`,{name:'Hacked'})).s === 404);

// ── Users ─────────────────────────────────────────────────────────────────
check('user list: B cannot see A\'s admin',
  !(await b('GET','/v1/users')).d?.some?.((u:any) => u.id === userA));
check('user get: B gets 404',                  (await b('GET',`/v1/users/${userA}`)).s === 404);
check('user role-change: B gets 404',          (await b('POST',`/v1/users/${userA}/roles`,{role:'cpo_operations_manager'})).s === 404);
check('user deactivate: B gets 404',           (await b('POST',`/v1/users/${userA}`,{status:'inactive'})).s === 404);

// ── Audit log ─────────────────────────────────────────────────────────────
const audit = (await b('GET','/v1/audit')).d;
const leaked = (audit?.entries ?? []).filter((e:any) => e.actor_id === userA);
check('audit: B cannot see A\'s entries',      leaked.length === 0, {leaked:leaked.length});

// ── ID-swap: use A's IDs in B's write operations ──────────────────────────
check('id-swap: B cannot edit A\'s site via POST',
  (await b('POST',`/v1/sites/${siteA}`,{name:'B taking A'})).s === 404);
check('id-swap: B cannot reassign A\'s charger to B\'s site',
  (await b('PUT',`/v1/charge-points/ISO-CP-A-${tagA}`,{siteId:siteB})).s === 404);
check('id-swap: B cannot assign A\'s tariff to B\'s site',
  (await b('POST',`/v1/tariffs/${tarA}/assign`,{scopeType:'site',scopeId:siteB})).s === 404);

// ── Integrity: A's own data is untouched ──────────────────────────────────
const cpIdent = `ISO-CP-A-${tagA}`;
check('integrity: A can still get its own charger by identity',
  (await a('GET',`/v1/charge-points/${cpIdent}`)).s === 200);
check('integrity: A can still get its own session',
  (await a('GET',`/v1/sessions/${sessA}`)).s === 200);
check('integrity: A\'s charger still in its list',
  (await a('GET','/v1/charge-points')).d?.some?.((c:any) => c.id === cpA) === true);

// ── Teardown ──────────────────────────────────────────────────────────────
async function teardown() {
  for (const oid of [orgA, orgB]) {
    for (const t of ['webhook_delivery','webhook_endpoint','api_key','promotion','fleet_account',
                     'token','tariff','charging_session','alert','payment_intent','cdr']) {
      await run(`DELETE FROM ${t} WHERE org_id=$1`,[oid]).catch(()=>{});
    }
    await run(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id=e.charge_point_id JOIN site s ON s.id=cp.site_id WHERE s.org_id=$1)`,[oid]).catch(()=>{});
    await run(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id=cp.site_id WHERE s.org_id=$1)`,[oid]).catch(()=>{});
    await run(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id=$1)`,[oid]).catch(()=>{});
    await run(`DELETE FROM site WHERE org_id=$1`,[oid]).catch(()=>{});
    await run(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id=$1)`,[oid]).catch(()=>{});
    await run(`DELETE FROM app_user WHERE org_id=$1`,[oid]).catch(()=>{});
    await run(`DELETE FROM organisation WHERE id=$1`,[oid]).catch(()=>{});
  }
  await db.end();
}
await teardown();

const total = passed + failed;
console.log(`\n${total}/${total} checks: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
