// PlugSure v1.3 — onboarding with automatic charger certificates, end to end.
//
// The gateway runs as it does behind Caddy: it trusts the proxy's
// X-Forwarded-Proto and X-Client-Cert-Fingerprint headers
// (OCPP_TRUST_PROXY_PROTO=true on the API and the gateway), so this test can
// open real Profile 2 and Profile 3 connections:
//
//   A. Hardware details entered, a key and certificate issued automatically by
//      PlugSure's CA, Profile 3 enforced; the charger connects with its
//      certificate; wrong, missing and plain-text connections refused.
//   B. The charger's own CSR signed (no key handed out); a CSR for another
//      identity refused.
//   C. Zero-touch over OCPP 1.6: connect on Profile 2 → PlugSure asks for a CSR
//      (ExtendedTriggerMessage) → SignCertificate → CertificateSigned →
//      SecurityProfile 3; the password no longer works, the certificate does.
//      Then a renewal: the old certificate keeps working until the new one is
//      used, then stops.
//   D. OCPP 2.0.1: SignCertificate(ChargingStationCertificate) → CertificateSigned.
//   E. The Onboarding page's data, the CA download, the published schemas.
//
//     npx tsx tools/e2e/onboarding-e2e.mts      (E2E_API / E2E_OCPP / E2E_PASSWORD override)
// NEVER point this at production.
import WebSocket from 'ws';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildCsr, name, splitPemChain } from '../../src/pnc/der.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: boolean[] = [];
const check = (label: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = () => new Date().toISOString();
const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, text: t, headers: r.headers };
}

/** A charger connecting through the TLS terminator: the headers are what Caddy sets. */
class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1' = 'ocpp1.6') {}
  /** Resolves 'open', or the HTTP status the gateway refused with. */
  connect(h: { tls?: boolean; certFp?: string; key?: string } = {}): Promise<'open' | number> {
    const headers: Record<string, string> = { 'x-forwarded-proto': h.tls === false ? 'http' : 'https' };
    if (h.certFp) headers['x-client-cert-fingerprint'] = h.certFp;
    if (h.key) headers.authorization = 'Basic ' + Buffer.from(`${this.id}:${h.key}`).toString('base64');
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version], { headers });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const handler = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (handler ? handler(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], desc: f[3] });
        this.pending.delete(f[1]);
      }
    });
    return new Promise((res) => {
      this.ws.once('open', () => res('open'));
      this.ws.once('unexpected-response', (_q: any, r: any) => res(r.statusCode));
      this.ws.once('error', () => res(0));
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
  async closed() { this.close(); await sleep(400); }
  boot() { return this.version === 'ocpp1.6'
    ? this.call('BootNotification', { chargePointVendor: 'E2E Hardware', chargePointModel: 'EH-60DC', chargePointSerialNumber: `SN-${this.id}`, firmwareVersion: '3.1.0' })
    : this.call('BootNotification', { reason: 'PowerUp', chargingStation: { model: 'EH-201', vendorName: 'E2E Hardware', firmwareVersion: '3.1.0' } }); }
}

const raws: Raw[] = [];
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
  const features = (await ops('GET', '/v1/meta')).data;
  const site = await ops('POST', '/v1/sites', { name: 'Onboarding E2E Hub', address: 'Jl. Gatot Subroto', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const ca = await ops('GET', '/v1/charger-ca');
  cc('/v1/charger-ca', 'get', '200', ca.data);
  const caX = new X509Certificate(ca.data.certificatePem);
  check('setup: signed in; the charging-station CA exists (a CA certificate, with the proxy settings)',
    login.status === 200 && site.status === 200 && caX.ca && ca.data.fingerprint === fp(ca.data.certificatePem) && /trusted_ca_cert_file/.test(ca.data.proxy.caddy), { ca: ca.data?.subject, features: features?.minSecurityProfile });
  const caPem = await ops('GET', '/v1/charger-ca/ca.pem');
  check('setup: the CA downloads as a PEM file', caPem.status === 200 && /attachment/.test(caPem.headers.get('content-disposition') ?? '') && caPem.text.trim() === ca.data.certificatePem.trim(), caPem.status);
  const sfx = Date.now().toString().slice(-6);
  const evses = [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }];
  const register = (id: string, v = 'ocpp1.6') => ops('POST', '/v1/charge-points', { ocppIdentity: id, siteId: site.data.id, displayName: `Onboarding ${id}`, vendor: 'E2E Hardware', model: 'EH-60DC', serial: `SN-${id}`, firmware: '3.0.0', ocppVersion: v, evses });

  // ================================================================ A. automatic certificate, key generated
  const A = `ONB-A-${sfx}`;
  const regA = await register(A);
  const detail = await ops('GET', `/v1/charge-points/${A}`);
  check('A: hardware details saved (manufacturer, model, serial, firmware)', regA.status === 200 && detail.data.vendor === 'E2E Hardware' && detail.data.model === 'EH-60DC' && detail.data.serial === `SN-${A}`, detail.data);
  const issued = await ops('POST', `/v1/charge-points/${A}/keys`, { profile: 3, method: 'auto', keyType: 'ec', days: 365 });
  cc('/v1/charge-points/{identity}/keys', 'post', '200', issued.data);
  const certA = issued.data.files?.['client.crt'];
  const xA = certA ? new X509Certificate(certA) : null;
  check('A: key and certificate issued automatically: CN = identity, signed by the CA, TLS client, 1 year; the key is returned once',
    issued.status === 200 && issued.data.source === 'plugsure_ca' && /BEGIN PRIVATE KEY/.test(issued.data.files['client.key']) && xA!.subject.includes(`CN=${A}`) && xA!.checkIssued(caX) && xA!.verify(caX.publicKey)
      && xA!.keyUsage?.includes('1.3.6.1.5.5.7.3.2') && issued.data.fingerprint === fp(certA) && Math.abs(new Date(issued.data.expiresAt).getTime() - Date.now() - 365 * 86_400_000) < 86_400_000
      && issued.data.files['ca.pem'].trim() === ca.data.certificatePem.trim() && issued.data.commissioning?.config?.securityProfile === 3, { st: issued.status, d: issued.data?.warning ?? issued.data });
  const profA = await ops('PUT', `/v1/charge-points/${A}/security-profile`, { profile: 3 });
  await ops('POST', `/v1/charge-points/${A}/activate`);
  check('A: Profile 3 enforced (a certificate is bound, TLS is available)', profA.status === 200, profA.data);
  const other = await ops('POST', `/v1/charge-points/${A}/keys`, { profile: 3, method: 'auto', keyType: 'rsa' }).then(async (r) => {
    // A second, different certificate (RSA) — then bind the first one back.
    const second = r.data.files['client.crt'];
    await ops('POST', `/v1/charge-points/${A}/keys`, { profile: 3, certificatePem: certA });
    return second as string;
  });
  const a1 = new Raw(A); raws.push(a1);
  const noTls = await a1.connect({ tls: false, certFp: fp(certA) });
  const noCert = await new Raw(A).connect({});
  const wrong = await new Raw(A).connect({ certFp: fp(other) });
  const pw = await new Raw(A).connect({ key: 'NotACertificate1234567890' });
  check('A: refused without TLS, without a certificate, with another certificate, and with a password', noTls !== 'open' && noCert === 401 && wrong === 401 && pw === 401, { noTls, noCert, wrong, pw });
  const okA = await a1.connect({ certFp: fp(certA) });
  const bootA = okA === 'open' ? await a1.boot() : null;
  const statusA = await until(() => ops('GET', `/v1/charge-points/${A}/commissioning`), (r) => r.data.adopted === true, 15_000);
  cc('/v1/charge-points/{identity}/commissioning', 'get', '200', statusA.data);
  check('A: the charger connects with its certificate over mutual TLS; hardware connected and adopted, Profile 3 with the certificate',
    okA === 'open' && bootA?.status === 'Accepted' && statusA.data.adopted && statusA.data.security?.profile === 3 && statusA.data.security.certificate?.source === 'external', { okA, bootA, sec: statusA.data.security });

  // ================================================================ B. the charger's own CSR
  const B = `ONB-B-${sfx}`;
  await register(B);
  const kB = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const csrB = buildCsr(name([['C', 'ID'], ['O', 'E2E Hardware'], ['CN', B]]), kB);
  const sB = await ops('POST', `/v1/charge-points/${B}/keys`, { profile: 3, method: 'csr', csr: csrB });
  const xB = sB.data.files ? new X509Certificate(sB.data.files['client.crt']) : null;
  const wrongCn = await ops('POST', `/v1/charge-points/${B}/keys`, { profile: 3, method: 'csr', csr: buildCsr(name([['CN', 'SOMEONE-ELSE']]), kB) });
  const garbage = await ops('POST', `/v1/charge-points/${B}/keys`, { profile: 3, method: 'csr', csr: '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----' });
  check('B: the charger\'s CSR signed for its own key — no key handed out; a CSR for another identity or a broken one refused (422)',
    sB.status === 200 && sB.data.source === 'plugsure_ca_csr' && !sB.data.files['client.key'] && xB!.publicKey.export({ type: 'spki', format: 'der' }).equals(kB.publicKey.export({ type: 'spki', format: 'der' }))
      && wrongCn.status === 422 && /not for/.test(wrongCn.data.error) && garbage.status === 422, { sB: sB.status, wrongCn: wrongCn.data, garbage: garbage.status });

  // ================================================================ C. zero-touch over OCPP 1.6
  const C = `ONB-C-${sfx}`;
  await register(C);
  const keyC = await ops('POST', `/v1/charge-points/${C}/keys`, { profile: 2, autoCertificate: true });
  await ops('PUT', `/v1/charge-points/${C}/security-profile`, { profile: 2 });
  await ops('POST', `/v1/charge-points/${C}/activate`);
  const c1 = new Raw(C); raws.push(c1);
  let keyPairC = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const installedC: string[] = [];
  const behave = (r: Raw) => {
    r.handlers.ExtendedTriggerMessage = (p) => {
      if (p.requestedMessage === 'SignChargePointCertificate') {
        setTimeout(() => void r.call('SignCertificate', { csr: buildCsr(name([['C', 'ID'], ['O', 'E2E Hardware'], ['CN', C]]), keyPairC) }).then((a) => r.calls.push({ action: '_SignAnswer', payload: a, at: Date.now() })), 100);
      }
      return { status: 'Accepted' };
    };
    r.handlers.CertificateSigned = (p) => {
      const leaf = splitPemChain(p.certificateChain)[0]!;
      const mine = new X509Certificate(leaf).publicKey.export({ type: 'spki', format: 'der' }).equals(keyPairC.publicKey.export({ type: 'spki', format: 'der' }));
      if (mine) installedC.push(leaf);
      return { status: mine ? 'Accepted' : 'Rejected' };
    };
  };
  behave(c1);
  const t0 = Date.now();
  const openC = await c1.connect({ key: keyC.data.key });
  await c1.boot();
  const trig = await c1.waitFor('ExtendedTriggerMessage', t0, (p) => p.requestedMessage === 'SignChargePointCertificate');
  const signAns = await c1.waitFor('_SignAnswer', t0);
  const signed = await c1.waitFor('CertificateSigned', t0);
  const raise = await c1.waitFor('ChangeConfiguration', t0, (p) => p.key === 'SecurityProfile');
  check('C: connected on Profile 2 with its key; PlugSure asked for a CSR (ExtendedTriggerMessage), accepted it and installed the certificate (CertificateSigned)',
    keyC.status === 200 && openC === 'open' && !!trig && signAns?.payload.status === 'Accepted' && !!signed && installedC.length === 1, { openC, sign: signAns?.payload });
  const leafC = installedC[0]!;
  const xC = new X509Certificate(leafC);
  const cpC = await until(() => ops('GET', `/v1/charge-points/${C}/commissioning`), (r) => r.data.security?.profile === 3, 15_000);
  check('C: the certificate is for this charger, from the CA; SecurityProfile 3 set on the charger and enforced',
    xC.subject.includes(`CN=${C}`) && xC.checkIssued(caX) && raise?.payload.value === '3' && cpC.data.security.profile === 3 && cpC.data.security.certAutoUpgrade === false && cpC.data.security.certificate?.source === 'ocpp_csr', { sec: cpC.data.security, raise: raise?.payload });
  await c1.closed();
  const c2 = new Raw(C); raws.push(c2); behave(c2);
  const byPassword = await new Raw(C).connect({ key: keyC.data.key });
  const byCert = await c2.connect({ certFp: fp(leafC) });
  check('C: after the switch the password no longer works; the certificate does', byPassword === 401 && byCert === 'open', { byPassword, byCert });
  await c2.boot();

  // Renewal over OCPP: the old certificate works until the new one is used.
  const oldC = leafC;
  keyPairC = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const t1 = Date.now();
  const renew = await ops('POST', `/v1/charge-points/${C}/certificate/request`);
  const signed2 = await c2.waitFor('CertificateSigned', t1);
  await until(async () => installedC.length, (n) => n === 2, 10_000);
  const newC = installedC[1]!;
  await sleep(500);
  const certs = await ops('GET', '/v1/station-certificates');
  cc('/v1/station-certificates', 'get', '200', certs.data);
  const rowC = certs.data.certificates?.find((x: any) => x.ocpp_identity === C);
  check('renewal: requested from the console; a new certificate installed; the charger is shown mid-change',
    renew.data.status === 'Accepted' && !!signed2 && fp(newC) !== fp(oldC) && rowC?.rotating === true && rowC.source === 'ocpp_csr', { renew: renew.data, rowC });
  await c2.closed();
  const withOld = await new Raw(C).connect({ certFp: fp(oldC) });
  await sleep(300);
  const c3 = new Raw(C); raws.push(c3);
  const withNew = await c3.connect({ certFp: fp(newC) });
  await c3.closed();
  const oldAfter = await new Raw(C).connect({ certFp: fp(oldC) });
  check('renewal: the old certificate still works until the new one is used; then only the new one does', withOld === 'open' && withNew === 'open' && oldAfter === 401, { withOld, withNew, oldAfter });
  // Back online with its new certificate, as the charger would be.
  const c4 = new Raw(C); raws.push(c4);
  await c4.connect({ certFp: fp(newC) });
  await c4.boot();

  // ================================================================ D. OCPP 2.0.1 station
  // A station certificate is only signed over an authenticated (Profile 2+) connection, and only when PlugSure asked
  // for it: an unsolicited CSR is refused even from the right charger.
  const D = `ONB-D-${sfx}`;
  await register(D, 'ocpp2.0.1');
  const keyD = await ops('POST', `/v1/charge-points/${D}/keys`, { profile: 2 });
  await ops('PUT', `/v1/charge-points/${D}/security-profile`, { profile: 2 });
  await ops('POST', `/v1/charge-points/${D}/activate`);
  const d1 = new Raw(D, 'ocpp2.0.1'); raws.push(d1);
  await d1.connect({ key: keyD.data.key });
  await d1.boot();
  const kD = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const unsolicited = await d1.call('SignCertificate', { csr: buildCsr(name([['CN', D], ['O', 'E2E Hardware']]), kD), certificateType: 'ChargingStationCertificate' });
  check('D: an unsolicited 2.0.1 SignCertificate is Rejected (NotAllowed): PlugSure signs only what it asked for',
    unsolicited.status === 'Rejected' && unsolicited.statusInfo?.reasonCode === 'NotAllowed', unsolicited);
  const t3 = Date.now();
  const trigD = await ops('POST', `/v1/charge-points/${D}/certificate/request`);
  const tmD = await d1.waitFor('TriggerMessage', t3);
  check('D: a certificate request to a 2.0.1 station is TriggerMessage(SignChargingStationCertificate)', trigD.status === 200 && tmD?.payload.requestedMessage === 'SignChargingStationCertificate', tmD?.payload);
  const badD = await d1.call('SignCertificate', { csr: buildCsr(name([['CN', 'NOT-ME']]), kD) });
  const t2 = Date.now();
  const sD = await d1.call('SignCertificate', { csr: buildCsr(name([['CN', D], ['O', 'E2E Hardware']]), kD), certificateType: 'ChargingStationCertificate' });
  const csD = await d1.waitFor('CertificateSigned', t2);
  check('D: the requested 2.0.1 SignCertificate(ChargingStationCertificate) accepted and answered with CertificateSigned; a CSR for another identity Rejected',
    sD.status === 'Accepted' && csD?.payload.certificateType === 'ChargingStationCertificate' && new X509Certificate(splitPemChain(csD.payload.certificateChain)[0]!).subject.includes(`CN=${D}`) && badD.status === 'Rejected', { sD, badD, cs: csD?.payload?.certificateType });

  // ================================================================ E. Onboarding page data, audit, console
  const onb = await ops('GET', '/v1/onboarding');
  cc('/v1/onboarding', 'get', '200', onb.data);
  const stageOf = (id: string) => onb.data.chargers?.find((x: any) => x.ocpp_identity === id)?.stage;
  check('onboarding: the new chargers are listed with where each one is', stageOf(A) === 'connected' && stageOf(C) === 'connected' && ['waiting', 'registered'].includes(stageOf(B)) && onb.data.counts.total >= 4, onb.data.chargers?.filter((x: any) => [A, B, C, D].includes(x.ocpp_identity)).map((x: any) => [x.ocpp_identity, x.stage]));
  const audit = await ops('GET', '/v1/audit?limit=150');
  check('audit: certificates issued (onboarding and OCPP), requested, and the profile change are recorded',
    ['charge_point.client_cert.issued', 'charge_point.client_cert.requested', 'charge_point.security_profile.changed'].every((a) => audit.text.includes(a)), audit.status);
  const views = await Promise.all(['onboarding.js', 'onboard.js'].map((f) => fetch(`${API}/js/views/${f}`).then((r) => r.text())));
  check('console: the Onboarding page and the wizard with automatic certificates are served', /registerView\('onboarding'/.test(views[0]!) && /Issue automatically/.test(views[1]!));
  check('contract: live onboarding responses match the published schemas', contract.length === 0, contract);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const r of raws) r.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
