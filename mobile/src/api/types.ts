/**
 * Wire types of the PlugSure driver API (`/d/v1`, plugsure/src/driver/*). Field names and meanings follow the
 * server exactly. Types for endpoints that do not exist yet (spec §14 G1–G9) are marked `[§14 Gx]` and are the
 * app's proposal — re-check them against spec §15 when the backend lands.
 */
export type CurrencyCode = 'IDR' | 'MYR' | 'SGD';
export type CountryCode = 'ID' | 'MY' | 'SG';

/** Connector status as `stations.ts toConnectorView` reports it. */
export type ConnectorStatus =
  | 'Available'
  | 'Charging'
  | 'Occupied'
  | 'Faulted'
  | 'Offline'
  | 'Blocked'
  | 'Maintenance'
  | 'Unavailable'
  | 'Reserved'
  | 'Queued';

export interface Reliability {
  /** 0–100 from real start/stop outcomes over `basis` [§14 G9]. */
  score: number | null;
  label: 'reliable' | 'mixed' | 'new' | 'issue';
  basis: '30d';
  lastSuccessAt: string | null;
  lastIssueAt?: string | null;
}

export interface ConnectorView {
  connectorId: string;
  ocppIdentity: string;
  chargerName: string;
  connectorNo: number;
  type: string;
  typeLabel: string;
  current: 'AC' | 'DC';
  maxPowerW: number;
  maxPowerKw: number;
  chargingClass: string;
  status: ConnectorStatus;
  available: boolean;
  blockedReason: string | null;
  reliability?: Reliability | null;
}

export interface StationView {
  siteId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  spkluId: string | null;
  operator: string;
  distanceKm: number | null;
  connectors: ConnectorView[];
  availableCount: number;
  totalCount: number;
  maxPowerKw: number;
  fastest: string;
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  currency: CurrencyCode;
  countryCode: CountryCode;
  timezone: string | null;
  pricesIncludeTax: boolean;
  reliability?: Reliability | null;
}

export interface Fee {
  kind: 'session' | 'admin' | 'idle' | 'time' | string;
  label: string;
  /** Rates per minute in major units; session/admin fees in minor units (server comment). */
  rate: number;
}

export interface PaymentMethodChoice {
  channel: Channel;
  method: 'qris' | 'qr' | 'bank' | 'ewallet' | 'card';
  label: string;
}

export type Channel = 'QRIS' | 'GOPAY' | 'SHOPEEPAY' | 'OVO' | 'DANA' | 'LINKAJA' | 'CARD' | 'PAYNOW' | 'FPX' | 'GRABPAY';

export interface SavedCardBrief {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth?: number | null;
  expYear?: number | null;
}

export interface LinkedWallet {
  id: string;
  channel: Channel | null;
  accountLabel: string | null;
  postpay: boolean;
}

/** `paymentSetupFor` — what the operator at this connector accepts and what the driver has saved there. */
export interface PaymentSetup {
  currency: CurrencyCode;
  presetsMinor: number[];
  maxPrepaidMinor: number;
  paymentMethods: PaymentMethodChoice[];
  cardHolds: boolean;
  canSaveCard: boolean;
  savedCards: SavedCardBrief[];
  linkableWallets: Channel[];
  linkedWallets: LinkedWallet[];
  walletPostpay: boolean;
  postpayLimitIdr: number | null;
  postpayBlocked: string | null;
}

export interface ConnectorDetail extends ConnectorView {
  station: { siteId: string; name: string; address: string | null; operator: string; spkluId: string | null };
  /** Energy rate per kWh in MAJOR units of `currency` (server naming is historical). */
  energyPriceMinor: number | null;
  currency: CurrencyCode;
  countryCode: CountryCode;
  timezone: string | null;
  pricesIncludeTax: boolean;
  presetsMinor: number[];
  maxPrepaidMinor: number;
  fees: Fee[];
  reservedForYou: { id: string; expiresAt: string } | null;
  canReserve: boolean;
  reservationFee: { feeMinor: number; taxMinor: number; totalMinor: number; fleetInvoice: boolean; currency: CurrencyCode } | null;
  reservationPay: Record<string, unknown> | null;
  /** [§14 G15] the saved cards this connector's acquirer can charge. */
  acceptsCardIds?: string[];
}

export interface QuoteOk extends PaymentSetup {
  ok: true;
  allowanceWh: number;
  allowanceKwh: number;
  amountMinor: number;
  mdrMinor: number;
  membership: string | null;
  promotion: string | null;
  codeProblem: string | null;
  pricesIncludeTax: boolean;
}

export interface QuoteFail {
  ok: false;
  error: string;
  minimumViableMinor?: number;
}

export type Quote = QuoteOk | QuoteFail;

export interface PaymentView {
  method: string;
  channel: Channel | string;
  label: string;
  action: 'qr' | 'redirect' | 'push' | 'done';
  checkoutUrl: string | null;
  providerRef: string;
  amountMinor: number;
  expiresAt: string;
  hold: boolean;
  postpay: boolean;
  savedCardId: string | null;
  saveCard: boolean;
}

export interface QrPayload {
  qrString: string;
  qrImage: string;
  qrPng: string;
  providerRef: string;
  amountMinor: number;
  expiresAt: string;
}

export interface CheckoutResult {
  ok: boolean;
  error?: string;
  code?: string;
  minimumViableMinor?: number;
  chargeId?: string;
  currency?: CurrencyCode;
  qr?: QrPayload;
  payment?: PaymentView;
  startToken?: string;
  allowanceWh?: number;
  allowanceKwh?: number;
  demo?: boolean;
}

export interface PayRequest {
  method?: Channel;
  phone?: string;
  savedCardId?: string;
  saveCard?: boolean;
  walletId?: string;
  /** [§14 G11] where the acquirer returns the driver; ignored by today's server (it returns to /app/paid.html). */
  returnUrl?: string;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** OCPP RemoteStart answer: Accepted | Rejected | Offline | Unreachable. */
  status?: string;
  /** The charger was not reachable: the driver presents this token at the charger. */
  presentToken?: string;
}

export interface RefundInfo {
  state: 'due' | 'processing' | 'refunded' | 'failed';
  amountMinor: number;
  reason: string | null;
  reference: string | null;
  refundedAt: string | null;
}

export type HostedState =
  | 'awaiting_payment'
  | 'awaiting_start'
  | 'charging'
  | 'finishing'
  | 'ended'
  | 'rated'
  | 'refund_pending'
  | 'refunded'
  | 'released'
  | 'unknown';

export interface LiveCost {
  totalMinor: number;
  subtotalMinor: number;
  taxTotalMinor: number;
  discountMinor: number;
  idleFeeMinor: number;
  idleMinutes: number;
  asOf: string;
  final: boolean;
}

export interface HostedStatus {
  state: HostedState;
  refund?: RefundInfo | null;
  chargeId: string;
  mode: 'prepaid' | 'fleet' | 'postpay' | string;
  energyKwh: number;
  powerKw: number | null;
  durationMin: number;
  startedAt: string | null;
  amountMinor: number | null;
  allowanceKwh: number | null;
  progressPct: number | null;
  estimatedMinor: number | null;
  cost?: LiveCost | null;
  currency: CurrencyCode;
  siteName: string;
  connectorLabel: string;
  hasReceipt: boolean;
  /** Present when the charger reports it (V2X / ISO 15118); the server exposes it under v2x today. */
  v2x?: { socPercent: number | null } | null;
  /** [§14 G3] state of charge when reported by the car. */
  socPercent?: number | null;
}

export type RoamingState = 'paying' | 'starting' | 'rejected' | 'charging' | 'finishing' | 'billed';

export interface RoamingHold {
  amountMinor: number;
  currency: string;
  state: string;
  holdState: string | null;
  capturedMinor: number | null;
  checkoutUrl: string | null;
}

export interface RoamingStatus {
  chargeId: string;
  state: RoamingState;
  problem: string | null;
  energyKwh: number;
  durationMin: number;
  startedAt: string | null;
  totalMinor: number | null;
  currency: string | null;
  hold: RoamingHold | null;
  cdrId: string | null;
  siteName: string;
  operator: string;
  connectorLabel: string;
  canStop: boolean;
}

export interface RoamingEvse {
  uid: string;
  evseId: string;
  status: string;
  available: boolean;
  connectors: { id: string; typeLabel: string; current: 'AC' | 'DC'; maxPowerKw: number | null }[];
}

export interface RoamingStation {
  partnerId: string;
  countryCode: string;
  partyId: string;
  locationId: string;
  name: string;
  address: string | null;
  city: string | null;
  operator: string;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
  evses: RoamingEvse[];
  availableCount: number;
  totalCount: number;
  fastest: string | null;
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  priceCurrency: string | null;
  vatPercent: number | null;
  currency: CurrencyCode | null;
  startable: boolean;
  reason: string | null;
  holdMinor: number | null;
  savedCards: SavedCardBrief[];
  reasonCode?: 'sign_in' | 'payment' | 'fleet_limit' | 'unavailable' | null;
  /** stale partner data (no status update for 24 h). */
  lastUpdated?: string | null;
  openingTimes?: { twentyfourseven: boolean; openNow?: boolean | null } | null;
  reliability?: Reliability | null;
}

export interface RoamingStations {
  enabled: boolean;
  reason?: string;
  mode?: 'app' | 'fleet';
  stations: RoamingStation[];
}

export interface RoamingStartRequest {
  partnerId: string;
  countryCode: string;
  partyId: string;
  locationId: string;
  evseUid: string;
  connectorId?: string;
  savedCardId?: string;
  saveCard?: boolean;
  /** Where the hosted card page returns: the app's `<scheme>://paid` (G11). */
  returnUrl?: string;
}

export interface RoamingStartResult {
  ok: boolean;
  chargeId?: string;
  error?: string;
  code?: string;
  payment?: {
    hold: true;
    currency: string;
    amountMinor: number;
    action: 'redirect' | 'done' | 'qr' | 'push';
    checkoutUrl: string | null;
    providerRef: string;
    expiresAt: string;
    savedCardId: string | null;
  };
}

export interface ReceiptLine {
  key?: string;
  /** Partner-network (roaming) receipts and the demo backend send a ready label. */
  label?: string;
  /** Hosted receipts (`/d/v1/charge/:id/receipt`) send the tariff line as rated: kind + English description. */
  kind?: 'energy' | 'session' | 'admin' | 'idle' | 'time' | string;
  description?: string;
  touBlock?: string;
  adjustment?: { source?: string } | null;
  quantity?: number;
  unit?: string;
  rate?: number;
  amountMinor: number;
  [k: string]: unknown;
}

export interface HostedReceipt {
  chargeId: string;
  receiptNo: string;
  mode: string;
  sessionId: string | null;
  loyalty: { earnedPoints: number; usedPoints: number; usedMinor: number } | null;
  station: {
    name: string;
    address: string | null;
    spkluId: string | null;
    operator: string;
    operatorNpwp: string | null;
    operatorPkp: boolean;
    taxRegistration: { label: string; number: string } | null;
  };
  connector: string;
  currency: CurrencyCode;
  countryCode: CountryCode;
  timezone: string | null;
  taxScheme: string | null;
  pricesIncludeTax: boolean;
  startedAt: string | null;
  endedAt: string | null;
  energyKwh: number;
  durationMin: number;
  idleMinutes: number;
  paymentMode: string | null;
  prepaidAmountMinor: number | null;
  settlement: Record<string, unknown> | null;
  rated: boolean;
  lines: ReceiptLine[];
  tax: {
    subtotalMinor: number;
    localTaxMinor: number;
    localTaxRateBps: number;
    taxBaseMinor: number;
    ppnRateBps: number;
    ppnEffectiveRateBps: number;
    dppFraction: string;
    taxMinor: number;
    totalMinor: number;
  } | null;
  flags: string[];
  signedData: { status: string | null; meterSerial: string | null; signedEnergyKwh: number | null; values: number } | null;
}

export interface RoamingReceipt {
  cdrId: string;
  reference: string;
  operator: string;
  party: string;
  siteName: string;
  address: string;
  evseId: string | null;
  startedAt: string;
  endedAt: string;
  energyKwh: number;
  durationMin: number;
  currency: string;
  lines: { label: string; amount: number; amountMinor: number | null }[];
  totalExclVat: number;
  totalInclVat: number | null;
  totalExclVatMinor: number | null;
  totalInclVatMinor: number | null;
  hold: {
    amountMinor: number;
    currency: string;
    state: string | null;
    outcome: string | null;
    capturedMinor: number | null;
    shortfallMinor: number | null;
  } | null;
}

export interface HistoryItem {
  kind?: 'roaming';
  chargeId: string | null;
  cdrId?: string | null;
  mode: string;
  siteName: string;
  address?: string | null;
  operator?: string;
  createdAt: string;
  state: string;
  refundState?: string | null;
  refundMinor?: number | null;
  energyKwh: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMin?: number | null;
  totalMinor: number | null;
  currency: CurrencyCode | string | null;
}

export interface HistoryPage {
  charges: HistoryItem[];
  /** [§14 G14] */
  nextCursor?: string | null;
  totals?: { currency: string; totalMinor: number; kwh: number }[];
}

export interface UnpaidItem {
  chargeId: string;
  kind: 'postpay' | 'expired_hold' | 'roaming';
  owedMinor: number;
  site: string;
  endedAt: string;
  currency: CurrencyCode;
}

export interface Account {
  id: string;
  phone: string;
  name: string | null;
}

export interface Me {
  deviceId: string;
  account: Account | null;
  fleet: { uid: string; orgId: string } | null;
}

export interface Meta {
  map: { tileUrl: string; attribution: string; maxZoom: number };
  push: { publicKey: string | null };
  reservations: { enabled: boolean; minutes: number };
}

export interface Favourite {
  id: string;
  siteId: string | null;
  partnerId: string | null;
  countryCode: string | null;
  partyId: string | null;
  locationId: string | null;
}

export interface DriverCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  provider: string;
  integrationId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expired: boolean;
  usableAt: string;
  kind: 'card' | 'ewallet';
  channel: Channel | null;
  accountLabel: string | null;
  status: string;
}

/** §15.3 `GET /d/v1/app/config` — version gate, maintenance, remote features, links, brand. */
export interface AppConfig {
  platform: 'ios' | 'android' | null;
  version: string | null;
  build: number | null;
  minSupported: string | null;
  latest: string | null;
  storeUrl: string | null;
  force: boolean;
  softUpdate: boolean;
  maintenance: { active: boolean; message: string | null };
  features: Record<string, boolean>;
  links: { terms?: string | null; privacy?: string | null; support?: string | null; faq?: string | null; status?: string | null; accountDeletion?: string | null };
  brand: { slug: string; name: string; shortName: string; supportEmail: string | null; supportPhone: string | null; privacyUrl: string | null; termsUrl: string | null; accent: string; scope: 'network' | 'operator' } | null;
  languages?: { server: string[]; fallback: Record<string, string> };
  polling?: { liveSessionS: number; paymentS: number };
}

/** §15.4 `GET /d/v1/stations?bbox&near&limit&cursor` (paged answer). */
export interface StationsPage {
  stations: StationView[];
  total: number;
  nextCursor: string | null;
}

/** §15.4 a station on the map (hosted and partner merged). */
export interface MapStationDto {
  id: string;
  kind: 'hosted' | 'partner';
  path: 'direct' | 'roaming';
  siteId?: string;
  name: string;
  operator: string;
  address: string | null;
  lat: number;
  lon: number;
  distanceKm: number | null;
  availableCount: number;
  totalCount: number;
  maxPowerKw: number | null;
  dc: boolean;
  connectorTypes: string[];
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  currency: CurrencyCode | null;
  pricesIncludeTax: boolean | null;
  startable: boolean;
  reason: string | null;
  reasonCode: 'sign_in' | 'payment' | 'fleet_limit' | 'unavailable' | null;
  partner?: { partnerId: string; countryCode: string; partyId: string; locationId: string; holdMinor: number | null };
  /** [§14 G9] not built yet. */
  reliability?: Reliability | null;
}

export interface MapCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  available: number;
  bbox: [number, number, number, number];
  expansionZoom: number;
}

/** §15.4 `GET /d/v1/map`. */
export interface MapViewport {
  zoom: number;
  bbox: [number, number, number, number];
  clusters: MapCluster[];
  stations: MapStationDto[];
  total: number;
  unclustered: number;
  nextCursor: string | null;
  partners: { enabled: boolean; reason: string | null } | null;
}

/** §15.5 `GET /d/v1/links/resolve`. */
export type LinkResolution =
  | { kind: 'connector'; path: 'direct'; connectorId: string; siteId: string | null; connector: ConnectorView }
  | {
      kind: 'partner_evse';
      path: 'roaming';
      name: string;
      operator: string | null;
      status: string | null;
      partner: { partnerId: string; countryCode: string; partyId: string; locationId: string; evseUid: string; connectorId: string | null };
    }
  | { kind: 'site'; siteId: string }
  | { kind: 'charge'; chargeId: string }
  | { kind: 'receipt'; chargeId: string }
  | { kind: 'partner_receipt'; cdrId: string }
  | { kind: 'payment_return'; for: string | null };

/** §15.8 why an account cannot be deleted yet. */
export type DeletionBlocker =
  | { code: 'unpaid'; unpaid: { chargeId: string; kind: string; owedMinor: number; currency: string; site: string }[] }
  | { code: 'active_session'; chargeIds: string[] }
  | { code: 'open_hold'; chargeIds: string[] }
  | { code: 'active_reservation' }
  | { code: 'in_queue' };

export interface DeletionStart {
  ok: true;
  phoneMasked: string;
  blockers: DeletionBlocker[];
  deleted: string[];
  retained: string[];
  devCode?: string;
}

/** Reservations (`driver/reservations.ts`). */
export interface ReservationView {
  id: string;
  connectorId: string;
  siteName: string;
  chargerName: string;
  connectorNo: number;
  state: string;
  expiresAt: string;
  minutesLeft: number;
  queue: boolean;
}

export interface ReservationCheckout {
  id: string;
  state: string;
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
  siteName: string;
  currency?: CurrencyCode;
}

export interface ReserveResult {
  ok: boolean;
  error?: string;
  code?: string;
  reservation?: ReservationView;
  checkout?: ReservationCheckout;
  payment?: PaymentView;
  qr?: QrPayload;
  demo?: boolean;
}

/** Site queues (`driver/queue.ts`). */
export interface QueueEntryView {
  id: string;
  siteId: string;
  siteName: string;
  state: 'waiting' | 'offered' | 'missed' | 'expired' | 'removed' | string;
  joinedAt: string;
  position: number | null;
  waiting: number;
  want: { current: 'AC' | 'DC' | null; type: string | null; typeLabel: string | null };
  offerMinutes: number;
  leaveBy: string;
  offer: { reservationId: string; connectorId: string; chargerName: string; connectorNo: number; expiresAt: string; minutesLeft: number } | null;
  endReason: string | null;
}

export interface SiteQueueView {
  enabled: boolean;
  offerMinutes: number;
  maxLength: number;
  maxWaitMinutes: number;
  waiting: number;
  full: boolean;
  freeNow: number;
  types: { current: 'AC' | 'DC'; type: string; typeLabel: string }[];
  mine: QueueEntryView | null;
  canJoin: boolean;
  reason: string | null;
}

export type ProblemCategory = 'broken' | 'blocked' | 'payment' | 'cable' | 'other';
