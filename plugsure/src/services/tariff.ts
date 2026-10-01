import { config } from '../config.js';
import { chargingClassForPowerW, type ChargingClass } from '../domain/spklu.js';
import { computeTax, type TaxResult } from './tax.js';

/**
 * Indonesian layered tariff engine.
 *
 * Two things make this different from a generic CSMS rating engine:
 *
 * 1. PLN tariffs are FORMULA-DRIVEN, not table-driven.
 *      curah (bulk)          = Q x base   0.8 <= Q <= 3     base ~ 707
 *      layanan khusus        = N x base   1.0 <= N <= 1.5   base ~ 1650 (Q3-2026 published 1645)
 *    The widely-quoted retail price of Rp 2,466-2,475/kWh is simply N = 1.5.
 *    A hardcoded rate table breaks on the next Direksi decision, and the base
 *    itself moves with quarterly tariff adjustment. Model the multiplier.
 *
 * 2. Regulatory ceilings are a HARD CONSTRAINT LAYER above operator pricing.
 *    Kepmen ESDM 182.K/TL.04/MEM.S/2023 caps the per-session service fee at
 *    Rp 25,000 (fast, >22-50 kW) and Rp 57,000 (ultrafast, >50 kW). Slow and
 *    medium are deliberately unregulated. Validate at SAVE time, not bill time.
 */

export type TouBlock = 'WBP' | 'LWBP' | 'ANY';
export type ComponentKind = 'energy' | 'time' | 'session' | 'idle' | 'admin';

export interface TariffComponent {
  kind: ComponentKind;
  /**
   * IDR per kWh (energy) / per minute (time, idle) / flat (session, admin).
   *
   * Energy only: 0 is a price — free (a "first 5 kWh free" tier). An energy
   * component billed at the PLN formula rate says so explicitly: `formulaRate`,
   * or no rate at all (null/undefined, as an API caller may send it; stored as
   * NULL, migration 051). A zero rate used to mean "formula", so a free tier on
   * a layanan khusus tariff was billed at Rp 2,467.50/kWh.
   */
  rate: number;
  /** Energy only: bill this band at the PLN formula rate (`rate` is ignored). */
  formulaRate?: boolean;
  touBlock: TouBlock;
  /** Bitmask, bit 0 = Monday. 127 = every day. */
  dayMask?: number;
  timeFrom?: string; // 'HH:MM'
  timeTo?: string;
  /**
   * Banded pricing. A tier covers [fromKwh, toKwh) and is billed on the energy
   * that falls INSIDE the band. Billing `pool - fromKwh` at each tier's own rate,
   * additively, overcharged a two-tier tariff by 57%.
   */
  fromKwh?: number;
  toKwh?: number;
  /** Grace period before an idle/time component starts accruing. */
  fromMinutes?: number;
  toMinutes?: number;
  sortOrder?: number;
}

export interface Tariff {
  id: string;
  name: string;
  currency: 'IDR';
  plnScheme?: 'curah' | 'layanan_khusus' | 'none';
  plnBaseRate?: number;
  plnMultiplier?: number;
  components: TariffComponent[];
  /**
   * Whether PPN is charged on sessions under this tariff. Defaults to true —
   * every tariff that existed before migration 009 charged PPN. Only a CPO that
   * is not PKP-registered may switch it off (the console warns otherwise).
   */
  ppnApplies?: boolean;
}

export interface RatingContext {
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  /** Connector nameplate power — determines the charging class and its ceiling. */
  connectorMaxPowerW: number;
  /** Per-municipality PBJT rate in basis points. */
  pbjtRateBps: number;
  /** Minutes the vehicle stayed plugged in after charging completed. */
  idleMinutes?: number;
  timezone?: string;
  /** Membership benefits and promotions, applied after the caps and before tax. */
  adjustments?: PriceAdjustment[];
}

export interface CdrLine {
  kind: ComponentKind;
  description: string;
  quantity: number;
  unit: string;
  unitRate: number;
  amountIdr: number;
  touBlock?: TouBlock;
  /** Set on a discount line: the membership or promotion it came from. */
  adjustment?: { source: 'subscription' | 'promotion' | 'loyalty' | 'v2x'; id: string; name: string };
}

export interface RatingResult {
  lines: CdrLine[];
  chargingClass: ChargingClass;
  tax: TaxResult;
  /** Non-fatal regulatory observations recorded on the CDR. */
  flags: RegulatoryFlag[];
  tariffSnapshot: Tariff;
}

export interface RegulatoryFlag {
  code: string;
  severity: 'info' | 'warning' | 'violation';
  message: string;
}

// ---------------------------------------------------------------- PLN formula

/**
 * Is this energy component billed at the PLN formula rate? Only when it says
 * so (formulaRate) or carries no rate. Typed as number, a rate can still arrive
 * as null/undefined from JSON (the API, a stored tariff snapshot).
 */
export function usesFormulaRate(c: Pick<TariffComponent, 'rate' | 'formulaRate'>): boolean {
  return c.formulaRate === true || c.rate == null;
}

/** Resolve the regulated energy rate from the PLN multiplier formula. */
export function plnEnergyRate(t: Pick<Tariff, 'plnScheme' | 'plnBaseRate' | 'plnMultiplier'>): number | null {
  if (!t.plnScheme || t.plnScheme === 'none') return null;
  const base =
    t.plnBaseRate ??
    (t.plnScheme === 'curah' ? config.regulatory.curahBase : config.regulatory.layananKhususBase);
  const mult = t.plnMultiplier ?? 1;
  return base * mult;
}

export function validateMultiplier(scheme: 'curah' | 'layanan_khusus', multiplier: number): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  const r = config.regulatory;
  if (scheme === 'curah' && (multiplier < r.curahQMin || multiplier > r.curahQMax)) {
    flags.push({
      code: 'PLN_Q_OUT_OF_RANGE',
      severity: 'violation',
      message: `Curah multiplier Q=${multiplier} is outside the regulated range ${r.curahQMin}-${r.curahQMax}.`,
    });
  }
  if (scheme === 'layanan_khusus' && (multiplier < 1 || multiplier > r.layananKhususNMax)) {
    flags.push({
      code: 'PLN_N_OUT_OF_RANGE',
      severity: 'violation',
      message: `Layanan khusus multiplier N=${multiplier} is outside the regulated range 1.0-${r.layananKhususNMax}. Values outside the range require Director-General approval.`,
    });
  }
  return flags;
}

/** Service-fee ceiling per session for a charging class, or null when unregulated. */
export function serviceFeeCeiling(cls: ChargingClass): number | null {
  return config.regulatory.serviceFeeCeilingIdr[cls];
}

/**
 * The regulated ceiling on the per-kWh price, in IDR.
 *
 * `plnScheme` used to gate this: setting it to `'none'` removed the ceiling
 * entirely, and a tariff at Rp 10,000/kWh — four times the legal maximum —
 * saved and billed with no flag at all. But the scheme is a property of the
 * SUPPLY, not a field the tariff author gets to opt out of. A public SPKLU in
 * Indonesia sells under layanan khusus unless it is genuinely on curah, so an
 * unstated scheme resolves to layanan khusus rather than to "unregulated".
 */
export function regulatedEnergyCeiling(t: Pick<Tariff, 'plnScheme' | 'plnBaseRate'>): number {
  if (t.plnScheme === 'curah') {
    return (t.plnBaseRate ?? config.regulatory.curahBase) * config.regulatory.curahQMax;
  }
  return (t.plnBaseRate ?? config.regulatory.layananKhususBase) * config.regulatory.layananKhususNMax;
}

/**
 * Validate a tariff against the regulatory ceilings. Call this at SAVE time so
 * an illegal tariff can never be assigned, rather than discovering it at billing.
 */
export function validateTariff(t: Tariff, connectorMaxPowerW: number): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  const cls = chargingClassForPowerW(connectorMaxPowerW);

  if (t.plnScheme && t.plnScheme !== 'none' && t.plnMultiplier != null) {
    flags.push(...validateMultiplier(t.plnScheme, t.plnMultiplier));
  }

  // Only an energy component may leave its rate out (the PLN formula rate);
  // anything else without a price cannot be billed or stored.
  for (const c of t.components) {
    if (c.kind !== 'energy' && (c.rate == null || !Number.isFinite(Number(c.rate)))) {
      flags.push({ code: 'RATE_MISSING', severity: 'violation', message: `The ${c.kind} component has no rate.` });
    }
  }

  const ceiling = serviceFeeCeiling(cls);
  if (ceiling != null) {
    // The ceiling caps the charge for the charging SERVICE, not just the
    // component that happens to be named "session". An "admin fee" levied on
    // every session is the same charge under another name, and excluding it was
    // a loophole wide enough to drive the whole fee through.
    const serviceFees = t.components
      .filter((c) => c.kind === 'session' || c.kind === 'admin')
      .reduce((a, c) => a + c.rate, 0);
    if (serviceFees > ceiling) {
      flags.push({
        code: 'SERVICE_FEE_CEILING_EXCEEDED',
        severity: 'violation',
        message:
          `Service + admin fees total Rp ${fmt(serviceFees)}, above the Rp ${fmt(ceiling)} ceiling ` +
          `for ${cls} charging (Kepmen ESDM 182.K/2023).`,
      });
    }
  }

  // Occupancy charges are commercially distinct from the biaya layanan, but they
  // are per-minute and were unbounded: an abandoned vehicle on the shipped seed
  // tariff accrued Rp 6,692,360. Require an explicit upper bound and check the
  // worst case against the platform cap.
  const idleCap = config.regulatory.idleFeeCapIdr;
  for (const c of t.components) {
    if (c.kind !== 'idle' && c.kind !== 'time') continue;
    if (c.toMinutes == null) {
      flags.push({
        code: 'UNBOUNDED_TIME_FEE',
        severity: 'violation',
        message:
          `The ${c.kind} component charges Rp ${fmt(c.rate)}/min with no to_minutes bound. ` +
          `Set an upper bound so the worst-case charge is knowable before it is billed.`,
      });
      continue;
    }
    const worst = Math.max(0, c.toMinutes - (c.fromMinutes ?? 0)) * c.rate;
    if (worst > idleCap) {
      flags.push({
        code: 'TIME_FEE_CAP_EXCEEDED',
        severity: 'violation',
        message:
          `The ${c.kind} component tops out at Rp ${fmt(worst)} per session, above the ` +
          `Rp ${fmt(idleCap)} platform cap. Lower the rate, narrow the window, or raise ` +
          `IDLE_FEE_CAP_IDR deliberately.`,
      });
    }
  }

  // The regulated ceiling applies to the rate actually billed per kWh, which is
  // the `energy` component — not to `base × multiplier`, which can only fail
  // when the multiplier is already out of range and validateMultiplier has
  // caught it. That made this check structurally unable to fire.
  const maxEnergy = regulatedEnergyCeiling(t);
  const formulaRate = plnEnergyRate(t) ?? 0;
  const billed = t.components.filter((c) => c.kind === 'energy').map((c) => (usesFormulaRate(c) ? formulaRate : c.rate));
  const worst = billed.length ? Math.max(...billed) : null;
  if (worst != null && worst > maxEnergy + 0.001) {
    flags.push({
      code: 'ENERGY_CEILING_EXCEEDED',
      severity: 'violation',
      message:
        `Energy rate Rp ${fmt(worst)}/kWh exceeds the ` +
        `${t.plnScheme === 'curah' ? 'curah' : 'layanan khusus'} ceiling of Rp ${fmt(maxEnergy)}/kWh ` +
        `(${(worst / maxEnergy).toFixed(2)}×).` +
        (t.plnScheme === 'none' || !t.plnScheme
          ? ' A tariff with no declared PLN scheme is still bound by the layanan khusus ceiling — ' +
            'the scheme is a property of the supply, not something a tariff opts out of.'
          : ''),
    });
  }

  /**
   * Overlapping ToU coverage. A kWh in a block priced by BOTH a block-specific
   * component and the ANY catch-all used to be billed twice; rating now lets the
   * specific component win, but the tariff is still ambiguous as written and the
   * operator should be told at save time rather than discovering it on an invoice.
   */
  const blocks = new Set(t.components.filter((c) => c.kind === 'energy').map((c) => c.touBlock));
  if (blocks.has('ANY') && (blocks.has('WBP') || blocks.has('LWBP'))) {
    flags.push({
      code: 'AMBIGUOUS_TOU_COVERAGE',
      severity: 'warning',
      message:
        `Energy is priced both for a specific ToU block and by an ANY component. The ` +
        `block-specific price applies and ANY covers only the remaining blocks; state both ` +
        `blocks explicitly if that is not what you meant.`,
    });
  }

  return flags;
}

// ---------------------------------------------------------------- time of use

/**
 * Classify a moment into WBP (peak) or LWBP (off-peak).
 *
 * SPKLU tariff schedules currently price both blocks the same, but the structure
 * exists in regulation, PLN already applies WBP/LWBP differentials to industrial
 * categories, and a future SPKLU differential is a plausible policy move.
 * Retrofitting ToU into a flat-rate engine is expensive; anticipating it is free.
 */
/**
 * Formatter is built ONCE. Constructing an Intl.DateTimeFormat inside the split
 * loop cost 92 us per iteration, which is how a charger with a 1970 clock could
 * block the event loop for an estimated 84 minutes and take the gateway down for
 * every other charger on it.
 */
const TZ_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = TZ_FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    TZ_FORMATTERS.set(tz, f);
  }
  return f;
}

const WEEKDAY_BIT: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

interface LocalMoment {
  minutes: number; // minutes since local midnight
  dayBit: number; // 0 = Monday
}

function localMoment(d: Date, tz: string): LocalMoment {
  const parts = formatterFor(tz).formatToParts(d);
  let hour = 0;
  let minute = 0;
  let weekday = 'Mon';
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'weekday') weekday = p.value;
  }
  return { minutes: hour * 60 + minute, dayBit: WEEKDAY_BIT[weekday] ?? 0 };
}

/**
 * Classify a moment into WBP (peak) or LWBP (off-peak).
 *
 * SPKLU tariff schedules currently price both blocks the same, but the structure
 * exists in regulation, PLN already applies WBP/LWBP differentials to industrial
 * categories, and a future SPKLU differential is a plausible policy move.
 * Retrofitting ToU into a flat-rate engine is expensive; anticipating it is free.
 */
export function touBlockAt(d: Date, tz = 'Asia/Jakarta'): 'WBP' | 'LWBP' {
  const m = localMoment(d, tz).minutes;
  return withinWindowMinutes(m, toMinutes(config.tou.wbpStart), toMinutes(config.tou.wbpEnd)) ? 'WBP' : 'LWBP';
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function withinWindowMinutes(x: number, a: number, b: number): boolean {
  return a <= b ? x >= a && x < b : x >= a || x < b; // handles windows crossing midnight
}

/** Does a component's day mask and time window admit this moment? */
export function componentAppliesAt(c: TariffComponent, d: Date, tz: string): boolean {
  const { minutes, dayBit } = localMoment(d, tz);
  const mask = c.dayMask ?? 127;
  if (((mask >> dayBit) & 1) === 0) return false;
  if (c.timeFrom && c.timeTo) {
    return withinWindowMinutes(minutes, toMinutes(c.timeFrom), toMinutes(c.timeTo));
  }
  return true;
}

/** Bound on the number of minute-slices we will ever walk. */
const MAX_SPLIT_MINUTES = 7 * 24 * 60;

export interface SessionSplit {
  /** Energy in Wh by ToU block. */
  tou: Record<'WBP' | 'LWBP', number>;
  /** Energy in Wh attributable to each component's day/time window, by index. */
  perComponent: Map<number, number>;
  /** True when the session was longer than the bound and had to be approximated. */
  truncated: boolean;
  /**
   * The same energy in CHRONOLOGICAL runs: consecutive time in one ToU block
   * under one set of applicable component windows. Tiers band on the session's
   * cumulative kWh, so rating has to know which kWh came first — the per-block
   * and per-component totals above cannot say that. Segment Wh sum to energyWh.
   */
  segments: SplitSegment[];
}

export interface SplitSegment {
  block: 'WBP' | 'LWBP';
  /** Indices (into the components passed to splitSession) whose day/time window admits this run. */
  applies: number[];
  wh: number;
}

/**
 * Apportion a session's energy across ToU blocks and per-component time windows.
 *
 * Apportioned by wall-clock time rather than measured energy per block — accurate
 * enough while SPKLU blocks are priced identically. When a real differential
 * appears, switch to apportioning from the interval meter values, which are
 * already stored per timestamp for exactly this reason.
 *
 * The walk is BOUNDED. An unbounded per-minute loop over a bad charger clock was
 * a denial of service against the whole gateway.
 */
export function splitSession(
  startedAt: Date,
  endedAt: Date,
  energyWh: number,
  components: TariffComponent[],
  tz = 'Asia/Jakarta',
): SessionSplit {
  const tou: Record<'WBP' | 'LWBP', number> = { WBP: 0, LWBP: 0 };
  const perComponent = new Map<number, number>();
  components.forEach((_, i) => perComponent.set(i, 0));

  const totalMs = Math.max(1, endedAt.getTime() - startedAt.getTime());
  const rawMinutes = Math.ceil(totalMs / 60_000);
  const truncated = rawMinutes > MAX_SPLIT_MINUTES;

  // Coarsen the slice rather than walking more of them, so cost is constant.
  const slices = Math.min(rawMinutes, MAX_SPLIT_MINUTES);
  const stepMs = totalMs / Math.max(1, slices);

  let wbpMs = 0;
  const componentMs = new Array<number>(components.length).fill(0);
  const runs: Array<{ block: 'WBP' | 'LWBP'; applies: number[]; key: string; ms: number }> = [];

  for (let i = 0; i < slices; i++) {
    const at = new Date(startedAt.getTime() + i * stepMs);
    const sliceMs = Math.min(stepMs, endedAt.getTime() - at.getTime());
    if (sliceMs <= 0) break;
    const block = touBlockAt(at, tz);
    if (block === 'WBP') wbpMs += sliceMs;
    const applies: number[] = [];
    for (let ci = 0; ci < components.length; ci++) {
      if (componentAppliesAt(components[ci]!, at, tz)) {
        componentMs[ci]! += sliceMs;
        applies.push(ci);
      }
    }
    const key = `${block}|${applies.join(',')}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.ms += sliceMs;
    else runs.push({ block, applies, key, ms: sliceMs });
  }

  tou.WBP = Math.round((energyWh * wbpMs) / totalMs);
  tou.LWBP = energyWh - tou.WBP;
  for (let ci = 0; ci < components.length; ci++) {
    perComponent.set(ci, Math.round((energyWh * componentMs[ci]!) / totalMs));
  }

  // Cumulative rounding, so the segments add up to the delivery to the watt-hour.
  const segments: SplitSegment[] = [];
  const walkedMs = runs.reduce((a, r) => a + r.ms, 0) || 1;
  let cumMs = 0;
  let cumWh = 0;
  for (const r of runs) {
    cumMs += r.ms;
    const upTo = Math.round((energyWh * cumMs) / walkedMs);
    segments.push({ block: r.block, applies: r.applies, wh: upTo - cumWh });
    cumWh = upTo;
  }

  return { tou, perComponent, truncated, segments };
}

/** Back-compatible helper retained for the existing tests. */
export function splitEnergyByTou(
  startedAt: Date,
  endedAt: Date,
  energyWh: number,
  tz = 'Asia/Jakarta',
): Record<'WBP' | 'LWBP', number> {
  return splitSession(startedAt, endedAt, energyWh, [], tz).tou;
}

// ---------------------------------------------------------------- rating

export function rateSession(tariff: Tariff, ctx: RatingContext): RatingResult {
  const tz = ctx.timezone ?? 'Asia/Jakarta';
  const cls = chargingClassForPowerW(ctx.connectorMaxPowerW);
  const flags: RegulatoryFlag[] = [];
  const lines: CdrLine[] = [];

  const durationMin = Math.max(0, (ctx.endedAt.getTime() - ctx.startedAt.getTime()) / 60_000);
  const totalKwh = ctx.energyWh / 1000;

  const components = [...tariff.components].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.fromKwh ?? 0) - (b.fromKwh ?? 0),
  );

  // One bounded walk apportions both ToU blocks and every component's own
  // day/time window. Those window fields were previously stored, typed, exposed
  // in the API — and never read, so an operator's time-of-day price silently
  // did nothing.
  const split = splitSession(ctx.startedAt, ctx.endedAt, ctx.energyWh, components, tz);
  if (split.truncated) {
    flags.push({
      code: 'SPLIT_APPROXIMATED',
      severity: 'warning',
      message: 'Session exceeded the time-of-use resolution bound; apportionment is approximate.',
    });
  }

  const regulated = plnEnergyRate(tariff);
  const energyIdx = components
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.kind === 'energy');

  // --- energy ------------------------------------------------------------
  if (energyIdx.length === 0) {
    if (regulated != null) {
      // No explicit component: bill the whole session at the regulated formula rate.
      lines.push(energyLine('Energy', totalKwh, regulated, 'ANY'));
    } else if (ctx.energyWh > 0) {
      // Energy was delivered and nothing prices it. Free electricity is a
      // configuration accident, not a business decision.
      flags.push({
        code: 'NO_ENERGY_COMPONENT',
        severity: 'violation',
        message: `${round3(totalKwh)} kWh was delivered but the tariff prices no energy.`,
      });
    }
  } else {
    /**
     * Price each delivered kWh EXACTLY ONCE.
     *
     * Two bugs lived here, and the second was created by the fix for the first.
     *
     * 1. Tiers were additive: each one billed `pool − fromKwh` at its own full
     *    rate, so a two-tier tariff overcharged by 57 %. Banding fixed that —
     *    but only when the operator set `toKwh` on the lower tier. Written the
     *    natural way (tier 1 from 0, tier 2 from 50, no upper bounds) it still
     *    double-billed everything above the step.
     *
     * 2. The band derivation then grouped peers BY ToU BLOCK, so an `ANY`
     *    component and a `WBP` component never truncated each other — and a
     *    tariff with both, created through our own API and passed by our own
     *    validator, billed a 40 kWh session as 80 kWh at 2× the regulated
     *    ceiling with a clean CDR.
     *
     * The model that makes both impossible: a delivered kWh belongs to exactly
     * one ToU block, and within that block exactly one component prices it. A
     * block-specific component beats the `ANY` catch-all — that is what "peak
     * price" means — and within the chosen set, tiers band by kWh with each
     * tier's upper bound defaulting to the next tier's lower bound.
     *
     * Two more ways the same kWh escaped that model, both proved by running
     * rateSession:
     *
     * 3. Tiers banded on EACH BLOCK'S kWh, not the session's. Tiers of 0–50 kWh
     *    at Rp 2,000 and 50+ at Rp 1,500 on a 60 kWh session split 30/30 across
     *    the 17:00 peak boundary never reached the second tier (Rp 120,000); the
     *    same session off-peak only billed Rp 115,000. A tier is a property of
     *    how much the SESSION has taken, so the bands are now walked on the
     *    cumulative kWh in chronological order and each band's kWh is split
     *    across the blocks it fell in.
     *
     * 4. A component's own time window was intersected with the whole session,
     *    never with the block being priced, so a day (06–22) and a night (22–06)
     *    component on a 20:00–24:00 session each billed their window's kWh in
     *    BOTH ToU blocks: 40 kWh invoiced for 20 delivered. The walk is now over
     *    chronological segments that carry which windows admit them, so a kWh is
     *    priced only by a component whose window covers the moment it flowed.
     */
    let pricedKwh = 0;
    const anyExists = energyIdx.some(({ c }) => c.touBlock === 'ANY');
    const flagged = new Set<string>();
    const flagOnce = (f: RegulatoryFlag) => {
      const k = `${f.code}|${f.message}`;
      if (flagged.has(k)) return;
      flagged.add(k);
      flags.push(f);
    };

    interface Band { e: { c: TariffComponent; i: number }; from: number; to: number; rate: number }
    /** Tier bands of one applicable set, computed once per distinct set. */
    const bandCache = new Map<string, Band[]>();
    const bandsFor = (applicable: Array<{ c: TariffComponent; i: number }>): Band[] => {
      const key = applicable.map((e) => e.i).join(',');
      const hit = bandCache.get(key);
      if (hit) return hit;
      const sorted = [...applicable].sort((a, b) => (a.c.fromKwh ?? 0) - (b.c.fromKwh ?? 0));
      const bands = sorted.map((e, idx) => {
        const next = sorted[idx + 1];
        const implicitTo = next ? (next.c.fromKwh ?? Infinity) : Infinity;
        const declaredTo = e.c.toKwh ?? Infinity;
        if (declaredTo > implicitTo && e.c.toKwh != null) {
          flagOnce({
            code: 'OVERLAPPING_ENERGY_TIERS',
            severity: 'warning',
            message:
              `Energy tier [${e.c.fromKwh ?? 0}, ${e.c.toKwh}) kWh overlaps the next tier, which ` +
              `starts at ${implicitTo} kWh. Billed to ${implicitTo} kWh so no energy is charged twice.`,
          });
        }
        // The PLN formula rate only where the component asks for it; a rate of 0
        // is a free band and stays free (it used to be read as "use the formula").
        const formula = usesFormulaRate(e.c);
        if (formula && regulated == null) {
          flagOnce({
            code: 'NO_FORMULA_RATE',
            severity: 'warning',
            message: 'An energy tier is priced at the PLN formula rate, but the tariff has no PLN scheme: it is billed at Rp 0.',
          });
        }
        return {
          e,
          from: e.c.fromKwh ?? 0,
          to: Math.min(declaredTo, implicitTo),
          rate: formula ? (regulated ?? 0) : e.c.rate,
        };
      });
      bandCache.set(key, bands);
      return bands;
    };

    // One line per (block, tier), in the order the energy was first priced.
    const energyLines = new Map<string, { block: TouBlock; band: string; kwh: number; rate: number }>();

    /**
     * Session Wh delivered before the segment being priced. Walked in whole Wh,
     * not summed kWh fractions, so a band edge cannot slip by a float epsilon.
     */
    let cumWh = 0;
    for (const seg of split.segments) {
      if (seg.wh <= 0) continue;
      const segFrom = cumWh;
      const segTo = cumWh + seg.wh;
      cumWh = segTo;

      // Only components whose day/time window admits this segment may price it.
      const open = energyIdx.filter(({ i }) => seg.applies.includes(i));
      // A component priced for THIS block wins over the catch-all; only if none
      // exists does `ANY` apply. Both applying is what double-billed.
      const specific = open.filter(({ c }) => c.touBlock === seg.block);
      const applicable = specific.length ? specific : open.filter(({ c }) => c.touBlock === 'ANY');
      if (applicable.length === 0) continue;

      if (specific.length && anyExists) {
        flagOnce({
          code: 'TOU_COMPONENT_SHADOWED',
          severity: 'info',
          message: `${seg.block} energy priced by its own component; the ANY component does not also apply to it.`,
        });
      }

      for (const b of bandsFor(applicable)) {
        // The part of this segment's cumulative kWh range that falls in the band.
        const billable = Math.max(0, Math.min(segTo, b.to * 1000) - Math.max(segFrom, b.from * 1000)) / 1000;
        if (billable <= 0) continue;
        pricedKwh += billable;
        const band =
          b.from === 0 && b.to === Infinity
            ? ''
            : ` ${round3(b.from)}\u2013${b.to === Infinity ? '\u221e' : round3(b.to)} kWh`;
        const key = `${seg.block}|${b.e.i}|${b.from}|${b.to}`;
        const acc = energyLines.get(key);
        if (acc) acc.kwh += billable;
        else energyLines.set(key, { block: seg.block, band, kwh: billable, rate: b.rate });
      }
    }
    for (const l of energyLines.values()) {
      lines.push(energyLine(`Energy (${l.block})${l.band}`, l.kwh, l.rate, l.block));
    }

    // Every delivered kWh must be priced by something. A WBP-only tariff on an
    // off-peak session previously billed zero and said nothing.
    const unpriced = totalKwh - pricedKwh;
    if (unpriced > 0.001 && ctx.energyWh > 0) {
      flags.push({
        code: 'UNPRICED_ENERGY',
        severity: 'violation',
        message: `${round3(unpriced)} kWh of ${round3(totalKwh)} kWh delivered falls outside every energy component.`,
      });
    }
    // ...and no kWh may be priced twice. There was a detector for underpricing
    // and none for overpricing, which is the direction that reaches a customer.
    if (pricedKwh - totalKwh > 0.001) {
      flags.push({
        code: 'DOUBLE_PRICED_ENERGY',
        severity: 'violation',
        message:
          `${round3(pricedKwh)} kWh was priced against a ${round3(totalKwh)} kWh delivery. ` +
          `The invoice cannot be reconciled against the meter.`,
      });
    }
  }

  // --- the rate actually charged, against the regulated ceiling -------------
  //
  // The save-time check compares the highest COMPONENT rate. That misses every
  // way the rate a customer actually pays can exceed the ceiling without any
  // single component doing so — overlapping components, a stacked ToU price, a
  // tariff with `plnScheme: 'none'`. This checks the arithmetic mean the invoice
  // implies, which is the number a regulator would compute.
  const billedEnergyIdr = lines
    .filter((l) => l.kind === 'energy')
    .reduce((a, l) => a + l.amountIdr, 0);
  const energyCeiling = regulatedEnergyCeiling(tariff);
  if (totalKwh > 0.001) {
    const effectiveRate = billedEnergyIdr / totalKwh;
    if (effectiveRate > energyCeiling + 0.5) {
      flags.push({
        code: 'ENERGY_CEILING_EXCEEDED',
        severity: 'violation',
        message:
          `The invoice charges Rp ${fmt(effectiveRate)}/kWh against a Rp ${fmt(energyCeiling)}/kWh ` +
          `ceiling (${(effectiveRate / energyCeiling).toFixed(2)}\u00d7).`,
      });
    }
  }

  // --- time --------------------------------------------------------------
  //
  // CHARGING time, not plug-in time. Billing the whole duration charged the idle
  // minutes here AND again on the idle line below, so overstay was paid twice
  // whenever a tariff had both. Idle minutes are the tail after the last
  // material increase (sessions.ts computeIdleMinutes), so they come off the top.
  const chargingMin = Math.max(0, durationMin - (ctx.idleMinutes ?? 0));
  for (const c of components.filter((x) => x.kind === 'time')) {
    const upper = c.toMinutes ?? Infinity;
    const billable = Math.max(0, Math.min(chargingMin, upper) - (c.fromMinutes ?? 0));
    if (billable <= 0) continue;
    lines.push({
      kind: 'time',
      description: 'Charging time',
      quantity: round3(billable),
      unit: 'min',
      unitRate: c.rate,
      amountIdr: Math.round(billable * c.rate),
      touBlock: c.touBlock,
    });
  }

  // --- idle / overstay ---------------------------------------------------
  const idle = ctx.idleMinutes ?? 0;
  for (const c of components.filter((x) => x.kind === 'idle')) {
    const upper = c.toMinutes ?? Infinity;
    const billable = Math.max(0, Math.min(idle, upper) - (c.fromMinutes ?? 0));
    if (billable <= 0) continue;
    lines.push({
      kind: 'idle',
      description: `Idle fee (after ${c.fromMinutes ?? 0} min grace)`,
      quantity: round3(billable),
      unit: 'min',
      unitRate: c.rate,
      amountIdr: Math.round(billable * c.rate),
    });
  }

  /**
   * A session that delivered nothing owes nothing.
   *
   * A charger that faults sixty seconds after StartTransaction produced a
   * Rp 29,138 invoice — a full biaya layanan plus admin fee for zero kWh. That
   * is a straightforward chargeback and a BPKN complaint, and it is exactly the
   * kind of charge that makes a driver stop using a network. The threshold is
   * configurable because "delivered nothing" is a commercial judgement, not a
   * physical one: a few watt-hours of handshake is not a charging session.
   */
  const deliveredNothing = ctx.energyWh < config.limits.minBillableWh;
  if (deliveredNothing && (components.some((c) => c.kind === 'session' || c.kind === 'admin'))) {
    flags.push({
      code: 'NO_ENERGY_DELIVERED',
      severity: 'warning',
      message:
        `${ctx.energyWh} Wh was delivered, below the ${config.limits.minBillableWh} Wh billable ` +
        `minimum. Fixed fees were not charged.`,
    });
  }

  // --- session and admin fees -------------------------------------------
  let sessionFeeTotal = 0;
  for (const c of components.filter((x) => x.kind === 'session')) {
    if (deliveredNothing) continue;
    sessionFeeTotal += c.rate;
    lines.push({
      kind: 'session',
      description: 'Service fee (biaya layanan)',
      quantity: 1,
      unit: 'session',
      unitRate: c.rate,
      amountIdr: Math.round(c.rate),
    });
  }
  for (const c of components.filter((x) => x.kind === 'admin')) {
    if (deliveredNothing) continue;
    lines.push({
      kind: 'admin',
      description: 'Admin fee',
      quantity: 1,
      unit: 'session',
      unitRate: c.rate,
      amountIdr: Math.round(c.rate),
    });
  }

  // --- caps: enforced on the invoice, not merely observed -------------------
  //
  // Both caps below used to be flag-only: the illegal amount was still billed,
  // with a note attached that nothing read. They are now applied to the invoice
  // as explicit negative lines, so the customer is never charged above the cap
  // and the adjustment is visible and auditable rather than folded into another
  // line. A tariff that trips either of these is misconfigured and the session
  // is flagged for review; capping is the safety net, not the fix.
  const ceiling = serviceFeeCeiling(cls);

  // 1. Kepmen ESDM 182.K/2023 biaya layanan ceiling. `admin` is inside it: an
  //    admin fee charged on every session is the same charge under another name.
  const serviceLineTotal = lines
    .filter((l) => l.kind === 'session' || l.kind === 'admin')
    .reduce((a, l) => a + l.amountIdr, 0);
  if (ceiling != null && serviceLineTotal > ceiling) {
    const excess = serviceLineTotal - ceiling;
    lines.push({
      kind: 'session',
      description: `Service-fee cap adjustment (Kepmen ESDM 182.K/2023, ${cls})`,
      quantity: 1,
      unit: 'session',
      unitRate: -excess,
      amountIdr: -excess,
    });
    flags.push({
      // WARNING, not violation, and the distinction is the whole point of the
      // cap. A violation blocks CDR creation, so the negative line added above
      // could never actually reach an invoice — the customer got no bill at all
      // instead of a correctly capped one, and the session sat parked forever
      // because nothing in the system could re-rate it. The invoice is now
      // right; what is wrong is the TARIFF, and that is raised separately.
      code: 'SERVICE_FEE_CEILING_EXCEEDED',
      severity: 'warning',
      message:
        `Service + admin fees totalled Rp ${fmt(serviceLineTotal)}, above the Rp ${fmt(ceiling)} ` +
        `ceiling for ${cls} charging. Capped; Rp ${fmt(excess)} was not billed. The assigned ` +
        `tariff is illegal as written and must be corrected.`,
    });
  }

  // 2. Occupancy cap. This is what turned a 60 kWh delivery into Rp 6,692,360.
  const idleCap = config.regulatory.idleFeeCapIdr;
  const timeLineTotal = lines
    .filter((l) => l.kind === 'idle' || l.kind === 'time')
    .reduce((a, l) => a + l.amountIdr, 0);
  if (timeLineTotal > idleCap) {
    const excess = timeLineTotal - idleCap;
    lines.push({
      kind: 'idle',
      description: 'Occupancy-fee cap adjustment',
      quantity: 1,
      unit: 'session',
      unitRate: -excess,
      amountIdr: -excess,
    });
    flags.push({
      // Warning for the same reason as above: the invoice has been corrected, so
      // it should be issued. The tariff is what needs attention.
      code: 'TIME_FEE_CAP_EXCEEDED',
      severity: 'warning',
      message:
        `Idle/time charges totalled Rp ${fmt(timeLineTotal)} over ${round3(idle)} idle minutes, ` +
        `above the Rp ${fmt(idleCap)} per-session cap. Capped; Rp ${fmt(excess)} was not billed.`,
    });
  }
  if (tariff.plnScheme && tariff.plnScheme !== 'none' && tariff.plnMultiplier != null) {
    flags.push(...validateMultiplier(tariff.plnScheme, tariff.plnMultiplier));
  }
  if (ctx.energyWh < 0) {
    flags.push({
      code: 'NEGATIVE_ENERGY',
      severity: 'violation',
      message: `Session reports ${ctx.energyWh} Wh delivered.`,
    });
  }

  // --- memberships and promotions -------------------------------------------
  // After the caps (a discount never makes a capped fee legal or illegal) and
  // before tax (PBJT-TL and PPN are levied on what the customer actually pays).
  if (ctx.adjustments?.length) applyAdjustments(lines, ctx.adjustments, totalKwh);

  const subtotalIdr = lines.reduce((a, l) => a + l.amountIdr, 0);
  // PBJT is a tax on electricity, so it needs to know which part of the invoice
  // IS electricity. Passing the whole subtotal taxed the service fee too.
  const energyIdr = lines.filter((l) => l.kind === 'energy').reduce((a, l) => a + l.amountIdr, 0);
  const tax = computeTax({
    subtotalIdr,
    energyIdr,
    pbjtRateBps: ctx.pbjtRateBps,
    ppnApplies: tariff.ppnApplies !== false,
  });

  return { lines, chargingClass: cls, tax, flags, tariffSnapshot: structuredClone(tariff) };
}

/**
 * Inverse rating for the QRIS pre-purchase flow: given a rupiah amount the driver
 * has already paid, how much energy may the charger deliver?
 *
 * This inverts the unknown-amount problem instead of fighting it, which is the
 * only workable answer on a rail with no pre-authorisation.
 *
 * Returns 0 when the fixed fees alone already exceed the payment — the caller
 * must refuse the sale rather than take money for nothing.
 */
/**
 * The allowance to actually SELL, as opposed to the one a best-case quote
 * produces.
 *
 * `energyAllowanceWh` answers "how much energy does Rp X buy under exactly these
 * circumstances". Checkout used it with a guess — a 45-minute session, no idle
 * time, the ToU block in force at that moment — and the real session then
 * diverged: the car sat for an hour, or the session crossed into the WBP peak
 * block. Measured shortfalls ran to Rp 58,552 per session, uncollectable from a
 * walk-up guest who has no card on file.
 *
 * A pre-purchase is a RESERVATION, so it has to reserve the worst case: the most
 * expensive ToU block the session could reach, and the idle fee it could accrue
 * before the connector frees up. Under-promising is recoverable — the surplus is
 * settled afterwards. Over-promising is not.
 */
export function conservativeAllowanceWh(
  tariff: Tariff,
  amountIdr: number,
  ctx: Omit<RatingContext, 'energyWh' | 'idleMinutes'>,
  maxWh = 500_000,
): number {
  // The most idle time this tariff can bill.
  const worstIdle = tariff.components
    .filter((c) => c.kind === 'idle')
    .reduce((a, c) => Math.max(a, (c.toMinutes ?? 0) - (c.fromMinutes ?? 0)), 0);

  // A window that lands squarely inside the peak block, so a WBP price applies
  // if the tariff has one. Same duration, so per-minute components are unchanged.
  const durationMs = ctx.endedAt.getTime() - ctx.startedAt.getTime();
  const tz = ctx.timezone ?? 'Asia/Jakarta';
  const peakStart = atLocalTime(ctx.startedAt, config.tou.wbpStart, tz);
  const peakCtx = { ...ctx, startedAt: peakStart, endedAt: new Date(peakStart.getTime() + durationMs) };

  const candidates = [
    energyAllowanceWh(tariff, amountIdr, { ...ctx, idleMinutes: worstIdle }, maxWh),
    energyAllowanceWh(tariff, amountIdr, { ...peakCtx, idleMinutes: worstIdle }, maxWh),
  ];
  return Math.min(...candidates);
}

/**
 * The allowance to sell for a DRIVER-FACING prepaid top-up.
 *
 * `conservativeAllowanceWh` reserves the full worst-case idle window, which is
 * correct when an operator wants to never under-collect from a walk-up — but it
 * makes small top-ups impossible: on the seed tariff a Rp 50,000 purchase bought
 * ZERO energy because ~Rp 90,000 of potential idle fee was reserved against it.
 *
 * That reservation is wrong for THIS flow. A prepaid session stops the moment its
 * energy allowance is delivered (the prepaid enforcement module throttles at 90%
 * and issues RemoteStop at 100%), so the session has ENDED before any meaningful
 * idle time can accrue. What must still be reserved is the worst ENERGY price the
 * session could reach — the peak ToU block — plus a small idle buffer to cover the
 * brief gap between hitting the target and the charger actually stopping.
 */
export function driverAllowanceWh(
  tariff: Tariff,
  amountIdr: number,
  ctx: Omit<RatingContext, 'energyWh' | 'idleMinutes'>,
  maxWh = 500_000,
): number {
  // A small idle buffer: the grace period plus fifteen minutes, so the brief
  // throttle-to-stop gap is covered without pricing out a modest top-up.
  const grace = tariff.components
    .filter((c) => c.kind === 'idle')
    .reduce((a, c) => Math.max(a, c.fromMinutes ?? 0), 0);
  const idleBuffer = grace + 15;

  const durationMs = ctx.endedAt.getTime() - ctx.startedAt.getTime();
  const tz = ctx.timezone ?? 'Asia/Jakarta';
  const peakStart = atLocalTime(ctx.startedAt, config.tou.wbpStart, tz);
  const peakCtx = { ...ctx, startedAt: peakStart, endedAt: new Date(peakStart.getTime() + durationMs) };

  // Reserve the worse of "now" and "the peak block", each with the small buffer.
  return Math.min(
    energyAllowanceWh(tariff, amountIdr, { ...ctx, idleMinutes: idleBuffer }, maxWh),
    energyAllowanceWh(tariff, amountIdr, { ...peakCtx, idleMinutes: idleBuffer }, maxWh),
  );
}

/** The next occurrence of a local wall-clock time, on the same local day as `ref`. */
function atLocalTime(ref: Date, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ref);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Shift `ref` by the difference between its local time and the target time.
  const deltaMin = (h! * 60 + (m ?? 0)) - (get('hour') * 60 + get('minute'));
  return new Date(ref.getTime() + deltaMin * 60_000);
}

export function energyAllowanceWh(
  tariff: Tariff,
  amountIdr: number,
  ctx: Omit<RatingContext, 'energyWh'>,
  maxWh = 500_000,
): number {
  // If zero energy already costs more than was paid, no allowance exists.
  const floor = rateSession(tariff, { ...ctx, energyWh: 0 });
  if (floor.tax.totalIdr > amountIdr) return 0;

  // Expand the upper bound only as far as needed, so a cheap tariff is not
  // silently capped at the default ceiling.
  let hi = 1_000;
  while (hi < maxWh && rateSession(tariff, { ...ctx, energyWh: hi }).tax.totalIdr <= amountIdr) {
    hi *= 2;
  }
  hi = Math.min(hi, maxWh);

  let lo = 0;
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === lo) break;
    if (rateSession(tariff, { ...ctx, energyWh: mid }).tax.totalIdr <= amountIdr) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- memberships and promotions

/**
 * A price change from a membership or a promotion. Several may apply, in
 * order (the membership first); each works on what the earlier ones left.
 */
export interface PriceAdjustment {
  /** v2x: the credit for energy a car gave back (bidirectional charging). */
  source: 'subscription' | 'promotion' | 'loyalty' | 'v2x';
  id: string;
  name: string;
  /** Member / promo price per kWh: energy is billed at this rate where it is lower. */
  energyRateIdr?: number | null;
  /** Basis points off the energy. */
  energyPercentOffBps?: number | null;
  /** kWh free, at the session's average energy price. */
  freeKwh?: number | null;
  /** Service and admin fees waived. */
  waiveSessionFees?: boolean;
  /** Rupiah off: from the energy first, then from the fees. */
  amountOffIdr?: number | null;
}

const sumOf = (lines: CdrLine[], kinds: ComponentKind[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + l.amountIdr, 0);

/**
 * Add each adjustment as negative lines of the kind it reduces (energy, or
 * service fee), so PBJT-TL still sees the true energy amount. Nothing goes
 * below zero. Mutates and returns `lines`.
 */
export function applyAdjustments(lines: CdrLine[], adjustments: PriceAdjustment[], totalKwh: number): CdrLine[] {
  for (const a of adjustments) {
    const tag = { source: a.source, id: a.id, name: a.name };
    const discount = (kind: ComponentKind, amount: number, what: string) => {
      const avail = sumOf(lines, kind === 'energy' ? ['energy'] : ['session', 'admin']);
      const x = Math.min(Math.round(amount), avail);
      if (x <= 0) return 0;
      lines.push({ kind, description: `${a.name}: ${what}`, quantity: 1, unit: 'session', unitRate: -x, amountIdr: -x, adjustment: tag });
      return x;
    };
    if (a.energyRateIdr != null && totalKwh > 0) {
      const energy = sumOf(lines, ['energy']);
      const target = Math.round(totalKwh * a.energyRateIdr);
      if (energy > target) discount('energy', energy - target, `energy at Rp ${fmt(a.energyRateIdr)}/kWh`);
    }
    if (a.freeKwh && totalKwh > 0) {
      const energy = sumOf(lines, ['energy']);
      const kwh = Math.min(a.freeKwh, totalKwh);
      discount('energy', (energy / totalKwh) * kwh, `${round3(kwh)} kWh included`);
    }
    if (a.energyPercentOffBps) {
      discount('energy', (sumOf(lines, ['energy']) * a.energyPercentOffBps) / 10_000, `${a.energyPercentOffBps / 100}% off energy`);
    }
    if (a.waiveSessionFees) discount('session', sumOf(lines, ['session', 'admin']), 'service fee waived');
    if (a.amountOffIdr) {
      const fromEnergy = discount('energy', a.amountOffIdr, `Rp ${fmt(a.amountOffIdr)} off`);
      if (a.amountOffIdr - fromEnergy > 0) discount('session', a.amountOffIdr - fromEnergy, `Rp ${fmt(a.amountOffIdr)} off`);
    }
  }
  return lines;
}

/** What each adjustment took off, from the lines it produced. */
export function adjustmentTotals(lines: CdrLine[]): Map<string, { source: 'subscription' | 'promotion' | 'loyalty' | 'v2x'; name: string; discountIdr: number }> {
  const m = new Map<string, { source: 'subscription' | 'promotion' | 'loyalty' | 'v2x'; name: string; discountIdr: number }>();
  for (const l of lines) {
    if (!l.adjustment) continue;
    const e = m.get(l.adjustment.id) ?? { source: l.adjustment.source, name: l.adjustment.name, discountIdr: 0 };
    e.discountIdr += -l.amountIdr;
    m.set(l.adjustment.id, e);
  }
  return m;
}

// ---------------------------------------------------------------- helpers

function energyLine(description: string, kwh: number, rate: number, touBlock: TouBlock): CdrLine {
  return {
    kind: 'energy',
    description,
    quantity: round3(kwh),
    unit: 'kWh',
    unitRate: rate,
    amountIdr: Math.round(kwh * rate),
    touBlock,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n);
