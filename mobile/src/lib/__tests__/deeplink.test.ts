import { extractChargerCode, hrefFor, parseLink, paymentReturnFailed } from '../deeplink';

const U = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('extractChargerCode (scanner — same rules as the PWA)', () => {
  it.each([
    ['AK-SNY-01:1', 'AK-SNY-01:1'],
    ['  AK-SNY-01/2 ', 'AK-SNY-01/2'],
    ['01.JKT.20.3171.001', '01.JKT.20.3171.001'],
    ['https://go.plugsure.asia/c/AK-SNY-01:1', 'AK-SNY-01:1'],
    ['https://ops.example.com/app/?code=CHG-77', 'CHG-77'],
    ['https://ops.example.com/app/?c=CHG-78', 'CHG-78'],
    ['https://ops.example.com/app/#c/CHG-79', 'CHG-79'],
    ['https://ops.example.com/app/#c/CHG%3A2', 'CHG:2'],
    ['https://other.example/stickers/CHG-80', 'CHG-80'],
    [`https://x.example/app/?code=${U}`, U],
    ['plugsure://c/AK-SNY-01:1', 'AK-SNY-01:1'],
  ])('%s → %s', (raw, code) => expect(extractChargerCode(raw)).toBe(code));

  it.each(['', '   ', 'https://go.plugsure.asia/app/', 'https://x/app/index.html', 'DROP TABLE; <script>', 'x'.repeat(81)])('refuses %p', (raw) =>
    expect(extractChargerCode(raw)).toBeNull(),
  );
});

describe('parseLink (universal links, app links, custom scheme, push URLs)', () => {
  it('charger links', () => {
    expect(parseLink('https://go.plugsure.asia/c/AK-1:2')).toEqual({ type: 'charger', code: 'AK-1:2' });
    expect(parseLink('plugsure://c/AK-1')).toEqual({ type: 'charger', code: 'AK-1' });
    expect(parseLink('https://app.nusantaracharge.id/app/?code=NC-9')).toEqual({ type: 'charger', code: 'NC-9' });
    expect(parseLink('https://app.nusantaracharge.id/app/#c/NC-10')).toEqual({ type: 'charger', code: 'NC-10' });
  });
  it('station, receipt, session, partner', () => {
    expect(parseLink(`https://go.plugsure.asia/s/${U}`)).toEqual({ type: 'station', siteId: U });
    expect(parseLink(`https://go.plugsure.asia/r/roaming/${U}`)).toEqual({ type: 'receipt', kind: 'roaming', id: U });
    expect(parseLink(`plugsure://session/charge/${U}`)).toEqual({ type: 'session', kind: 'charge', id: U });
    expect(parseLink(`https://go.plugsure.asia/p/${U}/SG/LCE/LOC-SG-11`)).toEqual({ type: 'partner', partnerId: U, countryCode: 'SG', partyId: 'LCE', locationId: 'LOC-SG-11' });
  });
  it('PWA push hashes keep working', () => {
    expect(parseLink(`https://x/app/#s/${U}`)).toEqual({ type: 'session', kind: 'charge', id: U });
    expect(parseLink(`https://x/app/#r/${U}`)).toEqual({ type: 'receipt', kind: 'charge', id: U });
    expect(parseLink(`https://x/app/#rr/${U}`)).toEqual({ type: 'receipt', kind: 'roaming', id: U });
    expect(parseLink('https://x/app/#history')).toEqual({ type: 'tab', tab: 'activity' });
    expect(parseLink('https://x/app/#home')).toEqual({ type: 'tab', tab: 'map' });
  });
  it('payment returns (today /app/paid.html, with [§14 G11] /paid and the custom scheme)', () => {
    expect(parseLink('https://ops.example/app/paid.html?for=charge&status=success')).toEqual({ type: 'paid', for: 'charge', status: 'success' });
    expect(parseLink('plugsure://paid?for=roaming&redirect_status=failed')).toEqual({ type: 'paid', for: 'roaming', status: 'failed' });
    expect(parseLink('https://go.plugsure.asia/paid?transaction_status=deny')).toEqual({ type: 'paid', for: null, status: 'deny' });
  });
  it('a failed / cancelled return is recognised, linking an e-wallet is not judged by the return', () => {
    expect(paymentReturnFailed({ type: 'paid', for: 'charge', status: 'expire' })).toBe(true);
    expect(paymentReturnFailed({ type: 'paid', for: 'charge', status: 'cancelled' })).toBe(true);
    expect(paymentReturnFailed({ type: 'paid', for: 'charge', status: 'settlement' })).toBe(false);
    expect(paymentReturnFailed({ type: 'paid', for: 'link', status: 'cancel' })).toBe(false);
    expect(paymentReturnFailed({ type: 'paid', for: 'charge', status: null })).toBe(false);
  });
  it('raw codes and junk', () => {
    expect(parseLink('AK-SNY-01')).toEqual({ type: 'charger', code: 'AK-SNY-01' });
    expect(parseLink('<<<').type).toBe('unknown');
  });
});

describe('hrefFor', () => {
  it('routes intents into the app', () => {
    expect(hrefFor({ type: 'charger', code: 'AK 1:2' })).toBe('/c/AK%201%3A2');
    expect(hrefFor({ type: 'station', siteId: U })).toBe(`/station/${U}`);
    expect(hrefFor({ type: 'receipt', kind: 'roaming', id: U })).toBe(`/receipt/roaming/${U}`);
    expect(hrefFor({ type: 'paid', for: 'charge', status: 'ok' })).toBe('/paid?for=charge&status=ok');
    expect(hrefFor({ type: 'tab', tab: 'map' })).toBe('/');
    expect(hrefFor({ type: 'partner', partnerId: U, countryCode: 'SG', partyId: 'LCE', locationId: 'L 1' })).toBe(`/partner/${U}/L%201?countryCode=SG&partyId=LCE`);
    expect(hrefFor({ type: 'unknown', raw: 'x' })).toBeNull();
  });
});
