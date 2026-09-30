import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

const T = 'Plug & Charge' as const;
const DT = { type: 'string', format: 'date-time' };
const status = (d: string): Schema => ({ type: ['string', 'null'], description: d });

const hashData: Schema = {
  type: 'object',
  required: ['hashAlgorithm', 'issuerNameHash', 'issuerKeyHash', 'serialNumber'],
  properties: {
    hashAlgorithm: { type: 'string', enum: ['SHA256', 'SHA384', 'SHA512'] },
    issuerNameHash: { type: 'string', description: 'Hex hash of the issuer\'s distinguished name.' },
    issuerKeyHash: { type: 'string', description: 'Hex hash of the issuer\'s public key.' },
    serialNumber: { type: 'string', description: 'Serial number, hex, no leading zeros.' },
  },
};

export const schemas: Record<string, Schema> = {
  PncSettings: {
    type: 'object',
    required: ['enabled', 'acceptWhenOcspUnavailable'],
    properties: {
      enabled: { type: 'boolean', description: 'Plug & Charge is on for the organisation. Off: contracts are refused and certificate requests answered Failed.' },
      acceptWhenOcspUnavailable: { type: 'boolean', description: 'Accept a contract when its OCSP responder cannot be reached (the charger validated the chain).' },
    },
  },
  PncOverview: {
    type: 'object',
    required: ['settings', 'pki', 'counts'],
    properties: {
      settings: ref('PncSettings'),
      pki: {
        type: 'object', required: ['mode', 'description', 'problem'],
        properties: { mode: { type: 'string', enum: ['none', 'mock', 'http'] }, description: { type: 'string' }, problem: nullable('string') },
      },
      counts: {
        type: 'object',
        properties: {
          contracts: { type: 'integer' }, active_contracts: { type: 'integer' }, chargers: { type: 'integer' }, trust_anchors: { type: 'integer' },
          authorizations_30d: { type: 'integer' }, accepted_30d: { type: 'integer' },
        },
      },
    },
  },
  PncContract: {
    type: 'object',
    required: ['id', 'emaid', 'emaid_display', 'status', 'account_type'],
    properties: {
      id: { type: 'string', format: 'uuid', description: 'The contract\'s token id (RFID centre, fleet accounts and memberships use it as for a card).' },
      emaid: { type: 'string', description: 'eMAID without separators.' },
      emaid_display: { type: 'string', description: 'eMAID as CC-PPP-IIIIIIIII[-C].' },
      status: { type: 'string', description: 'Accepted, or Blocked when cancelled.' },
      holder_name: nullable('string'), account_type: { type: 'string', enum: ['retail', 'fleet', 'vip', 'technician'] }, fleet_name: nullable('string'),
      valid_to: nullable('string', { format: 'date-time' }), notes: nullable('string'), created_at: DT,
      sessions: { type: 'integer' }, last_used: nullable('string', { format: 'date-time' }),
    },
  },
  PncTrustAnchor: {
    type: 'object',
    required: ['id', 'kind', 'subject', 'fingerprint', 'not_after', 'source'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['V2GRootCertificate', 'MORootCertificate'] },
      subject: { type: 'string' }, fingerprint: { type: 'string', description: 'SHA-256, hex.' },
      not_after: DT, source: { type: 'string', enum: ['pki', 'upload'] }, created_at: DT,
      pem: { type: 'string' },
    },
  },
  PncCharger: {
    type: 'object',
    required: ['id', 'ocpp_identity', 'pnc_enabled'],
    properties: {
      id: { type: 'string', format: 'uuid' }, ocpp_identity: { type: 'string' }, display_name: nullable('string'), ocpp_version: nullable('string'),
      site_name: { type: 'string' }, pnc_enabled: { type: 'boolean' },
      pnc_installed: { type: ['array', 'null'], description: 'Last GetInstalledCertificateIds answer.' }, pnc_installed_at: nullable('string', { format: 'date-time' }),
      cert_state: { type: ['string', 'null'], enum: ['requested', 'signed', 'delivered', 'rejected', 'failed', null] },
      cert_subject: nullable('string'), cert_serial: nullable('string'), cert_not_after: nullable('string', { format: 'date-time' }),
      cert_requested_at: nullable('string', { format: 'date-time' }), cert_delivered_at: nullable('string', { format: 'date-time' }), cert_error: nullable('string'),
    },
  },
  PncEvent: {
    type: 'object',
    required: ['id', 'action', 'outcome', 'created_at'],
    properties: {
      id: { type: 'integer' }, action: { type: 'string', description: 'The OCPP message or operator action.' }, outcome: { type: 'string' },
      emaid: nullable('string'), detail: { type: 'object' }, created_at: DT, ocpp_identity: nullable('string'),
    },
  },
  PncCommandResult: {
    type: 'object',
    properties: { status: status('The charger\'s answer (Accepted, Rejected, Failed…); null when it gave none.') },
  },
};

const HOW =
  'Chargers speak Plug & Charge over OCPP 2.0.1, or over OCPP 1.6 wrapped in DataTransfer (vendorId `org.openchargealliance.iso15118pnc`); both are handled. ' +
  'A contract is authorised in two steps: its certificate (chain to an installed MO root, expiry, OCSP) proves the car holds it; the contract then decides, like a card (status, expiry, limits, fleet account, membership).';

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/pnc', tag: T, summary: 'Plug & Charge overview',
    description: 'Settings, the V2G PKI in use and counts. ' + HOW,
    responses: { 200: { description: 'Overview', schema: ref('PncOverview') } },
  },
  {
    method: 'PUT', path: '/v1/pnc/settings', tag: T, summary: 'Update Plug & Charge settings',
    body: { required: true, schema: ref('PncSettings'), example: { enabled: true, acceptWhenOcspUnavailable: true } },
    responses: { 200: { description: 'Saved', schema: ref('PncSettings') } },
  },
  {
    method: 'GET', path: '/v1/pnc/contracts', tag: T, summary: 'List contracts (eMAIDs)',
    responses: { 200: { description: 'Contracts', schema: { type: 'object', required: ['contracts'], properties: { contracts: arrayOf(ref('PncContract')) } } } },
  },
  {
    method: 'POST', path: '/v1/pnc/contracts', tag: T, summary: 'Register a contract',
    description: 'A contract of your own mobility service. The eMAID is stored without separators; a fleet contract is billed to its fleet account like a fleet card.',
    body: {
      required: true,
      schema: {
        type: 'object', required: ['emaid'],
        properties: {
          emaid: { type: 'string', description: 'CC-PPP-IIIIIIIII[-C], separators optional.' }, holderName: { type: 'string' },
          accountType: { type: 'string', enum: ['retail', 'fleet'], default: 'retail' }, fleetName: { type: 'string' },
          validTo: { type: 'string', format: 'date-time' }, notes: { type: 'string' },
        },
      },
      example: { emaid: 'ID-PLS-C12345678-9', holderName: 'Budi Santoso', accountType: 'fleet', fleetName: 'PT Armada Hijau' },
    },
    responses: { 201: { description: 'Registered', schema: ref('PncContract') } },
    errors: [409, 422],
  },
  {
    method: 'POST', path: '/v1/pnc/contracts/:id/cancel', tag: T, summary: 'Cancel a contract', pathParams: { id: 'Contract (token) id.' },
    description: 'The car is refused from now on (certificate status ContractCancelled).',
    responses: { 200: { description: 'Cancelled', schema: ref('PncContract') } }, errors: [404],
  },
  {
    method: 'POST', path: '/v1/pnc/contracts/:id/reactivate', tag: T, summary: 'Reactivate a contract', pathParams: { id: 'Contract (token) id.' },
    responses: { 200: { description: 'Active', schema: ref('PncContract') } }, errors: [404],
  },
  {
    method: 'GET', path: '/v1/pnc/trust-anchors', tag: T, summary: 'List trust anchors',
    description: 'Root certificates for the chargers\' trust stores: the V2G root (the charger\'s own chain) and mobility operators\' roots (contract certificates). MO roots are also what the CSMS checks contract chains against.',
    responses: { 200: { description: 'Trust anchors', schema: { type: 'object', required: ['anchors'], properties: { anchors: arrayOf(ref('PncTrustAnchor')) } } } },
  },
  {
    method: 'POST', path: '/v1/pnc/trust-anchors', tag: T, summary: 'Add a trust anchor',
    body: {
      required: true,
      schema: { type: 'object', required: ['kind', 'pem'], properties: { kind: { type: 'string', enum: ['V2GRootCertificate', 'MORootCertificate'] }, pem: { type: 'string' } } },
      example: { kind: 'MORootCertificate', pem: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----' },
    },
    responses: { 201: { description: 'Added', schema: ref('PncTrustAnchor') } }, errors: [422],
  },
  {
    method: 'POST', path: '/v1/pnc/trust-anchors/sync', tag: T, summary: 'Fetch the PKI\'s root certificates',
    responses: { 200: { description: 'Anchors after the fetch', schema: { type: 'object', required: ['anchors', 'received'], properties: { anchors: arrayOf(ref('PncTrustAnchor')), received: { type: 'integer' } } } } },
    errors: [502],
  },
  {
    method: 'DELETE', path: '/v1/pnc/trust-anchors/:id', tag: T, summary: 'Remove a trust anchor', pathParams: { id: 'Trust anchor id.' },
    description: 'Removes it from the list only; delete it from each charger with delete-certificate.',
    responses: { 204: { description: 'Removed' } }, errors: [404],
  },
  {
    method: 'GET', path: '/v1/pnc/chargers', tag: T, summary: 'Chargers and their V2G certificates',
    responses: { 200: { description: 'Chargers', schema: { type: 'object', required: ['chargers'], properties: { chargers: arrayOf(ref('PncCharger')) } } } },
  },
  {
    method: 'POST', path: '/v1/pnc/chargers/:identity/enable', tag: T, summary: 'Switch Plug & Charge on or off at a charger', pathParams: { identity: 'OCPP identity.' },
    description: 'Marks the charger as Plug & Charge capable (its V2G certificate is then renewed before it expires) and sets `ISO15118PnCEnabled` (1.6) / `ISO15118Ctrlr.PnCEnabled` (2.0.1).',
    body: { schema: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } }, example: { enabled: true } },
    responses: { 200: { description: 'Done', schema: { type: 'object', required: ['pncEnabled'], properties: { pncEnabled: { type: 'boolean' }, charger: status('The charger\'s answer, or why it was not sent.') } } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/pnc/chargers/:identity/request-certificate', tag: T, summary: 'Ask a charger for a new V2G certificate', pathParams: { identity: 'OCPP identity.' },
    description: 'TriggerMessage(SignV2GCertificate). The charger sends a signing request; the PKI signs it and CertificateSigned is sent back.',
    responses: { 200: { description: 'The charger\'s answer', schema: ref('PncCommandResult') } }, errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/pnc/chargers/:identity/install-roots', tag: T, summary: 'Install the trust anchors on a charger', pathParams: { identity: 'OCPP identity.' },
    body: { schema: { type: 'object', properties: { kinds: { type: 'array', items: { type: 'string', enum: ['V2GRootCertificate', 'MORootCertificate'] } } } } },
    responses: { 200: { description: 'One answer per certificate', schema: { type: 'object', required: ['results'], properties: { results: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, subject: { type: 'string' }, status: status('Accepted, Rejected or Failed.') } } } } } } },
    errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/pnc/chargers/:identity/read-installed', tag: T, summary: 'Read the certificates installed on a charger', pathParams: { identity: 'OCPP identity.' },
    description: 'GetInstalledCertificateIds for the V2G root, MO roots and the V2G certificate chain. The answer is also kept with the charger.',
    responses: { 200: { description: 'Installed certificates', schema: { type: 'object', required: ['certificates'], properties: { status: status('Accepted or NotFound.'), certificates: { type: 'array', items: { type: 'object', properties: { certificateType: { type: 'string' }, certificateHashData: hashData } } } } } } },
    errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/pnc/chargers/:identity/delete-certificate', tag: T, summary: 'Delete a certificate from a charger', pathParams: { identity: 'OCPP identity.' },
    body: { required: true, schema: { type: 'object', required: ['certificateHashData'], properties: { certificateHashData: hashData } } },
    responses: { 200: { description: 'The charger\'s answer', schema: ref('PncCommandResult') } }, errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/pnc/events', tag: T, summary: 'Plug & Charge exchange log',
    description: 'Every Authorize with a contract, certificate request, OCSP check and certificate command, newest first.',
    query: [
      { name: 'identity', description: 'Only this charger.', schema: { type: 'string' } },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
    ],
    responses: { 200: { description: 'Events', schema: { type: 'object', required: ['events'], properties: { events: arrayOf(ref('PncEvent')) } } } },
  },
  {
    method: 'POST', path: '/v1/pnc/test-contracts', tag: T, summary: 'Issue a test contract certificate',
    description: 'Test PKI only (PNC_PKI=mock; never in production): a contract certificate for the eMAID, with the chain and the hash data a charger would send, to try Plug & Charge in a sandbox. Answers 409 with any other PKI.',
    body: { required: true, schema: { type: 'object', required: ['emaid'], properties: { emaid: { type: 'string' } } }, example: { emaid: 'ID-PLS-C12345678' } },
    responses: {
      201: {
        description: 'Issued',
        schema: {
          type: 'object', required: ['emaid', 'serial', 'certificatePem', 'chainPem', 'hashData'],
          properties: {
            emaid: { type: 'string' }, serial: { type: 'string' }, certificatePem: { type: 'string' }, chainPem: { type: 'string' },
            hashData: { type: 'array', items: { ...hashData, properties: { ...(hashData.properties as object), responderURL: { type: 'string' } } } },
          },
        },
      },
    },
    errors: [409, 422],
  },
  {
    method: 'POST', path: '/v1/pnc/test-contracts/:serial/revoke', tag: T, summary: 'Revoke a test contract certificate', pathParams: { serial: 'Certificate serial number (hex).' },
    description: 'Test PKI only. Its OCSP responder answers revoked from now on.',
    responses: { 200: { description: 'Done', schema: { type: 'object', required: ['revoked'], properties: { revoked: { type: 'boolean' } } } } },
    errors: [409],
  },
];

