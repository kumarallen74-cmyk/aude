// PlugSure v1.3 — ISO 15118 Plug & Charge (CSMS side), end to end.
//
// With the test PKI (PNC_PKI=mock, the default outside production):
//
// Part A, in the operator's test tenant, with raw chargers:
//   - a 2.0.1 station: Plug & Charge switched on (SetVariables), trust anchors
//     installed (InstallCertificate), its V2G certificate requested
//     (TriggerMessage → SignCertificate → CertificateSigned) and checked against
//     the V2G root; contracts authorised from the certificate hash data (OCSP)
//     and from the full chain; a session billed to the contract's fleet
//     account; OCSP for the car (GetCertificateStatus); a contract certificate
//     for the car (Get15118EVCertificate); revoked, cancelled and unknown
//     contracts refused; the trust store read and a certificate deleted;
//   - a 1.6 charger doing the same through DataTransfer (OCA application note).
// Part B, in a developer sandbox: the virtual charger set up from the API and
// a simulated Plug & Charge car charging.
//
// Plug & Charge is switched off again for the tenant at the end.
//
//     npx tsx tools/e2e/pnc-e2e.mts        (E2E_API / E2E_OCPP / E2E_PASSWORD override)
// NEVER point this at production.
import WebSocket from 'ws';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildCsr, certInfo, name, readOcspResponse, splitPemChain } from '../../src/pnc/der.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, text: t };
}
let KEY = '';
async function sb(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1') {}
  key = '';
  async connect() {
    const headers: Record<string, string> = this.key ? { authorization: 'Basic ' + Buffer.from(`${this.id}:${this.key}`).toString('base64'), 'x-forwarded-proto': 'https' } : {};
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version], { headers });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], desc: f[3] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 15_000); });
  }
  waitFor(action: string, after = 0, pred: (p: any) => boolean = () => true, ms = 20_000) {
    return until(async () => this.calls.find((c) => c.action === action && c.at >= after && pred(c.payload)), (v) => !!v, ms, 200);
  }
  close() { try { this.ws.close(); } catch {} }
}

const PNC = 'org.openchargealliance.iso15118pnc';
const raws: Raw[] = [];
let tenantSettings: any = null;
let sandboxId = '';
const contract: string[] = [];

try {
  const spec = (await ops('GET', '/openapi.json')).data;
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  ajv.addSchema({ $id: 'spec', components: spec.components });
  const cc = (path: string, method: string, status: string, body: unknown) => {
    const s = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
    if (!s) { contract.push(`no documented ${status} schema for ${method} ${path}`); return; }
    const v = ajv.compile(JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"spec#/components/')));
    if (!v(body)) contract.push(`${method} ${path}: ${v.errors.slice(0, 3).map((e: any) => `${e.instancePath} ${e.message}`).join('; ')}`);
  };

  // ================================================================ setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  const ov0 = await ops('GET', '/v1/pnc');
  tenantSettings = ov0.data.settings;
  cc('/v1/pnc', 'get', '200', ov0.data);
  check('setup: signed in; Plug & Charge overview with the test PKI', login.status === 200 && ov0.data.pki?.mode === 'mock' && ov0.data.pki.problem === null, ov0.data);
  await ops('PUT', '/v1/pnc/settings', { enabled: false });

  const site = await ops('POST', '/v1/sites', { name: 'PnC E2E Hub', address: 'Jl. Thamrin', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'PnC E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const suffix = Date.now().toString().slice(-6);
  const ID2 = `PNC201-${suffix}`, ID16 = `PNC16-${suffix}`;
  for (const [id, v] of [[ID2, 'ocpp2.0.1'], [ID16, 'ocpp1.6']] as const) {
    await ops('POST', '/v1/charge-points', { ocppIdentity: id, siteId: site.data.id, displayName: `PnC ${v}`, ocppVersion: v,
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    await ops('POST', `/v1/charge-points/${id}/activate`);
  }
  // Certificates are only issued over Profile 2+: connect both chargers with a key over (proxied) TLS.
  const keys: Record<string, string> = {};
  for (const id of [ID2, ID16]) {
    keys[id] = (await ops('POST', `/v1/charge-points/${id}/keys`, { profile: 2 })).data.key;
    await ops('PUT', `/v1/charge-points/${id}/security-profile`, { profile: 2 });
  }
  const st = new Raw(ID2, 'ocpp2.0.1'); raws.push(st); st.key = keys[ID2]!;
  await st.connect();
  await st.call('BootNotification', { reason: 'PowerUp', chargingStation: { model: 'PNC-201', vendorName: 'E2ESim', firmwareVersion: '2.0.1' } });
  await st.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Available', evseId: 1, connectorId: 1 });
  const c16 = new Raw(ID16, 'ocpp1.6'); raws.push(c16); c16.key = keys[ID16]!;
  await c16.connect();
  await c16.call('BootNotification', { chargePointVendor: 'E2ESim', chargePointModel: 'PNC-16', firmwareVersion: '1.6.0' });
  await c16.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });
  check('setup: a site, a tariff, a 2.0.1 station and a 1.6 charger online', site.status === 200 && tariff.status === 200, { site: site.data, tariff: tariff.data });

  // The station's own behaviour: accepts variables, keeps what is installed, answers the trust-store queries.
  const installed: Array<{ type: string; pem: string }> = [];
  const v2gKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  st.handlers.SetVariables = (p) => ({ setVariableResult: p.setVariableData.map((d: any) => ({ attributeStatus: 'Accepted', component: d.component, variable: d.variable })) });
  st.handlers.InstallCertificate = (p) => { installed.push({ type: p.certificateType, pem: p.certificate }); return { status: 'Accepted' }; };
  st.handlers.TriggerMessage = (p) => {
    if (p.requestedMessage === 'SignV2GCertificate') setTimeout(() => void st.call('SignCertificate', { csr: buildCsr(name([['C', 'ID'], ['O', 'Nusantara Charge'], ['CN', ID2], ['DC', 'CPO']]), v2gKeys), certificateType: 'V2GCertificate' }).then((r) => { st.calls.push({ action: '_SignCertificateAnswer', payload: r, at: Date.now() }); }), 100);
    return { status: 'Accepted' };
  };
  st.handlers.GetInstalledCertificateIds = () => ({ status: 'Accepted', certificateHashDataChain: installed.map((i) => ({ certificateType: i.type, certificateHashData: { hashAlgorithm: 'SHA256', issuerNameHash: 'aa', issuerKeyHash: 'bb', serialNumber: certInfo(i.pem).serial } })) });
  st.handlers.DeleteCertificate = () => ({ status: 'Accepted' });

  // ================================================================ switched off
  const offAuth = await st.call('Authorize', { idToken: { idToken: 'ID-E2E-C00000000', type: 'eMAID' } });
  const offSign = await st.call('SignCertificate', { csr: buildCsr(name([['CN', ID2]]), v2gKeys), certificateType: 'V2GCertificate' });
  check('off: with Plug & Charge switched off, a contract is Invalid and a V2G signing request is Rejected', offAuth.idTokenInfo?.status === 'Invalid' && offSign.status === 'Rejected' && offSign.statusInfo?.reasonCode === 'Disabled', { offAuth, offSign });

  // ================================================================ settings, trust anchors, contracts
  const on = await ops('PUT', '/v1/pnc/settings', { enabled: true, acceptWhenOcspUnavailable: false });
  cc('/v1/pnc/settings', 'put', '200', on.data);
  const sync = await ops('POST', '/v1/pnc/trust-anchors/sync');
  cc('/v1/pnc/trust-anchors/sync', 'post', '200', sync.data);
  const anchors = sync.data.anchors ?? [];
  const v2gRoot = anchors.find((a: any) => a.kind === 'V2GRootCertificate');
  const badAnchor = await ops('POST', '/v1/pnc/trust-anchors', { kind: 'MORootCertificate', pem: 'not a certificate' });
  check('trust anchors: the PKI\'s V2G and MO roots fetched; a non-certificate refused',
    on.data.enabled === true && anchors.some((a: any) => a.kind === 'MORootCertificate') && !!v2gRoot && badAnchor.status === 422, { anchors: anchors.map((a: any) => [a.kind, a.subject]), bad: badAnchor.status });

  const EMAID = `ID-E2E-C${suffix}AB`;
  const E = EMAID.replace(/-/g, '');
  const FLEET = `PT PnC E2E ${suffix}`;
  const ct = await ops('POST', '/v1/pnc/contracts', { emaid: EMAID.toLowerCase(), holderName: 'Budi PnC', accountType: 'fleet', fleetName: FLEET });
  const dup = await ops('POST', '/v1/pnc/contracts', { emaid: E });
  const badE = await ops('POST', '/v1/pnc/contracts', { emaid: 'RFID-0001' });
  cc('/v1/pnc/contracts', 'post', '201', ct.data);
  check('contracts: registered (any case, with or without separators, stored without); duplicates 409; not an eMAID 422',
    ct.status === 201 && ct.data.emaid === E && ct.data.emaid_display === EMAID && dup.status === 409 && badE.status === 422, { ct: ct.data, dup: dup.status, bad: badE.status });
  const accts = await ops('GET', '/v1/fleet-accounts');
  const acct = accts.data.accounts?.find((a: any) => a.name === FLEET);
  check('contracts: a fleet contract gets its fleet account, like a fleet card', acct?.cards === 1, accts.data.accounts?.map((a: any) => [a.name, a.cards]));

  // ================================================================ the station: switch on, trust store, V2G certificate
  const en = await ops('POST', `/v1/pnc/chargers/${ID2}/enable`, { enabled: true });
  const sv = await st.waitFor('SetVariables', 0, (p) => p.setVariableData?.[0]?.variable?.name === 'PnCEnabled');
  check('charger: switched on with SetVariables ISO15118Ctrlr.PnCEnabled = true (2.0.1)',
    en.data.pncEnabled === true && en.data.charger === 'Accepted' && sv?.payload.setVariableData[0].component.name === 'ISO15118Ctrlr' && sv.payload.setVariableData[0].attributeValue === 'true', { en: en.data, sv: sv?.payload, calls: st.calls.filter((c) => c.action === 'SetVariables').map((c) => c.payload) });
  const inst = await ops('POST', `/v1/pnc/chargers/${ID2}/install-roots`, {});
  check('charger: trust anchors installed with InstallCertificate (V2G root and MO root)',
    inst.data.results?.length >= 2 && inst.data.results.every((r: any) => r.status === 'Accepted') && installed.some((i) => i.type === 'V2GRootCertificate') && installed.some((i) => i.type === 'MORootCertificate'), inst.data);
  const t0 = Date.now();
  const req = await ops('POST', `/v1/pnc/chargers/${ID2}/request-certificate`);
  const trig = await st.waitFor('TriggerMessage', t0);
  const signAns = await st.waitFor('_SignCertificateAnswer', t0);
  const signed = await st.waitFor('CertificateSigned', t0);
  const chain = splitPemChain(signed?.payload.certificateChain ?? '');
  const leaf = chain[0] ? new X509Certificate(chain[0]) : null;
  const sub = chain[1] ? new X509Certificate(chain[1]) : null;
  const root = new X509Certificate(v2gRoot.pem);
  check('V2G certificate: TriggerMessage(SignV2GCertificate) → SignCertificate Accepted → CertificateSigned with the chain',
    req.data.status === 'Accepted' && trig?.payload.requestedMessage === 'SignV2GCertificate' && signAns?.payload.status === 'Accepted' && signed?.payload.certificateType === 'V2GCertificate' && chain.length === 2, { req: req.data, sign: signAns?.payload });
  check('V2G certificate: certifies the station\'s own key, for its identity, and verifies up to the V2G root',
    !!leaf && !!sub && leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(v2gKeys.publicKey.export({ type: 'spki', format: 'der' })) && certInfo(chain[0]!).subject.includes(`CN=${ID2}`)
      && leaf.checkIssued(sub) && leaf.verify(sub.publicKey) && sub.checkIssued(root) && sub.verify(root.publicKey), certInfo(chain[0] ?? '').subject);
  const chargers = await until(() => ops('GET', '/v1/pnc/chargers'), (r) => r.data.chargers?.find((c: any) => c.ocpp_identity === ID2)?.cert_state === 'delivered', 10_000);
  cc('/v1/pnc/chargers', 'get', '200', chargers.data);
  const row = chargers.data.chargers.find((c: any) => c.ocpp_identity === ID2);
  check('V2G certificate: shown as delivered with its expiry (about a year)', row?.cert_state === 'delivered' && row.pnc_enabled && Math.abs(new Date(row.cert_not_after).getTime() - Date.now() - 365 * 86_400_000) < 2 * 86_400_000, row);
  const badCsr = await st.call('SignCertificate', { csr: 'MIIB-not-a-csr', certificateType: 'V2GCertificate' });
  const csCert = await st.call('SignCertificate', { csr: buildCsr(name([['CN', ID2]]), v2gKeys) });
  check('SignCertificate: a malformed request is Rejected (InvalidCSR); a station certificate goes to the charging-station CA (Accepted)',
    badCsr.status === 'Rejected' && badCsr.statusInfo?.reasonCode === 'InvalidCSR' && csCert.status === 'Rejected' && csCert.statusInfo?.reasonCode === 'NotAllowed', { badCsr, csCert });

  // ================================================================ contracts at the station (2.0.1)
  const tc = await ops('POST', '/v1/pnc/test-contracts', { emaid: EMAID });
  cc('/v1/pnc/test-contracts', 'post', '201', tc.data);
  const hd = tc.data.hashData;
  const a1 = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: hd });
  check('Authorize: the certificate hash data checked by OCSP, then the contract → Accepted / certificate Accepted', a1.idTokenInfo?.status === 'Accepted' && a1.certificateStatus === 'Accepted', a1);
  const a2 = await st.call('Authorize', { idToken: { idToken: E, type: 'eMAID' }, certificate: tc.data.chainPem });
  check('Authorize: the full contract chain (charger could not validate it) checked up to the MO root → Accepted', a2.idTokenInfo?.status === 'Accepted' && a2.certificateStatus === 'Accepted', a2);
  const other = await ops('POST', '/v1/pnc/test-contracts', { emaid: `ID-E2E-X${suffix}CD` });
  const a3 = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, certificate: other.data.chainPem });
  check('Authorize: someone else\'s contract certificate with this eMAID → Invalid / CertChainError', a3.idTokenInfo?.status === 'Invalid' && a3.certificateStatus === 'CertChainError', a3);

  // A session with the contract: billed to it and to its fleet account.
  const TX = `PNC-${Date.now().toString(36)}`;
  const mv = (wh: number, ts: string) => [{ timestamp: ts, sampledValue: [{ value: wh, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }] }];
  const s0 = await st.call('TransactionEvent', { eventType: 'Started', timestamp: iso(-600), triggerReason: 'Authorized', seqNo: 0, transactionInfo: { transactionId: TX }, evse: { id: 1, connectorId: 1 }, idToken: { idToken: EMAID, type: 'eMAID' }, meterValue: mv(50_000, iso(-600)) });
  await st.call('TransactionEvent', { eventType: 'Ended', timestamp: iso(-10), triggerReason: 'EVDeparted', seqNo: 1, transactionInfo: { transactionId: TX, stoppedReason: 'EVDisconnected' }, evse: { id: 1, connectorId: 1 }, meterValue: mv(62_000, iso(-10)) });
  const sess = await until(() => ops('GET', `/v1/sessions/search?identity=${ID2}&limit=5`), (r) => r.data.rows?.find((x: any) => x.ocpp_transaction_id === TX)?.total_minor != null, 20_000);
  const srow = sess.data.rows?.find((x: any) => x.ocpp_transaction_id === TX);
  check('session: started with the eMAID (with separators), rated, and the contract is the card on it', s0.idTokenInfo?.status === 'Accepted' && srow?.total_minor > 0 && Number(srow.energy_wh) === 12_000 && srow.id_tag === E, { s0, srow });
  const period = (await ops('GET', '/v1/fleet-billing/periods/2000-01')).data.current;
  const stmt = await ops('GET', `/v1/fleet-accounts/${acct.id}/statement?period=${period}`);
  check('session: on the fleet account\'s monthly statement', stmt.data.totals?.sessions === 1, stmt.data.totals);

  // OCSP and contract certificates for the car.
  const gcs = await st.call('GetCertificateStatus', { ocspRequestData: hd[0] });
  const ocsp = gcs.ocspResult ? readOcspResponse(Buffer.from(gcs.ocspResult, 'base64'), hd[0], [new X509Certificate(splitPemChain(tc.data.chainPem)[1]!).publicKey]) : null;
  check('GetCertificateStatus: the OCSP answer for the car, good and signed by the issuer', gcs.status === 'Accepted' && ocsp?.status === 'good' && ocsp.signatureValid === true, { gcs: gcs.status, ocsp });
  const gcsBad = await st.call('GetCertificateStatus', { ocspRequestData: { ...hd[0], responderURL: 'http://127.0.0.1:1/ocsp' } });
  check('GetCertificateStatus: an unreachable responder → Failed', gcsBad.status === 'Failed' && gcsBad.statusInfo?.reasonCode === 'OcspUnavailable', gcsBad);
  const ev = await st.call('Get15118EVCertificate', { iso15118SchemaVersion: 'urn:iso:15118:2:2013:MsgDef', action: 'Install', exiRequest: Buffer.from('CertificateInstallationReq').toString('base64') });
  check('Get15118EVCertificate: passed to the PKI and its answer returned (test PKI marker)', ev.status === 'Accepted' && /^PLUGSURE-TEST-PKI:Install:/.test(Buffer.from(ev.exiResponse, 'base64').toString()), ev);

  // Refusals.
  await ops('PUT', '/v1/pnc/settings', { acceptWhenOcspUnavailable: false });
  const aDown = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: [{ ...hd[0], responderURL: 'http://127.0.0.1:1/ocsp' }] });
  await ops('PUT', '/v1/pnc/settings', { acceptWhenOcspUnavailable: true });
  const aDownOk = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: [{ ...hd[0], responderURL: 'http://127.0.0.1:1/ocsp' }] });
  check('OCSP unreachable: refused (Unknown) when the setting says so; accepted when it allows', aDown.idTokenInfo?.status === 'Unknown' && aDownOk.idTokenInfo?.status === 'Accepted', { aDown, aDownOk });
  const cancel = await ops('POST', `/v1/pnc/contracts/${ct.data.id}/cancel`);
  const aCancelled = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: hd });
  await ops('POST', `/v1/pnc/contracts/${ct.data.id}/reactivate`);
  const aBack = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: hd });
  check('contract cancelled → Blocked / ContractCancelled; reactivated → Accepted', cancel.data.status === 'Blocked' && aCancelled.idTokenInfo?.status === 'Blocked' && aCancelled.certificateStatus === 'ContractCancelled' && aBack.idTokenInfo?.status === 'Accepted', { aCancelled, aBack });
  const aUnknown = await st.call('Authorize', { idToken: { idToken: other.data.emaid, type: 'eMAID' }, iso15118CertificateHashData: other.data.hashData });
  check('a valid certificate for a contract that is not registered → Invalid / ContractCancelled', aUnknown.idTokenInfo?.status === 'Invalid' && aUnknown.certificateStatus === 'ContractCancelled', aUnknown);
  const rev = await ops('POST', `/v1/pnc/test-contracts/${tc.data.serial}/revoke`);
  const aRevoked = await st.call('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: hd });
  check('the contract certificate revoked → Invalid / CertificateRevoked (OCSP)', rev.data.revoked === true && aRevoked.idTokenInfo?.status === 'Invalid' && aRevoked.certificateStatus === 'CertificateRevoked', aRevoked);

  // The station's trust store.
  const read = await ops('POST', `/v1/pnc/chargers/${ID2}/read-installed`);
  cc('/v1/pnc/chargers/{identity}/read-installed', 'post', '200', read.data);
  const del = await ops('POST', `/v1/pnc/chargers/${ID2}/delete-certificate`, { certificateHashData: read.data.certificates?.[0]?.certificateHashData });
  const delCall = await st.waitFor('DeleteCertificate', 0);
  check('trust store: read with GetInstalledCertificateIds and kept; a certificate deleted with DeleteCertificate',
    read.data.status === 'Accepted' && read.data.certificates.length === installed.length && del.data.status === 'Accepted' && delCall?.payload.certificateHashData?.serialNumber === read.data.certificates[0].certificateHashData.serialNumber, { read: read.data, del: del.data });

  // ================================================================ the 1.6 charger (DataTransfer)
  const dt = (messageId: string, payload: unknown) => c16.call('DataTransfer', { vendorId: PNC, messageId, data: JSON.stringify(payload) });
  const tc2 = await ops('POST', '/v1/pnc/test-contracts', { emaid: EMAID });
  const w1 = await dt('Authorize', { idToken: { idToken: EMAID, type: 'eMAID' }, iso15118CertificateHashData: tc2.data.hashData });
  const w1d = w1.data ? JSON.parse(w1.data) : null;
  const start16 = await c16.call('StartTransaction', { connectorId: 1, idTag: E, meterStart: 1000, timestamp: iso() });
  const unknownMsg = await dt('SignCertificateX', {});
  const malformed = await dt('Authorize', { idToken: { idToken: EMAID } });
  check('1.6: Authorize in DataTransfer answered in DataTransfer (Accepted / certificate Accepted); StartTransaction with the eMAID accepted',
    w1.status === 'Accepted' && w1d?.idTokenInfo?.status === 'Accepted' && w1d.certificateStatus === 'Accepted' && start16.idTagInfo?.status === 'Accepted', { w1, start16 });
  check('1.6: an unknown Plug & Charge message → UnknownMessageId; a malformed one → Rejected', unknownMsg.status === 'UnknownMessageId' && malformed.status === 'Rejected', { unknownMsg, malformed });
  if (start16.transactionId) await c16.call('StopTransaction', { transactionId: start16.transactionId, meterStop: 3000, timestamp: iso(), reason: 'EVDisconnected' });
  const t16 = Date.now();
  c16.handlers.DataTransfer = (p) => ({ status: 'Accepted', data: JSON.stringify({ status: p.messageId === 'InstallCertificate' ? 'Accepted' : 'Rejected' }) });
  const inst16 = await ops('POST', `/v1/pnc/chargers/${ID16}/install-roots`, { kinds: ['MORootCertificate'] });
  const wrapped = await c16.waitFor('DataTransfer', t16, (p) => p.vendorId === PNC && p.messageId === 'InstallCertificate');
  const inner = wrapped ? JSON.parse(wrapped.payload.data) : null;
  check('1.6: InstallCertificate sent wrapped in DataTransfer (vendorId, messageId, JSON data) and the answer unwrapped',
    inst16.data.results?.[0]?.status === 'Accepted' && inner?.certificateType === 'MORootCertificate' && /BEGIN CERTIFICATE/.test(inner.certificate), { inst16: inst16.data, inner });

  // ================================================================ log, audit, console
  const events = await ops('GET', `/v1/pnc/events?identity=${ID2}&limit=200`);
  cc('/v1/pnc/events', 'get', '200', events.data);
  const outcomes = new Set((events.data.events ?? []).map((e: any) => `${e.action}:${e.outcome}`));
  check('log: every exchange recorded (authorisations with their outcome, signing, delivery, OCSP, install)',
    ['Authorize:accepted', 'Authorize:certificate_refused', 'Authorize:contract_refused', 'Authorize:unknown_contract', 'Authorize:ocsp_unavailable', 'SignCertificate:accepted', 'SignCertificate:rejected', 'CertificateSigned:delivered', 'GetCertificateStatus:good', 'InstallCertificate:Accepted'].every((o) => outcomes.has(o)), [...outcomes]);
  const list = await ops('GET', '/v1/pnc/contracts');
  cc('/v1/pnc/contracts', 'get', '200', list.data);
  const mine = list.data.contracts.find((c: any) => c.emaid === E);
  check('contracts: the list shows the session and last use', mine?.sessions >= 2 && !!mine.last_used, mine);
  const ta = await ops('GET', '/v1/pnc/trust-anchors'); cc('/v1/pnc/trust-anchors', 'get', '200', ta.data);
  const ov = await ops('GET', '/v1/pnc'); cc('/v1/pnc', 'get', '200', ov.data);
  const audit = await ops('GET', '/v1/audit?limit=100');
  check('audit: settings, contracts, trust anchors and charger switch-on are audited',
    ['pnc.settings_updated', 'pnc.contract_created', 'pnc.contract_cancelled', 'pnc.trust_anchors_synced', 'pnc.charger_enabled', 'pnc.certificate_deleted'].every((a) => audit.text.includes(a)), audit.status);
  const view = await fetch(`${API}/js/views/pnc.js`).then((r) => r.text());
  check('console: the Plug & Charge page is served', /registerView\('pnc'/.test(view));

  // ================================================================ Part B — sandbox
  for (const s of (await ops('GET', '/v1/sandboxes')).data.sandboxes ?? []) if (/E2E/.test(s.name)) await ops('DELETE', `/v1/sandboxes/${s.id}`);
  const sbx = await ops('POST', '/v1/sandboxes', { name: 'PnC E2E' });
  KEY = sbx.data.apiKey; sandboxId = sbx.data.id;
  const DC = sbx.data.chargePoints.find((c: any) => c.current === 'DC').identity as string;
  await until(() => sb('GET', '/v1/sandbox'), (r) => r.data.chargePoints?.find((c: any) => c.identity === DC)?.simulator?.online, 30_000, 1000);
  const early = await sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'plug-and-charge', emaid: 'ID-SBX-C12345678' });
  check('sandbox: before set-up, a Plug & Charge car is refused with what to do', early.status === 409 && /Plug & Charge is off|ISO15118PnCEnabled/.test(early.data.error), early.data);
  await sb('PUT', '/v1/pnc/settings', { enabled: true });
  await sb('POST', '/v1/pnc/trust-anchors/sync');
  await sb('POST', '/v1/pnc/contracts', { emaid: 'ID-SBX-C12345678', holderName: 'Sandbox driver' });
  const sEn = await sb('POST', `/v1/pnc/chargers/${DC}/enable`, { enabled: true });
  const sInst = await sb('POST', `/v1/pnc/chargers/${DC}/install-roots`, {});
  const sReq = await sb('POST', `/v1/pnc/chargers/${DC}/request-certificate`);
  const sRow = await until(() => sb('GET', '/v1/pnc/chargers'), (r) => r.data.chargers?.find((c: any) => c.ocpp_identity === DC)?.cert_state === 'delivered', 20_000, 700);
  const snap = await sb('GET', '/v1/sandbox');
  const simPnc = snap.data.chargePoints.find((c: any) => c.identity === DC)?.simulator?.pnc;
  check('sandbox: the virtual charger switched on, trust anchors installed, its V2G certificate signed and delivered (all over 1.6 DataTransfer)',
    sEn.data.charger === 'Accepted' && sInst.data.results?.every((r: any) => r.status === 'Accepted') && sReq.data.status === 'Accepted'
      && sRow.data.chargers.find((c: any) => c.ocpp_identity === DC)?.cert_state === 'delivered' && simPnc?.enabled && simPnc.certificate?.subject.includes(DC) && simPnc.roots.length >= 2,
    { sEn: sEn.data, sInst: sInst.data, sReq: sReq.data, simPnc });
  const car = await sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'plug-and-charge', emaid: 'ID-SBX-C12345678', kwh: 2 });
  const sSess = await until(async () => ((await sb('GET', `/v1/sessions?identity=${DC}`)).data ?? []).find?.((x: any) => x.total_minor != null), (x) => !!x, 60_000, 1500);
  check('sandbox: a simulated Plug & Charge car is authorised (Accepted / certificate Accepted) and its session rated',
    car.status === 200 && car.data.authorize?.idTokenInfo?.status === 'Accepted' && car.data.authorize.certificateStatus === 'Accepted' && sSess?.total_minor > 0, { car: car.data?.authorize ?? car.data, sSess });
  const unreg = await sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'plug-and-charge', emaid: 'ID-SBX-C99999999' });
  check('sandbox: a car with an unregistered contract is refused (Invalid / ContractCancelled)', unreg.data.authorize?.idTokenInfo?.status === 'Invalid' && unreg.data.authorize.certificateStatus === 'ContractCancelled', unreg.data.authorize);

  check('contract: live Plug & Charge responses match the published schemas', contract.length === 0, contract);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const r of raws) r.close();
  // Leave the tenant as it was: its test contracts cancelled, Plug & Charge back to its setting.
  for (const c of (await ops('GET', '/v1/pnc/contracts').catch(() => null))?.data?.contracts ?? []) if (/^IDE2E/.test(c.emaid) && c.status === 'Accepted') await ops('POST', `/v1/pnc/contracts/${c.id}/cancel`).catch(() => {});
  if (tenantSettings) await ops('PUT', '/v1/pnc/settings', tenantSettings).catch(() => {});
  if (sandboxId) await ops('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
