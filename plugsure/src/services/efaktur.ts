/**
 * e-Faktur: the bulk-import XML for output tax invoices (Faktur Pajak
 * Keluaran) in DJP Coretax, the format of the DJP import template.
 *
 * One <TaxInvoice> per fleet invoice, one <GoodService> per invoice line (a
 * site's month). PPN at 12% on DPP nilai lain (11/12 of the price) is
 * transaction code 04, with TaxBase = the price, OtherTaxBase = the DPP and
 * VAT = 12% of the DPP — the same figures as the invoice.
 *
 * The goods/service code and the unit of measure depend on how the operator's
 * tax adviser classifies EV charging, so they are settings that must be
 * confirmed before the first export. Import the file into Coretax (Faktur Pajak
 * → Impor Data) and check the draft invoices there before approving them: this
 * file prepares the faktur, Coretax issues it.
 */

export interface EfakturSettings {
  /** A = goods (barang), B = services (jasa). */
  itemOpt: 'A' | 'B';
  /** 6-digit goods/service code from the DJP reference list. */
  itemCode: string;
  /** Coretax unit-of-measure code, e.g. UM.0000-style. */
  unitCode: string;
}

export interface EfakturInvoice {
  /** The commercial invoice number: the faktur's reference (RefDesc). */
  number: string;
  /**
   * TaxInvoiceDate (YYYY-MM-DD): the faktur date, NOT the invoice's issue date.
   * A monthly fleet invoice is a faktur gabungan, which must be dated no later
   * than the last day of the month of delivery (fakturDate below).
   */
  date: string;
  buyer: { taxId: string | null; kind: 'TIN' | 'NIK' | 'Passport' | 'Other'; nitku: string | null; name: string; address: string | null; email: string | null };
  /** A line may carry its own item settings (a membership fee is not electricity). */
  lines: Array<{ name: string; taxBaseIdr: number; dppIdr: number; ppnIdr: number; item?: EfakturSettings }>;
}

/**
 * The last day of a billing month (YYYY-MM-DD): the date of the faktur pajak.
 *
 * A fleet invoice is a faktur gabungan — one faktur for a month of deliveries —
 * and a faktur gabungan must be made no later than the last day of the month of
 * delivery. Using the invoice's issue date (always in the following month: a
 * month can be invoiced only once it has ended) made every faktur late — a
 * sanction for the seller (UU KUP art. 14(4)) and a risk to the buyer's input-tax
 * credit for the month the electricity was delivered.
 */
export function fakturDate(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** Digits only; a 15-digit NPWP becomes the 16-digit form with a leading 0. */
export function normaliseNpwp(v: string | null | undefined): string | null {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 15) return '0' + d;
  if (d.length === 16) return d;
  return null;
}

/** NITKU: 22 digits; when absent, the head office's (NPWP + 000000). */
export function nitkuFor(taxId16: string | null, nitku: string | null | undefined): string | null {
  const d = String(nitku ?? '').replace(/\D/g, '');
  if (d.length === 22) return d;
  return taxId16 ? taxId16 + '000000' : null;
}

export function settingsProblem(s: Partial<EfakturSettings> & { confirmed?: boolean }, seller: { npwp: string | null; nitku: string | null; pkp: boolean }): string | null {
  if (!seller.pkp) return 'Your organisation is not a PKP (VAT-registered): its invoices carry no PPN and no faktur pajak.';
  if (!normaliseNpwp(seller.npwp)) return "Enter your organisation's NPWP (16 digits) under Fleet billing → Settings.";
  if (!nitkuFor(normaliseNpwp(seller.npwp), seller.nitku)) return "Enter your organisation's NITKU (22 digits).";
  if (s.itemOpt !== 'A' && s.itemOpt !== 'B') return 'Choose whether the charging is goods (A) or services (B) for e-Faktur.';
  if (!/^\d{6}$/.test(String(s.itemCode ?? ''))) return 'Enter the 6-digit e-Faktur goods/service code.';
  if (!/^UM\.\d{4}$/.test(String(s.unitCode ?? ''))) return 'Enter the Coretax unit-of-measure code (UM.nnnn).';
  if (!s.confirmed) return 'Confirm the e-Faktur item settings with your tax adviser, then tick "confirmed" in Settings.';
  return null;
}

const x = (s: unknown) =>
  String(s ?? '')
    // XML 1.0 forbids most control characters outright.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const n = (v: number) => String(Math.round(v));

/** Item settings for membership fees on the faktur, or why they are missing. */
export function feeItemProblem(s: { feeItemOpt?: string; feeItemCode?: string; feeUnitCode?: string }): string | null {
  if (s.feeItemOpt !== 'A' && s.feeItemOpt !== 'B') return 'Set the e-Faktur item type for membership fees (usually B, services).';
  if (!/^\d{6}$/.test(String(s.feeItemCode ?? ''))) return 'Enter the 6-digit e-Faktur code for membership and reservation fees.';
  if (!/^UM\.\d{4}$/.test(String(s.feeUnitCode ?? ''))) return 'Enter the Coretax unit code for membership fees (UM.nnnn).';
  return null;
}

export function buyerProblem(b: EfakturInvoice['buyer']): string | null {
  if (b.kind === 'TIN') return normaliseNpwp(b.taxId) ? null : 'no valid NPWP';
  if (b.kind === 'NIK') return /^\d{16}$/.test(String(b.taxId ?? '').replace(/\D/g, '')) ? null : 'no valid NIK';
  return b.taxId ? null : 'no buyer ID';
}

export function efakturXml(seller: { npwp: string; nitku: string | null }, invoices: EfakturInvoice[], s: EfakturSettings, ppnRatePct = 12): string {
  const tin = normaliseNpwp(seller.npwp)!;
  const sellerTku = nitkuFor(tin, seller.nitku)!;
  const body = invoices.map((inv) => {
    const b = inv.buyer;
    const isTin = b.kind === 'TIN';
    const buyerTin = isTin ? normaliseNpwp(b.taxId)! : '0000000000000000';
    const docNumber = isTin ? '-' : String(b.taxId ?? '').replace(/\s/g, '');
    const buyerTku = isTin ? nitkuFor(buyerTin, b.nitku)! : `${String(b.taxId ?? '').replace(/\D/g, '')}000000`;
    const document = { TIN: 'TIN', NIK: 'National ID', Passport: 'Passport', Other: 'Other ID' }[b.kind];
    const goods = inv.lines.map((l) => { const it = l.item ?? s; return `
        <GoodService>
          <Opt>${it.itemOpt}</Opt>
          <Code>${x(it.itemCode)}</Code>
          <Name>${x(l.name)}</Name>
          <Unit>${x(it.unitCode)}</Unit>
          <Price>${n(l.taxBaseIdr)}</Price>
          <Qty>1</Qty>
          <TotalDiscount>0</TotalDiscount>
          <TaxBase>${n(l.taxBaseIdr)}</TaxBase>
          <OtherTaxBase>${n(l.dppIdr)}</OtherTaxBase>
          <VATRate>${ppnRatePct}</VATRate>
          <VAT>${n(l.ppnIdr)}</VAT>
          <STLGRate>0</STLGRate>
          <STLG>0</STLG>
        </GoodService>`; }).join('');
    return `
    <TaxInvoice>
      <TaxInvoiceDate>${x(inv.date)}</TaxInvoiceDate>
      <TaxInvoiceOpt>Normal</TaxInvoiceOpt>
      <TrxCode>04</TrxCode>
      <AddInfo/>
      <CustomDoc/>
      <RefDesc>${x(inv.number)}</RefDesc>
      <FacilityStamp/>
      <SellerIDTKU>${sellerTku}</SellerIDTKU>
      <BuyerTin>${buyerTin}</BuyerTin>
      <BuyerDocument>${document}</BuyerDocument>
      <BuyerCountry>IDN</BuyerCountry>
      <BuyerDocumentNumber>${x(docNumber)}</BuyerDocumentNumber>
      <BuyerName>${x(b.name)}</BuyerName>
      <BuyerAdress>${x(b.address ?? '')}</BuyerAdress>
      <BuyerEmail>${x(b.email ?? '')}</BuyerEmail>
      <BuyerIDTKU>${buyerTku}</BuyerIDTKU>
      <ListOfGoodService>${goods}
      </ListOfGoodService>
    </TaxInvoice>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<TaxInvoiceBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="TaxInvoice.xsd">
  <TIN>${tin}</TIN>
  <ListOfTaxInvoice>${body}
  </ListOfTaxInvoice>
</TaxInvoiceBulk>
`;
}
