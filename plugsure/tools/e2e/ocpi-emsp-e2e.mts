// PlugSure v1.3 — roaming (OCPI 2.2.1, eMSP role) end-to-end test.
//
// The operator's own RFID cards charge on another operator's network. A mock
// CPO (a local HTTP server) registers with PlugSure, has its network imported,
// receives the shared cards, asks for real-time approval, reports our drivers'
// sessions and charge records, and executes the commands the console sends.
// Covers card sharing and withdrawal, limits across networks, CDR immutability
// and the charges export.
//
// Same prerequisites as console-e2e.mts. The mock CPO listens on
// E2E_OCPI_CPO_PORT (9312).
//     npx tsx tools/e2e/ocpi-emsp-e2e.mts
// NEVER point this at production.
import { randomUUID } from 'node:crypto';
import { MockCpoPartner, decodeToken as decode, type PeerGot } from './lib/ocpi-fakes.mts';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const PORT = Number(process.env.E2E_OCPI_CPO_PORT ?? 9312);
const MOCK = `http://127.0.0.1:${PORT}`;
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const b64 = (s: string) => Buffer.from(s).toString('base64');
const nowIso = () => new Date().toISOString();

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, headers: r.headers };
}
async function ocpi(method: string, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      ...(token ? { authorization: `Token ${b64(token)}` } : {}),
      'x-request-id': randomUUID(), 'x-correlation-id': randomUUID(),
      'ocpi-from-country-code': 'ID', 'ocpi-from-party-id': 'CPX', 'ocpi-to-country-code': 'ID', 'ocpi-to-party-id': 'PLS',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, body: d, headers: r.headers };
}

// ─────────────────────────────────────────── the mock CPO
type Got = PeerGot;
const TOKEN_B = 'mock-cpo-token-B-' + randomUUID();   // what PlugSure presents to the mock CPO
let TOKEN_C = '';                                     // what the mock CPO presents to PlugSure
const RUN = Date.now().toString().slice(-6);
// Earlier runs leave their shared cards behind; pulls ask only for what changed since this run began.
const RUN_STARTED = new Date(Date.now() - 60_000).toISOString();
const location = (n: number, status = 'AVAILABLE') => ({
  country_code: 'ID', party_id: 'CPX', id: `CPX-LOC-${RUN}-${n}`, publish: true, name: `Mock Mall ${n}`, address: `Jl. Asia Afrika ${n}`, city: 'Bandung',
  country: 'IDN', coordinates: { latitude: '-6.921000', longitude: '107.607000' }, time_zone: 'Asia/Jakarta',
  evses: [{ uid: `CPX-E-${RUN}-${n}`, evse_id: `ID*CPX*E${RUN}${n}`, status, connectors: [{ id: '1', standard: 'IEC_62196_T2_COMBO', format: 'CABLE', power_type: 'DC', max_voltage: 500, max_amperage: 200, max_electric_power: 100000, tariff_ids: [`CPX-T-${RUN}`], last_updated: nowIso() }], last_updated: nowIso() }],
  operator: { name: 'Mock CPO' }, last_updated: nowIso(),
});
const mockTariff = { country_code: 'ID', party_id: 'CPX', id: `CPX-T-${RUN}`, currency: 'IDR', elements: [{ price_components: [{ type: 'ENERGY', price: 2500, vat: 11, step_size: 1 }] }], last_updated: nowIso() };
const mock = new MockCpoPartner({ port: PORT, tokenB: TOKEN_B, locations: () => [location(1), location(2)], tariff: mockTariff });
const got = mock.got;
const pendingResults = mock.pendingResults;
await mock.start();
const received = (pred: (g: Got) => boolean, after = 0) => mock.received(pred, after);
const waitReceived = (pred: (g: Got) => boolean, after = 0, ms = 20_000) => mock.waitReceived(pred, after, ms);
/** The mock CPO posts the charger's outcome of the queued commands back to PlugSure. */
async function flushResults() {
  const out = [];
  while (pendingResults.length) {
    const r = pendingResults.shift()!;
    out.push(await ocpi('POST', r.url, TOKEN_C, { result: r.result }));
  }
  return out;
}

let partnerId = '';
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const party = await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'PLS', businessName: 'Nusantara Charge' });
  check('setup: roaming identity ID*PLS', party.status === 200, party.data);
  for (const p of (await ops('GET', '/v1/roaming')).data?.partners ?? []) {
    if (String(p.name).startsWith('E2E CPO')) await ops('DELETE', `/v1/roaming/partners/${p.id}`);
  }

  // Four cards: a normal fleet card, one with a spending limit, one we will block, one never shared.
  const card = async (uid: string, extra: Record<string, unknown> = {}) => (await ops('POST', '/v1/tokens', { uid, holderName: `Driver ${uid.slice(-2)}`, accountType: 'fleet', fleetName: 'Armada Nusantara', ...extra })).data;
  const OK = await card(`EMSP-OK-${RUN}`, { holderName: '=HYPERLINK("http://x")', pin: '2468' });
  const LIM = await card(`EMSP-LIM-${RUN}`, { spendLimitMinor: 50000 });
  const BLK = await card(`EMSP-BLK-${RUN}`);
  const NOT = await card(`EMSP-NOT-${RUN}`, { pin: '1357' });
  check('setup: four fleet cards', [OK, LIM, BLK, NOT].every((c) => c?.id), [OK, LIM, BLK, NOT]);
  const share = await ops('PUT', '/v1/roaming/cards', { ids: [OK.id, LIM.id, BLK.id], shared: true });
  check('cards: three cards are shared for roaming', share.status === 200 && share.data.changed === 3, share.data);
  await ops('PUT', `/v1/tokens/${BLK.id}`, { status: 'Blocked' });
  const cards = (await ops('GET', '/v1/roaming/cards')).data ?? [];
  const cOK = cards.find((c: any) => c.id === OK.id);
  check('cards: a shared card gets an eMAID-style contract id (ID-PLS-C…)', /^ID-PLS-C[0-9A-F]{8}$/.test(cOK?.contract_id ?? '') && !cards.find((c: any) => c.id === NOT.id)?.contract_id, cOK);

  // ─────────────────────────────────────────── the CPO registers
  const created = await ops('POST', '/v1/roaming/partners', { name: 'E2E CPO', kind: 'cpo' });
  partnerId = created.data.partner?.id;
  const TOKEN_A = created.data.token as string;
  const versions = await ocpi('GET', created.data.versionsUrl, TOKEN_A);
  const details = await ocpi('GET', versions.body.data[0].url, TOKEN_A);
  const eps = details.body.data?.endpoints ?? [];
  const ep = (id: string, role: string) => eps.find((e: any) => e.identifier === id && e.role === role)?.url as string;
  check('register: we offer the eMSP side too (locations/tariffs/sessions/cdrs RECEIVER, tokens/commands SENDER)',
    !!(['locations', 'tariffs', 'sessions', 'cdrs'].every((m) => ep(m, 'RECEIVER')?.includes('/emsp/')) && ep('tokens', 'SENDER')?.includes('/emsp/') && ep('commands', 'SENDER')), eps);
  const creds = await ocpi('POST', ep('credentials', 'RECEIVER'), TOKEN_A, { token: TOKEN_B, url: `${MOCK}/cpo/versions`, roles: [{ role: 'CPO', country_code: 'ID', party_id: 'CPX', business_details: { name: 'Mock CPO' } }] });
  TOKEN_C = creds.body.data?.token;
  const roles = (creds.body.data?.roles ?? []).map((r: any) => r.role);
  check('register: our credentials carry both roles, CPO and EMSP, as ID*PLS', creds.status === 200 && roles.includes('CPO') && roles.includes('EMSP'), creds.body);
  const view = await ops('GET', '/v1/roaming');
  check('register: the console shows the partner as a connected CPO', (view.data.partners ?? []).some((p: any) => p.id === partnerId && p.kind === 'cpo' && p.state === 'connected'), view.data.partners);

  // ─────────────────────────────────────────── the CPO's network comes to us
  const net = await until(() => ops('GET', '/v1/roaming/network'), (r) => (r.data ?? []).filter((l: any) => l.partnerId === partnerId).length >= 2, 20_000);
  const mine = (net.data ?? []).filter((l: any) => l.partnerId === partnerId);
  check('network: both pages of the CPO\'s locations are imported (Link header followed)', mine.length === 2 && mine.every((l: any) => l.city === 'Bandung' && l.available === 1), mine);
  const L3 = location(3);
  const put3 = await ocpi('PUT', `${ep('locations', 'RECEIVER')}/ID/CPX/${L3.id}`, TOKEN_C, L3);
  const patch3 = await ocpi('PATCH', `${ep('locations', 'RECEIVER')}/ID/CPX/${L3.id}/${L3.evses[0]!.uid}`, TOKEN_C, { status: 'CHARGING', last_updated: nowIso() });
  const get3 = await ocpi('GET', `${ep('locations', 'RECEIVER')}/ID/CPX/${L3.id}/${L3.evses[0]!.uid}`, TOKEN_C);
  check('network: the CPO pushes a new location and an EVSE status change', put3.status === 200 && patch3.status === 200 && get3.body.data?.status === 'CHARGING', { put3: put3.body, patch3: patch3.body, get3: get3.body });
  const patchUnknown = await ocpi('PATCH', `${ep('locations', 'RECEIVER')}/ID/CPX/nope/x`, TOKEN_C, { status: 'AVAILABLE', last_updated: nowIso() });
  check('network: a PATCH for an unknown location answers 404 / 2003', patchUnknown.status === 404 && patchUnknown.body.status_code === 2003, patchUnknown.body);
  const foreign = await ocpi('PUT', `${ep('locations', 'RECEIVER')}/ID/XYZ/other`, TOKEN_C, { ...L3, party_id: 'XYZ', id: 'other' });
  check('network: a CPO cannot publish locations for another party', foreign.status === 403, foreign.body);
  const tar = await ocpi('GET', `${ep('tariffs', 'RECEIVER')}/ID/CPX/${mockTariff.id}`, TOKEN_C);
  check('network: the CPO\'s tariff was imported', tar.body.data?.elements?.[0]?.price_components?.[0]?.price === 2500, tar.body);

  // ─────────────────────────────────────────── our cards go to the CPO
  const pushed = (uid: string) => received((g) => g.method === 'PUT' && g.path.startsWith(`/cpo/2.2.1/tokens/ID/PLS/${uid}`));
  await until(() => [pushed(OK.uid), pushed(LIM.uid), pushed(BLK.uid)], (v) => v.every(Boolean), 20_000);
  const pOK = pushed(OK.uid); const pLIM = pushed(LIM.uid); const pBLK = pushed(BLK.uid);
  check('tokens: the shared cards are PUT to the CPO, signed with token B and addressed to ID*CPX',
    !!pOK && decode(pOK.headers.authorization as string) === TOKEN_B && pOK.headers['ocpi-to-party-id'] === 'CPX' && pOK.body?.contract_id === cOK?.contract_id && pOK.body?.type === 'RFID' && pOK.path.includes('type=RFID'), pOK?.body);
  check('tokens: a card with a spending limit is NEVER whitelisted (the CPO must ask us); others ALLOWED',
    pOK?.body?.whitelist === 'ALLOWED' && pLIM?.body?.whitelist === 'NEVER', { ok: pOK?.body?.whitelist, lim: pLIM?.body?.whitelist });
  check('tokens: the blocked card is sent as valid=false; the unshared card is never sent',
    pBLK?.body?.valid === false && pOK?.body?.valid === true && !pushed(NOT.uid), { blk: pBLK?.body?.valid });
  const pull = await ocpi('GET', `${ep('tokens', 'SENDER')}?limit=100&date_from=${encodeURIComponent(RUN_STARTED)}`, TOKEN_C);
  const pulledUids = (pull.body.data ?? []).map((t: any) => t.uid);
  check('tokens: the CPO can pull the shared cards (not the unshared one)', pulledUids.includes(OK.uid) && pulledUids.includes(LIM.uid) && !pulledUids.includes(NOT.uid), pulledUids);

  // ─────────────────────────────────────────── real-time authorisation
  const auth = (uid: string) => ocpi('POST', `${ep('tokens', 'SENDER')}/${uid}/authorize?type=RFID`, TOKEN_C, { location_id: L3.id });
  const aOK = await auth(OK.uid);
  const aBLK = await auth(BLK.uid);
  const aNOT = await auth(NOT.uid);
  check('authorize: a shared card is ALLOWED with an authorization_reference', aOK.body.data?.allowed === 'ALLOWED' && !!aOK.body.data.authorization_reference, aOK.body);
  check('authorize: the blocked card is BLOCKED; an unshared card is unknown (404 / 2004)', aBLK.body.data?.allowed === 'BLOCKED' && aNOT.status === 404 && aNOT.body.status_code === 2004, { aBLK: aBLK.body, aNOT: aNOT.body });

  // ─────────────────────────────────────────── commands from the console
  const loc1 = mine.find((l: any) => l.id.endsWith('-1'));
  let mark = Date.now();
  const start = await ops('POST', '/v1/roaming/commands', { partnerId, command: 'START_SESSION', tokenId: OK.id, locationId: loc1.id, evseUid: loc1.evses[0].uid, connectorId: '1', countryCode: 'ID', partyId: 'CPX' });
  const startAtCpo = received((g) => g.method === 'POST' && g.path === '/cpo/2.2.1/commands/START_SESSION', mark);
  check('command: the console starts a charge at the CPO with the card as token', start.status === 200 && start.data.response === 'ACCEPTED' && startAtCpo?.body?.token?.uid === OK.uid && startAtCpo.body.location_id === loc1.id && /\/emsp\/commands\/START_SESSION\//.test(startAtCpo.body.response_url), { s: start.data, b: startAtCpo?.body });
  const res1 = await flushResults();
  const cmds = await until(() => ops('GET', '/v1/roaming/commands'), (r) => (r.data ?? []).find((c: any) => c.id === start.data.id)?.result === 'ACCEPTED', 5000);
  check('command: the CPO\'s result (ACCEPTED) arrives at our response_url and shows in the console', res1[0]?.status === 200 && (cmds.data ?? []).find((c: any) => c.id === start.data.id)?.result === 'ACCEPTED', { res1: res1.map((r) => r.body), c: (cmds.data ?? [])[0] });
  const startNot = await ops('POST', '/v1/roaming/commands', { partnerId, command: 'START_SESSION', tokenId: NOT.id, locationId: loc1.id });
  check('command: a card that is not shared cannot be started abroad', startNot.status === 422, startNot.data);

  // ─────────────────────────────────────────── our driver's session and the CDR
  const S1 = `CPX-S-${RUN}`;
  const sessionBody = { country_code: 'ID', party_id: 'CPX', id: S1, start_date_time: nowIso(), kwh: 0, cdr_token: { country_code: 'ID', party_id: 'PLS', uid: OK.uid, type: 'RFID', contract_id: cOK.contract_id },
    auth_method: 'COMMAND', location_id: loc1.id, evse_uid: loc1.evses[0].uid, connector_id: '1', currency: 'IDR', status: 'ACTIVE', last_updated: nowIso() };
  const sPut = await ocpi('PUT', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S1}`, TOKEN_C, sessionBody);
  const sPatch = await ocpi('PATCH', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S1}`, TOKEN_C, { kwh: 5.5, last_updated: nowIso() });
  const sGet = await ocpi('GET', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S1}`, TOKEN_C);
  check('session: the CPO reports our driver\'s session (PUT, then PATCH 5.5 kWh)', sPut.status === 200 && sPatch.status === 200 && sGet.body.data?.kwh === 5.5 && sGet.body.data.status === 'ACTIVE', { sPut: sPut.body, sGet: sGet.body });
  const abroad = await ops('GET', '/v1/roaming/abroad');
  check('session: the console shows it as charging abroad, with the location and driver', (abroad.data.active ?? []).some((s: any) => s.session_id === S1 && s.location_name === 'Mock Mall 1' && s.uid === OK.uid), abroad.data.active);
  const sForeign = await ocpi('PUT', `${ep('sessions', 'RECEIVER')}/ID/CPX/X-${RUN}`, TOKEN_C, { ...sessionBody, id: `X-${RUN}`, cdr_token: { ...sessionBody.cdr_token, party_id: 'ZZZ' } });
  check('session: a session for somebody else\'s token is refused (2004)', sForeign.status === 400 && sForeign.body.status_code === 2004, sForeign.body);
  mark = Date.now();
  const stop = await ops('POST', '/v1/roaming/commands', { partnerId, command: 'STOP_SESSION', sessionId: S1 });
  const stopAtCpo = received((g) => g.path === '/cpo/2.2.1/commands/STOP_SESSION', mark);
  await flushResults();
  const stopDone = await until(() => ops('GET', '/v1/roaming/commands'), (r) => (r.data ?? []).find((c: any) => c.id === stop.data.id)?.result === 'ACCEPTED', 5000);
  check('command: STOP_SESSION reaches the CPO with the session id, and its result is recorded', stopAtCpo?.body?.session_id === S1 && (stopDone.data ?? []).find((c: any) => c.id === stop.data.id)?.result === 'ACCEPTED', stopAtCpo?.body);
  await ocpi('PATCH', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S1}`, TOKEN_C, { status: 'COMPLETED', kwh: 12.5, end_date_time: nowIso(), last_updated: nowIso() });

  const cdr = (id: string, uid: string, contract: string, excl: number, incl: number, kwh: number, sessionId = S1, at = loc1) => ({
    country_code: 'ID', party_id: 'CPX', id, start_date_time: new Date(Date.now() - 3600_000).toISOString(), end_date_time: nowIso(), session_id: sessionId,
    cdr_token: { country_code: 'ID', party_id: 'PLS', uid, type: 'RFID', contract_id: contract }, auth_method: 'COMMAND',
    cdr_location: { id: at.id, name: at.name, address: at.address, city: 'Bandung', country: 'IDN', coordinates: { latitude: '-6.921000', longitude: '107.607000' }, evse_uid: at.evses[0].uid, evse_id: at.evses[0].evseId, connector_id: '1', connector_standard: 'IEC_62196_T2_COMBO', connector_format: 'CABLE', connector_power_type: 'DC' },
    currency: 'IDR', charging_periods: [{ start_date_time: nowIso(), dimensions: [{ type: 'ENERGY', volume: kwh }] }],
    total_cost: { excl_vat: excl, incl_vat: incl }, total_energy: kwh, total_time: 1, last_updated: nowIso(),
  });
  const C1 = cdr(`CPX-CDR-${RUN}`, OK.uid, cOK.contract_id, 40_000, 44_400, 12.5);
  const post1 = await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, C1);
  const loc = post1.headers.get('location');
  const back = loc ? await ocpi('GET', loc, TOKEN_C) : null;
  check('cdr: the CPO posts the charge record; we answer with a Location to read it back', post1.status === 200 && !!loc && back?.body.data?.id === C1.id && back.body.data.total_cost.incl_vat === 44_400, { post1: post1.body, loc });
  const again = await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, C1);
  check('cdr: the same CDR posted twice is acknowledged once (same Location)', again.status === 200 && again.headers.get('location') === loc, again.body);
  const changed = await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, { ...C1, total_cost: { excl_vat: 1, incl_vat: 1 } });
  check('cdr: a changed CDR under the same id is refused (CDRs cannot be changed)', changed.status === 409, changed.body);

  // ─────────────────────────────────────────── limits hold across networks
  const lim = (await ops('GET', '/v1/roaming/cards')).data.find((c: any) => c.id === LIM.id);
  const aLimBefore = await auth(LIM.uid);
  // The record quotes the approval we just gave (no session was reported for this card):
  // a CDR linked to neither a session nor an approval of ours is held, not billed.
  await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, { ...cdr(`CPX-CDR-L-${RUN}`, LIM.uid, lim.contract_id, 54_000, 59_940, 20), session_id: `CPX-S-L-${RUN}`, authorization_reference: aLimBefore.body.data?.authorization_reference });
  const aLimAfter = await auth(LIM.uid);
  check('limits: a card over its Rp 50,000 limit because of roaming charges gets NO_CREDIT', aLimBefore.body.data?.allowed === 'ALLOWED' && aLimAfter.body.data?.allowed === 'NO_CREDIT', { before: aLimBefore.body.data?.allowed, after: aLimAfter.body.data?.allowed });

  // ─────────────────────────────────────────── records we cannot place are held, not billed
  const negative = await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, cdr(`CPX-CDR-N-${RUN}`, OK.uid, cOK.contract_id, -1000, -1110, 1));
  check('review: a CDR with a negative total is refused (400)', negative.status === 400, negative.body);
  const orphan = await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, cdr(`CPX-CDR-O-${RUN}`, OK.uid, cOK.contract_id, 10_000, 11_100, 3, `NO-SUCH-${RUN}`));
  const held = await ops('GET', '/v1/roaming/cdrs/held');
  const heldRow = (held.data ?? []).find((c: any) => c.cdr_id === `CPX-CDR-O-${RUN}`);
  check('review: a CDR for no session or approval of ours is received but held for review', orphan.status === 200 && !!heldRow && /no session/.test(heldRow.hold_reason ?? ''), { orphan: orphan.body, held: held.data });
  const rejected = heldRow ? await ops('POST', `/v1/roaming/cdrs/${heldRow.id}/reject`, { note: 'e2e' }) : null;
  const rejectedAgain = heldRow ? await ops('POST', `/v1/roaming/cdrs/${heldRow.id}/reject`, {}) : null;
  check('review: the operator rejects it (once)', rejected?.status === 200 && rejected.data.status === 'rejected' && rejectedAgain?.status === 409, { r: rejected?.data, again: rejectedAgain?.status });

  // ─────────────────────────────────────────── what the operator sees and bills
  const cardsAfter = (await ops('GET', '/v1/roaming/cards')).data ?? [];
  check('console: each card shows its roaming charges', Number(cardsAfter.find((c: any) => c.id === OK.id)?.roaming_minor) === 44_400 && cardsAfter.find((c: any) => c.id === LIM.id)?.roaming_cdrs === 1);
  const ab = await ops('GET', '/v1/roaming/abroad');
  const row = (ab.data.cdrs ?? []).find((c: any) => c.cdr_id === C1.id);
  check('console: the charge record lists partner, location, card, holder and totals', row?.partner_name === 'E2E CPO' && row.location_name === 'Mock Mall 1' && row.uid === OK.uid && Number(row.total_incl_vat) === 44_400, row);
  const csv = await ops('GET', '/v1/roaming/abroad.csv');
  const lines = String(csv.data).split('\r\n');
  check('export: the CSV has a header and the charge, with the holder name neutralised against formula injection',
    csv.status === 200 && lines[0]!.startsWith('start,end,partner') && lines.some((l) => l.includes(C1.id) && l.includes(`"'=HYPERLINK(""http://x"")"`)), lines.slice(0, 3));

  // ─────────────────────────────────────────── the driver app: a fleet driver charges at a partner
  const drv = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(`${API}/d${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d };
  };
  const device = async () => (await drv('POST', '/v1/device', null)).data.deviceToken as string;
  const dev = await device();
  const flogin = await drv('POST', '/v1/fleet/login', dev, { orgSlug: 'nusantara-charge', rfidUid: OK.uid, pin: '2468' });
  check('app: the fleet driver signs in with card and PIN', flogin.status === 200, flogin.data);
  const rs = await drv('GET', '/v1/roaming/stations?lat=-6.92&lon=107.6', dev);
  const m1 = (rs.data.stations ?? []).find((s: any) => s.locationId === loc1.id);
  const m3 = (rs.data.stations ?? []).find((s: any) => s.locationId === L3.id);
  check('app: partner stations are listed with availability, distance, operator and the operator\'s energy price',
    rs.data.enabled === true && m1?.name === 'Mock Mall 1' && m1.availableCount === 1 && m1.distanceKm != null && m1.distanceKm < 5 && m1.operator === 'Mock CPO' && m1.priceFromMinor === 2500 && m1.vatPercent === 11,
    { enabled: rs.data.enabled, m1 });
  check('app: a partner charger in use shows as not available', m3 && m3.evses[0].status === 'Charging' && m3.evses[0].available === false, m3?.evses);
  const devNot = await device();
  await drv('POST', '/v1/fleet/login', devNot, { orgSlug: 'nusantara-charge', rfidUid: NOT.uid, pin: '1357' });
  const rsNot = await drv('GET', '/v1/roaming/stations', devNot);
  const rsGuest = await drv('GET', '/v1/roaming/stations', await device());
  check('app: a card not enabled for roaming, and a guest, see no partner network (with the reason)',
    rsNot.data.enabled === false && /belum diaktifkan/.test(rsNot.data.reason) && rsGuest.data.enabled === false && (rsNot.data.stations ?? []).length === 0, { not: rsNot.data, guest: rsGuest.data });

  const loc2 = mine.find((l: any) => l.id.endsWith('-2'));
  mark = Date.now();
  const busy = await drv('POST', '/v1/roaming/charge', dev, { partnerId, countryCode: 'ID', partyId: 'CPX', locationId: L3.id, evseUid: L3.evses[0]!.uid });
  check('app: starting at a partner charger in use is refused with a reason', busy.status === 422 && /tidak tersedia/.test(busy.data.error), busy.data);
  const start2 = await drv('POST', '/v1/roaming/charge', dev, { partnerId, countryCode: 'ID', partyId: 'CPX', locationId: loc2.id, evseUid: loc2.evses[0].uid });
  const atCpo2 = received((g) => g.path === '/cpo/2.2.1/commands/START_SESSION' && g.body?.location_id === loc2.id, mark);
  check('app: the driver starts a charge; the operator receives START_SESSION with the driver\'s card', start2.status === 200 && !!start2.data.chargeId && atCpo2?.body?.token?.uid === OK.uid && atCpo2.body.evse_uid === loc2.evses[0].uid, { s: start2.data, b: atCpo2?.body });
  const chargeId = start2.data.chargeId as string;
  await flushResults();
  const st1 = await drv('GET', `/v1/roaming/charge/${chargeId}/status`, dev);
  check('app: until the operator reports the session, the app shows it as starting', st1.data.state === 'starting' && st1.data.siteName === 'Mock Mall 2' && st1.data.operator === 'Mock CPO', st1.data);
  const S2 = `CPX-S2-${RUN}`;
  await ocpi('PUT', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S2}`, TOKEN_C, { ...sessionBody, id: S2, location_id: loc2.id, evse_uid: loc2.evses[0].uid, kwh: 3.25, start_date_time: new Date(Date.now() - 600_000).toISOString(), last_updated: nowIso() });
  const st2 = await drv('GET', `/v1/roaming/charge/${chargeId}/status`, dev);
  check('app: the operator\'s session appears as charging, with energy and time', st2.data.state === 'charging' && st2.data.energyKwh === 3.25 && st2.data.durationMin >= 9 && st2.data.canStop === true, st2.data);
  const hist1 = await drv('GET', '/v1/history', dev);
  check('app: the live roaming charge is in the history (for the "charging now" banner)', (hist1.data.charges ?? []).some((c: any) => c.kind === 'roaming' && c.chargeId === chargeId && c.state === 'active'), (hist1.data.charges ?? []).slice(0, 3));
  const other = await drv('GET', `/v1/roaming/charge/${chargeId}/status`, devNot);
  check('app: another driver cannot see this charge', other.status === 404, other.data);
  mark = Date.now();
  const stop2 = await drv('POST', `/v1/roaming/charge/${chargeId}/stop`, dev);
  const stopAt2 = received((g) => g.path === '/cpo/2.2.1/commands/STOP_SESSION' && g.body?.session_id === S2, mark);
  check('app: Stop sends STOP_SESSION for the operator\'s session', stop2.status === 200 && !!stopAt2, { s: stop2.data });
  await flushResults();
  await ocpi('PATCH', `${ep('sessions', 'RECEIVER')}/ID/CPX/${S2}`, TOKEN_C, { status: 'COMPLETED', kwh: 9, end_date_time: nowIso(), last_updated: nowIso() });
  const st3 = await drv('GET', `/v1/roaming/charge/${chargeId}/status`, dev);
  check('app: after stopping, the app waits for the operator\'s bill', st3.data.state === 'finishing' && st3.data.energyKwh === 9, st3.data);
  await ocpi('POST', ep('cdrs', 'RECEIVER'), TOKEN_C, cdr(`CPX-CDR2-${RUN}`, OK.uid, cOK.contract_id, 30_000, 33_300, 9, S2, loc2));
  const st4 = await drv('GET', `/v1/roaming/charge/${chargeId}/status`, dev);
  check('app: once the charge record arrives the charge is complete, with the total incl. tax', st4.data.state === 'billed' && st4.data.totalMinor === 33_300 && !!st4.data.cdrId, st4.data);
  const rc = await drv('GET', `/v1/roaming/cdr/${st4.data.cdrId}`, dev);
  check('app: the charge details show the site, energy, totals before and after tax', rc.status === 200 && rc.data.siteName === 'Mock Mall 2' && rc.data.energyKwh === 9 && rc.data.totalExclVat === 30_000 && rc.data.totalInclVat === 33_300, rc.data);
  const rcOther = await drv('GET', `/v1/roaming/cdr/${st4.data.cdrId}`, devNot);
  check('app: another driver cannot read the charge details', rcOther.status === 404);
  const hist2 = await drv('GET', '/v1/history', dev);
  const hRoam = (hist2.data.charges ?? []).filter((c: any) => c.kind === 'roaming');
  check('app: history lists the app-started charge and the card-tap charge from the partner network',
    hRoam.some((c: any) => c.chargeId === chargeId && c.state === 'rated' && c.totalMinor === 33_300) && hRoam.some((c: any) => c.chargeId == null && c.totalMinor === 44_400), hRoam);

  // ─────────────────────────────────────────── the driver app: reserving a partner charger
  const at = (s: any) => ({ partnerId, countryCode: 'ID', partyId: 'CPX', locationId: s.id, evseUid: s.evses[0].uid });
  mark = Date.now();
  const rv1 = await drv('POST', '/v1/roaming/reservations', dev, at(loc1));
  const rnAtCpo = received((g) => g.path === '/cpo/2.2.1/commands/RESERVE_NOW', mark);
  const exp = new Date(rnAtCpo?.body?.expiry_date ?? 0).getTime() - Date.now();
  check('reserve: the operator receives RESERVE_NOW with the driver\'s card, our reservation id and a 15-minute expiry; the app waits for the charger',
    rv1.status === 200 && rv1.data.reservation?.state === 'requested' && rnAtCpo?.body?.token?.uid === OK.uid && rnAtCpo.body.location_id === loc1.id
      && rnAtCpo.body.evse_uid === loc1.evses[0].uid && /^PLS-/.test(rnAtCpo.body.reservation_id) && exp > 14 * 60_000 && exp <= 15 * 60_000
      && /\/emsp\/commands\/RESERVE_NOW\//.test(rnAtCpo.body.response_url), { rv1: rv1.data, b: rnAtCpo?.body });
  await flushResults();
  const rv1s = await drv('GET', `/v1/roaming/reservations/${rv1.data.reservation?.id}`, dev);
  const cur = await drv('GET', '/v1/reservation', dev);
  check('reserve: the charger accepts → active, and it is the driver\'s current reservation (Mock Mall 1)',
    rv1s.data.reservation?.state === 'active' && cur.data.partner?.id === rv1.data.reservation?.id && cur.data.partner.siteName === 'Mock Mall 1' && cur.data.partner.minutesLeft >= 14 && cur.data.reservation === null,
    { s: rv1s.data, cur: cur.data });
  const twice = await drv('POST', '/v1/roaming/reservations', dev, at(loc2));
  const notRoam = await drv('POST', '/v1/roaming/reservations', devNot, at(loc2));
  const otherSees = await drv('GET', `/v1/roaming/reservations/${rv1.data.reservation?.id}`, devNot);
  check('reserve: one reservation at a time; a card not enabled for roaming cannot reserve; another driver cannot see it',
    twice.status === 422 && /sudah punya reservasi/.test(twice.data.error) && notRoam.status === 422 && /belum diaktifkan/.test(notRoam.data.error) && otherSees.status === 404,
    { twice: twice.data, not: notRoam.data, other: otherSees.status });
  mark = Date.now();
  const startRes = await drv('POST', '/v1/roaming/charge', dev, at(loc1));
  const used = await drv('GET', `/v1/roaming/reservations/${rv1.data.reservation?.id}`, dev);
  const cur2 = await drv('GET', '/v1/reservation', dev);
  check('reserve: starting a charge at the reserved charger uses the reservation up',
    startRes.status === 200 && !!received((g) => g.path === '/cpo/2.2.1/commands/START_SESSION' && g.body?.location_id === loc1.id, mark)
      && used.data.reservation?.state === 'used' && cur2.data.partner === null, { start: startRes.data, used: used.data, cur2: cur2.data });
  await flushResults();

  const rv2 = await drv('POST', '/v1/roaming/reservations', dev, at(loc2));
  pendingResults[pendingResults.length - 1]!.result = 'EVSE_OCCUPIED';
  await flushResults();
  const rv2s = await drv('GET', `/v1/roaming/reservations/${rv2.data.reservation?.id}`, dev);
  const cur3 = await drv('GET', '/v1/reservation', dev);
  check('reserve: the charger refuses (occupied) → rejected with the reason; the driver holds nothing',
    rv2.status === 200 && rv2s.data.reservation?.state === 'rejected' && rv2s.data.reservation.problem === 'Charger sedang dipakai.' && cur3.data.partner === null, { rv2s: rv2s.data, cur3: cur3.data });

  const rv3 = await drv('POST', '/v1/roaming/reservations', dev, at(loc2));
  await flushResults();
  mark = Date.now();
  const cx = await drv('POST', `/v1/roaming/reservations/${rv3.data.reservation?.id}/cancel`, dev);
  const cxAtCpo = received((g) => g.path === '/cpo/2.2.1/commands/CANCEL_RESERVATION', mark);
  const rv3s = await drv('GET', `/v1/roaming/reservations/${rv3.data.reservation?.id}`, dev);
  const cx2 = await drv('POST', `/v1/roaming/reservations/${rv3.data.reservation?.id}/cancel`, dev);
  check('cancel: CANCEL_RESERVATION with the same reservation id; cancelled; cancelling again is 404',
    cx.status === 200 && !!cxAtCpo?.body?.reservation_id
      && cxAtCpo.body.reservation_id === [...got].reverse().find((g) => g.path === '/cpo/2.2.1/commands/RESERVE_NOW' && g.body?.location_id === loc2.id)?.body?.reservation_id
      && rv3s.data.reservation?.state === 'cancelled' && cx2.status === 404, { cx: cx.data, b: cxAtCpo?.body, s: rv3s.data });
  await flushResults();
  const cmdList = await ops('GET', '/v1/roaming/commands');
  check('console: the reservation commands show in the roaming command log with their results',
    (cmdList.data ?? []).some((c: any) => c.command === 'RESERVE_NOW' && c.result === 'EVSE_OCCUPIED') && (cmdList.data ?? []).some((c: any) => c.command === 'CANCEL_RESERVATION'), (cmdList.data ?? []).slice(0, 4));

  if (process.env.E2E_KEEP) {
    // Leave the partner and its network in place to look at the console and the driver app (not a normal run).
    partnerId = '';
    throw new Error('E2E_KEEP: stopped before withdrawing cards and disconnecting, as asked');
  }
  // ─────────────────────────────────────────── withdrawal and disconnect
  mark = Date.now();
  await ops('PUT', '/v1/roaming/cards', { ids: [OK.id], shared: false });
  const revoked = await waitReceived((g) => g.method === 'PUT' && g.path.startsWith(`/cpo/2.2.1/tokens/ID/PLS/${OK.uid}`) && g.body?.valid === false, mark);
  check('cards: an unshared card is sent to the CPO once more as valid=false', !!revoked, got.filter((g) => g.at >= mark).map((g) => [g.method, g.path, g.body?.valid]));
  const aRevoked = await auth(OK.uid);
  check('cards: the CPO\'s next check for that card answers NOT_ALLOWED', aRevoked.body.data?.allowed === 'NOT_ALLOWED', aRevoked.body);
  const pushes = await ops('GET', `/v1/roaming/partners/${partnerId}/pushes`);
  check('console: nothing failed in the outbox', !(pushes.data ?? []).some((p: any) => p.state === 'failed'), (pushes.data ?? []).filter((p: any) => p.state === 'failed'));
  mark = Date.now();
  const del = await ops('DELETE', `/v1/roaming/partners/${partnerId}`);
  const told = await waitReceived((g) => g.method === 'DELETE' && g.path === '/cpo/2.2.1/credentials', mark, 5000);
  const after = await ocpi('GET', `${ep('tokens', 'SENDER')}`, TOKEN_C);
  check('disconnect: the CPO is told and its token stops working', del.status === 200 && !!told && after.status === 401, { del: del.data, after: after.status });
  partnerId = '';
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  if (partnerId) await ops('DELETE', `/v1/roaming/partners/${partnerId}`).catch(() => null);
  mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
