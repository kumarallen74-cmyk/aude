import { type Op, type Schema, ref, arrayOf, nullable, OK } from '../types.js';

export const schemas: Record<string, Schema> = {
  SandboxSummary: {
    type: 'object',
    required: ['id', 'name', 'slug', 'createdAt', 'chargePoints', 'keys'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      slug: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      createdBy: nullable('string'),
      chargePoints: { type: 'integer', description: 'Virtual chargers in the sandbox.' },
      keys: arrayOf({
        type: 'object',
        required: ['id', 'prefix', 'name', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          prefix: { type: 'string' },
          name: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: nullable('string', { format: 'date-time' }),
        },
      }),
    },
  },
  SandboxCreated: {
    type: 'object',
    required: ['id', 'name', 'slug', 'apiKey', 'siteId', 'chargePoints', 'tokens'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      slug: { type: 'string' },
      apiKey: { type: 'string', description: 'The sandbox API key (`psk_…`). Shown once.' },
      siteId: { type: 'string', format: 'uuid' },
      chargePoints: arrayOf({
        type: 'object',
        required: ['identity', 'connectors', 'current', 'maxPowerKw'],
        properties: {
          identity: { type: 'string', examples: ['SBX-3F9A1C-DC60'] },
          connectors: { type: 'integer' },
          current: { type: 'string', enum: ['AC', 'DC'] },
          maxPowerKw: { type: 'number' },
        },
      }),
      tokens: arrayOf({
        type: 'object',
        required: ['uid', 'status', 'holder'],
        properties: { uid: { type: 'string' }, status: { type: 'string' }, holder: { type: 'string' } },
      }),
    },
  },
  SandboxCharger: {
    type: 'object',
    description: 'What the virtual charger itself reports.',
    required: ['online', 'charging', 'meterWh', 'faults', 'reservations'],
    properties: {
      online: { type: 'boolean' },
      state: { type: 'string', description: 'Connection state: connecting, booted, disconnected…' },
      charging: { type: 'boolean' },
      connectorId: nullable('integer'),
      transactionId: nullable('integer'),
      meterWh: { type: 'integer', description: 'Lifetime energy register.' },
      powerW: { type: 'integer' },
      limitW: { type: 'integer', description: 'Current power limit (smart charging).' },
      firmware: { type: 'string' },
      queuedOffline: { type: 'integer', description: 'Transaction messages stored while offline, sent on reconnect.' },
      faults: arrayOf({
        type: 'object',
        properties: {
          connectorId: { type: 'integer' },
          errorCode: { type: 'string' },
          vendorErrorCode: { type: 'string' },
          info: { type: 'string' },
        },
      }),
      reservations: arrayOf({
        type: 'object',
        properties: { connectorId: { type: 'integer' }, reservationId: { type: 'integer' }, idTag: { type: 'string' } },
      }),
      pnc: {
        type: 'object',
        description: 'ISO 15118 Plug & Charge at this charger (OCPP 1.6 with the OCA DataTransfer wrapping).',
        properties: {
          enabled: { type: 'boolean', description: 'ISO15118PnCEnabled.' },
          certificate: { anyOf: [{ type: 'object', properties: { subject: { type: 'string' }, serial: { type: 'string' }, notAfter: { type: 'string', format: 'date-time' } } }, { type: 'null' }], description: 'Its V2G certificate.' },
          roots: arrayOf({ type: 'object', properties: { type: { type: 'string' }, subject: { type: 'string' } } }),
        },
      },
    },
  },
};

const IDENTITY = 'OCPP identity of a virtual charger in this sandbox, e.g. `SBX-3F9A1C-DC60`.';

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/sandboxes', tag: 'Sandbox',
    summary: 'List developer sandboxes',
    description: 'The sandboxes this operator has created, with their active API keys (prefix only).',
    responses: {
      200: {
        description: 'Sandboxes',
        schema: { type: 'object', required: ['sandboxes', 'max'], properties: { sandboxes: arrayOf(ref('SandboxSummary')), max: { type: 'integer' } } },
      },
    },
  },
  {
    method: 'POST', path: '/v1/sandboxes', tag: 'Sandbox',
    summary: 'Create a developer sandbox',
    description:
      'Creates a separate sandbox tenant: a Jakarta site, a 60 kW DC charger with two connectors and a 22 kW AC charger (both virtual, ' +
      'simulated by the gateway), a legal tariff, three RFID cards (one blocked), and an API key with full operator rights inside the ' +
      'sandbox only. The key is returned once. At most 3 sandboxes per operator. A sandbox cannot itself create sandboxes.',
    body: {
      schema: { type: 'object', properties: { name: { type: 'string', maxLength: 60, description: 'A label, e.g. the integrator.' } } },
      example: { name: 'Fleet app integration' },
    },
    responses: { 201: { description: 'The new sandbox, with its API key', schema: ref('SandboxCreated') } },
    errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/sandboxes/:id/rotate-key', tag: 'Sandbox',
    summary: "Rotate a sandbox's API key",
    description: 'Revokes every key of the sandbox and returns a new one (shown once).',
    pathParams: { id: 'Sandbox id.' },
    responses: { 200: { description: 'The new key', schema: { type: 'object', required: ['apiKey'], properties: { apiKey: { type: 'string' } } } } },
    errors: [404],
  },
  {
    method: 'DELETE', path: '/v1/sandboxes/:id', tag: 'Sandbox',
    summary: 'Delete a sandbox',
    description: 'Revokes its keys, stops its virtual chargers and archives the tenant. Its data stays for the audit trail.',
    pathParams: { id: 'Sandbox id.' },
    responses: { 200: { description: 'Deleted', schema: OK } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/sandbox', tag: 'Sandbox',
    summary: 'Describe this sandbox',
    description:
      'Called with a sandbox key: the sandbox, its virtual chargers with what each simulator reports right now, its RFID cards, ' +
      'the events that can be simulated, and the time scale (energy accrues 30× faster than the wall clock). 404 with a production key.',
    responses: {
      200: {
        description: 'The sandbox',
        schema: {
          type: 'object',
          required: ['sandbox', 'chargePoints', 'tokens', 'events', 'timeScale'],
          properties: {
            sandbox: { type: 'object', required: ['id', 'name', 'parent'], properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, parent: { type: 'string' } } },
            chargePoints: arrayOf({
              type: 'object',
              required: ['identity', 'status', 'connectors'],
              properties: {
                identity: { type: 'string' },
                displayName: nullable('string'),
                status: { type: 'string' },
                connectors: { type: 'integer' },
                simulator: { anyOf: [ref('SandboxCharger'), { type: 'null' }] },
              },
            }),
            tokens: arrayOf({ type: 'object', properties: { uid: { type: 'string' }, status: { type: 'string' }, holder: nullable('string') } }),
            events: arrayOf({ type: 'string' }),
            timeScale: { type: 'integer' },
          },
        },
      },
    },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/sandbox/chargers/:identity/simulate', tag: 'Sandbox',
    summary: 'Simulate an event at a virtual charger',
    description:
      'Acts out what happens at a real charger, so your integration sees the same OCPP traffic, sessions, alerts and webhooks as in production:\n\n' +
      '- `plug-in` — a cable is connected (connector goes Preparing)\n' +
      '- `tap-card` — an RFID card is tapped: Authorize, then a session starts (give `idTag`, optionally `kwh` to stop by itself)\n' +
      '- `plug-and-charge` — an ISO 15118 car plugs in with its contract (give `emaid`): the test PKI issues its contract certificate, the charger sends Authorize with the certificate hash data, the CSMS checks it (OCSP) and the contract, and the session starts. Set up first under Plug & Charge: switch it on, register the contract, fetch and install the trust anchors, request the charger\'s certificate\n' +
      '- `stop` — the driver stops at the charger; `unplug` — the car is unplugged (ends a session with EVDisconnected)\n' +
      '- `fault` / `clear-fault` — a connector fault (default `GroundFailure`, optional `vendorErrorCode`, `info`); a fault stops a running session\n' +
      '- `go-offline` / `come-online` — the 4G link drops and returns; a running session carries on and its messages are sent on reconnect\n' +
      '- `reboot` — power cycle; `status` — just report.\n\n' +
      'Commands you send through the normal API (remote start/stop, reset, unlock, configuration, reservations, firmware updates, ' +
      'diagnostics) are answered by the virtual charger too.',
    pathParams: { identity: IDENTITY },
    body: {
      required: true,
      schema: {
        type: 'object',
        required: ['event'],
        properties: {
          event: { type: 'string', enum: ['plug-in', 'unplug', 'tap-card', 'plug-and-charge', 'stop', 'fault', 'clear-fault', 'go-offline', 'come-online', 'reboot', 'status'] },
          connectorId: { type: 'integer', minimum: 1, default: 1 },
          idTag: { type: 'string', description: 'For `tap-card`: the card tapped, e.g. SANDBOX-RFID-0001.' },
          emaid: { type: 'string', description: 'For `plug-and-charge`: the car\'s contract, e.g. ID-PLS-C12345678.' },
          kwh: { type: 'number', exclusiveMinimum: 0, maximum: 200, description: 'For `tap-card` and `plug-and-charge`: energy after which the car is full and the session ends.' },
          errorCode: { type: 'string', description: 'For `fault`: an OCPP 1.6 ChargePointErrorCode.', default: 'GroundFailure' },
          vendorErrorCode: { type: 'string', maxLength: 50 },
          info: { type: 'string', maxLength: 50 },
        },
      },
      example: { event: 'tap-card', connectorId: 1, idTag: 'SANDBOX-RFID-0001', kwh: 5 },
    },
    responses: {
      200: {
        description: 'Done; with what the charger reports now',
        schema: {
          type: 'object', required: ['identity', 'event', 'charger'],
          properties: {
            identity: { type: 'string' }, event: { type: 'string' }, charger: ref('SandboxCharger'),
            authorize: { type: ['object', 'null'], description: 'For `plug-and-charge`: the CSMS\'s answer to the charger (idTokenInfo, certificateStatus).' },
            contract: { type: 'object', description: 'For `plug-and-charge`: the test contract certificate used.', properties: { emaid: { type: 'string' }, serial: { type: 'string' } } },
          },
        },
      },
    },
    errors: [400, 404, 409, 502, 503],
  },
  {
    method: 'POST', path: '/v1/sandbox/reset', tag: 'Sandbox',
    summary: "Reset this sandbox's chargers",
    description: 'Brings every virtual charger back online, stops running sessions and clears faults. Sessions, sites and settings are kept.',
    responses: {
      200: { description: 'Reset', schema: { type: 'object', required: ['ok', 'reset'], properties: { ok: { type: 'boolean' }, reset: arrayOf({ type: 'string' }) } } },
    },
    errors: [404],
  },
];
