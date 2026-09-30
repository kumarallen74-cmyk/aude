/**
 * OCPP configuration key catalog — the plain-English layer of the Configuration
 * Key Studio (SPEC-UI-CSMS-2026-FINAL Module 6).
 *
 * A charger answers GetConfiguration with bare key names and string values. An
 * operator needs to know what each one DOES, what shape the value takes, and
 * which ones the platform relies on. This catalog is that knowledge; keys a
 * charger reports that are not in it (vendor extensions) still render, as
 * category "Vendor".
 *
 * `v201` maps a 1.6 key onto its OCPP 2.0.1 device-model component/variable so
 * the same studio can read and write a 2.0.1 charging station through
 * GetVariables / SetVariables.
 */

export type ConfigCategory =
  | 'Core'
  | 'Smart Charging'
  | 'Security'
  | 'Metrology'
  | 'Networking'
  | 'Local Auth'
  | 'Vendor';

export type ConfigType = 'integer' | 'boolean' | 'csl' | 'string';

export interface ConfigKeyInfo {
  key: string;
  category: ConfigCategory;
  type: ConfigType;
  unit?: string;
  description: string;
  /** The value PlugSure provisions (ocpp/provisioning.ts DESIRED_CONFIG), if any. */
  managed?: boolean;
  /** Changing this usually needs a reboot on real hardware. */
  rebootHint?: boolean;
  /** Never readable: the charger must not return it, and the studio never shows it. */
  writeOnly?: boolean;
  v201?: { component: string; variable: string };
}

const K = (info: ConfigKeyInfo): ConfigKeyInfo => info;

export const CONFIG_CATALOG: ConfigKeyInfo[] = [
  // ---------------------------------------------------------------- Networking
  K({ key: 'HeartbeatInterval', category: 'Networking', type: 'integer', unit: 's', managed: true,
      description: 'How often the charger sends a Heartbeat when idle. Too long and a dead link is noticed late; too short wastes 4G data.',
      v201: { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' } }),
  K({ key: 'WebSocketPingInterval', category: 'Networking', type: 'integer', unit: 's', managed: true,
      description: 'WebSocket ping interval. Keeps carrier NAT sessions open and detects half-open sockets. 0 disables.',
      v201: { component: 'OCPPCommCtrlr', variable: 'WebSocketPingInterval' } }),
  K({ key: 'TransactionMessageAttempts', category: 'Networking', type: 'integer', managed: true,
      description: 'How many times the charger retries a transaction message the CSMS did not acknowledge. Protects billing across outages.' }),
  K({ key: 'TransactionMessageRetryInterval', category: 'Networking', type: 'integer', unit: 's', managed: true,
      description: 'Wait between transaction message retries (multiplied by the attempt number on most firmware).',
      v201: { component: 'OCPPCommCtrlr', variable: 'MessageAttemptInterval' } }),
  K({ key: 'ResetRetries', category: 'Networking', type: 'integer',
      description: 'Times the charger retries an unsuccessful reset before giving up.',
      v201: { component: 'OCPPCommCtrlr', variable: 'ResetRetries' } }),
  K({ key: 'GetConfigurationMaxKeys', category: 'Networking', type: 'integer',
      description: 'Maximum number of keys the charger returns in one GetConfiguration response. Read-only on most units.' }),

  // ---------------------------------------------------------------- Core
  K({ key: 'ConnectionTimeOut', category: 'Core', type: 'integer', unit: 's', managed: true,
      description: 'After authorisation, how long the driver has to plug in before the authorisation is cancelled.',
      v201: { component: 'TxCtrlr', variable: 'EVConnectionTimeOut' } }),
  K({ key: 'AuthorizeRemoteTxRequests', category: 'Core', type: 'boolean',
      description: 'Whether a RemoteStartTransaction must still be authorised locally (Authorize.req) before charging begins.',
      v201: { component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart' } }),
  K({ key: 'StopTransactionOnInvalidId', category: 'Core', type: 'boolean', managed: true,
      description: 'Stop a running transaction when the CSMS later reports the idTag as invalid (e.g. a blocked RFID card).',
      v201: { component: 'TxCtrlr', variable: 'StopTxOnInvalidId' } }),
  K({ key: 'StopTransactionOnEVSideDisconnect', category: 'Core', type: 'boolean',
      description: 'End the transaction when the cable is unplugged at the vehicle side.',
      v201: { component: 'TxCtrlr', variable: 'StopTxOnEVSideDisconnect' } }),
  K({ key: 'UnlockConnectorOnEVSideDisconnect', category: 'Core', type: 'boolean',
      description: 'Release the connector lock automatically when the vehicle-side plug is removed.' }),
  K({ key: 'MaxEnergyOnInvalidId', category: 'Core', type: 'integer', unit: 'Wh',
      description: 'Energy the charger may still deliver after an idTag turns out to be invalid mid-session.' }),
  K({ key: 'MinimumStatusDuration', category: 'Core', type: 'integer', unit: 's',
      description: 'A status must persist this long before a StatusNotification is sent. Suppresses flapping.' }),
  K({ key: 'ConnectorPhaseRotation', category: 'Core', type: 'csl',
      description: 'Phase rotation per connector relative to the grid connection (e.g. 0.RST,1.RST).' }),
  K({ key: 'NumberOfConnectors', category: 'Core', type: 'integer',
      description: 'Number of physical connectors the charger reports. Read-only.' }),
  K({ key: 'SupportedFeatureProfiles', category: 'Core', type: 'csl',
      description: 'OCPP feature profiles this firmware implements (Core, SmartCharging, FirmwareManagement, LocalAuthListManagement…). Read-only.' }),
  K({ key: 'BlinkRepeat', category: 'Core', type: 'integer',
      description: 'Times the charger blinks its lights when asked to (vendor-dependent).' }),
  K({ key: 'LightIntensity', category: 'Core', type: 'integer', unit: '%',
      description: 'Status light intensity, where supported.' }),
  K({ key: 'ReserveConnectorZeroSupported', category: 'Core', type: 'boolean',
      description: 'Whether a reservation may target the whole station (connector 0). Read-only.' }),

  // ---------------------------------------------------------------- Metrology
  K({ key: 'MeterValueSampleInterval', category: 'Metrology', type: 'integer', unit: 's', managed: true,
      description: 'Interval of in-session MeterValues. Drives the live energy display and prepaid enforcement accuracy.',
      v201: { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval' } }),
  K({ key: 'MeterValuesSampledData', category: 'Metrology', type: 'csl', managed: true,
      description: 'Measurands sent in periodic in-session MeterValues (energy register, power, current, voltage, SoC).',
      v201: { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' } }),
  K({ key: 'StopTxnSampledData', category: 'Metrology', type: 'csl', managed: true,
      description: 'Measurands included in StopTransaction transactionData. The energy register here is what billing trusts.',
      v201: { component: 'SampledDataCtrlr', variable: 'TxEndedMeasurands' } }),
  K({ key: 'ClockAlignedDataInterval', category: 'Metrology', type: 'integer', unit: 's', managed: true,
      description: 'Interval of clock-aligned meter readings (e.g. 900 = every quarter hour), used for grid reporting.',
      v201: { component: 'AlignedDataCtrlr', variable: 'Interval' } }),
  K({ key: 'MeterValuesAlignedData', category: 'Metrology', type: 'csl',
      description: 'Measurands sent in clock-aligned MeterValues.',
      v201: { component: 'AlignedDataCtrlr', variable: 'Measurands' } }),
  K({ key: 'StopTxnAlignedData', category: 'Metrology', type: 'csl',
      description: 'Clock-aligned measurands included in StopTransaction transactionData.',
      v201: { component: 'AlignedDataCtrlr', variable: 'TxEndedMeasurands' } }),
  K({ key: 'MeterValuesSampledDataMaxLength', category: 'Metrology', type: 'integer',
      description: 'Maximum number of measurands the charger accepts in MeterValuesSampledData. Read-only.' }),

  // ---------------------------------------------------------------- Local Auth
  K({ key: 'LocalAuthListEnabled', category: 'Local Auth', type: 'boolean', managed: true,
      description: 'Use the Local Authorization List pushed by the CSMS (SendLocalList). Essential for charging during WAN outages.',
      v201: { component: 'LocalAuthListCtrlr', variable: 'Enabled' } }),
  K({ key: 'LocalAuthorizeOffline', category: 'Local Auth', type: 'boolean', managed: true,
      description: 'While offline, authorise idTags found in the local list or cache.',
      v201: { component: 'AuthCtrlr', variable: 'LocalAuthorizeOffline' } }),
  K({ key: 'LocalPreAuthorize', category: 'Local Auth', type: 'boolean',
      description: 'While online, start charging immediately for locally-known idTags without waiting for the CSMS.',
      v201: { component: 'AuthCtrlr', variable: 'LocalPreAuthorize' } }),
  K({ key: 'AllowOfflineTxForUnknownId', category: 'Local Auth', type: 'boolean', managed: true,
      description: 'While offline, allow ANY idTag to charge. Keep false on public chargers: unknown cards would charge for free.',
      v201: { component: 'AuthCtrlr', variable: 'OfflineTxForUnknownIdEnabled' } }),
  K({ key: 'AuthorizationCacheEnabled', category: 'Local Auth', type: 'boolean',
      description: 'Cache recently authorised idTags on the charger. ClearCache empties it.',
      v201: { component: 'AuthCacheCtrlr', variable: 'Enabled' } }),
  K({ key: 'LocalAuthListMaxLength', category: 'Local Auth', type: 'integer',
      description: 'Maximum entries the Local Authorization List can hold. Read-only.' }),
  K({ key: 'SendLocalListMaxLength', category: 'Local Auth', type: 'integer',
      description: 'Maximum entries per SendLocalList message. Read-only.' }),

  // ---------------------------------------------------------------- Smart Charging
  K({ key: 'ChargeProfileMaxStackLevel', category: 'Smart Charging', type: 'integer',
      description: 'Highest charging-profile stack level the charger supports. Load management uses 5, prepaid 9. Read-only.',
      v201: { component: 'SmartChargingCtrlr', variable: 'ProfileStackLevel' } }),
  K({ key: 'ChargingScheduleAllowedChargingRateUnit', category: 'Smart Charging', type: 'csl',
      description: 'Units the charger accepts in charging profiles: Current (A) and/or Power (W). Read-only.',
      v201: { component: 'SmartChargingCtrlr', variable: 'RateUnit' } }),
  K({ key: 'ChargingScheduleMaxPeriods', category: 'Smart Charging', type: 'integer',
      description: 'Maximum periods per charging schedule. Read-only.',
      v201: { component: 'SmartChargingCtrlr', variable: 'PeriodsPerSchedule' } }),
  K({ key: 'MaxChargingProfilesInstalled', category: 'Smart Charging', type: 'integer',
      description: 'Maximum charging profiles the charger can hold at once. Read-only.' }),
  K({ key: 'ConnectorSwitch3to1PhaseSupported', category: 'Smart Charging', type: 'boolean',
      description: 'Whether the charger can switch between three-phase and single-phase charging. Read-only.' }),

  // ---------------------------------------------------------------- Security
  K({ key: 'SecurityProfile', category: 'Security', type: 'integer', rebootHint: true,
      description: 'OCPP security profile the charger uses: 1 Basic auth, 2 Basic auth over TLS, 3 mutual TLS. Change via the Security tab, never here — the order of key and profile changes matters.',
      v201: { component: 'SecurityCtrlr', variable: 'SecurityProfile' } }),
  K({ key: 'AuthorizationKey', category: 'Security', type: 'string', writeOnly: true,
      description: 'HTTP Basic password for profiles 1–2. Write-only; issue it from the Security tab so PlugSure stores its hash.' }),
  K({ key: 'CpoName', category: 'Security', type: 'string',
      description: 'CPO name the charger expects in the CSMS certificate (profiles 2–3).',
      v201: { component: 'SecurityCtrlr', variable: 'OrganizationName' } }),
  K({ key: 'AdditionalRootCertificateCheck', category: 'Security', type: 'boolean',
      description: 'Require a new CSMS root certificate to be signed by the previous one.' }),
  K({ key: 'CertificateStoreMaxLength', category: 'Security', type: 'integer',
      description: 'Maximum certificates the charger can store. Read-only.' }),
  K({ key: 'CertificateSignedMaxChainSize', category: 'Security', type: 'integer',
      description: 'Maximum size (bytes) of a certificate chain the charger accepts. Read-only.' }),
  // ISO 15118 Plug & Charge (OCPP 1.6: the OCA application note's keys).
  K({ key: 'ISO15118PnCEnabled', category: 'Security', type: 'boolean',
      description: 'ISO 15118 Plug & Charge: the car identifies itself with its contract certificate. Switch on from Plug & Charge → Chargers.',
      v201: { component: 'ISO15118Ctrlr', variable: 'PnCEnabled' } }),
  K({ key: 'CentralContractValidationAllowed', category: 'Security', type: 'boolean',
      description: 'Let the charger send the contract certificate to the CSMS when it cannot validate it itself (no MO root installed).',
      v201: { component: 'ISO15118Ctrlr', variable: 'CentralContractValidationAllowed' } }),
  K({ key: 'ContractValidationOffline', category: 'Security', type: 'boolean',
      description: 'Let the charger accept a contract certificate it validated locally while the CSMS is unreachable.',
      v201: { component: 'ISO15118Ctrlr', variable: 'ContractValidationOffline' } }),
];

const BY_KEY = new Map(CONFIG_CATALOG.map((c) => [c.key, c]));

export function catalogEntry(key: string): ConfigKeyInfo | undefined {
  return BY_KEY.get(key);
}

/** 1.6 key -> 2.0.1 component/variable. `Component.Variable` passes through as given. */
export function to201Variable(key: string): { component: string; variable: string } | null {
  const hit = BY_KEY.get(key)?.v201;
  if (hit) return hit;
  const dot = key.indexOf('.');
  if (dot > 0 && dot < key.length - 1) return { component: key.slice(0, dot), variable: key.slice(dot + 1) };
  return null;
}

/** 2.0.1 component/variable -> the 1.6 key the studio shows. */
export function from201Variable(component: string, variable: string): string {
  for (const c of CONFIG_CATALOG) {
    if (c.v201 && c.v201.component === component && c.v201.variable === variable) return c.key;
  }
  return `${component}.${variable}`;
}

/** Keys the studio asks a 2.0.1 station for when it has no key list of its own. */
export function default201Keys(): string[] {
  return CONFIG_CATALOG.filter((c) => c.v201).map((c) => c.key);
}

/**
 * Light client-side-equivalent validation, so an obviously wrong value is refused
 * before it is sent to hardware. The charger remains the authority.
 */
export function validateConfigValue(key: string, value: string): string | null {
  if (value.length > 500) return 'value is longer than the OCPP maximum of 500 characters';
  const info = BY_KEY.get(key);
  if (!info) return null;
  if (info.writeOnly) return `${key} is write-only and must be set from the Security tab`;
  if (info.type === 'integer' && !/^-?\d+$/.test(value.trim())) return `${key} must be an integer`;
  if (info.type === 'boolean' && !/^(true|false)$/i.test(value.trim())) return `${key} must be true or false`;
  return null;
}

/** Categories in display order. */
export const CONFIG_CATEGORIES: ConfigCategory[] = [
  'Core', 'Smart Charging', 'Security', 'Metrology', 'Networking', 'Local Auth', 'Vendor',
];
