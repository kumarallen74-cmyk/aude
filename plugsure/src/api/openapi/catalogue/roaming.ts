/**
 * API catalogue: the console's roaming routes (src/api/roaming-routes.ts) —
 * this operator's OCPI identity, partners, shared sites and cards, and what went
 * to and from each partner. One entry per /v1 route, in source order.
 */
import { type Op, type Schema, ref, arrayOf, nullable, OK } from '../types.js';

// ------------------------------------------------------------ shorthands

const S: Schema = { type: 'string' };
const UUID: Schema = { type: 'string', format: 'uuid' };
const DT: Schema = { type: 'string', format: 'date-time' };
const I: Schema = { type: 'integer' };
const B: Schema = { type: 'boolean' };
const nS = nullable('string');
const nDT = nullable('string', { format: 'date-time' });
const nI = nullable('integer');
/** Postgres NUMERIC, which node-postgres returns as a decimal string. */
const DEC: Schema = { type: 'string', description: 'Decimal number as a string (Postgres NUMERIC).' };
const nDEC = nullable('string', { description: 'Decimal number as a string (Postgres NUMERIC), or null.' });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const PARTNER_ID = 'Roaming partner id (UUID).';

const partnerCols: Record<string, Schema> = {
  id: UUID,
  name: S,
  kind: { type: 'string', enum: ['emsp', 'cpo', 'hub'] },
  state: { type: 'string', enum: ['pending', 'connected', 'suspended', 'closed'] },
  versions_url: { ...nS, description: 'The partner’s OCPI versions URL, once connected.' },
  version: { ...nS, description: 'Negotiated OCPI version (2.2.1).' },
  endpoints: arrayOf(obj({ identifier: S, role: { type: 'string', enum: ['SENDER', 'RECEIVER'] }, url: S })),
  roles: arrayOf(obj({ role: S, party_id: S, country_code: S, business_details: { type: 'object' } })),
  country_code: nS,
  party_id: nS,
  last_error: nS,
  last_success_at: nDT,
  registered_at: nDT,
  created_at: DT,
};
const partnerRequired = ['id', 'name', 'kind', 'state', 'endpoints', 'roles', 'created_at'];

// ------------------------------------------------------------ schemas

export const schemas: Record<string, Schema> = {
  RoamingParty: obj(
    {
      country_code: { type: 'string', pattern: '^[A-Z]{2}$' },
      party_id: { type: 'string', pattern: '^[A-Z0-9]{3}$' },
      business_name: S,
      website: nS,
    },
    ['country_code', 'party_id', 'business_name'],
  ),
  RoamingPartyOfCountry: obj(
    {
      country_code: { type: 'string', pattern: '^[A-Z]{2}$' },
      party_id: { type: 'string', pattern: '^[A-Z0-9]{3}$' },
      business_name: S,
      website: nS,
      is_home: { ...B, description: 'The home party: the eMSP identity and the one connections are made with.' },
    },
    ['country_code', 'party_id', 'business_name', 'is_home'],
  ),
  RoamingPartner: obj(partnerCols, partnerRequired),
  RoamingPartnerSummary: obj(
    {
      ...partnerCols,
      queued: { ...I, description: 'Calls waiting to be delivered to the partner.' },
      failed: { ...I, description: 'Calls that gave up; replay them with POST …/replay.' },
      tokens: { ...I, description: 'Driver tokens the partner has pushed to us.' },
      sessions: { ...I, description: 'Sessions on our chargers by the partner’s drivers.' },
      network_locations: { ...I, description: 'Locations imported from the partner (CPO role).' },
      cdrs_received: { ...I, description: 'Charge records the partner sent us for our cards.' },
      hub_clients: { ...I, description: 'Parties behind the partner, when it is a hub (HubClientInfo).' },
    },
    [...partnerRequired, 'queued', 'failed', 'tokens', 'sessions', 'network_locations', 'cdrs_received', 'hub_clients'],
  ),
  RoamingSite: obj(
    {
      id: UUID,
      name: S,
      city: S,
      publish: { ...B, description: 'Actually shared: opted in and nothing missing.' },
      problem: { ...nS, description: 'Why the site cannot be shared yet, if anything.' },
      evses: { ...I, description: 'EVSEs the location would carry.' },
      tariffs: { ...I, description: 'Tariffs in use on its connectors.' },
      optedIn: { ...B, description: 'The operator has opted the site in.' },
    },
    ['id', 'name', 'city', 'publish', 'problem', 'evses', 'tariffs', 'optedIn'],
  ),
  RoamingOverview: obj(
    {
      party: { anyOf: [ref('RoamingParty'), { type: 'null' }], description: 'This operator’s roaming identity (the home party), or null until set.' },
      parties: { ...arrayOf(ref('RoamingPartyOfCountry')), description: 'Every OCPI party of the operator, one per country, the home party first.' },
      versionsUrl: { ...S, description: 'Our OCPI versions URL, to give to partners.' },
      partners: arrayOf(ref('RoamingPartnerSummary')),
      sites: { ...arrayOf(ref('RoamingSite')), description: 'Empty until the roaming identity is set.' },
    },
    ['party', 'versionsUrl', 'partners', 'sites'],
  ),
  OcpiMessage: obj(
    {
      id: I,
      direction: { type: 'string', enum: ['in', 'out'] },
      method: S,
      url: S,
      http_status: nI,
      ocpi_status: nI,
      duration_ms: nI,
      error: nS,
      created_at: DT,
    },
    ['id', 'direction', 'method', 'url', 'created_at'],
  ),
  OcpiPush: obj(
    {
      id: I,
      module: { ...S, description: 'OCPI module: locations, tariffs, sessions, cdrs, tokens, commands, chargingprofiles.' },
      action: S,
      object_key: S,
      state: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
      attempts: I,
      next_attempt_at: DT,
      last_status: nI,
      last_error: nS,
      created_at: DT,
      delivered_at: nDT,
    },
    ['id', 'module', 'action', 'object_key', 'state', 'attempts', 'next_attempt_at', 'created_at'],
  ),
  OcpiToken: obj(
    {
      id: UUID,
      country_code: S,
      party_id: S,
      uid: S,
      type: { type: 'string', enum: ['AD_HOC_USER', 'APP_USER', 'OTHER', 'RFID'] },
      contract_id: S,
      visual_number: nS,
      issuer: S,
      valid: B,
      whitelist: { type: 'string', enum: ['ALWAYS', 'ALLOWED', 'ALLOWED_OFFLINE', 'NEVER'] },
      last_updated: DT,
      received_at: DT,
    },
    ['id', 'country_code', 'party_id', 'uid', 'type', 'contract_id', 'issuer', 'valid', 'whitelist', 'last_updated', 'received_at'],
  ),
  RoamingHubClient: obj(
    {
      country_code: S,
      party_id: S,
      role: { type: 'string', enum: ['CPO', 'EMSP', 'HUB', 'NAP', 'NSP', 'OTHER', 'SCSP'] },
      status: { type: 'string', enum: ['CONNECTED', 'OFFLINE', 'PLANNED', 'SUSPENDED'] },
      last_updated: DT,
      received_at: DT,
    },
    ['country_code', 'party_id', 'role', 'status', 'last_updated', 'received_at'],
  ),
  RoamingChargingLimit: obj(
    {
      session_id: UUID,
      partner_name: S,
      site_name: S,
      ocpp_identity: S,
      started_at: DT,
      contract_id: nS,
      received_at: DT,
      last_result: { ...nS, description: 'ACCEPTED (the charger took it) | REJECTED (offline or refused; applied on a later pass) | null (being applied).' },
      applied_at: nDT,
      unit: { type: 'string', enum: ['W', 'A'] },
      periods: { ...I, description: 'Steps in the partner’s schedule.' },
      limitNow: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'The partner’s limit right now, in its unit; null when none is in force.' },
      limitNowW: { ...nI, description: 'The same in watts.' },
    },
    ['session_id', 'partner_name', 'site_name', 'ocpp_identity', 'started_at', 'received_at', 'unit', 'periods', 'limitNow', 'limitNowW'],
  ),
  RoamingCard: obj(
    {
      id: UUID,
      uid: S,
      status: { ...S, description: 'Accepted | Blocked | Expired | Invalid | ConcurrentTx.' },
      valid_to: nDT,
      holder_name: nS,
      fleet_name: nS,
      account_type: { ...S, description: 'retail | fleet | vip | technician.' },
      roaming_shared: B,
      contract_id: { ...nS, description: 'eMAID-style contract id, given when the card is first shared.' },
      energy_limit_wh: nI,
      spend_limit_minor: nI,
      roaming_cdrs: { ...I, description: 'Charge records received for this card from other networks.' },
      roaming_minor: { ...I, description: 'Charged to this card on other networks in its spending-limit currency (minor units).' },
      spend_limit_currency: { ...S, description: 'The currency of the spending limit (IDR, MYR or SGD).' },
      roaming_currency: S,
      roaming_cdrs_held: I,
      roaming_by_currency: { type: 'object', additionalProperties: I, description: 'Charged on other networks per currency (minor units); never added across currencies.' },
    },
    ['id', 'uid', 'status', 'account_type', 'roaming_shared', 'roaming_cdrs', 'roaming_minor'],
  ),
  RoamingNetworkLocation: obj(
    {
      partnerId: UUID,
      partnerName: S,
      party: { ...S, description: '`country_code*party_id` of the operator.' },
      countryCode: S,
      partyId: S,
      id: { ...S, description: 'The CPO’s location id.' },
      name: S,
      address: S,
      city: S,
      operator: nS,
      lastUpdated: DT,
      available: { ...I, description: 'EVSEs currently AVAILABLE.' },
      evses: arrayOf(
        obj(
          {
            uid: S,
            evseId: S,
            status: S,
            connectors: arrayOf(obj({ id: S, standard: S, powerType: S, maxPowerW: nI })),
          },
          ['connectors'],
        ),
      ),
    },
    ['partnerId', 'partnerName', 'party', 'countryCode', 'partyId', 'id', 'operator', 'lastUpdated', 'available', 'evses'],
  ),
  RoamingCommand: obj(
    {
      id: UUID,
      command: { type: 'string', enum: ['START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR', 'RESERVE_NOW', 'CANCEL_RESERVATION'], description: 'RESERVE_NOW and CANCEL_RESERVATION are sent by the driver app (a fleet driver reserving a partner charger).' },
      response: { ...nS, description: 'The CPO’s synchronous answer (ACCEPTED, REJECTED, … or FAILED when unreachable).' },
      result: { ...nS, description: 'The charger’s outcome, posted back later by the CPO.' },
      message: nS,
      created_at: DT,
      responded_at: nDT,
      result_at: nDT,
      location_id: nS,
      session_id: nS,
      partner_name: S,
      uid: nS,
      holder_name: nS,
    },
    ['id', 'command', 'created_at', 'partner_name'],
  ),
  RoamingCommandSent: obj(
    {
      id: UUID,
      response: { ...S, description: 'The CPO’s answer, or FAILED when it could not be reached.' },
      message: nS,
    },
    ['id', 'response', 'message'],
  ),
  RoamingAbroadCdr: obj(
    {
      id: UUID,
      cdr_id: S,
      session_id: nS,
      start_date_time: DT,
      end_date_time: DT,
      total_energy: { ...DEC, description: 'kWh, as a decimal string.' },
      currency: S,
      total_excl_vat: DEC,
      total_incl_vat: nDEC,
      received_at: DT,
      country_code: S,
      party_id: S,
      partner_name: S,
      uid: nS,
      contract_id: nS,
      holder_name: nS,
      fleet_name: nS,
      location_name: nS,
      city: nS,
    },
    ['id', 'cdr_id', 'start_date_time', 'end_date_time', 'total_energy', 'currency', 'total_excl_vat', 'received_at', 'country_code', 'party_id', 'partner_name'],
  ),
  RoamingAbroadSession: obj(
    {
      session_id: S,
      partner_id: UUID,
      status: { ...nS, description: 'ACTIVE | PENDING | RESERVATION.' },
      kwh: nDEC,
      last_updated: DT,
      started_at: nS,
      location_id: nS,
      partner_name: S,
      uid: nS,
      holder_name: nS,
      fleet_name: nS,
      location_name: nS,
      city: nS,
    },
    ['session_id', 'partner_id', 'last_updated', 'partner_name'],
  ),
  RoamingSession: obj(
    {
      id: UUID,
      started_at: DT,
      ended_at: nDT,
      state: S,
      energy_wh: I,
      ocpi_auth_method: nS,
      partner_name: S,
      contract_id: S,
      country_code: S,
      party_id: S,
      visual_number: nS,
      site_name: S,
      ocpp_identity: S,
      total_minor: nI,
      cdr_push_state: { ...nS, description: 'State of the CDR delivery to the partner: pending | delivered | failed, or null before one is queued.' },
    },
    ['id', 'started_at', 'state', 'energy_wh', 'partner_name', 'contract_id', 'country_code', 'party_id', 'site_name', 'ocpp_identity'],
  ),
};

// ------------------------------------------------------------ operations

const partnerPath = { id: PARTNER_ID };
const dateRange = [
  { name: 'from', description: 'Charge records that ended at or after this instant (ignored when not a date).', schema: DT },
  { name: 'to', description: 'Charge records that ended before this instant (ignored when not a date).', schema: DT },
];

export const ops: Op[] = [
  {
    method: 'GET',
    path: '/v1/roaming',
    tag: 'Roaming',
    summary: 'Get the roaming overview',
    description:
      'This operator’s OCPI roaming identity, the versions URL to give partners, every partner that is not closed (with queue, token, session and CDR counts), ' +
      'and each site with whether it can be and is shared.',
    responses: { 200: { description: 'The overview.', schema: ref('RoamingOverview') } },
  },
  {
    method: 'PUT',
    path: '/v1/roaming/party',
    tag: 'Roaming',
    summary: 'Set the roaming identity',
    description:
      'Sets the country code and party id partners know this operator by, and the business name they see. Changing the party id while any partner is connected, ' +
      'or choosing one another organisation uses, is refused with 409. Audited as roaming.identity_set.',
    body: {
      schema: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'ISO 3166 alpha-2, e.g. ID. Upper-cased.' },
          partyId: { type: 'string', pattern: '^[A-Za-z0-9]{3}$', description: 'Three letters or digits. Upper-cased.' },
          businessName: { type: 'string', minLength: 1 },
          website: { type: 'string', pattern: '^https://\\S+$' },
        },
        required: ['countryCode', 'partyId', 'businessName'],
      },
      example: { countryCode: 'ID', partyId: 'PLS', businessName: 'PT PlugSure Energi Indonesia', website: 'https://plugsure.id' },
    },
    responses: { 200: { description: 'The identity now in force.', schema: obj({ party: ref('RoamingParty') }, ['party']) } },
    errors: [400, 409],
  },
  {
    method: 'GET',
    path: '/v1/roaming/parties',
    tag: 'Roaming',
    summary: 'List the OCPI parties (one per country)',
    description: 'Every OCPI party of the operator, the home party first. A site is published under the party of its country, else under the home party.',
    responses: { 200: { description: 'The parties.', schema: obj({ parties: arrayOf(ref('RoamingPartyOfCountry')) }, ['parties']) } },
  },
  {
    method: 'PUT',
    path: '/v1/roaming/parties/:country',
    tag: 'Roaming',
    summary: 'Set the OCPI party of a country',
    description:
      'Adds or updates the party under which the operator publishes its sites in another country (MY, SG). The home party is set with PUT /v1/roaming/party. ' +
      'All parties are listed in our OCPI credentials (one CPO role each). Audited as roaming.party_set.',
    pathParams: { country: 'ISO 3166-1 alpha-2: ID, MY or SG.' },
    body: {
      schema: {
        type: 'object',
        properties: {
          partyId: { type: 'string', pattern: '^[A-Za-z0-9]{3}$', description: 'Three letters or digits. Upper-cased.' },
          businessName: { type: 'string', minLength: 1 },
          website: { type: 'string', pattern: '^https://\\S+$' },
        },
        required: ['partyId', 'businessName'],
      },
      example: { partyId: 'PLS', businessName: 'PlugSure Malaysia Sdn Bhd' },
    },
    responses: { 200: { description: 'The party now in force.', schema: obj({ party: ref('RoamingParty') }, ['party']) } },
    errors: [400, 409],
  },
  {
    method: 'DELETE',
    path: '/v1/roaming/parties/:country',
    tag: 'Roaming',
    summary: 'Remove the OCPI party of a country',
    description: 'Removes a non-home party; that country\'s sites are then published under the home party. Audited as roaming.party_removed.',
    pathParams: { country: 'ISO 3166-1 alpha-2.' },
    responses: { 200: { description: 'Removed.', schema: obj({ ok: { type: 'boolean' } }, ['ok']) } },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners',
    tag: 'Roaming',
    summary: 'Create a roaming partner',
    description:
      'Creates a partner connection in `pending` and returns the credentials token (token A) to hand to the partner with our versions URL. ' +
      'Requires the roaming identity to be set (409 otherwise). Audited as roaming.partner_created.',
    body: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: ['emsp', 'cpo', 'hub'], default: 'emsp', description: 'Any other value is stored as emsp.' },
        },
        required: ['name'],
      },
      example: { name: 'Hub Roaming Nusantara', kind: 'hub' },
    },
    responses: {
      200: {
        description: 'The partner and its credentials token.',
        schema: obj(
          {
            partner: ref('RoamingPartner'),
            token: { ...S, description: 'Token A for the partner. Shown once.' },
            versionsUrl: S,
          },
          ['partner', 'token', 'versionsUrl'],
        ),
      },
    },
    errors: [400, 409],
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners/:id/connect',
    tag: 'Roaming',
    summary: 'Connect to a roaming partner',
    description:
      'Runs the OCPI 2.2.1 credentials handshake with a partner using the versions URL and token it gave us, then publishes our locations, tariffs and shared ' +
      'cards to it (and imports its network, for a CPO) after the response. Any failure of the handshake answers 502 with the reason. Audited as roaming.partner_connected.',
    pathParams: partnerPath,
    body: {
      schema: {
        type: 'object',
        properties: {
          versionsUrl: { type: 'string', minLength: 1, description: 'The partner’s OCPI versions URL.' },
          token: { type: 'string', minLength: 1, description: 'The credentials token the partner issued to us.' },
        },
        required: ['versionsUrl', 'token'],
      },
      example: { versionsUrl: 'https://ocpi.hub-nusantara.co.id/ocpi/versions', token: 'c2b7e0f4-9a1d-4e63-8f55-1b3d7a90e2c8' },
    },
    responses: { 200: { description: 'The partner, now connected.', schema: ref('RoamingPartner') } },
    errors: [400, 404, 502],
  },
  {
    method: 'PATCH',
    path: '/v1/roaming/partners/:id',
    tag: 'Roaming',
    summary: 'Rename, suspend or resume a partner',
    description:
      'Renames a partner and/or suspends a connected one or resumes a suspended one (409 for any other transition). A resumed partner is re-sent everything after the response. ' +
      'Suspension and resumption are audited.',
    pathParams: partnerPath,
    body: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          state: { type: 'string', enum: ['suspended', 'connected'] },
        },
      },
      example: { state: 'suspended' },
    },
    responses: { 200: { description: 'The partner.', schema: ref('RoamingPartner') } },
    errors: [400, 404, 409],
  },
  {
    method: 'DELETE',
    path: '/v1/roaming/partners/:id',
    tag: 'Roaming',
    summary: 'Disconnect a roaming partner',
    description:
      'Closes the connection: tells a connected partner (DELETE on its credentials endpoint), revokes both tokens and fails every pending call to it. ' +
      'Audited as roaming.partner_disconnected.',
    pathParams: partnerPath,
    responses: { 200: { description: 'Closed.', schema: OK } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/roaming/partners/:id/messages',
    tag: 'Roaming',
    summary: 'List OCPI messages with a partner',
    description: 'The request/response log of OCPI calls to and from one partner, newest first (up to 300).',
    pathParams: partnerPath,
    responses: { 200: { description: 'Messages.', schema: arrayOf(ref('OcpiMessage')) } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/roaming/partners/:id/pushes',
    tag: 'Roaming',
    summary: 'List queued pushes to a partner',
    description: 'The outbox of calls to one partner (location, tariff, session, CDR and token updates) with their delivery state, newest first (up to 300).',
    pathParams: partnerPath,
    responses: { 200: { description: 'Pushes.', schema: arrayOf(ref('OcpiPush')) } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/roaming/partners/:id/tokens',
    tag: 'Roaming',
    summary: 'List tokens from a partner',
    description: 'Driver tokens a partner has pushed to us, most recently received first (up to 500).',
    pathParams: partnerPath,
    responses: { 200: { description: 'Tokens.', schema: arrayOf(ref('OcpiToken')) } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners/:id/replay',
    tag: 'Roaming',
    summary: 'Replay failed pushes',
    description: 'Queues every failed call to a partner for delivery again. Audited as roaming.replayed.',
    pathParams: partnerPath,
    responses: { 200: { description: 'Calls re-queued.', schema: obj({ requeued: I }, ['requeued']) } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/roaming/partners/:id/hub-clients',
    tag: 'Roaming',
    summary: 'List the parties behind a hub',
    description:
      'What a roaming hub reported about the operators and service providers behind it (OCPI HubClientInfo). Once a hub has sent this list, ' +
      'it may only act for parties on it that are CONNECTED or OFFLINE. Empty for a partner that is not a hub.',
    pathParams: partnerPath,
    responses: { 200: { description: 'Parties.', schema: arrayOf(ref('RoamingHubClient')) } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners/:id/hub-clients/refresh',
    tag: 'Roaming',
    summary: 'Pull the hub’s client list',
    description:
      'Reads the full client list from the hub’s HubClientInfo endpoint (paged) and replaces what we hold. 409 when the partner is not a connected hub; ' +
      '502 when the hub offers no list or did not answer.',
    pathParams: partnerPath,
    responses: { 200: { description: 'Pulled.', schema: obj({ clients: I }, ['clients']) } },
    errors: [404, 409, 502],
  },
  {
    method: 'GET',
    path: '/v1/roaming/charging-profiles',
    tag: 'Roaming',
    summary: 'List partners’ charging limits',
    description:
      'Charging limits partners have set on their drivers’ sessions still running here (OCPI ChargingProfiles), with the limit in force now. ' +
      'Load management applies them on top of the site power budget; a partner can lower a session’s rate, never raise it.',
    responses: { 200: { description: 'Limits.', schema: arrayOf(ref('RoamingChargingLimit')) } },
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners/:id/sync',
    tag: 'Roaming',
    summary: 'Re-send everything to a partner',
    description: 'Queues a full publication of our shared locations, tariffs and cards to one connected partner (409 when it is not connected).',
    pathParams: partnerPath,
    responses: {
      200: {
        description: 'Objects queued.',
        schema: obj({ locations: I, tariffs: I, tokens: I }, ['locations', 'tariffs', 'tokens']),
      },
    },
    errors: [404, 409],
  },
  {
    method: 'PUT',
    path: '/v1/roaming/sites/:id',
    tag: 'Roaming',
    summary: 'Share or withdraw a site',
    description:
      'Sets a site’s city and/or whether it is shared with roaming partners. Sharing a site that is incomplete (no coordinates, address or city; archived; private-billed) ' +
      'is refused with 422. Changes are published to partners after the response. Sharing and withdrawal are audited.',
    pathParams: { id: 'Site id (UUID).' },
    body: {
      schema: {
        type: 'object',
        properties: {
          city: { type: 'string', maxLength: 45 },
          publish: { type: 'boolean', description: 'true to share, false to withdraw.' },
        },
      },
      example: { city: 'Jakarta Selatan', publish: true },
    },
    responses: { 200: { description: 'Saved.', schema: OK } },
    errors: [404, 422],
  },
  {
    method: 'GET',
    path: '/v1/roaming/cards',
    tag: 'Roaming',
    summary: 'List cards for roaming',
    description: 'The organisation’s RFID cards (up to 2,000), shared ones first, with their contract id and usage on other networks.',
    responses: { 200: { description: 'Cards.', schema: arrayOf(ref('RoamingCard')) } },
  },
  {
    method: 'PUT',
    path: '/v1/roaming/cards',
    tag: 'Roaming',
    summary: 'Share or unshare cards',
    description:
      'Lets the chosen RFID cards (or, with `all: true`, every active card) charge on partner networks, or stops that. A card gets a contract id when first shared. ' +
      'Requires the roaming identity (409 otherwise). Published to partners after the response. Audited.',
    body: {
      schema: {
        type: 'object',
        properties: {
          shared: { type: 'boolean', description: 'true to share; anything else unshares.' },
          all: { type: 'boolean', description: 'Every active card whose sharing differs.' },
          ids: { ...arrayOf(UUID), description: 'Card (token) ids. Required unless `all` is true.' },
        },
      },
      example: { shared: true, ids: ['0b8f3c21-5d6e-4a7b-9c10-2e3f4a5b6c7d'] },
    },
    responses: { 200: { description: 'Cards changed.', schema: obj({ changed: I }, ['changed']) } },
    errors: [400, 409],
  },
  {
    method: 'GET',
    path: '/v1/roaming/settings',
    tag: 'Roaming',
    summary: 'Get the driver-app roaming settings',
    description: 'Whether signed-in app drivers may charge on partner networks, and the card hold placed before such a charge, per currency (the operator\'s amount, else the country default).',
    responses: {
      200: {
        description: 'Settings.',
        schema: obj({
          appDrivers: B,
          holds: arrayOf(obj({ currency: S, holdMinor: { ...I, description: 'Minor units of the currency.' }, defaultMinor: I, custom: B }, ['currency', 'holdMinor', 'defaultMinor', 'custom'])),
        }, ['appDrivers', 'holds']),
      },
    },
  },
  {
    method: 'PUT',
    path: '/v1/roaming/settings',
    tag: 'Roaming',
    summary: 'Change the driver-app roaming settings',
    description: 'Turns partner networks on or off for app drivers and sets the hold per currency (minor units; up to 50 times the country default; leave a currency out for the default). Audited.',
    body: {
      required: true,
      schema: obj({ appDrivers: B, holdMinor: { type: 'object', additionalProperties: nI, description: 'Hold per currency code, minor units.' } }),
      example: { appDrivers: true, holdMinor: { IDR: 300000, SGD: 8000 } },
    },
    responses: { 200: { description: 'Saved.', schema: obj({ ok: B, appDrivers: B, holdMinor: { type: 'object' } }, ['ok']) } },
    errors: [422],
  },
  {
    method: 'GET',
    path: '/v1/roaming/network',
    tag: 'Roaming',
    summary: 'List partner charging locations',
    description: 'Charging locations published by connected CPO partners (up to 1,000, by city and name), with EVSE status, where our shared cards can charge.',
    responses: { 200: { description: 'Locations.', schema: arrayOf(ref('RoamingNetworkLocation')) } },
  },
  {
    method: 'POST',
    path: '/v1/roaming/partners/:id/import',
    tag: 'Roaming',
    summary: 'Import a partner’s network',
    description: 'Pulls a connected CPO partner’s locations and tariffs now (409 when it is not connected).',
    pathParams: partnerPath,
    responses: {
      200: { description: 'Objects imported.', schema: obj({ locations: I, tariffs: I }, ['locations', 'tariffs']) },
    },
    errors: [404, 409],
  },
  {
    method: 'POST',
    path: '/v1/roaming/commands',
    tag: 'Roaming',
    summary: 'Send a command to a partner',
    description:
      'Sends an OCPI command to a CPO partner for one of our cards: START_SESSION (card and location), STOP_SESSION (session) or UNLOCK_CONNECTOR (location, EVSE and connector). ' +
      'The CPO answers at once; the charger’s result arrives later (see GET /v1/roaming/commands). 409 when the partner is not connected or takes no commands, ' +
      '422 when a required field is missing or the card is not shared. Audited.',
    body: {
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR'] },
          partnerId: UUID,
          tokenId: { ...UUID, description: 'START_SESSION: our card (token) id; it must be shared for roaming.' },
          locationId: { ...S, description: 'START_SESSION, UNLOCK_CONNECTOR.' },
          evseUid: { ...S, description: 'Optional for START_SESSION; required for UNLOCK_CONNECTOR.' },
          connectorId: { ...S, description: 'Optional for START_SESSION; required for UNLOCK_CONNECTOR.' },
          sessionId: { ...S, description: 'STOP_SESSION.' },
          countryCode: { ...S, description: 'The location owner’s country code, when the partner is a hub.' },
          partyId: { ...S, description: 'The location owner’s party id, when the partner is a hub.' },
        },
        required: ['command', 'partnerId'],
      },
      example: {
        command: 'START_SESSION',
        partnerId: '3d2a1b0c-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
        tokenId: '0b8f3c21-5d6e-4a7b-9c10-2e3f4a5b6c7d',
        locationId: 'LOC-JKT-SCBD-01',
        evseUid: 'ID*XYZ*E0001',
      },
    },
    responses: { 200: { description: 'The command and the CPO’s answer.', schema: ref('RoamingCommandSent') } },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'GET',
    path: '/v1/roaming/commands',
    tag: 'Roaming',
    summary: 'List commands sent to partners',
    description: 'The 200 most recent OCPI commands this operator sent, with the CPO’s answer and the charger’s result.',
    responses: { 200: { description: 'Commands, newest first.', schema: arrayOf(ref('RoamingCommand')) } },
  },
  {
    method: 'GET',
    path: '/v1/roaming/abroad',
    tag: 'Roaming',
    summary: 'List charging by our cards on other networks',
    description:
      'Our drivers’ sessions currently active on partner networks (up to 100) and the charge records partners sent for our cards (up to 500, most recent end first), ' +
      'optionally limited by end time. Monetary and energy totals are decimal strings.',
    query: dateRange,
    responses: {
      200: {
        description: 'Active sessions and charge records.',
        schema: obj({ active: arrayOf(ref('RoamingAbroadSession')), cdrs: arrayOf(ref('RoamingAbroadCdr')) }, ['active', 'cdrs']),
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/roaming/abroad.csv',
    tag: 'Roaming',
    summary: 'Export charges on other networks as CSV',
    description:
      'Every charge record partners sent for our cards in the range, as a CSV attachment (columns start, end, partner, operator, location, city, card, contract_id, ' +
      'holder, fleet, kwh, currency, total_excl_vat, total_incl_vat, cdr_id, session_id).',
    query: dateRange,
    responses: { 200: { description: 'CSV file.', contentType: 'text/csv', schema: S } },
  },
  {
    method: 'GET',
    path: '/v1/roaming/cdrs/held',
    tag: 'Roaming',
    summary: 'List partner charge records held for review',
    description:
      'Charge records (CDRs) a partner CPO sent for our fleet cards that could not be linked to a session that partner reported or an ' +
      'authorisation we issued, or that failed the plausibility checks (energy, price per kWh, VAT, duration). Held records are not ' +
      'invoiced and do not count against card limits until accepted. Newest first (up to 500).',
    responses: { 200: { description: 'Held charge records.', schema: arrayOf(obj({
  id: UUID, cdr_id: S, session_id: nS, start_date_time: DT, end_date_time: DT, total_energy: DEC, currency: S,
  total_excl_vat: DEC, total_incl_vat: nDEC, received_at: DT, country_code: S, party_id: S,
  hold_reason: nS, partner_name: S, uid: nS, contract_id: nS, holder_name: nS, fleet_name: nS,
  location_name: nS, authorization_reference: nS,
}, ['id', 'cdr_id', 'currency', 'total_excl_vat', 'received_at', 'partner_name'])) } },
  },
  {
    method: 'POST',
    path: '/v1/roaming/cdrs/:id/accept',
    tag: 'Roaming',
    summary: 'Accept a held partner charge record',
    description: 'Accepts a held (or rejected) record: it is invoiced in the month it was reviewed and counts against the card limits, and the driver gets the receipt. Audited as roaming.cdr_accepted.',
    pathParams: { id: 'Charge record id (UUID).' },
    body: {
      required: false,
      schema: { type: 'object', properties: { note: { type: 'string', maxLength: 500, description: 'Why, for the audit log.' } } },
    },
    responses: { 200: { description: 'The new status.', schema: obj({ id: UUID, status: { type: 'string', enum: ['accepted'] } }, ['id', 'status']) } },
    errors: [404, 409],
  },
  {
    method: 'POST',
    path: '/v1/roaming/cdrs/:id/reject',
    tag: 'Roaming',
    summary: 'Reject a held partner charge record',
    description: 'Rejects a held record: it is never invoiced. A record already accepted cannot be rejected (409). Audited as roaming.cdr_rejected.',
    pathParams: { id: 'Charge record id (UUID).' },
    body: {
      required: false,
      schema: { type: 'object', properties: { note: { type: 'string', maxLength: 500, description: 'Why, for the audit log.' } } },
    },
    responses: { 200: { description: 'The new status.', schema: obj({ id: UUID, status: { type: 'string', enum: ['rejected'] } }, ['id', 'status']) } },
    errors: [404, 409],
  },
  {
    method: 'GET',
    path: '/v1/roaming/sessions',
    tag: 'Roaming',
    summary: 'List partner drivers’ sessions',
    description: 'The 200 most recent sessions on our chargers by roaming partners’ drivers, with the billed total and the state of the CDR delivery to the partner.',
    responses: { 200: { description: 'Sessions, newest first.', schema: arrayOf(ref('RoamingSession')) } },
  },
];
