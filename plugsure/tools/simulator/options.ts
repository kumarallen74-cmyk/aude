import type { VcpOptions } from './charge-point.js';

/**
 * Shared CLI plumbing for autel-sim and fleet.
 *
 * Everything the VirtualChargePoint can do is reachable from a flag, so a
 * failure seen in the field can be reproduced from a shell line and pasted into
 * a bug report verbatim.
 */

export type Args = Record<string, string | true>;

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let value: string | undefined;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      // A negative number is a value, not a flag: --clock-skew -20y.
      if (next !== undefined && (!next.startsWith('--') || /^--?\d/.test(next))) {
        value = next;
        i++;
      }
    }
    out[key] = value ?? true;
  }
  return out;
}

export const has = (a: Args, k: string): boolean => k in a && a[k] !== 'false';
export const str = (a: Args, k: string, d?: string): string | undefined => {
  const v = a[k];
  return typeof v === 'string' ? v : d;
};
export const num = (a: Args, k: string, d?: number): number | undefined => {
  const v = a[k];
  if (typeof v !== 'string') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const list = (a: Args, k: string): string[] | undefined => {
  const v = a[k];
  if (typeof v !== 'string') return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Duration with a unit suffix, signed. `-20y` boots the charger in 1970-ish
 * territory, which is exactly what a unit with a dead RTC and no NTP reports.
 */
export function parseDuration(spec: string): number {
  const m = /^([+-]?)(\d+(?:\.\d+)?)(ms|s|m|h|d|y)?$/i.exec(spec.trim());
  if (!m) throw new Error(`cannot parse duration: ${spec}`);
  const sign = m[1] === '-' ? -1 : 1;
  const value = Number(m[2]);
  const unit = (m[3] ?? 'ms').toLowerCase();
  const scale: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    y: 365.25 * 86_400_000,
  };
  return Math.round(sign * value * (scale[unit] ?? 1));
}

export function optionsFromArgs(a: Args): Partial<VcpOptions> {
  const dc = has(a, 'dc');
  const o: Partial<VcpOptions> = { dc };

  const set = <K extends keyof VcpOptions>(k: K, v: VcpOptions[K] | undefined) => {
    if (v !== undefined) o[k] = v;
  };

  set('id', str(a, 'id'));
  set('url', str(a, 'url'));
  set('connectors', num(a, 'connectors'));
  set('idTag', str(a, 'idtag') ?? str(a, 'id-tag'));
  set('vendor', str(a, 'vendor'));
  set('model', str(a, 'model'));
  set('firmware', str(a, 'firmware'));

  // reconnect
  if (has(a, 'no-reconnect')) set('reconnect', false);
  set('backoffBaseMs', num(a, 'backoff-base'));
  set('backoffMaxMs', num(a, 'backoff-max'));
  set('backoffMaxAttempts', num(a, 'backoff-attempts'));
  set('backoffJitter', num(a, 'jitter'));

  // charging model
  set('meterStartWh', num(a, 'meter-start'));
  set('speed', num(a, 'speed'));
  set('meterIntervalS', num(a, 'meter-interval'));
  set('targetKwh', num(a, 'kwh'));
  set('maxPowerW', num(a, 'max-power'));
  set('phases', num(a, 'phases'));
  set('voltage', num(a, 'voltage'));
  if (has(a, 'per-phase')) set('perPhase', true);
  set('rolloverWh', num(a, 'rollover'));
  if (has(a, 'sim-time')) set('simTime', true);

  // replay disorder
  if (has(a, 'replay-shuffle')) set('replayShuffle', true);
  if (has(a, 'replay-duplicate')) set('replayDuplicate', true);

  // faults
  const rejectKeys = list(a, 'reject-key') ?? [];
  if (has(a, 'reject-metervalues')) rejectKeys.push('MeterValuesSampledData');
  if (rejectKeys.length) set('rejectConfigKeys', rejectKeys);
  set('callErrorRate', num(a, 'callerror-rate'));
  if (has(a, 'silent')) set('silent', true);
  const skew = str(a, 'clock-skew');
  if (skew) set('clockSkewMs', parseDuration(skew));
  if (has(a, 'omit-meterstop')) set('omitMeterStop', true);
  set('transactionDataSkewWh', num(a, 'txdata-skew'));

  // transport
  set('authKey', str(a, 'auth-key'));
  if (has(a, 'wss')) set('wss', true);
  if (has(a, 'insecure')) set('insecure', true);
  set('offer', list(a, 'offer'));

  if (has(a, 'verbose')) set('verbose', true);

  return o;
}

export const COMMON_FLAG_HELP = `
  Connection
    --url <ws://host:port/ocpp>   gateway base URL (the id is appended)
    --id <identity>               OCPP identity / final path segment
    --auth-key <key>              send Authorization: Basic base64(id:key)
    --wss                         upgrade a ws:// base URL to wss://
    --insecure                    accept a self-signed certificate (local only)
    --offer ocpp1.6,ocpp2.0.1     subprotocols to offer on the upgrade

  Hardware shape
    --connectors <n>              number of connectors (default 1)
    --dc                          DC unit: 40 kW, 400 V, Power rate unit
    --phases <n> --voltage <v>    AC topology (default 3 x 230 V)
    --max-power <W>               hardware ceiling
    --meter-start <Wh>            lifetime register at boot
    --vendor/--model/--firmware   BootNotification identity

  Session
    --session                     run one scripted session then exit
    --idtag <tag>                 token to present (default ID-RFID-0001)
    --kwh <n>                     energy to deliver (default 8)
    --speed <n>                   simulated seconds per real second (default 60)
    --meter-interval <s>          simulated seconds between MeterValues
    --sim-time                    timestamps advance at --speed, not wall clock
    --per-phase                   report the energy register per phase (L1/L2/L3)
    --rollover <Wh>               wrap the energy register at this width

  Reconnect
    --no-reconnect                fail fast instead of retrying
    --backoff-base <ms>           first retry delay (default 1000)
    --backoff-max <ms>            ceiling (default 60000)
    --backoff-attempts <n>        give up after n attempts (0 = forever)
    --jitter <0..1>               jitter fraction (default 0.3)

  Offline replay
    --replay-shuffle              replay the offline queue out of order
    --replay-duplicate            replay every queued message twice

  Fault injection
    --reject-metervalues          reject MeterValuesSampledData (Autel quirk)
    --reject-key <k1,k2>          reject these ChangeConfiguration keys
    --callerror-rate <0..1>       answer this fraction of CSMS calls CALLERROR
    --silent                      accept the socket, answer nothing
    --clock-skew <-20y|+2h|...>   offset every timestamp we emit
    --omit-meterstop              omit meterStop from StopTransaction
    --txdata-skew <Wh>            make transactionData disagree with meterStop

  Misc
    --verbose                     print every frame
`;
