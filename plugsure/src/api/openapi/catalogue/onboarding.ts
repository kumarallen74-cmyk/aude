import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

const T = 'Onboarding' as const;
const DT = { type: 'string', format: 'date-time' };

export const schemas: Record<string, Schema> = {
  OnboardingCharger: {
    type: 'object',
    required: ['ocpp_identity', 'status', 'stage', 'online'],
    properties: {
      ocpp_identity: { type: 'string' }, display_name: nullable('string'), vendor: nullable('string'), model: nullable('string'), serial: nullable('string'),
      ocpp_version: nullable('string'), status: { type: 'string' }, security_profile: { type: 'integer' }, boot_count: { type: 'integer' },
      last_seen_at: nullable('string', { format: 'date-time' }), created_at: DT, site_name: { type: 'string' },
      cert_auto_upgrade: { type: 'boolean', description: 'Zero-touch certificate pending: the charger will be asked for its CSR and moved to Profile 3.' },
      has_certificate: { type: 'boolean' }, has_key: { type: 'boolean' },
      client_cert_not_after: nullable('string', { format: 'date-time' }), client_cert_source: nullable('string'),
      last_attempt: { type: ['object', 'null'], description: 'The last connection attempt: ts, outcome, detail.' },
      online: { type: 'boolean' },
      stage: {
        type: 'string', enum: ['waiting', 'registered', 'refused', 'awaiting_activation', 'certificate_in_progress', 'needs_certificate', 'connected'],
        description: 'Where the charger is: waiting for its first connection, refused at the handshake, connected but not activated, getting its certificate, or connected.',
      },
    },
  },
  ChargerCa: {
    type: 'object',
    required: ['source', 'subject', 'fingerprint', 'notAfter', 'certificatePem', 'certificateDays', 'proxy'],
    properties: {
      source: { type: 'string', enum: ['builtin', 'file'], description: 'PlugSure\'s own CA, or yours (CHARGER_CA_CERT_FILE / CHARGER_CA_KEY_FILE).' },
      subject: { type: 'string' }, fingerprint: { type: 'string' }, notAfter: DT, certificatePem: { type: 'string' },
      certificateDays: { type: 'integer', description: 'Default validity of charger certificates.' },
      csmsRootPem: { type: ['string', 'null'], description: 'The OCPP host\'s TLS root handed to chargers (CSMS_ROOT_CA_FILE), or null for a public CA.' },
      proxy: { type: 'object', properties: { caddy: { type: 'string' }, gateway: { type: 'string' } } },
    },
  },
  StationCertificate: {
    type: 'object',
    required: ['ocpp_identity', 'security_profile', 'bound', 'online'],
    properties: {
      ocpp_identity: { type: 'string' }, display_name: nullable('string'), site_name: { type: 'string' }, site_id: { type: 'string', format: 'uuid' },
      security_profile: { type: 'integer' }, status: { type: 'string' }, ocpp_version: nullable('string'), cert_auto_upgrade: { type: 'boolean' },
      bound: { type: 'boolean', description: 'A certificate is bound to the charger.' }, serial: nullable('string'), not_after: nullable('string', { format: 'date-time' }),
      source: { type: ['string', 'null'], enum: ['plugsure_ca', 'plugsure_ca_csr', 'ocpp_csr', 'vault', 'external', null] },
      rotating: { type: 'boolean', description: 'A new certificate was installed; the previous one is accepted until the charger uses the new one.' },
      last_request: { type: ['object', 'null'], description: 'The latest certificate request: state, requested_at, delivered_at, error.' },
      online: { type: 'boolean' },
    },
  },
};

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/onboarding', tag: T, summary: 'Chargers being onboarded',
    description: 'Chargers registered in the last 90 days, with where each one is: waiting for its first connection, refused at the handshake (with the reason), connected but not yet activated, getting its certificate, or connected.',
    responses: {
      200: {
        description: 'Chargers and counts',
        schema: {
          type: 'object', required: ['chargers', 'counts'],
          properties: {
            chargers: arrayOf(ref('OnboardingCharger')),
            counts: { type: 'object', properties: { total: { type: 'integer' }, connected: { type: 'integer' }, waiting: { type: 'integer' }, refused: { type: 'integer' }, certificateInProgress: { type: 'integer' }, needsCertificate: { type: 'integer' } } },
          },
        },
      },
    },
  },
  {
    method: 'GET', path: '/v1/charger-ca', tag: T, summary: 'The charging-station CA',
    description: 'The CA that issues chargers\' client certificates (Security Profile 3), created on first use. The TLS terminator must trust it; the answer includes a Caddy snippet.',
    responses: { 200: { description: 'The CA', schema: ref('ChargerCa') } },
  },
  {
    method: 'GET', path: '/v1/charger-ca/ca.pem', tag: T, summary: 'Download the charging-station CA certificate',
    responses: { 200: { description: 'PEM file (attachment).', contentType: 'application/x-pem-file', schema: { type: 'string' } } },
  },
  {
    method: 'GET', path: '/v1/station-certificates', tag: T, summary: 'Chargers\' client certificates',
    description: 'Every charger with a client certificate, on Profile 3, or getting one: where the certificate came from, its serial and expiry, and the latest request. Certificates from PlugSure\'s CA are renewed over OCPP before they expire, with an alert two weeks before.',
    responses: { 200: { description: 'Certificates', schema: { type: 'object', required: ['certificates'], properties: { certificates: arrayOf(ref('StationCertificate')) } } } },
  },
  {
    method: 'POST', path: '/v1/charge-points/:identity/certificate/request', tag: T, summary: 'Ask a charger for a new client certificate',
    pathParams: { identity: 'OCPP identity.' },
    description: 'ExtendedTriggerMessage(SignChargePointCertificate) on OCPP 1.6, TriggerMessage(SignChargingStationCertificate) on 2.0.1. The charger sends a CSR; PlugSure signs it and installs the certificate with CertificateSigned. The previous certificate stays accepted until the charger uses the new one.',
    responses: { 200: { description: 'The charger\'s answer', schema: { type: 'object', properties: { status: { type: ['string', 'null'] } } } } },
    errors: [404, 409],
  },
];
