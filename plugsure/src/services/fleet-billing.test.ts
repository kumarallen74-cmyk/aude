import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeFleetStatement, taxBaseOf, dppOf, ppnOf, type FleetSession, type FleetRoaming, type TaxCfg } from './fleet-calc.js';
import { efakturXml, normaliseNpwp, nitkuFor, settingsProblem, buyerProblem } from './efaktur.js';
import { computeTax } from './tax.js';

const CFG: TaxCfg = { ppnRateBps: 1200, dppNum: 11, dppDen: 12 };

/** A session rated exactly as the rating engine does (computeTax), so the fixtures are real. */
function session(id: string, site: string, subtotal: number, pbjtBps = 1000, over: Partial<FleetSession> = {}): FleetSession {
  const t = computeTax({ subtotalMinor: subtotal, localTaxRateBps: pbjtBps });
  return {
    id, startedAt: '2026-09-10T02:00:00Z', endedAt: '2026-09-10T03:00:00Z', siteId: site, siteName: site === 's1' ? 'Kuningan' : 'Bekasi',
    ocppIdentity: 'CP-1', cardUid: 'FLEET-1', holder: 'Budi', energyWh: 10_000,
    subtotalMinor: t.subtotalMinor, localTaxMinor: t.localTaxMinor, taxBaseMinor: t.taxBaseMinor, ppnRateBps: t.taxRateBps, taxMinor: t.taxMinor, totalMinor: t.totalMinor, ...over,
  };
}

describe('fleet invoice arithmetic', () => {
  test('the PPN price is recovered from the stored DPP, whichever PBJT treatment was in force', () => {
    const s = session('a', 's1', 29_005);
    const t = taxBaseOf(s, CFG);
    assert.ok(t.exact);
    assert.equal(dppOf(t.base, CFG), s.taxBaseMinor);
    assert.deepEqual(taxBaseOf({ subtotalMinor: 29_005, localTaxMinor: 2_901, taxBaseMinor: dppOf(29_005, CFG), ppnRateBps: 1200 }, CFG), { base: 29_005, exact: true });
    assert.deepEqual(taxBaseOf({ subtotalMinor: 1000, localTaxMinor: 0, taxBaseMinor: 0, ppnRateBps: 0 }, CFG), { base: 0, exact: true });
  });

  test('PPN is computed per site line on the summed price: DPP = 11/12, PPN = 12% of DPP', () => {
    const sessions = [session('a', 's1', 29_005), session('b', 's1', 41_333), session('c', 's2', 17_777)];
    const st = computeFleetStatement(sessions, [], { includeRoaming: true, cfg: CFG });
    assert.equal(st.sites.length, 2);
    for (const l of st.sites) {
      assert.equal(l.taxBaseMinor, Math.round((l.taxableMinor * 11) / 12));
      assert.equal(l.taxMinor, Math.round((l.taxBaseMinor * 1200) / 10_000));
      assert.equal(l.totalMinor, l.subtotalMinor + l.localTaxMinor + l.taxMinor);
    }
    const t = st.totals;
    assert.equal(t.totalMinor, t.subtotalMinor + t.localTaxMinor + t.taxMinor);
    assert.equal(t.receiptsTotalMinor, sessions.reduce((a, s) => a + s.totalMinor, 0));
    // Per-line PPN may differ from the sum of per-session PPN only by rounding: a rupiah per session at most.
    assert.ok(Math.abs(t.roundingMinor) <= sessions.length, `rounding ${t.roundingMinor}`);
    assert.equal(t.roundingMinor, t.ownTotalMinor - t.receiptsTotalMinor);
  });

  test('sessions without PPN add nothing to the tax base and are counted', () => {
    const untaxed = session('u', 's1', 20_000, 1000, { taxBaseMinor: 0, ppnRateBps: 0, taxMinor: 0, totalMinor: 22_000 });
    const st = computeFleetStatement([untaxed, session('a', 's1', 10_000)], [], { includeRoaming: true, cfg: CFG });
    assert.equal(st.sites[0]!.untaxedSessions, 1);
    assert.equal(st.sites[0]!.taxableMinor, taxBaseOf(session('a', 's1', 10_000), CFG).base);
  });

  test('partner-network records are re-billed at cost in IDR; other currencies are left off with a warning', () => {
    const roam: FleetRoaming[] = [
      { id: 'r1', operator: 'Partner', location: 'Mall', cardUid: 'FLEET-1', startedAt: '2026-09-11T01:00:00Z', endedAt: '2026-09-11T02:00:00Z', energyKwh: 12.5, exclVat: 30_000, inclVat: 33_300, currency: 'IDR' },
      { id: 'r2', operator: 'Partner', location: null, cardUid: 'FLEET-2', startedAt: '2026-09-12T01:00:00Z', endedAt: '2026-09-12T02:00:00Z', energyKwh: 5, exclVat: 12.5, inclVat: null, currency: 'EUR' },
    ];
    const st = computeFleetStatement([session('a', 's1', 10_000)], roam, { includeRoaming: true, cfg: CFG });
    assert.deepEqual(st.roaming.map((x) => [x.id, x.amountMinor]), [['r1', 33_300]]);
    assert.equal(st.totals.totalMinor, st.totals.ownTotalMinor + 33_300);
    assert.ok(st.warnings.some((w) => /another currency/.test(w)));
    assert.equal(st.cards.find((c) => c.uid === 'FLEET-1')!.roamingMinor, 33_300);
    const off = computeFleetStatement([session('a', 's1', 10_000)], roam, { includeRoaming: false, cfg: CFG });
    assert.equal(off.totals.roamingMinor, 0);
    assert.equal(off.roaming.length, 0);
  });

  test('ppnOf / dppOf round half away as the receipts do', () => {
    assert.equal(dppOf(1_000_000, CFG), 916_667);
    assert.equal(ppnOf(916_667, CFG), 110_000);
  });
});

describe('e-Faktur (Coretax XML)', () => {
  const settings = { itemOpt: 'A' as const, itemCode: '000000', unitCode: 'UM.0033' };

  test('NPWP and NITKU normalisation', () => {
    assert.equal(normaliseNpwp('01.234.567.8-091.000'), '0012345678091000');
    assert.equal(normaliseNpwp('0012345678091000'), '0012345678091000');
    assert.equal(normaliseNpwp('123'), null);
    assert.equal(nitkuFor('0012345678091000', null), '0012345678091000000000');
    assert.equal(nitkuFor('0012345678091000', '0012345678091000000001'), '0012345678091000000001');
  });

  test('export is refused until the seller and item settings are complete and confirmed', () => {
    const seller = { npwp: '0012345678091000', nitku: null, pkp: true };
    assert.match(settingsProblem({ ...settings }, seller)!, /Confirm/);
    assert.equal(settingsProblem({ ...settings, confirmed: true }, seller), null);
    assert.match(settingsProblem({ ...settings, confirmed: true }, { ...seller, pkp: false })!, /not a PKP/);
    assert.match(settingsProblem({ ...settings, unitCode: 'kWh', confirmed: true }, seller)!, /unit/);
    assert.equal(buyerProblem({ taxId: null, kind: 'TIN', nitku: null, name: 'x', address: null, email: null }), 'no valid NPWP');
  });

  test('one TaxInvoice per invoice with code 04 and the invoice figures; text is escaped', () => {
    const xml = efakturXml({ npwp: '0012345678091000', nitku: null }, [
      {
        number: 'FLT/2026/10/0001', date: '2026-10-01',
        buyer: { taxId: '0987654321098765', kind: 'TIN', nitku: null, name: 'PT Logistik & Co <Tbk>', address: 'Jl. "A" 1', email: 'ap@x.co.id' },
        lines: [{ name: 'Pengisian listrik — Kuningan', taxableMinor: 101_229, taxBaseMinor: 92_793, taxMinor: 11_135 }],
      },
      {
        number: 'FLT/2026/10/0002', date: '2026-10-01',
        buyer: { taxId: '3171012345678901', kind: 'NIK', nitku: null, name: 'Budi', address: null, email: null },
        lines: [{ name: 'x', taxableMinor: 1200, taxBaseMinor: 1100, taxMinor: 132 }],
      },
    ], settings);
    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
    assert.equal((xml.match(/<TaxInvoice>/g) ?? []).length, 2);
    assert.match(xml, /<TIN>0012345678091000<\/TIN>/);
    assert.match(xml, /<SellerIDTKU>0012345678091000000000<\/SellerIDTKU>/);
    assert.equal((xml.match(/<TrxCode>04<\/TrxCode>/g) ?? []).length, 2);
    assert.match(xml, /<BuyerName>PT Logistik &amp; Co &lt;Tbk&gt;<\/BuyerName>/);
    assert.match(xml, /<BuyerAdress>Jl\. &quot;A&quot; 1<\/BuyerAdress>/);
    assert.match(xml, /<TaxBase>101229<\/TaxBase>\s*<OtherTaxBase>92793<\/OtherTaxBase>\s*<VATRate>12<\/VATRate>\s*<VAT>11135<\/VAT>/);
    assert.match(xml, /<BuyerDocument>National ID<\/BuyerDocument>[\s\S]*<BuyerDocumentNumber>3171012345678901<\/BuyerDocumentNumber>/);
    // Well-formed: every opened element is closed, in order.
    const stack: string[] = [];
    for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) assert.equal(stack.pop(), m[2]);
      else stack.push(m[2]!);
    }
    assert.deepEqual(stack, []);
  });
});
