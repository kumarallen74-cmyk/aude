// PlugSure v1.3 — fleet monthly statements, B2B invoices and e-Faktur, end to end.
//
// Runs inside a developer sandbox, so the sessions are real OCPP sessions on
// virtual chargers, rated by the production engine. Two fleet accounts charge at
// two sites (with different PBJT-TL rates); the month is moved back so it can be
// invoiced; then: invoices issued and numbered, the arithmetic checked against
// the session receipts, the e-Faktur XML checked against the invoices, the
// invoice e-mailed to a local SMTP server, a void and re-issue without double
// billing, payment, and the live responses validated against the published API
// document.
//
// Needs E2E_DATABASE_URL (the runtime role) to move the sessions into last month.
//
//     npx tsx tools/e2e/fleet-billing-e2e.mts
//
// NEVER point this at production.
import net from 'node:net';
import { inflateSync } from 'node:zlib';
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
/** The text a PDF shows (this CSMS writes plain Flate streams of literal strings). */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const page = inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1');
    for (const t of page.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)) out.push(t[1]!.replace(/\\([0-7]{3}|.)/g, (_x, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)));
  }
  return out.join('\n');
}
/** A credit amount (PPN included) that splits exactly: price ase, DPP 11/12 of it, PPN 12% of the DPP. */
const taxed = (base: number) => { const dpp = Math.round((base * 11) / 12); const ppn = Math.round((dpp * 1200) / 10000); return { base, dpp, ppn, amount: base + ppn }; };
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
const sb = (method: string, path: string, body?: unknown) => http(method, path, body, { authorization: `Bearer ${KEY}` });

// ------------------------------------------------------------ a local SMTP server
const mails: Array<{ to: string[]; raw: string }> = [];
const smtp = net.createServer((sock) => {
  let buf = ''; let inData = false; let to: string[] = [];
  sock.write('220 fake-smtp ready\r\n');
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
        mails.push({ to, raw: buf.slice(0, end) }); buf = buf.slice(end + 5); inData = false; to = [];
        sock.write('250 2.0.0 queued\r\n'); continue;
      }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-smtp\r\n250 8BITMIME\r\n');
      else if (cmd === 'RCPT') { to.push(/<([^>]+)>/.exec(line)?.[1] ?? ''); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
      else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => {});
});
await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));

const pg = process.env.E2E_DATABASE_URL ? new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL }) : null;
if (pg) await pg.connect();
let sandboxId = '';

try {
  if (!pg) throw new Error('set E2E_DATABASE_URL (the runtime role) — the test moves its sessions into last month');
  const spec = (await http('GET', '/openapi.json')).data;
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  ajv.addFormat('binary', true);
  ajv.addSchema({ $id: 'spec', components: spec.components });
  const conforms = (path: string, method: string, status: string, body: unknown) => {
    const s = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
    if (!s) return [`no documented ${status} schema for ${method} ${path}`];
    const v = ajv.compile(JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"spec#/components/')));
    return v(body) ? null : v.errors.slice(0, 3).map((e: any) => `${e.instancePath} ${e.message}`);
  };
  const contract: string[] = [];
  const cc = (path: string, method: string, status: string, body: unknown) => { const e = conforms(path, method, status, body); if (e) contract.push(`${method} ${path}: ${e.join('; ')}`); };

  // ------------------------------------------------------------ a sandbox to bill in
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  for (const s of (await ops('GET', '/v1/sandboxes')).data.sandboxes ?? []) if (/E2E/.test(s.name)) await ops('DELETE', `/v1/sandboxes/${s.id}`);
  const sbx = await ops('POST', '/v1/sandboxes', { name: 'Fleet billing E2E' });
  KEY = sbx.data.apiKey; sandboxId = sbx.data.id;
  const DC = sbx.data.chargePoints.find((c: any) => c.current === 'DC').identity as string;
  check('setup: operator creates a sandbox (virtual chargers, PKP seller)', login.status === 200 && sbx.status === 201, sbx.data);

  // ------------------------------------------------------------ accounts
  const accts = await sb('GET', '/v1/fleet-accounts');
  cc('/v1/fleet-accounts', 'get', '200', accts.data);
  const logistik = accts.data.accounts?.find((a: any) => a.name === 'Sandbox Logistik');
  check('accounts: a card\'s fleet name creates and links its fleet account (database trigger)', logistik?.cards === 1, accts.data);
  const upd = await sb('PUT', `/v1/fleet-accounts/${logistik.id}`, {
    legalName: 'PT Sandbox Logistik Indonesia', taxIdKind: 'TIN', taxId: '01.234.567.8-901.000', address: 'Jl. Gatot Subroto Kav. 12, Jakarta Selatan',
    billingEmail: 'ap@logistik.test, finance@logistik.test', paymentTermsDays: 30, contactName: 'Ibu Sari',
  });
  cc('/v1/fleet-accounts/{id}', 'put', '200', upd.data);
  check('accounts: legal and tax details saved; a 15-digit NPWP is stored in the 16-digit form', upd.status === 200 && upd.data.tax_id === '0012345678901000' && upd.data.payment_terms_days === 30, upd.data);
  const badNpwp = await sb('PUT', `/v1/fleet-accounts/${logistik.id}`, { taxIdKind: 'TIN', taxId: '12345' });
  check('accounts: an invalid NPWP is refused (422)', badNpwp.status === 422, badNpwp.data);
  const dua = await sb('POST', '/v1/fleet-accounts', { name: 'PT Armada Dua', billingEmail: 'billing@armadadua.test', paymentTermsDays: 14 });
  const moved = await sb('PUT', `/v1/fleet-accounts/${dua.data.id}/cards`, { add: ['SANDBOX-RFID-0001', 'NOPE-404'] });
  check('accounts: a second account; a card moved onto it (unknown UIDs reported)',
    dua.status === 201 && moved.data.account?.cards?.some((c: any) => c.uid === 'SANDBOX-RFID-0001') && moved.data.unknown?.[0] === 'NOPE-404', moved.data);
  const dupe = await sb('POST', '/v1/fleet-accounts', { name: 'PT Armada Dua' });
  check('accounts: duplicate name refused (409)', dupe.status === 409, dupe.data);
  const tok = await sb('POST', '/v1/tokens', { uid: `FLT-NEW-${Date.now().toString().slice(-6)}`, holderName: 'Driver Baru', accountType: 'fleet', fleetName: 'PT Baru Sejahtera' });
  const withNew = await sb('GET', '/v1/fleet-accounts');
  check('accounts: a card issued in the RFID centre with a new fleet name creates that account', tok.status === 200 && withNew.data.accounts.some((a: any) => a.name === 'PT Baru Sejahtera' && a.cards === 1), tok.data);

  // ------------------------------------------------------------ a second site with a different PBJT rate, and a charger there
  const site2 = await sb('POST', '/v1/sites', {
    name: 'Sandbox Hub — Bekasi', address: 'Jl. Ahmad Yani, Bekasi', kabupatenKotaCode: '3275', lat: '-6.2383', lon: '106.9756',
    gridTariffGroup: 'L/TR', connectedKva: '105', powerFactor: '0.95', phases: '3', pbjtRateBps: '500',
  });
  const B = `SBX-BKS-${Date.now().toString().slice(-5)}`;
  await sb('POST', '/v1/charge-points', {
    ocppIdentity: B, siteId: site2.data.id, displayName: 'Bekasi DC', ocppVersion: 'ocpp1.6',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }],
  });
  await sb('POST', `/v1/charge-points/${B}/activate`);
  const up = await until(() => sb('GET', '/v1/charge-points'), (r) => Array.isArray(r.data) && [DC, B].every((id) => r.data.find((c: any) => c.ocpp_identity === id)?.online), 45_000, 1000);
  check('setup: a second site (PBJT 5%) with a virtual charger online', site2.status === 200 && [DC, B].every((id) => up.data.find((c: any) => c.ocpp_identity === id)?.online), site2.data);

  // ------------------------------------------------------------ charging
  const taps: Array<[string, number, string, number]> = [
    [DC, 1, 'SANDBOX-FLEET-0002', 2], [DC, 2, 'SANDBOX-RFID-0001', 1.5], [B, 1, 'SANDBOX-FLEET-0002', 1.2],
  ];
  for (const [cp, conn, card, kwh] of taps) {
    await until(() => sb('POST', `/v1/sandbox/chargers/${cp}/simulate`, { event: 'tap-card', connectorId: conn, idTag: card, kwh }), (r) => r.status === 200, 30_000, 1500);
    if (cp === DC && conn === 1) await until(() => sb('GET', `/v1/sessions?identity=${DC}`), (r) => r.data.some?.((s: any) => s.id_tag === card && s.ended_at), 40_000, 1000);
  }
  const rated = await until(async () => {
    const a = (await sb('GET', `/v1/sessions?identity=${DC}`)).data;
    const b = (await sb('GET', `/v1/sessions?identity=${B}`)).data;
    return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  }, (l) => l.length === 3 && l.every((s: any) => s.ended_at && s.total_idr != null), 60_000, 1500);
  check('charging: three fleet sessions at two sites, rated with receipts', rated.length === 3 && rated.every((s: any) => s.total_idr > 0), rated.map((s: any) => [s.id_tag, s.energy_wh, s.total_idr]));
  const receiptTotal = (card: string) => rated.filter((s: any) => s.id_tag === card).reduce((a: number, s: any) => a + s.total_idr, 0);

  // ------------------------------------------------------------ this month: drafts only
  const cur = (await sb('GET', '/v1/fleet-billing/periods/2000-01')).data.current as string;
  const now = await sb('GET', `/v1/fleet-billing/periods/${cur}`);
  cc('/v1/fleet-billing/periods/{period}', 'get', '200', now.data);
  const early = await sb('POST', '/v1/fleet-invoices', { fleetAccountId: logistik.id, period: cur });
  check('this month: drafts for both accounts; invoicing refused until the month has ended (409)',
    now.data.rows?.filter((r: any) => r.status === 'draft').length === 2 && !now.data.ended && early.status === 409, { rows: now.data.rows, early: early.data });

  // ------------------------------------------------------------ move the sessions into last month
  const [y, m] = cur.split('-').map(Number);
  const prev = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
  await pg.query(
    `UPDATE cdr SET issued_at = ((date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '5 days') AT TIME ZONE 'Asia/Jakarta') WHERE org_id = $1`,
    [sandboxId],
  );
  const draft = await sb('GET', `/v1/fleet-accounts/${logistik.id}/statement?period=${prev}`);
  cc('/v1/fleet-accounts/{id}/statement', 'get', '200', draft.data);
  const t = draft.data.totals;
  const lines = draft.data.sites ?? [];
  const lineOk = lines.every((l: any) => l.dppIdr === Math.round((l.taxBaseIdr * 11) / 12) && l.ppnIdr === Math.round((l.dppIdr * 1200) / 10000) && l.totalIdr === l.subtotalIdr + l.pbjtIdr + l.ppnIdr);
  check(`statement: one line per site (${lines.length}); DPP = 11/12 of the price, PPN = 12% of DPP, per line`,
    draft.status === 200 && lines.length === 2 && lineOk && t.totalIdr === t.subtotalIdr + t.pbjtIdr + t.ppnIdr, draft.data.sites);
  check(`statement: agrees with the session receipts (${t.receiptsTotalIdr}) within rounding (${t.roundingIdr})`,
    t.receiptsTotalIdr === receiptTotal('SANDBOX-FLEET-0002') && Math.abs(t.roundingIdr) <= t.sessions && t.sessions === 2, t);
  check('statement: the two sites carry their own PBJT-TL rates (10% and 5%)',
    lines.find((l: any) => /Bekasi/.test(l.siteName))?.pbjtIdr < lines.find((l: any) => !/Bekasi/.test(l.siteName))?.pbjtIdr * 1.2 && lines.every((l: any) => l.pbjtIdr > 0), lines.map((l: any) => [l.siteName, l.subtotalIdr, l.pbjtIdr]));
  const draftHtml = await sb('GET', `/v1/fleet-accounts/${logistik.id}/statement.html?period=${prev}`);
  check('statement: printable draft', draftHtml.status === 200 && /Fleet statement \(draft\)/.test(draftHtml.text) && /DPP nilai lain/.test(draftHtml.text), draftHtml.status);

  // ------------------------------------------------------------ e-Faktur settings gate
  const gate1 = await sb('GET', `/v1/fleet-billing/periods/${prev}/efaktur.xml`);
  const setA = await sb('PUT', '/v1/fleet-billing/settings', {
    npwp: '0987654321098765', nitku: '0987654321098765000000', address: 'Jl. H.R. Rasuna Said Kav. 1, Jakarta Selatan', prefix: 'SBX',
    paymentInstructions: 'Transfer ke BCA 123-456-7890 a.n. PT Sandbox Charge', efaktur: { itemOpt: 'A', itemCode: '000000', unitCode: 'UM.0033' },
  });
  const gate2 = await sb('GET', `/v1/fleet-billing/periods/${prev}/efaktur.xml`);
  const setB = await sb('PUT', '/v1/fleet-billing/settings', { efaktur: { confirmed: true } });
  cc('/v1/fleet-billing/settings', 'put', '200', setB.data);
  check('e-Faktur: export refused until seller NPWP/NITKU and the item settings are saved and confirmed',
    gate1.status === 409 && /NPWP/.test(gate1.data.error) && setA.status === 200 && gate2.status === 409 && /Confirm/.test(gate2.data.error) && setB.data.efakturReady === null,
    { g1: gate1.data, g2: gate2.data, ready: setB.data.efakturReady });

  // ------------------------------------------------------------ issue
  const all = await sb('POST', `/v1/fleet-billing/periods/${prev}/issue`);
  cc('/v1/fleet-billing/periods/{period}/issue', 'post', '200', all.data);
  const [iy, im] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  check('issue: both accounts invoiced, numbered PREFIX/YYYY/MM/NNNN in sequence',
    all.data.issued?.length === 2 && all.data.issued.every((i: any) => new RegExp(`^SBX/${iy}/${im}/000[12]$`).test(i.number)), all.data);
  const again = await sb('POST', '/v1/fleet-invoices', { fleetAccountId: logistik.id, period: prev });
  check('issue: a second invoice for the same account and month is refused (409)', again.status === 409, again.data);
  const month = await sb('GET', `/v1/fleet-billing/periods/${prev}`);
  const rowL = month.data.rows.find((r: any) => r.accountId === logistik.id);
  const inv = await sb('GET', `/v1/fleet-invoices/${rowL.invoiceId}`);
  cc('/v1/fleet-invoices/{id}', 'get', '200', inv.data);
  const due = new Date(`${inv.data.issuedDate}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + 30);
  check('invoice: frozen with the draft\'s figures, buyer NPWP, and due after the 30-day terms',
    inv.data.status === 'issued' && inv.data.totals.totalIdr === t.totalIdr && inv.data.buyer.taxId === '0012345678901000' && inv.data.dueDate === due.toISOString().slice(0, 10),
    { st: inv.data.status, tot: inv.data.totals?.totalIdr, due: inv.data.dueDate });
  const html = await sb('GET', `/v1/fleet-invoices/${rowL.invoiceId}/invoice.html`);
  const csv = await sb('GET', `/v1/fleet-invoices/${rowL.invoiceId}/invoice.csv`);
  check('invoice: printable invoice (number, seller and buyer NPWP, DPP/PPN, payment instructions) and a session CSV',
    html.status === 200 && html.text.includes(inv.data.number) && html.text.includes('0987654321098765') && html.text.includes('0012345678901000') && /PPN 12% × DPP/.test(html.text) && /BCA 123-456-7890/.test(html.text)
      && csv.status === 200 && csv.text.trim().split('\r\n').length === 1 + 2, { h: html.status, lines: csv.text.split('\r\n').length });
  const list = await sb('GET', '/v1/fleet-invoices');
  cc('/v1/fleet-invoices', 'get', '200', list.data);

  // ------------------------------------------------------------ e-Faktur
  const ef = await sb('GET', `/v1/fleet-billing/periods/${prev}/efaktur.xml`);
  const skipped = JSON.parse(decodeURIComponent(ef.headers.get('x-plugsure-skipped') ?? '%5B%5D'));
  const invDua = month.data.rows.find((r: any) => r.accountId === dua.data.id);
  const xml = ef.text;
  const vat = [...xml.matchAll(/<VAT>(\d+)<\/VAT>/g)].reduce((a, x) => a + Number(x[1]), 0);
  const otb = [...xml.matchAll(/<OtherTaxBase>(\d+)<\/OtherTaxBase>/g)].reduce((a, x) => a + Number(x[1]), 0);
  check('e-Faktur: one faktur (code 04) for the account with an NPWP; the one without is skipped with the reason',
    ef.status === 200 && (xml.match(/<TaxInvoice>/g) ?? []).length === 1 && /<TrxCode>04<\/TrxCode>/.test(xml) && /<TIN>0987654321098765<\/TIN>/.test(xml)
      && /<BuyerTin>0012345678901000<\/BuyerTin>/.test(xml) && skipped.some((s: any) => s.number === invDua.number && /NPWP/.test(s.reason)), { s: ef.status, skipped });
  check('e-Faktur: the XML carries exactly the invoice\'s DPP and PPN, one line per site',
    vat === inv.data.totals.ppnIdr && otb === inv.data.totals.dppIdr && (xml.match(/<GoodService>/g) ?? []).length === 2 && new RegExp(`<RefDesc>${inv.data.number.replace(/\//g, '\\/')}</RefDesc>`).test(xml), { vat, otb, t: inv.data.totals });

  // ------------------------------------------------------------ e-mail
  await sb('PUT', '/v1/alert-routing/channels/email', { enabled: true, config: { host: '127.0.0.1', port: (smtp.address() as any).port, security: 'none', fromAddress: 'billing@sandbox.test', fromName: 'Sandbox Charge' } });
  const sent = await sb('POST', `/v1/fleet-invoices/${rowL.invoiceId}/send`);
  const mail = await until(async () => mails.find((x) => x.to.includes('ap@logistik.test')), (v) => !!v, 10_000);
  check('e-mail: sent to both billing addresses with the invoice (PDF) and session list (CSV) attached',
    sent.status === 200 && !!mail && mail.to.includes('finance@logistik.test') && mail.raw.includes(`filename=${inv.data.number.replace(/\//g, '_')}.pdf`) && /-sessions\.csv/.test(mail.raw)
      && /Content-Type: text\/csv/i.test(mail.raw) && /Content-Type: application\/pdf/i.test(mail.raw),
    { s: sent.data, to: mail?.to, headers: mail?.raw.split('\r\n').filter((l) => /filename|Content-Type/i.test(l)).slice(0, 12) });

  // ------------------------------------------------------------ void and re-issue, payment
  const vd = await sb('POST', `/v1/fleet-invoices/${rowL.invoiceId}/void`, { reason: 'Legal name corrected' });
  const redraft = await sb('GET', `/v1/fleet-accounts/${logistik.id}/statement?period=${prev}`);
  check('void: the invoice keeps its number; a faktur warning (it was exported); its sessions return to the draft',
    vd.status === 200 && vd.data.invoice.status === 'void' && /Coretax/.test(vd.data.fakturWarning ?? '') && redraft.data.status === 'draft' && redraft.data.totals.totalIdr === t.totalIdr, vd.data);
  const re = await sb('POST', '/v1/fleet-invoices', { fleetAccountId: logistik.id, period: prev });
  check('re-issue: a new number, the same charges, nothing billed twice',
    re.status === 201 && /0003$/.test(re.data.number) && re.data.totals.totalIdr === t.totalIdr && re.data.sessions.length === 2, re.data?.number);
  const paid = await sb('POST', `/v1/fleet-invoices/${invDua.invoiceId}/pay`, { paidAt: '2026-10-20', reference: 'BCA 2026102012345' });
  const voidPaid = await sb('POST', `/v1/fleet-invoices/${invDua.invoiceId}/void`, { reason: 'test' });
  check('payment: recorded; a paid invoice cannot be voided (409)', paid.data.status === 'paid' && paid.data.paidReference === 'BCA 2026102012345' && voidPaid.status === 409, { p: paid.data.status, v: voidPaid.status });
  const fk = await sb('PUT', `/v1/fleet-invoices/${re.data.id}/faktur-number`, { number: '04002600000012345' });
  const html2 = await sb('GET', `/v1/fleet-invoices/${re.data.id}/invoice.html`);
  check('faktur number: recorded from Coretax and printed on the invoice', fk.data.efakturNumber === '04002600000012345' && html2.text.includes('04002600000012345'));
  const items = await pg.query(`SELECT count(*)::int AS n FROM fleet_invoice_item WHERE org_id = $1`, [sandboxId]);
  check('no double billing: every session is on exactly one live invoice', items.rows[0].n === 3, items.rows[0]);
  const final = await sb('GET', `/v1/fleet-billing/periods/${prev}`);
  check('month: both accounts invoiced (one paid), nothing left in draft',
    final.data.rows.length === 2 && final.data.rows.every((r: any) => r.status !== 'draft') && final.data.rows.some((r: any) => r.status === 'paid'), final.data.rows);
  // ------------------------------------------------------------ PDF documents
  const pdfGet = async (path: string, headers: Record<string, string>) => {
    const r = await fetch(API + path, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') ?? '', buf, text: pdfText(buf) };
  };
  const auth = { authorization: `Bearer ${KEY}` };
  const pdf1 = await pdfGet(`/v1/fleet-invoices/${re.data.id}/invoice.pdf`, auth);
  check('PDF: the invoice as a PDF (number, both NPWPs, per-site lines, payment instructions, the session appendix)',
    pdf1.status === 200 && /application\/pdf/.test(pdf1.type) && pdf1.buf.subarray(0, 5).toString() === '%PDF-' && pdf1.text.includes(`No. ${re.data.number}`)
      && pdf1.text.includes('NPWP 0987654321098765') && pdf1.text.includes('NPWP 0012345678901000') && /Bekasi/.test(pdf1.text) && /BCA 123-456-7890/.test(pdf1.text)
      && /APPENDIX/.test(pdf1.text) && pdf1.text.includes('Faktur pajak: 04002600000012345'), { s: pdf1.status, t: pdf1.type, sample: pdf1.text.slice(0, 300) });
  const pdfDraft = await pdfGet(`/v1/fleet-accounts/${logistik.id}/statement.pdf?period=${cur}`, auth);
  check('PDF: this month\'s draft statement, marked as a draft', pdfDraft.status === 200 && /Draft \x97 not an invoice/.test(pdfDraft.text), pdfDraft.status);

  // ------------------------------------------------------------ credit notes
  const total = re.data.totals.totalIdr as number;
  const tooMuch = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Too much', lines: [{ description: 'More than the invoice', amountIdr: total + 1 }] });
  const noReason = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { lines: [{ description: 'No reason given', amountIdr: 1000 }] });
  const onVoid = await sb('POST', `/v1/fleet-invoices/${rowL.invoiceId}/credit-notes`, { reason: 'On a void invoice', full: true });
  const untaxed = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Dodging PPN', lines: [{ description: 'Half without PPN', amountIdr: Math.round(total / 2), taxed: false }] });
  check('credit: refused — more than the invoice, no reason, a void invoice, and an untaxed credit beyond the untaxed part of the invoice',
    tooMuch.status === 422 && noReason.status === 422 && onVoid.status === 409 && untaxed.status === 422 && /PPN/.test(untaxed.data.error), { tooMuch: tooMuch.data, noReason: noReason.data, onVoid: onVoid.data, untaxed: untaxed.data });
  const k1 = taxed(Math.floor(total / 5));
  const cn1 = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Session at Bekasi billed twice', lines: [{ description: 'Duplicate session, Bekasi DC', amountIdr: k1.amount }] });
  cc('/v1/fleet-invoices/{id}/credit-notes', 'post', '201', cn1.data);
  const c1 = cn1.data.creditNote;
  const [cy, cm] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  check(`credit: a partial credit on the unpaid invoice — numbered PREFIX-CN/YYYY/MM/0001, Rp ${k1.amount} split into price ${k1.base}, DPP ${k1.dpp} (11/12), PPN ${k1.ppn} (12%); settled on the invoice`,
    cn1.status === 201 && c1.number === `SBX-CN/${cy}/${cm}/0001` && c1.totalIdr === k1.amount && c1.dppIdr === k1.dpp && c1.ppnIdr === k1.ppn && c1.lines[0].taxBaseIdr === k1.base && c1.settlement === 'invoice' && cn1.data.settledInvoice === false,
    cn1.data);
  check('credit: a faktur warning, since the invoice\'s faktur pajak was recorded (nota pembatalan in Coretax)', /nota pembatalan/.test(cn1.data.fakturWarning ?? ''), cn1.data.fakturWarning);
  const afterCn = await sb('GET', `/v1/fleet-invoices/${re.data.id}`);
  cc('/v1/fleet-invoices/{id}', 'get', '200', afterCn.data);
  check('credit: the invoice itself is unchanged; what is owed drops by the credit', afterCn.data.totals.totalIdr === total && afterCn.data.creditedIdr === k1.amount && afterCn.data.balanceIdr === total - k1.amount && afterCn.data.creditNotes?.length === 1, { c: afterCn.data.creditedIdr, b: afterCn.data.balanceIdr });
  const pdfCn = await pdfGet(`/v1/fleet-credit-notes/${c1.id}/credit-note.pdf`, auth);
  const pdfInv2 = await pdfGet(`/v1/fleet-invoices/${re.data.id}/invoice.pdf`, auth);
  const due1 = `Rp ${new Intl.NumberFormat('id-ID').format(total - k1.amount)}`;
  check('PDF: the credit note (what it credits, reason, DPP and PPN, how it is settled) and the invoice showing the credit and the amount due',
    pdfCn.status === 200 && pdfCn.text.includes(`No. ${c1.number}`) && pdfCn.text.includes(`credits invoice ${re.data.number}`) && /Session at Bekasi billed twice/.test(pdfCn.text)
      && /reduces the amount due on invoice/.test(pdfCn.text) && pdfInv2.text.includes(`Credit note ${c1.number}`) && pdfInv2.text.includes('Amount due') && pdfInv2.text.includes(due1),
    { cn: pdfCn.text.slice(0, 200), inv: pdfInv2.text.includes('Amount due') });
  const full = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Customer goodwill: the month is on us', full: true });
  const settled = await sb('GET', `/v1/fleet-invoices/${re.data.id}`);
  check('credit: crediting the rest settles the invoice (paid, "Settled by credit note …")',
    full.status === 201 && full.data.settledInvoice === true && full.data.creditNote.totalIdr === total - k1.amount && full.data.creditNote.ppnIdr === re.data.totals.ppnIdr - k1.ppn
      && settled.data.status === 'paid' && settled.data.paidReference === `Settled by credit note ${full.data.creditNote.number}`, { full: full.data, st: settled.data.status, ref: settled.data.paidReference });
  const nothingLeft = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Again', lines: [{ description: 'One more', amountIdr: 100 }] });
  const vcn = await sb('POST', `/v1/fleet-credit-notes/${full.data.creditNote.id}/void`, { reason: 'Goodwill not approved' });
  const reopened = await sb('GET', `/v1/fleet-invoices/${re.data.id}`);
  const voidInvWithCredit = await sb('POST', `/v1/fleet-invoices/${re.data.id}/void`, { reason: 'test' });
  check('credit: nothing left to credit (409); voiding the settling note reopens the invoice; an invoice with credit notes cannot be voided (409)',
    nothingLeft.status === 409 && vcn.status === 200 && vcn.data.status === 'void' && reopened.data.status === 'issued' && reopened.data.balanceIdr === total - k1.amount && voidInvWithCredit.status === 409,
    { n: nothingLeft.status, v: vcn.data?.status, r: reopened.data.status, b: reopened.data.balanceIdr, vi: voidInvWithCredit.data });
  // A paid invoice: refunded, or deducted from the next invoice.
  const duaTotal = (await sb('GET', `/v1/fleet-invoices/${invDua.invoiceId}`)).data.totals.totalIdr as number;
  const kR = taxed(Math.floor(duaTotal / 10));
  const kN = taxed(Math.floor(duaTotal / 5));
  const refund = await sb('POST', `/v1/fleet-invoices/${invDua.invoiceId}/credit-notes`, { reason: 'Idle fee waived', lines: [{ description: 'Idle fee, 12 minutes', amountIdr: kR.amount }] });
  const nextInv = await sb('POST', `/v1/fleet-invoices/${invDua.invoiceId}/credit-notes`, { reason: 'Tariff error on 3 sessions', settlement: 'next_invoice', lines: [{ description: 'Tariff correction', amountIdr: kN.amount }] });
  const wrongSettle = await sb('POST', `/v1/fleet-invoices/${re.data.id}/credit-notes`, { reason: 'Refund on unpaid', settlement: 'refund', lines: [{ description: 'x x x', amountIdr: 100 }] });
  const openList = await sb('GET', '/v1/fleet-credit-notes?open=1');
  cc('/v1/fleet-credit-notes', 'get', '200', openList.data);
  check('credit: on a paid invoice a credit is refunded (default) or deducted from the next invoice; "refund" on an unpaid one is refused; both are listed as open',
    refund.status === 201 && refund.data.creditNote.settlement === 'refund' && nextInv.status === 201 && nextInv.data.creditNote.settlement === 'next_invoice' && wrongSettle.status === 422
      && [refund.data.creditNote.id, nextInv.data.creditNote.id].every((id) => openList.data.creditNotes.some((c: any) => c.id === id && c.pending)),
    { r: refund.data, n: nextInv.data, w: wrongSettle.data });
  const refunded = await sb('POST', `/v1/fleet-credit-notes/${refund.data.creditNote.id}/refunded`, { refundedAt: '2026-10-25', reference: 'BCA refund 7781' });
  cc('/v1/fleet-credit-notes/{id}/refunded', 'post', '200', refunded.data);
  const open2 = await sb('GET', '/v1/fleet-credit-notes?open=1');
  check('credit: the refund recorded; it is no longer open', refunded.data.refundedAt === '2026-10-25' && refunded.data.refundReference === 'BCA refund 7781' && !open2.data.creditNotes.some((c: any) => c.id === refund.data.creditNote.id), refunded.data);
  const cnSent = await sb('POST', `/v1/fleet-credit-notes/${nextInv.data.creditNote.id}/send`);
  const cnMail = await until(async () => mails.find((x) => x.to.includes('billing@armadadua.test') && x.raw.includes('Credit note')), (v) => !!v, 10_000);
  check('credit: e-mailed to the billing address with the credit note PDF attached',
    cnSent.status === 200 && !!cnMail && cnMail.raw.includes(`filename=${nextInv.data.creditNote.number.replace(/\//g, '_')}.pdf`) && /Content-Type: application\/pdf/i.test(cnMail.raw), cnSent.data);
  // A later month for the same account: the waiting credit comes off that invoice.
  await until(() => sb('POST', `/v1/sandbox/chargers/${DC}/simulate`, { event: 'tap-card', connectorId: 2, idTag: 'SANDBOX-RFID-0001', kwh: 1 }), (r) => r.status === 200, 30_000, 1500);
  await until(() => sb('GET', `/v1/sessions?identity=${DC}`), (r) => (r.data ?? []).filter?.((s: any) => s.id_tag === 'SANDBOX-RFID-0001' && s.ended_at && s.total_idr != null).length === 2, 60_000, 1500);
  const prev2 = (() => { const [py, pm] = prev.split('-').map(Number); return pm === 1 ? `${py! - 1}-12` : `${py}-${String(pm! - 1).padStart(2, '0')}`; })();
  await pg.query(`UPDATE cdr SET issued_at = (($2 || '-10')::timestamp AT TIME ZONE 'Asia/Jakarta') WHERE org_id = $1 AND issued_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'`, [sandboxId, prev2]);
  const later = await sb('POST', '/v1/fleet-invoices', { fleetAccountId: dua.data.id, period: prev2 });
  const nextState = await sb('GET', `/v1/fleet-credit-notes/${nextInv.data.creditNote.id}`);
  const voidApplied = await sb('POST', `/v1/fleet-credit-notes/${nextInv.data.creditNote.id}/void`, { reason: 'test' });
  check('credit: the next invoice deducts the waiting credit note (prior credit, amount due), which then shows where it went and can no longer be voided',
    later.status === 201 && later.data.priorCreditIdr === kN.amount && later.data.balanceIdr === later.data.totals.totalIdr - kN.amount && later.data.priorCredits?.[0]?.number === nextInv.data.creditNote.number
      && nextState.data.appliedInvoice === later.data.number && voidApplied.status === 409, { later: later.data?.priorCreditIdr, bal: later.data?.balanceIdr, applied: nextState.data.appliedInvoice, v: voidApplied.data });

  // ------------------------------------------------------------ fleet customer portal
  const noAccount = await sb('POST', '/v1/users', { name: 'Portal No Account', email: `nofleet-${Date.now()}@logistik.test`, role: 'fleet_customer' });
  const email = `ap-${Date.now()}@logistik.test`;
  const invite = await sb('POST', '/v1/users', { name: 'Ibu Sari (Logistik finance)', email, role: 'fleet_customer', fleetAccountId: logistik.id });
  check('portal: a fleet customer user is invited for one fleet account (one-time password); the account is required',
    invite.status === 200 && !!invite.data.temporaryPassword && noAccount.status === 400, { invite: invite.status, noAccount: noAccount.data });
  let pcookie = '';
  const portal = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { cookie: pcookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) pcookie = sc.split(';')[0]!;
    const tx = await r.text(); let d: any = tx; try { d = JSON.parse(tx); } catch {}
    return { status: r.status, data: d };
  };
  await portal('POST', '/v1/auth/login', { email, password: invite.data.temporaryPassword });
  const newPw = `Portal-${Date.now()}-Ok!`;
  const chg = await portal('POST', '/v1/auth/change-password', { current: invite.data.temporaryPassword, next: newPw });
  const me = await portal('GET', '/v1/auth/me');
  check('portal: the user signs in, replaces the one-time password, and holds only fleet:portal for that account',
    chg.status === 200 && me.data.fleets?.length === 1 && me.data.fleets[0].id === logistik.id && me.data.permissions.join() === 'fleet:portal', { chg: chg.data, fleets: me.data.fleets, perms: me.data.permissions });
  const po = await portal('GET', '/v1/fleet-portal');
  const pinv = await portal('GET', `/v1/fleet-portal/${logistik.id}/invoices`);
  check('portal: what the account owes, its invoices (not the voided one) and credit notes (not the voided one)',
    po.data.accounts?.[0]?.outstandingIdr === total - k1.amount && pinv.data.invoices.some((i: any) => i.id === re.data.id && i.balanceIdr === total - k1.amount)
      && !pinv.data.invoices.some((i: any) => i.id === rowL.invoiceId) && pinv.data.creditNotes.length === 1 && pinv.data.creditNotes[0].id === c1.id,
    { acc: po.data.accounts, inv: pinv.data.invoices?.map((i: any) => [i.number, i.status]), cn: pinv.data.creditNotes?.map((c: any) => c.number) });
  const ph = { cookie: pcookie };
  const ppdf = await pdfGet(`/v1/fleet-portal/${logistik.id}/invoices/${re.data.id}/invoice.pdf`, ph);
  const pcn = await pdfGet(`/v1/fleet-portal/${logistik.id}/credit-notes/${c1.id}/credit-note.pdf`, ph);
  const pcsv = await fetch(`${API}/v1/fleet-portal/${logistik.id}/invoices/${re.data.id}/invoice.csv`, { headers: ph });
  check('portal: the invoice and credit note as PDF, and the session CSV', ppdf.status === 200 && ppdf.text.includes(`No. ${re.data.number}`) && pcn.status === 200 && pcn.text.includes(c1.number) && pcsv.status === 200, { p: ppdf.status, c: pcn.status, csv: pcsv.status });
  const otherInv = await pdfGet(`/v1/fleet-portal/${logistik.id}/invoices/${invDua.invoiceId}/invoice.pdf`, ph);
  const otherAcc = await portal('GET', `/v1/fleet-portal/${dua.data.id}/invoices`);
  const voidedInv = await pdfGet(`/v1/fleet-portal/${logistik.id}/invoices/${rowL.invoiceId}/invoice.pdf`, ph);
  const opsDenied = await Promise.all(['/v1/fleet-invoices', '/v1/fleet-accounts', '/v1/sessions', '/v1/charge-points', '/v1/alert-routing'].map((p) => portal('GET', p)));
  check('portal: another account\'s invoice, another account, a voided invoice → 404; every operator page → 403',
    otherInv.status === 404 && otherAcc.status === 404 && voidedInv.status === 404 && opsDenied.every((r) => r.status === 403), { oi: otherInv.status, oa: otherAcc.status, vi: voidedInv.status, ops: opsDenied.map((r) => r.status) });
  const opsPortal = await ops('GET', '/v1/fleet-portal');
  check('portal: an operator (not a fleet customer) gets nothing from the portal routes', opsPortal.status === 403, opsPortal.data);
  const pst = await portal('GET', `/v1/fleet-portal/${logistik.id}/statement`);
  check('portal: this month so far, without the operator\'s notes', pst.status === 200 && pst.data.status === 'draft' && pst.data.warnings === undefined && typeof pst.data.totals?.totalIdr === 'number', { s: pst.status, w: pst.data.warnings });
  const pcards = await portal('GET', `/v1/fleet-portal/${logistik.id}/cards`);
  const card = pcards.data.cards?.find((c: any) => c.uid === 'SANDBOX-FLEET-0002');
  const blk = await portal('POST', `/v1/fleet-portal/${logistik.id}/cards/${card?.id}/block`, { blocked: true });
  const opView = await sb('GET', `/v1/fleet-accounts/${logistik.id}`);
  const unb = await portal('POST', `/v1/fleet-portal/${logistik.id}/cards/${card?.id}/block`, { blocked: false });
  check('portal: the customer blocks a lost card (the operator sees "blocked by the customer") and unblocks it again',
    !!card?.canBlock && blk.status === 200 && blk.data.status === 'Blocked' && opView.data.cards.find((c: any) => c.uid === 'SANDBOX-FLEET-0002')?.blocked_by_customer === true
      && unb.status === 200 && unb.data.status === 'Accepted', { card, blk: blk.data, unb: unb.data });
  const tokenId = card?.id;
  await sb('PUT', `/v1/tokens/${tokenId}`, { status: 'Blocked' });
  const unbOp = await portal('POST', `/v1/fleet-portal/${logistik.id}/cards/${tokenId}/block`, { blocked: false });
  await sb('PUT', `/v1/tokens/${tokenId}`, { status: 'Accepted' });
  const otherCard = (await sb('GET', `/v1/fleet-accounts/${dua.data.id}`)).data.cards?.[0];
  const otherBlock = await portal('POST', `/v1/fleet-portal/${logistik.id}/cards/${otherCard?.id}/block`, { blocked: true });
  check('portal: a card the operator blocked cannot be unblocked by the customer (409); another account\'s card is 404',
    unbOp.status === 409 && /operator/.test(unbOp.data.error) && otherBlock.status === 404, { unbOp: unbOp.data, other: otherBlock.status });

  const audit = await sb('GET', '/v1/audit?limit=200');
  check('audit: issued, e-Faktur export, e-mail, void, payment and faktur number are in the audit trail',
    ['fleet_invoice.issued', 'fleet_invoice.efaktur_exported', 'fleet_invoice.sent', 'fleet_invoice.voided', 'fleet_invoice.paid', 'fleet_invoice.faktur_number_set'].every((a) => JSON.stringify(audit.data).includes(a)), audit.status);
  check('audit: credit notes (issued, voided, refunded, sent) and the customer\'s card blocks are in the audit trail',
    ['fleet_credit_note.issued', 'fleet_credit_note.voided', 'fleet_credit_note.refunded', 'fleet_credit_note.sent', 'token.blocked_by_fleet_customer', 'token.unblocked_by_fleet_customer'].every((a) => JSON.stringify(audit.data).includes(a)), audit.status);
  check('contract: live fleet billing responses match the published schemas', contract.length === 0, contract);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  if (sandboxId) await ops('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  smtp.close();
  if (pg) await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
