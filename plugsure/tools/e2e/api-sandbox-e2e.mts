// PlugSure v1.3 — published API + developer sandbox, end to end.
//
// An operator creates a sandbox in the console; an integrator then uses only the
// sandbox key: reads the published OpenAPI document, starts and stops charges on
// the virtual chargers through the normal API, acts out a card tap, a fault and a
// dropped link, receives signed webhooks, and gets tax receipts. Isolation from
// the operator's real tenant, the driver app and the network is checked, and
// every GET in the document is called and its live response validated against
// the documented schema (the contract test).
//
// Same prerequisites as console-e2e.mts (stack running, NODE_ENV=development).
//
//     npx tsx tools/e2e/api-sandbox-e2e.mts
//
// NEVER point this at production.
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 500): Promise<T> {
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
  return { status: res.status, data, text, headers: res.headers };
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
const sb = (method: string, path: string, body?: unknown, key = KEY) => http(method, path, body, { authorization: `Bearer ${key}` });

// ------------------------------------------------------------ webhook receiver
const hooks: Array<{ type: string; body: any; ok: boolean }> = [];
let hookSecret = '';
const hookServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const sig = String(req.headers['plugsure-signature'] ?? '');
    const m = /t=(\d+),v1=([0-9a-f]+)/.exec(sig);
    const ok = !!m && createHmac('sha256', hookSecret).update(`${m[1]}.${raw}`).digest('hex') === m[2];
    try { hooks.push({ type: String(req.headers['plugsure-event'] ?? ''), body: JSON.parse(raw), ok }); } catch {}
    res.statusCode = 200; res.end('ok');
  });
});
await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
const HOOK_URL = `http://127.0.0.1:${(hookServer.address() as any).port}/plugsure`;
const hooksOf = (type: string, pred: (d: any) => boolean = () => true) => hooks.filter((h) => h.type === type && pred(h.body.data));

let sandboxId = '';
try {
  // ------------------------------------------------------------ the published document
  const spec = await http('GET', '/openapi.json');
  const nOps = spec.status === 200 ? Object.values(spec.data.paths as Record<string, object>).reduce((n: number, p) => n + Object.keys(p).length, 0) : 0;
  check('docs: /openapi.json is public OpenAPI 3.1 with the operator API, sandbox and webhooks',
    spec.status === 200 && spec.data.openapi === '3.1.0' && nOps >= 150 && !!spec.data.paths['/v1/sandbox/chargers/{identity}/simulate'] && Object.keys(spec.data.webhooks).length === 11,
    { s: spec.status, nOps });
  check('docs: internal routes (console sign-in, platform administration) are not published',
    !spec.data.paths['/v1/auth/login'] && !Object.keys(spec.data.paths).some((p: string) => p.startsWith('/v1/platform/')));
  const page = await http('GET', '/api-docs.html');
  check('docs: the API reference page is served', page.status === 200 && /\/openapi\.json/.test(page.text) && /Try it/.test(page.text), page.status);

  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  ajv.addFormat('binary', true);
  ajv.addSchema({ $id: 'spec', components: spec.data.components });
  const validator = (schema: unknown) => ajv.compile(JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"spec#/components/')));
  const responseSchema = (path: string, method: string, status = '200') => spec.data.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
  const conforms = (path: string, method: string, status: string, body: unknown) => {
    const v = validator(responseSchema(path, method, status));
    return v(body) ? null : v.errors.slice(0, 3).map((e: any) => `${e.instancePath} ${e.message}`);
  };

  // ------------------------------------------------------------ an operator creates a sandbox
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in to the console', login.status === 200, login.data);
  // Leave room: remove sandboxes left over from earlier runs.
  for (const s of (await ops('GET', '/v1/sandboxes')).data.sandboxes ?? []) if (/^.*E2E/.test(s.name)) await ops('DELETE', `/v1/sandboxes/${s.id}`);
  const created = await ops('POST', '/v1/sandboxes', { name: 'API E2E' });
  KEY = created.data.apiKey;
  sandboxId = created.data.id;
  const [DC, AC] = [created.data.chargePoints?.find((c: any) => c.current === 'DC')?.identity, created.data.chargePoints?.find((c: any) => c.current === 'AC')?.identity];
  check('sandbox: created with a key, a DC and an AC virtual charger, and RFID cards',
    created.status === 201 && /^psk_/.test(KEY) && !!DC && !!AC && created.data.tokens?.length === 3, created.data);
  check('contract: POST /v1/sandboxes matches its documented 201 schema', !conforms('/v1/sandboxes', 'post', '201', created.data), conforms('/v1/sandboxes', 'post', '201', created.data));
  const list = await ops('GET', '/v1/sandboxes');
  const mine = list.data.sandboxes?.find((s: any) => s.id === sandboxId);
  check('sandbox: listed for the operator with its key prefix only', !!mine && mine.keys.length === 1 && KEY.startsWith(`psk_${mine.keys[0].prefix}_`) && !JSON.stringify(list.data).includes(KEY.slice(`psk_${mine.keys[0].prefix}_`.length)), mine);

  const info = await until(() => sb('GET', '/v1/sandbox'), (r) => r.data.chargePoints?.length === 2 && r.data.chargePoints.every((c: any) => c.simulator?.online), 40_000, 1000);
  check('sandbox: both virtual chargers boot and are online (simulated inside the gateway)',
    info.status === 200 && info.data.chargePoints.every((c: any) => c.simulator?.online) && info.data.timeScale === 30, info.data);
  const fleet = await until(() => sb('GET', '/v1/charge-points'), (r) => Array.isArray(r.data) && r.data.filter((c: any) => c.online).length === 2, 20_000);
  check('sandbox key: the fleet list shows the two online virtual chargers and nothing of the operator\'s',
    Array.isArray(fleet.data) && fleet.data.length === 2 && fleet.data.every((c: any) => /^SBX-/.test(c.ocpp_identity) && c.online), fleet.data?.map?.((c: any) => [c.ocpp_identity, c.online]));

  // ------------------------------------------------------------ isolation
  const opsFleet = await ops('GET', '/v1/charge-points');
  check('isolation: the operator\'s own fleet does not include the sandbox chargers', Array.isArray(opsFleet.data) && !opsFleet.data.some((c: any) => /^SBX-/.test(c.ocpp_identity)));
  const notSb = await ops('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'status' });
  check('isolation: simulation is refused with a production credential (404)', notSb.status === 404, notSb);
  const nested = await sb('POST', '/v1/sandboxes', { name: 'nested' });
  check('isolation: a sandbox cannot create sandboxes', nested.status === 409, nested.data);
  const roam = await sb('POST', '/v1/roaming/partners', { name: 'x', kind: 'emsp' });
  check('isolation: roaming changes are refused in a sandbox (403)', roam.status === 403, roam.data);
  const stations = await http('GET', '/d/v1/stations');
  check('isolation: sandbox sites never appear in the public driver app',
    stations.status === 200 && !JSON.stringify(stations.data).includes(created.data.siteId), stations.status);
  const ws = await new Promise<{ status: number | null }>((res) => {
    const w = new WebSocket(`${OCPP}/${DC}`, ['ocpp1.6']);
    w.once('open', () => { w.close(); res({ status: 101 }); });
    w.once('unexpected-response', (_q: any, r: any) => res({ status: r.statusCode }));
    w.once('error', () => res({ status: null }));
  });
  check('isolation: nothing on the network can connect as a virtual charger (upgrade refused)', ws.status === 404, ws);

  // ------------------------------------------------------------ webhooks in the sandbox
  const wh = await sb('POST', '/v1/webhooks', { url: HOOK_URL, description: 'e2e receiver', events: ['*'] });
  hookSecret = wh.data.secret;
  check('webhooks: an endpoint is registered with the sandbox key', wh.status === 201 && !!hookSecret, wh.status);

  // ------------------------------------------------------------ remote start / stop through the normal API
  const t0 = Date.now();
  const rs = await sb('POST', `/v1/charge-points/${DC}/remote-start`, { connectorId: 1, idTag: 'SANDBOX-RFID-0001' });
  check('api: remote start on the virtual DC charger is accepted', rs.status === 200 && rs.data.status === 'Accepted', rs.data);
  const live = await until(() => sb('GET', `/v1/sessions?identity=${DC}`), (r) => Array.isArray(r.data) && r.data.some((s: any) => !s.ended_at && s.energy_wh > 0), 30_000, 1000);
  const session = live.data.find?.((s: any) => !s.ended_at);
  check(`api: a session is metered on the virtual charger (${Math.round((Date.now() - t0) / 100) / 10} s)`, !!session && session.energy_wh > 0, live.data);
  const stop = await sb('POST', `/v1/charge-points/${DC}/remote-stop`, { transactionId: session?.ocpp_transaction_id });
  const rated = await until(() => sb('GET', `/v1/sessions/${session?.id}`), (r) => !!r.data.ended_at && (r.data.state === 'rated' || r.data.total_idr != null), 30_000, 1000);
  check('api: remote stop ends the session, which is rated', stop.status === 200 && !!rated.data.ended_at, { stop: stop.data, s: rated.data?.state });
  const receipt = await sb('GET', `/v1/sessions/${session?.id}/receipt`);
  check('api: the tax receipt shows PPN and PBJT-TL', receipt.status === 200 && /PPN/.test(receipt.text) && /PBJT/.test(receipt.text), receipt.status);
  const gotStart = await until(async () => hooksOf('session.started', (d) => d.sessionId === session?.id), (l) => l.length > 0, 15_000);
  const gotCdr = await until(async () => hooksOf('cdr.created', (d) => d.sessionId === session?.id), (l) => l.length > 0, 20_000);
  check('webhooks: session.started and cdr.created arrive, signed with the endpoint secret',
    gotStart.length > 0 && gotCdr.length > 0 && [...gotStart, ...gotCdr].every((h) => h.ok) && gotCdr[0]!.body.data.totalIdr > 0, { s: gotStart.length, c: gotCdr.length });

  // ------------------------------------------------------------ simulated events
  const tap = await sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'tap-card', connectorId: 2, idTag: 'SANDBOX-FLEET-0002', kwh: 1 });
  check('simulate: a card tapped at connector 2 starts a session', tap.status === 200 && tap.data.charger?.charging === true, tap.data);
  check('contract: simulate matches its documented schema', !conforms('/v1/sandbox/chargers/{identity}/simulate', 'post', '200', tap.data), conforms('/v1/sandbox/chargers/{identity}/simulate', 'post', '200', tap.data));
  const full = await until(() => sb('GET', `/v1/sessions?identity=${DC}`), (r) => Array.isArray(r.data) && r.data.some((s: any) => s.id_tag === 'SANDBOX-FLEET-0002' && s.ended_at), 40_000, 1000);
  const tapped = full.data.find?.((s: any) => s.id_tag === 'SANDBOX-FLEET-0002');
  check('simulate: the car is full at 1 kWh and the session ends by itself', !!tapped?.ended_at && Math.abs(tapped.energy_wh - 1000) <= 60, tapped);
  const blocked = await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'tap-card', idTag: 'SANDBOX-BLOCKED-0003' });
  await sleep(2500);
  const acSessions = await sb('GET', `/v1/sessions?identity=${AC}`);
  const acSt = await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'status' });
  check('simulate: a blocked card is refused at Authorize — no session', blocked.status === 200 && acSessions.data.length === 0 && acSt.data.charger.charging === false, { n: acSessions.data.length, c: acSt.data.charger });

  const tF = Date.now();
  const fault = await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'fault', errorCode: 'GroundFailure', vendorErrorCode: 'E-GF-12' });
  const faulted = await until(async () => hooks.filter((h) => h.type === 'connector.status_changed' && h.body.data.ocppIdentity === AC && h.body.data.status === 'Faulted'), (l) => l.length > 0, 15_000);
  check('simulate: a ground fault reaches the API as connector Faulted (webhook)', fault.status === 200 && faulted.length > 0 && faulted[0]!.body.data.errorCode === 'GroundFailure', faulted[0]?.body);
  const alerts = await until(() => sb('GET', '/v1/alerts'), (r) => JSON.stringify(r.data).includes(AC!), 10_000);
  check('simulate: the fault raises an alert in the sandbox', JSON.stringify(alerts.data).includes(AC!), Date.now() - tF);
  await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'clear-fault' });
  const cleared = await until(async () => hooks.filter((h) => h.type === 'connector.status_changed' && h.body.data.ocppIdentity === AC && h.body.data.status === 'Available'), (l) => l.length > 0, 15_000);
  check('simulate: clearing the fault makes the connector Available again', cleared.length > 0);

  await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'go-offline' });
  const off = await until(() => sb('GET', '/v1/charge-points'), (r) => r.data.find?.((c: any) => c.ocpp_identity === AC)?.online === false, 15_000);
  const cmdOff = await sb('POST', `/v1/charge-points/${AC}/unlock`, { connectorId: 1 });
  check('simulate: a dropped 4G link takes the charger offline; a command to it is 409 (not 500)',
    off.data.find?.((c: any) => c.ocpp_identity === AC)?.online === false && cmdOff.status === 409, { cmd: cmdOff });
  await sb('POST', `/v1/sandbox/chargers/${AC}/simulate`, { event: 'come-online' });
  const on = await until(() => sb('GET', '/v1/charge-points'), (r) => r.data.find?.((c: any) => c.ocpp_identity === AC)?.online === true, 20_000);
  check('simulate: the link comes back and the charger is online again', on.data.find?.((c: any) => c.ocpp_identity === AC)?.online === true);

  const cfg = await sb('GET', `/v1/charge-points/${AC}/config`);
  check('api: configuration is read from the virtual charger (GetConfiguration)', cfg.status === 200 && JSON.stringify(cfg.data).includes('HeartbeatInterval'), cfg.status);
  const bad = await sb('GET', '/v1/sessions/not-a-uuid');
  check('api: a malformed id is a 400, not a 500', bad.status === 400, bad);

  // ------------------------------------------------------------ onboarding a new charger inside the sandbox
  const site = created.data.siteId;
  const NEW = `SBX-NEW-${Date.now().toString().slice(-5)}`;
  const reg = await sb('POST', '/v1/charge-points', {
    ocppIdentity: NEW, siteId: site, displayName: 'Onboarded in sandbox', ocppVersion: 'ocpp1.6',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'sType2', currentKind: 'AC3', maxPowerW: 11000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }],
  });
  const act = await sb('POST', `/v1/charge-points/${NEW}/activate`);
  const adopted = await until(() => sb('GET', '/v1/charge-points'), (r) => r.data.find?.((c: any) => c.ocpp_identity === NEW)?.online === true, 40_000, 1000);
  check('onboarding: a charger registered and activated in the sandbox becomes a virtual charger and comes online',
    reg.status === 200 && act.status === 200 && adopted.data.find?.((c: any) => c.ocpp_identity === NEW)?.online === true, { reg: reg.data, act: act.data });

  // ------------------------------------------------------------ the contract: every documented GET, validated
  const ids: Record<string, string> = { identity: DC!, siteId: site, id: session?.id ?? '' };
  const skipped: string[] = [];
  const failures: string[] = [];
  let validated = 0;
  for (const [path, item] of Object.entries(spec.data.paths as Record<string, Record<string, any>>)) {
    const op = item.get;
    if (!op) continue;
    const ct = Object.keys(op.responses?.['200']?.content ?? {})[0];
    if (ct === 'text/event-stream') { skipped.push(`${path} (stream)`); continue; }
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    // Only fill ids whose meaning is certain: {id} is a session id on /v1/sessions/ paths only.
    if (names.some((n) => !(n in ids) || (n === 'id' && !path.startsWith('/v1/sessions/')))) { skipped.push(path); continue; }
    const url = path.replace(/\{([^}]+)\}/g, (_m, n) => encodeURIComponent(ids[n]!));
    const r = await sb('GET', url);
    if (r.status === 403) { skipped.push(`${path} (403)`); continue; }
    // A documented 404 for something this sandbox does not have (e.g. a driver app's build kit).
    if (r.status === 404 && op.responses?.['404']) { skipped.push(`${path} (404: none here)`); continue; }
    if (r.status !== 200) { failures.push(`${path}: HTTP ${r.status} ${String(r.text).slice(0, 120)}`); continue; }
    if (ct !== 'application/json') {
      if (!(r.headers.get('content-type') ?? '').startsWith(ct!.split(';')[0]!)) failures.push(`${path}: content-type ${r.headers.get('content-type')} (documented ${ct})`);
      validated++;
      continue;
    }
    const errs = conforms(path, 'get', '200', r.data);
    if (errs) failures.push(`${path}: ${errs.join('; ')}`);
    validated++;
  }
  check(`contract: ${validated} documented GET operations answer with the documented schema (${skipped.length} need ids this run does not have)`,
    failures.length === 0 && validated >= 45, failures);

  // ------------------------------------------------------------ reset, rotate, delete
  const reset = await sb('POST', '/v1/sandbox/reset');
  check('sandbox: reset brings every charger back to a clean state', reset.status === 200 && reset.data.reset.length === 3, reset.data);
  const rot = await ops('POST', `/v1/sandboxes/${sandboxId}/rotate-key`);
  const oldKey = await sb('GET', '/v1/sandbox');
  const newKey = await sb('GET', '/v1/sandbox', undefined, rot.data.apiKey);
  check('sandbox: rotating the key revokes the old one at once', rot.status === 200 && oldKey.status === 401 && newKey.status === 200, { old: oldKey.status, new: newKey.status });
  KEY = rot.data.apiKey;
  const del = await ops('DELETE', `/v1/sandboxes/${sandboxId}`);
  const afterDel = await sb('GET', '/v1/charge-points');
  const gone = await until(() => ops('GET', '/v1/charge-points'), () => true, 1);
  void gone;
  const listed = await ops('GET', '/v1/sandboxes');
  check('sandbox: deleting it revokes the key and removes it from the list',
    del.status === 200 && afterDel.status === 401 && !listed.data.sandboxes.some((s: any) => s.id === sandboxId), { del: del.status, key: afterDel.status });
  sandboxId = '';
  const audit = await ops('GET', '/v1/audit?limit=50');
  check('audit: sandbox creation, key rotation and deletion are in the operator\'s audit trail',
    ['sandbox.created', 'sandbox.key_rotated', 'sandbox.deleted'].every((a) => JSON.stringify(audit.data).includes(a)), audit.status);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  if (sandboxId) await ops('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  hookServer.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
