import type { Channel, CurrencyCode, HistoryItem, HostedStatus, RoamingStatus } from '../types';
import { extractChargerCode, parseLink } from '@/lib/deeplink';
import { findConnector, partnerStations, resolveCode, stations, uuid } from './fixtures';
import { hostedDto, inBBox, mapAnswer, page, parseBBox, partnerDto } from './map';

/**
 * A fetch-compatible in-memory implementation of the driver API, for `API_BASE_URL=mock` (web screenshots,
 * demos without a backend) and component tests. It follows the real server's shapes and status codes (contract
 * §15 of MOBILE-APP-SPEC.md). `mockOptions.gaps = true` answers 404 for the endpoints the server has NOT built yet
 * (ratings, problem reports — §14 G9), like today's server.
 */
export const mockOptions = {
  latencyMs: 220,
  /** Simulated minutes per real second while charging. */
  speed: 40,
  /** Answer 404 for the not-yet-built P1 endpoints (ratings, reports), like today's server. */
  gaps: false,
};

interface Device {
  id: string;
  accountId: string | null;
  fleet: boolean;
}
interface Charge {
  id: string;
  deviceId: string;
  connectorId: string;
  amountMinor: number;
  currency: CurrencyCode;
  channel: string;
  paidAt: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  createdAt: number;
  powerKw: number;
  rate: number;
  siteName: string;
  connectorLabel: string;
  mode: 'prepaid' | 'fleet';
}
interface Roam {
  id: string;
  deviceId: string;
  currency: CurrencyCode;
  holdMinor: number;
  createdAt: number;
  authorisedAt: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  site: string;
  operator: string;
  rate: number;
}

const accounts = new Map<string, { id: string; phone: string; name: string | null }>();
const devices = new Map<string, Device>();
const charges = new Map<string, Charge>();
const roams = new Map<string, Roam>();
const favourites = new Map<string, { id: string; siteId: string | null; partnerId: string | null; countryCode: string | null; partyId: string | null; locationId: string | null }[]>();
const reservations = new Map<string, { id: string; connectorId: string; expiresAt: string; siteName: string }>();
/** Reservation-fee checkouts (§ reservations with a fee): pending until the (demo) payment, then held. */
const checkouts = new Map<string, { id: string; deviceId: string; connectorId: string; siteName: string; state: string; totalMinor: number }>();
/** Site queues: the device's entry. */
const queue = new Map<string, { id: string; siteId: string; siteName: string; joinedAt: string; want: { current: 'AC' | 'DC' | null; type: string | null } }>();
/** Mock sites with a reservation fee / a queue (Sudirman Tower: fee; Kuningan Central: every connector busy → queue). */
const FEE_SITE = uuid(4);
const QUEUE_SITE = uuid(2);
const FEE = { feeMinor: 5000, taxMinor: 550, totalMinor: 5550, fleetInvoice: false, currency: 'IDR' as const };
const qris = (amount: number) =>
  `00020101021226650013ID.CO.QRIS.WWW0118936009153000000000215ID10200000000000303UMI51440014ID.CO.QRIS.WWW0215ID1020000000000303UMI5204557253033605404${amount}5802ID5913PLUGSURE DEMO6007JAKARTA6304C0DE`;
let n = 0;
const id = () => uuid(500_000 + ++n);

/** On web the demo backend keeps its state across reloads (deep links, screenshots); never on native/tests. */
const STORE_KEY = 'ps.mockBackend.v1';
const webStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' && typeof jest === 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};
function persist(): void {
  const ls = webStorage();
  if (!ls) return;
  ls.setItem(STORE_KEY, JSON.stringify({ n, accounts: [...accounts], devices: [...devices], charges: [...charges], roams: [...roams], favourites: [...favourites], reservations: [...reservations], checkouts: [...checkouts], queue: [...queue] }));
}
(function restore() {
  const raw = webStorage()?.getItem(STORE_KEY);
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    n = d.n ?? 0;
    for (const [k, v] of d.accounts ?? []) accounts.set(k, v);
    for (const [k, v] of d.devices ?? []) devices.set(k, v);
    for (const [k, v] of d.charges ?? []) charges.set(k, v);
    for (const [k, v] of d.roams ?? []) roams.set(k, v);
    for (const [k, v] of d.favourites ?? []) favourites.set(k, v);
    for (const [k, v] of d.reservations ?? []) reservations.set(k, v);
    for (const [k, v] of d.checkouts ?? []) checkouts.set(k, v);
    for (const [k, v] of d.queue ?? []) queue.set(k, v);
  } catch {
    /* corrupt demo state: start fresh */
  }
})();

export function resetMock(): void {
  accounts.clear();
  devices.clear();
  charges.clear();
  roams.clear();
  favourites.clear();
  reservations.clear();
  checkouts.clear();
  queue.clear();
  idempotent.clear();
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const minutesSince = (t: number | null, end?: number | null) => (t == null ? 0 : (((end ?? Date.now()) - t) / 60_000) * mockOptions.speed);

const exp = (c: CurrencyCode) => (c === 'IDR' ? 0 : 2);
const minorOf = (major: number, c: CurrencyCode) => Math.round(major * 10 ** exp(c));

function methodsFor(currency: CurrencyCode, signedIn: boolean) {
  const list: Channel[] = currency === 'IDR' ? ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'CARD'] : currency === 'SGD' ? ['PAYNOW', 'CARD', 'GRABPAY'] : ['CARD', 'FPX', 'GRABPAY'];
  const label: Record<string, string> = { QRIS: 'QRIS', GOPAY: 'GoPay', OVO: 'OVO', DANA: 'DANA', SHOPEEPAY: 'ShopeePay', LINKAJA: 'LinkAja', CARD: 'Credit / debit card', PAYNOW: 'PayNow', FPX: 'FPX online banking', GRABPAY: 'GrabPay' };
  const method = (c: Channel) => (c === 'QRIS' ? 'qris' : c === 'CARD' ? 'card' : c === 'PAYNOW' ? 'qr' : c === 'FPX' ? 'bank' : 'ewallet');
  const presets: Record<CurrencyCode, number[]> = { IDR: [50_000, 100_000, 150_000, 200_000, 300_000, 500_000], MYR: [1_000, 2_000, 3_000, 5_000, 10_000], SGD: [1_000, 2_000, 3_000, 5_000, 8_000] };
  return {
    currency,
    presetsMinor: presets[currency],
    maxPrepaidMinor: currency === 'IDR' ? 10_000_000 : currency === 'MYR' ? 100_000 : 50_000,
    paymentMethods: list.map((c) => ({ channel: c, method: method(c), label: label[c] })),
    cardHolds: true,
    canSaveCard: signedIn,
    savedCards: signedIn ? [{ id: uuid(7001), brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029 }] : [],
    linkableWallets: signedIn && currency === 'IDR' ? ['OVO', 'DANA'] : [],
    linkedWallets: signedIn && currency === 'IDR' ? [{ id: uuid(7101), channel: 'GOPAY', accountLabel: '•• 12', postpay: true }] : [],
    walletPostpay: signedIn && currency === 'IDR',
    postpayLimitIdr: currency === 'IDR' ? 1_000_000 : null,
    postpayBlocked: null,
  };
}

function hostedStatus(c: Charge): HostedStatus {
  const base = {
    chargeId: c.id,
    mode: c.mode,
    amountMinor: c.mode === 'prepaid' ? c.amountMinor : null,
    currency: c.currency,
    siteName: c.siteName,
    connectorLabel: c.connectorLabel,
  };
  if (!c.paidAt) return { ...base, state: 'awaiting_payment', energyKwh: 0, powerKw: null, durationMin: 0, startedAt: null, allowanceKwh: null, progressPct: 0, estimatedMinor: null, hasReceipt: false };
  if (!c.startedAt || c.startedAt > Date.now()) return { ...base, state: 'awaiting_start', energyKwh: 0, powerKw: null, durationMin: 0, startedAt: null, allowanceKwh: null, progressPct: 0, estimatedMinor: null, hasReceipt: false };
  const mins = minutesSince(c.startedAt, c.stoppedAt);
  const allowanceKwh = c.mode === 'prepaid' ? Math.round((c.amountMinor / 10 ** exp(c.currency) / c.rate) * 100) / 100 : null;
  let energy = Math.round(((c.powerKw * mins) / 60) * 100) / 100;
  let state: HostedStatus['state'] = c.stoppedAt ? 'rated' : 'charging';
  if (allowanceKwh != null && energy >= allowanceKwh) {
    energy = allowanceKwh;
    state = 'rated';
  }
  const subtotal = minorOf(energy * c.rate, c.currency);
  const tax = c.currency === 'IDR' ? Math.round(subtotal * 0.11) : 0;
  return {
    ...base,
    state,
    energyKwh: energy,
    powerKw: state === 'charging' ? Math.round((c.powerKw * (0.92 + 0.06 * Math.sin(mins / 3))) * 10) / 10 : null,
    durationMin: Math.round(mins),
    // Simulated time runs `speed`× faster: report the start as far back as the simulated duration.
    startedAt: new Date(Date.now() - mins * 60_000).toISOString(),
    allowanceKwh,
    progressPct: allowanceKwh ? Math.min(100, Math.round((energy / allowanceKwh) * 100)) : null,
    estimatedMinor: subtotal + tax,
    cost: { totalMinor: subtotal + tax, subtotalMinor: subtotal, taxTotalMinor: tax, discountMinor: 0, idleFeeMinor: 0, idleMinutes: 0, asOf: new Date().toISOString(), final: state === 'rated' },
    socPercent: Math.min(100, Math.round(34 + mins * 1.1)),
    hasReceipt: state === 'rated',
  };
}

function roamStatus(r: Roam): RoamingStatus {
  const mins = r.startedAt && r.startedAt <= Date.now() ? minutesSince(r.startedAt, r.stoppedAt) : 0;
  const energy = Math.round(((90 * mins) / 60) * 100) / 100;
  const started = r.startedAt != null && r.startedAt <= Date.now();
  const state: RoamingStatus['state'] = !r.authorisedAt ? 'paying' : !started ? 'starting' : r.stoppedAt ? 'billed' : 'charging';
  return {
    chargeId: r.id,
    state,
    problem: null,
    energyKwh: energy,
    durationMin: Math.round(mins),
    startedAt: started ? new Date(r.startedAt!).toISOString() : null,
    totalMinor: started ? minorOf(energy * r.rate, r.currency) : null,
    currency: r.currency,
    hold: { amountMinor: r.holdMinor, currency: r.currency, state: r.authorisedAt ? 'authorised' : 'pending', holdState: r.stoppedAt ? 'captured' : 'held', capturedMinor: r.stoppedAt ? minorOf(energy * r.rate, r.currency) : null, checkoutUrl: r.authorisedAt ? null : 'https://checkout.mock/hold' },
    cdrId: r.stoppedAt ? r.id : null,
    siteName: r.site,
    operator: r.operator,
    connectorLabel: 'CCS2 · 100 kW',
    canStop: state === 'charging',
  };
}

const SEED_HISTORY = (deviceId: string): HistoryItem[] => {
  void deviceId;
  const d = (days: number, h: number) => new Date(Date.now() - days * 86_400_000 - h * 3_600_000).toISOString();
  return [
    { chargeId: uuid(8001), mode: 'prepaid', siteName: 'Sudirman Tower', createdAt: d(1, 3), state: 'rated', energyKwh: 38.42, durationMin: 24, totalMinor: 98_640, currency: 'IDR' },
    { kind: 'roaming', chargeId: uuid(8002), cdrId: uuid(8002), mode: 'app', siteName: 'Woodlands Checkpoint EV Bay', operator: 'Bay Charge SG', createdAt: d(4, 6), state: 'rated', energyKwh: 31.1, totalMinor: 2_239, currency: 'SGD' },
    { kind: 'roaming', chargeId: uuid(8003), cdrId: uuid(8003), mode: 'app', siteName: 'JomVolt — Johor Bahru Sentral', operator: 'JomVolt', createdAt: d(4, 9), state: 'rated', energyKwh: 22.75, totalMinor: 2_958, currency: 'MYR' },
    { chargeId: uuid(8004), mode: 'prepaid', siteName: 'Senayan Hub — B1', createdAt: d(9, 2), state: 'rated', energyKwh: 41.03, durationMin: 31, totalMinor: 112_340, currency: 'IDR' },
    { chargeId: uuid(8005), mode: 'prepaid', siteName: 'Kuningan Central P2', createdAt: d(12, 5), state: 'refunded', refundState: 'refunded', refundMinor: 100_000, energyKwh: null, totalMinor: 100_000, currency: 'IDR' },
  ];
};

function auth(headers: Headers): Device | null {
  const h = headers.get('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  return devices.get(tok) ?? null;
}

const GAP_ROUTES = [/\/rating$/, /^\/d\/v1\/reports$/];

/** POSTs that honour `Idempotency-Key` (as the server does): the first answer is stored and replayed. */
const IDEMPOTENT = /^\/d\/v1\/(charge\/(prepaid|fleet|[^/]+\/pay-unpaid)|reservations|roaming\/(charge|reservations)|memberships)$/;
const idempotent = new Map<string, { body: string; res: { status: number; text: string } | null }>();

export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const key = headers.get('idempotency-key');
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
  if (key && (init?.method ?? 'GET').toUpperCase() === 'POST' && IDEMPOTENT.test(path)) {
    const scope = `${headers.get('authorization') ?? ''}|${path}|${key}`;
    const body = String(init?.body ?? '');
    const prev = idempotent.get(scope);
    if (prev && prev.body !== body) return json(422, { error: 'This Idempotency-Key was used for a different request.', code: 'idempotency_key_reused' });
    if (prev && !prev.res) return json(409, { error: 'The first request with this Idempotency-Key is still being processed.', code: 'idempotency_in_progress' });
    if (prev?.res) return new Response(prev.res.text, { status: prev.res.status, headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' } });
    idempotent.set(scope, { body, res: null });
    try {
      const res = await handle(input, init);
      // A 5xx is not an answer: the same key may try again.
      if (res.status >= 500) idempotent.delete(scope);
      else idempotent.set(scope, { body, res: { status: res.status, text: await res.clone().text() } });
      persist();
      return res;
    } catch (e) {
      idempotent.delete(scope);
      throw e;
    }
  }
  const res = await handle(input, init);
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || /\/status$/.test(String(input))) persist();
  return res;
}

async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const path = url.pathname;
  const q = url.searchParams;
  if (mockOptions.latencyMs) await new Promise((r) => setTimeout(r, mockOptions.latencyMs));
  if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

  if (mockOptions.gaps && GAP_ROUTES.some((r) => r.test(path))) return json(404, { message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 });

  const near = q.get('lat') && q.get('lon') ? { lat: Number(q.get('lat')), lon: Number(q.get('lon')) } : undefined;

  // ── public
  if (path === '/d/v1/device' && method === 'POST') {
    const dev: Device = { id: id(), accountId: null, fleet: false };
    const token = `psd_mock${dev.id.replace(/-/g, '')}`;
    devices.set(token, dev);
    return json(200, { deviceToken: token, deviceId: dev.id });
  }
  const nearQ = q.get('near')?.split(',').map(Number);
  const near2 = nearQ && nearQ.length === 2 && nearQ.every(Number.isFinite) ? { lat: nearQ[0]!, lon: nearQ[1]! } : near;
  if (path === '/d/v1/stations') {
    if (!q.has('bbox') && !q.has('limit') && !q.has('cursor')) return json(200, { stations: stations(near) });
    const bbox = q.has('bbox') ? parseBBox(q.get('bbox')) : null;
    if (q.has('bbox') && !bbox) return json(400, { error: 'bad bbox', code: 'bad_bbox' });
    const all = stations(near2).filter((s) => !bbox || (s.lat != null && s.lon != null && inBBox(bbox, s.lat, s.lon)));
    const p = page(all, q, 50, 200);
    if ('error' in p) return json(400, { error: p.error, code: p.error });
    return json(200, { stations: p.items, total: all.length, nextCursor: p.nextCursor });
  }
  if (path === '/d/v1/map') {
    const signedIn = !!auth(headers)?.accountId;
    const all = [...stations(near2).filter((s) => s.lat != null).map(hostedDto), ...partnerStations(signedIn, near2).map(partnerDto)];
    const a = mapAnswer(all, q, { enabled: true, reason: signedIn ? null : 'Sign in to charge on partner networks.' });
    return 'error' in a ? json(400, { error: a.error, code: a.error }) : json(200, a);
  }
  if (path === '/d/v1/links/resolve') {
    const raw = q.get('url') ?? '';
    const intent = parseLink(raw);
    if (intent.type === 'station') return json(200, { kind: 'site', siteId: intent.siteId });
    if (intent.type === 'receipt') return json(200, intent.kind === 'roaming' ? { kind: 'partner_receipt', cdrId: intent.id } : { kind: 'receipt', chargeId: intent.id });
    if (intent.type === 'session') return json(200, { kind: 'charge', chargeId: intent.id });
    if (intent.type === 'paid') return json(200, { kind: 'payment_return', for: intent.for });
    const code = extractChargerCode(raw) ?? '';
    const c = resolveCode(code);
    if (c) return json(200, { kind: 'connector', path: 'direct', connectorId: c.connectorId, siteId: findConnector(c.connectorId)?.station.siteId ?? null, connector: c });
    const norm = code.replace(/\*/g, '').toUpperCase();
    for (const p of partnerStations(false)) {
      const e = p.evses.find((x) => x.evseId.replace(/\*/g, '').toUpperCase() === norm);
      if (e) return json(200, { kind: 'partner_evse', path: 'roaming', name: p.name, operator: p.operator, status: e.status.toUpperCase(), partner: { partnerId: p.partnerId, countryCode: p.countryCode, partyId: p.partyId, locationId: p.locationId, evseUid: e.uid, connectorId: e.connectors[0]?.id ?? null } });
    }
    return json(404, { error: 'Unknown charger code.', code: 'not_found' });
  }
  if (path === '/d/v1/app/config') {
    const platform = q.get('platform');
    if (platform && platform !== 'ios' && platform !== 'android') return json(400, { error: 'bad platform', code: 'bad_platform' });
    return json(200, {
      platform, version: q.get('version'), build: q.get('build') ? Number(q.get('build')) : null, minSupported: '1.0.0', latest: '1.0.0', storeUrl: null, force: false, softUpdate: false,
      maintenance: { active: false, message: null },
      features: { roaming: true, reservations: true, queue: true, memberships: true, favourites: true, liveActivities: true, accountDeletion: true, applePay: false, googlePay: false, routePlanner: false },
      links: { terms: null, privacy: null, support: null, faq: null, status: null, accountDeletion: null },
      brand: null, languages: { server: ['id', 'en'], fallback: { ms: 'en', zh: 'en' } }, polling: { liveSessionS: 5, paymentS: 2 },
    });
  }
  if (path === '/d/v1/meta')
    return json(200, { map: { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 }, push: { publicKey: null }, reservations: { enabled: true, minutes: 15 } });
  if (path === '/d/v1/resolve') {
    const c = resolveCode(q.get('code') ?? '');
    return c ? json(200, c) : json(404, { error: 'not_found', message: 'Unknown charger code.' });
  }
  if (path.startsWith('/d/v1/connectors/')) {
    const f = findConnector(path.split('/').pop() ?? '');
    if (!f) return json(404, { error: 'connector not found' });
    const dev = auth(headers);
    const setup = methodsFor(f.station.currency, !!dev?.accountId);
    return json(200, {
      ...f.connector,
      station: { siteId: f.station.siteId, name: f.station.name, address: f.station.address, operator: f.station.operator, spkluId: f.station.spkluId },
      energyPriceMinor: f.site.rate,
      currency: f.station.currency,
      countryCode: f.station.countryCode,
      timezone: f.station.timezone,
      pricesIncludeTax: f.station.pricesIncludeTax,
      presetsMinor: setup.presetsMinor,
      maxPrepaidMinor: setup.maxPrepaidMinor,
      fees: f.station.currency === 'IDR' ? [{ kind: 'session', label: 'Service fee', rate: 2500 }, { kind: 'idle', label: 'Idle fee (per minute after the grace period)', rate: 1000 }] : [{ kind: 'idle', label: 'Idle fee (per minute after the grace period)', rate: 0.5 }],
      reservedForYou: dev && reservations.get(dev.id)?.connectorId === f.connector.connectorId ? { id: reservations.get(dev.id)!.id, expiresAt: reservations.get(dev.id)!.expiresAt } : null,
      canReserve: f.connector.available && !(dev && reservations.has(dev.id)),
      reservationFee: f.station.siteId === FEE_SITE ? FEE : null,
      reservationPay: null,
    });
  }
  const sq = path.match(/^\/d\/v1\/sites\/([^/]+)\/queue$/);
  if (sq) {
    const site = stations().find((s) => s.siteId === sq[1]);
    if (!site) return json(404, { error: 'Site not found.' });
    const enabled = site.siteId === QUEUE_SITE;
    const d = auth(headers);
    const mine = d ? queue.get(d.id) : undefined;
    const signedIn = !!d?.accountId || !!d?.fleet;
    const waiting = [...queue.values()].filter((e) => e.siteId === site.siteId).length;
    const reason = !enabled ? 'This site has no queue.' : !signedIn ? 'Sign in with your phone number or a fleet card to join the queue.' : mine && mine.siteId !== site.siteId ? 'You are already in a queue at another site.' : null;
    return json(200, {
      enabled, offerMinutes: 10, maxLength: 20, maxWaitMinutes: 120, waiting, full: false, freeNow: site.availableCount,
      types: [...new Map(site.connectors.map((c) => [`${c.current}|${c.type}`, { current: c.current, type: c.type, typeLabel: c.typeLabel }])).values()],
      mine: mine && mine.siteId === site.siteId ? entryView(mine) : null, canJoin: enabled && !mine && !reason, reason,
    });
  }

  const dev = auth(headers);
  if (!dev) return json(401, { error: 'device token required', code: 'no_device' });
  const account = dev.accountId ? accounts.get(dev.accountId) ?? null : null;

  if (path === '/d/v1/me') return json(200, { deviceId: dev.id, account, fleet: dev.fleet ? { uid: 'FLEET-01', orgId: uuid(4) } : null });
  if (path === '/d/v1/otp/send') {
    const phone = String(body.phone ?? '').replace(/[^\d+]/g, '');
    if (phone.length < 9) return json(400, { error: 'Invalid phone number.' });
    return json(200, { ok: true, devCode: '123456' });
  }
  if (path === '/d/v1/otp/verify') {
    if (String(body.code) !== '123456') return json(400, { error: 'Wrong code. Try again.' });
    const phone = String(body.phone);
    let acc = [...accounts.values()].find((a) => a.phone === phone);
    if (!acc) {
      acc = { id: id(), phone, name: null };
      accounts.set(acc.id, acc);
    }
    dev.accountId = acc.id;
    return json(200, { ok: true, account: acc });
  }
  if (path === '/d/v1/account/name') {
    if (!account) return json(400, { error: 'Not signed in.' });
    account.name = String(body.name ?? '').slice(0, 80);
    return json(200, { ok: true });
  }
  if (path === '/d/v1/fleet/login') {
    if (String(body.pin) !== '1234') return json(400, { error: 'Fleet card, organisation or PIN not recognised.' });
    dev.fleet = true;
    return json(200, { ok: true });
  }
  if (path === '/d/v1/signout') {
    // The device token is revoked: the next call answers 401 no_device and the app issues a fresh one.
    dev.accountId = null;
    dev.fleet = false;
    for (const [tok, d] of devices) if (d === dev) devices.delete(tok);
    return json(200, { ok: true });
  }

  // ── charging (hosted)
  if (path === '/d/v1/charge/quote' || path === '/d/v1/charge/prepaid') {
    const f = findConnector(String(body.connectorId));
    if (!f) return json(422, { ok: false, error: 'Connector not found.' });
    const amount = Number(body.amountMinor);
    const cur = f.station.currency;
    const fixed = cur === 'IDR' ? 2500 : 0;
    if (!Number.isSafeInteger(amount) || amount <= fixed) return json(422, { ok: false, error: 'This amount does not cover the fixed fees yet.', minimumViableMinor: fixed + (cur === 'IDR' ? 1000 : 100) });
    const allowanceKwh = Math.round(((amount - fixed) / 10 ** exp(cur) / f.site.rate / (cur === 'IDR' ? 1.11 : 1)) * 100) / 100;
    if (path.endsWith('/quote')) {
      return json(200, { ok: true, allowanceWh: allowanceKwh * 1000, allowanceKwh, amountMinor: amount, mdrMinor: cur === 'IDR' ? Math.round(amount * 0.007) : 0, membership: null, promotion: body.promoCode ? 'WELCOME10' : null, codeProblem: null, pricesIncludeTax: cur !== 'IDR', ...methodsFor(cur, !!account) });
    }
    if (!f.connector.available) return json(422, { ok: false, error: 'This connector is in use.' });
    const channel = String(body.method ?? (body.savedCardId ? 'CARD' : body.walletId ? 'GOPAY' : cur === 'IDR' ? 'QRIS' : 'CARD'));
    const c: Charge = {
      id: id(), deviceId: dev.id, connectorId: f.connector.connectorId, amountMinor: amount, currency: cur, channel,
      paidAt: body.savedCardId || body.walletId ? Date.now() : null, startedAt: null, stoppedAt: null, createdAt: Date.now(),
      powerKw: Math.min(f.connector.maxPowerKw, 92), rate: f.site.rate, siteName: f.station.name, connectorLabel: `${f.connector.current} ${f.connector.maxPowerKw} kW`, mode: 'prepaid',
    };
    charges.set(c.id, c);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const action = body.savedCardId || body.walletId ? 'done' : channel === 'QRIS' || channel === 'PAYNOW' ? 'qr' : 'redirect';
    const qrString = channel === 'PAYNOW'
      ? `00020101021226370009SG.PAYNOW010120213T0000000000A0301052040000530370254${String((amount / 100).toFixed(2)).length.toString().padStart(2, '0')}${(amount / 100).toFixed(2)}5802SG5915PLUGSURE DEMO6009SINGAPORE6304ABCD`
      : `00020101021226650013ID.CO.QRIS.WWW0118936009153000000000215ID10200000000000303UMI51440014ID.CO.QRIS.WWW0215ID1020000000000303UMI5204557253033605404${amount}5802ID5913PLUGSURE DEMO6007JAKARTA6304C0DE`;
    return json(200, {
      ok: true,
      chargeId: c.id,
      currency: cur,
      payment: { method: channel === 'QRIS' ? 'qris' : channel === 'PAYNOW' ? 'qr' : channel === 'CARD' ? 'card' : 'ewallet', channel, label: channel, action, checkoutUrl: action === 'redirect' ? `https://checkout.mock/pay/${c.id}` : null, providerRef: `MOCK-${c.id.slice(-6)}`, amountMinor: amount, expiresAt, hold: channel === 'CARD', postpay: !!body.walletId, savedCardId: body.savedCardId ?? null, saveCard: !!body.saveCard },
      ...(action === 'qr' ? { qr: { qrString, qrImage: '', qrPng: '', providerRef: `MOCK-${c.id.slice(-6)}`, amountMinor: amount, expiresAt } } : {}),
      startToken: 'PS' + c.id.slice(-6).toUpperCase(),
      allowanceWh: allowanceKwh * 1000,
      allowanceKwh,
      demo: true,
    });
  }
  if (path === '/d/v1/charge/fleet') {
    const f = findConnector(String(body.connectorId));
    if (!f || !dev.fleet) return json(422, { ok: false, error: 'Sign in as a fleet driver first.' });
    const c: Charge = { id: id(), deviceId: dev.id, connectorId: f.connector.connectorId, amountMinor: 0, currency: f.station.currency, channel: 'FLEET', paidAt: Date.now(), startedAt: null, stoppedAt: null, createdAt: Date.now(), powerKw: Math.min(f.connector.maxPowerKw, 92), rate: f.site.rate, siteName: f.station.name, connectorLabel: `${f.connector.current} ${f.connector.maxPowerKw} kW`, mode: 'fleet' };
    charges.set(c.id, c);
    return json(200, { ok: true, chargeId: c.id, startToken: 'FLEET-01' });
  }
  let m = path.match(/^\/d\/v1\/charge\/([^/]+)\/(confirm-payment|start|status|stop|receipt|rating|pay-unpaid)$/);
  if (m) {
    const [, cid, action] = m;
    const c = charges.get(cid!);
    if (!c && action === 'receipt' && cid!.startsWith('00000000')) return json(200, demoReceipt(cid!));
    if (!c) return json(404, { error: 'not_found' });
    if (action === 'confirm-payment') {
      c.paidAt = Date.now();
      return json(200, { ok: true });
    }
    if (action === 'start') {
      if (!c.paidAt) return json(400, { ok: false, error: 'Payment not received yet.' });
      // Single-use, like the server: once the session runs, a repeated start is refused.
      if (c.startedAt && c.startedAt <= Date.now()) return json(400, { ok: false, error: 'This session has already started.' });
      // The charger answers RemoteStart and the car draws current ~2.5 s later.
      c.startedAt = Date.now() + 2500;
      persist();
      return json(200, { ok: true, status: 'Accepted' });
    }
    if (action === 'status') return json(200, hostedStatus(c));
    if (action === 'stop') {
      c.stoppedAt = Date.now();
      return json(200, { ok: true, status: 'Accepted' });
    }
    if (action === 'rating') return json(200, { ok: true });
    if (action === 'pay-unpaid') return json(200, { kind: 'postpay', owedMinor: 0, paid: true });
    if (action === 'receipt') return json(200, receiptFor(c));
  }
  if (path === '/d/v1/history') {
    const own: HistoryItem[] = [...charges.values()].filter((c) => c.deviceId === dev.id).map((c) => {
      const s = hostedStatus(c);
      return { chargeId: c.id, mode: c.mode, siteName: c.siteName, createdAt: new Date(c.createdAt).toISOString(), state: s.state === 'charging' ? 'active' : s.state === 'rated' ? 'rated' : 'no_session', energyKwh: s.energyKwh || null, totalMinor: s.cost?.totalMinor ?? c.amountMinor, currency: c.currency };
    });
    const roam: HistoryItem[] = [...roams.values()].filter((r) => r.deviceId === dev.id).map((r) => {
      const s = roamStatus(r);
      return { kind: 'roaming', chargeId: r.id, cdrId: s.cdrId, mode: 'app', siteName: r.site, operator: r.operator, createdAt: new Date(r.createdAt).toISOString(), state: s.state === 'charging' ? 'active' : s.state === 'billed' ? 'rated' : 'starting', energyKwh: s.energyKwh || null, totalMinor: s.totalMinor, currency: r.currency };
    });
    const all = [...own, ...roam, ...(account ? SEED_HISTORY(dev.id) : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(200, { charges: all });
  }
  if (path === '/d/v1/unpaid') return json(200, { unpaid: [] });

  // ── roaming
  if (path === '/d/v1/roaming/stations') {
    return json(200, { enabled: true, mode: 'app', stations: partnerStations(!!account, near) });
  }
  if (path === '/d/v1/roaming/charge') {
    if (!account) return json(422, { ok: false, error: 'Sign in to charge on partner networks.' });
    const st = partnerStations(true).find((s) => s.partnerId === body.partnerId && s.locationId === body.locationId);
    if (!st) return json(422, { ok: false, error: 'Partner charger not found.' });
    const r: Roam = { id: id(), deviceId: dev.id, currency: st.currency ?? 'IDR', holdMinor: st.holdMinor ?? 0, createdAt: Date.now(), authorisedAt: body.savedCardId ? Date.now() : null, startedAt: null, stoppedAt: null, site: st.name, operator: st.operator, rate: st.priceFromMajor ?? 1 };
    roams.set(r.id, r);
    if (r.authorisedAt) r.startedAt = Date.now() + 4000;
    return json(200, { ok: true, chargeId: r.id, payment: { hold: true, currency: r.currency, amountMinor: r.holdMinor, action: body.savedCardId ? 'done' : 'redirect', checkoutUrl: body.savedCardId ? null : `https://checkout.mock/hold/${r.id}`, providerRef: 'HOLD-' + r.id.slice(-6), expiresAt: new Date(Date.now() + 900_000).toISOString(), savedCardId: body.savedCardId ?? null } });
  }
  m = path.match(/^\/d\/v1\/roaming\/charge\/([^/]+)\/(status|stop|rating)$/);
  if (m) {
    const r = roams.get(m[1]!);
    if (!r) return json(404, { error: 'not_found' });
    if (m[2] === 'stop') {
      r.stoppedAt = Date.now();
      return json(200, { ok: true });
    }
    if (m[2] === 'rating') return json(200, { ok: true });
    if (!r.authorisedAt && Date.now() - r.createdAt > 3000) {
      r.authorisedAt = Date.now();
      r.startedAt = Date.now() + 4000;
    }
    return json(200, roamStatus(r));
  }
  m = path.match(/^\/d\/v1\/roaming\/cdr\/([^/]+)$/);
  if (m) {
    const r = roams.get(m[1]!);
    const cur = (r?.currency ?? 'SGD') as CurrencyCode;
    const s = r ? roamStatus(r) : null;
    const total = s?.totalMinor ?? 2239;
    return json(200, {
      cdrId: m[1], reference: 'CDR-' + m[1]!.slice(-6), operator: r?.operator ?? 'Bay Charge SG', party: 'SG*LCE', siteName: r?.site ?? 'Woodlands Checkpoint EV Bay', address: '21 Woodlands Crossing, Singapore', evseId: 'SG*LCE*E1101',
      startedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), endedAt: new Date(Date.now() - 4 * 86_400_000 + 32 * 60_000).toISOString(), energyKwh: s?.energyKwh ?? 31.1, durationMin: s?.durationMin ?? 32, currency: cur,
      lines: [{ label: 'Energy', amount: total / 100, amountMinor: total }], totalExclVat: total / 100 / 1.09, totalInclVat: total / 100, totalExclVatMinor: Math.round(total / 1.09), totalInclVatMinor: total,
      hold: { amountMinor: r?.holdMinor ?? 8000, currency: cur, state: 'captured', outcome: 'captured', capturedMinor: total, shortfallMinor: null },
    });
  }

  // ── favourites, cards, push, misc
  if (path === '/d/v1/favourites' && method === 'GET') return json(200, { favourites: favourites.get(dev.id) ?? [] });
  if (path === '/d/v1/favourites' && method === 'POST') {
    const list = favourites.get(dev.id) ?? [];
    const fav = { id: id(), siteId: body.siteId ?? null, partnerId: body.partnerId ?? null, countryCode: body.countryCode ?? null, partyId: body.partyId ?? null, locationId: body.locationId ?? null };
    list.push(fav);
    favourites.set(dev.id, list);
    return json(200, { ok: true, favourite: fav });
  }
  m = path.match(/^\/d\/v1\/favourites\/([^/]+)$/);
  if (m && method === 'DELETE') {
    favourites.set(dev.id, (favourites.get(dev.id) ?? []).filter((f) => f.id !== m![1]));
    return json(200, { ok: true });
  }
  if (path === '/d/v1/cards') {
    return json(200, {
      signedIn: !!account,
      cards: account
        ? [
            { id: uuid(7001), brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029, provider: 'stripe', integrationId: uuid(6001), createdAt: new Date().toISOString(), lastUsedAt: null, expired: false, usableAt: 'PlugSure Mobility', kind: 'card', channel: null, accountLabel: null, status: 'active' },
            { id: uuid(7002), brand: 'mastercard', last4: '5100', expMonth: 3, expYear: 2028, provider: 'xendit', integrationId: uuid(6002), createdAt: new Date().toISOString(), lastUsedAt: null, expired: false, usableAt: 'Arus Kota', kind: 'card', channel: null, accountLabel: null, status: 'active' },
            { id: uuid(7101), brand: null, last4: null, expMonth: null, expYear: null, provider: 'midtrans', integrationId: uuid(6003), createdAt: new Date().toISOString(), lastUsedAt: null, expired: false, usableAt: 'Arus Kota', kind: 'ewallet', channel: 'GOPAY', accountLabel: '•• 12', status: 'active' },
          ]
        : [],
    });
  }
  m = path.match(/^\/d\/v1\/cards\/([^/]+)$/);
  if (m && method === 'DELETE') return json(200, { ok: true });
  if (path.startsWith('/d/v1/push/apns') || path.startsWith('/d/v1/push/fcm')) return json(200, { ok: true });
  if (path === '/d/v1/push') return json(200, { subscribed: false, webpush: 0, apns: 0, fcm: 0 });
  if (path === '/d/v1/live-sessions') return json(200, { ok: true, kind: 'charge' });
  if (path.startsWith('/d/v1/live-sessions/') || path.startsWith('/d/v1/live-activities')) return json(200, { ok: true });
  if (path === '/d/v1/account/delete/start') {
    if (!account) return json(400, { error: 'Invalid phone number.' });
    return json(200, { ok: true, phoneMasked: account.phone.replace(/^(\+\d{2})(\d{3})\d+(\d{4})$/, '$1 $2-****-$3'), blockers: blockersFor(dev), deleted: DELETED, retained: RETAINED, devCode: '123456' });
  }
  if (path === '/d/v1/account/delete') {
    if (!account) return json(404, { error: 'Account not found.' });
    if (String(body.code) !== '123456') return json(400, { error: 'Wrong code. Try again.' });
    const blockers = blockersFor(dev);
    if (blockers.length) return json(409, { error: 'The account cannot be deleted yet: settle unpaid charges and end charges, reservations or queue places first.', code: blockers[0]!.code, blockers });
    accounts.delete(account.id);
    favourites.delete(dev.id);
    // Every device of the account is signed out and its token revoked.
    for (const [tok, d] of devices) if (d.accountId === account.id) devices.delete(tok);
    return json(200, { ok: true, deleted: DELETED, retained: RETAINED, summary: { devicesSignedOut: 1 } });
  }
  if (path === '/d/v1/reports') return json(200, { ok: true });
  if (path === '/d/v1/reservation') return json(200, { reservation: reservations.get(dev.id) ?? null, partner: null });
  if (path === '/d/v1/reservations' && method === 'POST') {
    const f = findConnector(String(body.connectorId));
    if (!account && !dev.fleet) return json(422, { ok: false, error: 'Sign in with your phone number or a fleet card to reserve.' });
    if (!f) return json(422, { ok: false, error: 'Connector not found.' });
    if (reservations.has(dev.id)) return json(422, { ok: false, error: 'You already have a reservation. Cancel it first.' });
    if (f.station.siteId === FEE_SITE && !dev.fleet) {
      const co = { id: id(), deviceId: dev.id, connectorId: f.connector.connectorId, siteName: f.station.name, state: 'pending', totalMinor: FEE.totalMinor };
      checkouts.set(co.id, co);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const ref = `MOCK-R${co.id.slice(-5)}`;
      return json(200, {
        ok: true,
        checkout: { id: co.id, state: 'pending', feeMinor: FEE.feeMinor, taxMinor: FEE.taxMinor, totalMinor: FEE.totalMinor, siteName: f.station.name, currency: 'IDR' },
        payment: { method: 'qris', channel: 'QRIS', label: 'QRIS', action: 'qr', checkoutUrl: null, providerRef: ref, amountMinor: FEE.totalMinor, expiresAt, hold: false, postpay: false, savedCardId: null, saveCard: false },
        qr: { qrString: qris(FEE.totalMinor), qrImage: '', qrPng: '', providerRef: ref, amountMinor: FEE.totalMinor, expiresAt },
        demo: true,
      });
    }
    return json(200, { ok: true, reservation: hold(dev.id, f.connector.connectorId, f.station.name) });
  }
  m = path.match(/^\/d\/v1\/reservations\/checkout\/([^/]+)(?:\/(confirm-payment|cancel))?$/);
  if (m) {
    const co = checkouts.get(m[1]!);
    if (!co || co.deviceId !== dev.id) return json(404, { error: 'Transaction not found.' });
    if (m[2] === 'confirm-payment' && co.state === 'pending') {
      co.state = 'held';
      hold(dev.id, co.connectorId, co.siteName);
    }
    if (m[2] === 'cancel' && co.state === 'pending') co.state = 'cancelled';
    if (m[2]) return json(200, { ok: true });
    const r = reservations.get(dev.id);
    return json(200, { id: co.id, state: co.state, problem: null, totalMinor: co.totalMinor, reservation: co.state === 'held' && r ? reservationView(r) : null });
  }
  m = path.match(/^\/d\/v1\/reservations\/([^/]+)\/cancel$/);
  if (m) {
    const r = reservations.get(dev.id);
    if (!r || r.id !== m[1]) return json(404, { ok: false, error: 'Reservation not found.' });
    reservations.delete(dev.id);
    return json(200, { ok: true });
  }
  if (path === '/d/v1/queue' && method === 'GET') {
    const e = queue.get(dev.id);
    return json(200, { entry: e ? entryView(e) : null, ended: null });
  }
  if (path === '/d/v1/queue' && method === 'POST') {
    const site = stations().find((s) => s.siteId === String(body.siteId));
    if (!account && !dev.fleet) return json(422, { ok: false, error: 'Sign in with your phone number or a fleet card to join the queue.' });
    if (!site || site.siteId !== QUEUE_SITE) return json(422, { ok: false, error: site ? 'This site has no queue.' : 'Site not found.' });
    if (queue.has(dev.id)) return json(422, { ok: false, error: 'You are already in the queue.' });
    const e = { id: id(), siteId: site.siteId, siteName: site.name, joinedAt: new Date().toISOString(), want: { current: (body.current ?? null) as 'AC' | 'DC' | null, type: (body.type ?? null) as string | null } };
    queue.set(dev.id, e);
    return json(200, { ok: true, entry: entryView(e) });
  }
  m = path.match(/^\/d\/v1\/queue\/([^/]+)\/leave$/);
  if (m) {
    const e = queue.get(dev.id);
    if (!e || e.id !== m[1]) return json(404, { ok: false, error: 'Queue entry not found.' });
    queue.delete(dev.id);
    return json(200, { ok: true });
  }
  if (path === '/d/v1/memberships') return json(200, { passes: [], plans: [] });
  if (path === '/d/v1/loyalty') return json(200, { balances: [] });

  return json(404, { message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 });
}

const DELETED = ['name', 'email', 'phone (pseudonymised: replaced by a keyed hash)', 'saved_cards', 'linked_ewallets', 'favourites', 'loyalty_membership', 'pass_auto_renewal', 'devices_signed_out', 'push_tokens', 'live_activity_tokens', 'sign_in_codes'];
const RETAINED = ['charges_and_receipts (tax law: ID 10 y, MY 7 y, SG 5 y)', 'payments_and_refunds', 'invoices', 'partner_network_charge_records', 'loyalty_ledger'];

/** What stops this device's account from being deleted (§15.8). */
function blockersFor(dev: Device) {
  const out: (Record<string, unknown> & { code: string })[] = [];
  const active = [...charges.values()].filter((c) => c.deviceId === dev.id && (c.paidAt || c.mode === 'fleet') && !c.stoppedAt);
  if (active.length) out.push({ code: 'active_session', chargeIds: active.map((c) => c.id) });
  if (reservations.has(dev.id)) out.push({ code: 'active_reservation' });
  if (queue.has(dev.id)) out.push({ code: 'in_queue' });
  return out;
}

function hold(deviceId: string, connectorId: string, siteName: string) {
  const r = { id: id(), connectorId, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), siteName };
  reservations.set(deviceId, r);
  return reservationView(r);
}

function reservationView(r: { id: string; connectorId: string; expiresAt: string; siteName: string }) {
  const f = findConnector(r.connectorId);
  return { ...r, chargerName: f?.connector.chargerName ?? '', connectorNo: f?.connector.connectorNo ?? 1, state: 'active', minutesLeft: Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 60_000)), queue: false };
}

function entryView(e: { id: string; siteId: string; siteName: string; joinedAt: string; want: { current: 'AC' | 'DC' | null; type: string | null } }) {
  const ahead = [...queue.values()].filter((x) => x.siteId === e.siteId && x.joinedAt < e.joinedAt).length;
  return {
    id: e.id, siteId: e.siteId, siteName: e.siteName, state: 'waiting', joinedAt: e.joinedAt, position: ahead + 1, waiting: [...queue.values()].filter((x) => x.siteId === e.siteId).length,
    want: { ...e.want, typeLabel: e.want.type === 'cCCS2' ? 'CCS2' : e.want.type === 'cChaDeMo' ? 'CHAdeMO' : e.want.type === 'sType2' ? 'Type 2' : null },
    offerMinutes: 10, leaveBy: new Date(new Date(e.joinedAt).getTime() + 120 * 60_000).toISOString(), offer: null, endReason: null,
  };
}

function receiptFor(c: Charge) {
  const s = hostedStatus(c);
  const total = s.cost?.totalMinor ?? 0;
  const sub = s.cost?.subtotalMinor ?? 0;
  return {
    chargeId: c.id, receiptNo: 'PS-' + c.id.slice(-8).toUpperCase(), mode: c.mode, sessionId: c.id, loyalty: null,
    station: { name: c.siteName, address: 'Jakarta', spkluId: null, operator: 'Arus Kota', operatorNpwp: '01.234.567.8-901.000', operatorPkp: true, taxRegistration: null },
    connector: 'AK-SNY-01 / 1', currency: c.currency, countryCode: c.currency === 'IDR' ? 'ID' : c.currency === 'MYR' ? 'MY' : 'SG', timezone: 'Asia/Jakarta', taxScheme: null,
    pricesIncludeTax: c.currency !== 'IDR', startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null, endedAt: new Date().toISOString(), energyKwh: s.energyKwh, durationMin: s.durationMin, idleMinutes: 0,
    paymentMode: 'prepaid', prepaidAmountMinor: c.amountMinor, settlement: { refundMinor: Math.max(0, c.amountMinor - total) }, rated: true,
    lines: [{ key: 'energy', label: `Energy ${s.energyKwh} kWh`, amountMinor: sub }],
    tax: { subtotalMinor: sub, localTaxMinor: 0, localTaxRateBps: 0, taxBaseMinor: Math.round((sub * 11) / 12), ppnRateBps: 1200, ppnEffectiveRateBps: 1100, dppFraction: '11/12', taxMinor: total - sub, totalMinor: total },
    flags: [], signedData: null,
  };
}

function demoReceipt(cid: string) {
  return {
    chargeId: cid, receiptNo: 'PS-' + cid.slice(-8).toUpperCase(), mode: 'prepaid', sessionId: cid, loyalty: { earnedPoints: 98, usedPoints: 0, usedMinor: 0 },
    station: { name: 'Sudirman Tower', address: 'Jl. Jend. Sudirman Kav. 52, Jakarta Selatan', spkluId: null, operator: 'Charge Nusantara', operatorNpwp: '01.234.567.8-901.000', operatorPkp: true, taxRegistration: null },
    connector: 'CN-SDT-01 / 2', currency: 'IDR', countryCode: 'ID', timezone: 'Asia/Jakarta', taxScheme: 'ID_PPN', pricesIncludeTax: false,
    startedAt: new Date(Date.now() - 27 * 3600_000).toISOString(), endedAt: new Date(Date.now() - 27 * 3600_000 + 24 * 60_000).toISOString(), energyKwh: 38.42, durationMin: 24, idleMinutes: 0,
    paymentMode: 'prepaid', prepaidAmountMinor: 150_000, settlement: { refundMinor: 51_360 }, rated: true,
    lines: [{ key: 'energy', label: 'Energy 38.42 kWh × Rp 2,300', amountMinor: 88_366 }, { key: 'session', label: 'Service fee', amountMinor: 2_500 }],
    tax: { subtotalMinor: 90_866, localTaxMinor: 0, localTaxRateBps: 0, taxBaseMinor: 83_294, ppnRateBps: 1200, ppnEffectiveRateBps: 1100, dppFraction: '11/12', taxMinor: 7_774, totalMinor: 98_640 },
    flags: [], signedData: null,
  };
}
