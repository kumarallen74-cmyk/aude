import { type Op, type Schema } from '../types.js';

/**
 * Phase 32 (v1.44.0): src/api/phase32-routes.ts. Fleet depot scheduling (Load management), queue analytics (Sites),
 * carbon per session and site (Finance), the diagnostics bot (Chargers).
 */

const obj: Schema = { type: 'object' };

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ depot scheduling
  { method: 'GET', path: '/v1/depot', tag: 'Load management', summary: 'Depot charging: sites, departures and plans',
    description: '(v1.44.0) Each site and whether depot scheduling is on; every active session with a departure (when, the energy needed and delivered, the plan: on_track, deferred, at_risk, ready, missed; the estimated ready time); active sessions at depot sites without one; the fleet vehicles.',
    responses: { 200: { description: '{sites, sessions, without, vehicles}.', schema: obj } } },
  { method: 'PUT', path: '/v1/depot/sites/:siteId', tag: 'Load management', summary: 'Switch depot scheduling on or off at a site',
    description: '(v1.44.0) enabled. On: the load manager plans each session with a departure so it is ready in time, using off-peak hours when there is time. Audited.',
    pathParams: { siteId: 'The site.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{siteId, depotScheduling}.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/depot/sessions/:sessionId/departure', tag: 'Load management', summary: 'Set a session\'s departure',
    description: '(v1.44.0) departureAt (5 minutes to 7 days ahead) and neededKwh (the energy the session must deliver in all). Overrides the vehicle\'s or the car\'s. Audited.',
    pathParams: { sessionId: 'The charging session.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The departure.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/fleet-vehicles', tag: 'Load management', summary: 'Fleet vehicles',
    description: '(v1.44.0) Each vehicle: name, plate, fleet account, battery, the card it charges with, its usual departure time and target.',
    responses: { 200: { description: '{vehicles}.', schema: obj } } },
  { method: 'POST', path: '/v1/fleet-vehicles', tag: 'Load management', summary: 'Add a fleet vehicle',
    description: '(v1.44.0) name, plate, fleetAccountId, batteryKwh, tokenId (the card it charges with; one vehicle per card), departureTime (HH:MM, the site\'s time), targetKwh or targetSocPct (with batteryKwh). A session started with the card gets the next departure at that time. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The vehicle.', schema: obj } }, errors: [409, 422] },
  { method: 'PUT', path: '/v1/fleet-vehicles/:id', tag: 'Load management', summary: 'Change or archive a fleet vehicle',
    description: '(v1.44.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The vehicle.' },
    body: { required: true, schema: obj }, responses: { 200: { description: 'The vehicle.', schema: obj } }, errors: [404, 409, 422] },

  // ------------------------------------------------------------------ queue analytics
  { method: 'GET', path: '/v1/sites/:siteId/queue/analytics', tag: 'Sites', summary: 'A site\'s queue over time',
    description: '(v1.44.0) Over the last days (default 30): joins, charged from the queue, no-shows (missed / (served + missed)), abandonment (left or waited too long), median and 90th-percentile wait, the priority lane\'s share and wait, places by day and joins by hour.',
    pathParams: { siteId: 'The site.' }, query: [{ name: 'days', schema: { type: 'integer' } }], responses: { 200: { description: 'The analytics.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/queue/analytics', tag: 'Sites', summary: 'Every site\'s queue over time',
    description: '(v1.44.0) As the site\'s, across the organisation.', query: [{ name: 'days', schema: { type: 'integer' } }],
    responses: { 200: { description: 'The analytics.', schema: obj } } },

  // ------------------------------------------------------------------ carbon
  { method: 'GET', path: '/v1/finance/carbon/sites', tag: 'Finance', summary: 'Carbon per site',
    description: '(v1.44.0) from, to (at most 92 days; both optional, by default the last 30 days): per site the sessions, kWh, the grid factor and where it came from (site, province, default), the measured solar share, emitted and avoided kg CO2e; totals.',
    query: [{ name: 'from', schema: { type: 'string', format: 'date' } }, { name: 'to', schema: { type: 'string', format: 'date' } }],
    responses: { 200: { description: 'The report.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/finance/carbon/esg', tag: 'Finance', summary: 'The ESG workbook',
    description: '(v1.44.0) The per-site report in Excel, with a summary and the methodology (factors, solar share, REC share).',
    query: [{ name: 'from', schema: { type: 'string', format: 'date' } }, { name: 'to', schema: { type: 'string', format: 'date' } }],
    responses: { 200: { description: 'An .xlsx file.', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', schema: { type: 'string', format: 'binary' } } }, errors: [422] },
  { method: 'GET', path: '/v1/sessions/:id/carbon', tag: 'Sessions', summary: 'A session\'s carbon',
    description: '(v1.44.0) kWh, the grid factor and its source, the solar share measured during the session, the REC share, emitted and avoided kg CO2e (against petrol). Also on the driver\'s receipt.',
    pathParams: { id: 'The charging session.' }, responses: { 200: { description: 'The carbon.', schema: obj } }, errors: [404] },

  // ------------------------------------------------------------------ the diagnostics bot
  { method: 'GET', path: '/v1/diagnostics-bot/charge-points/:cpId', tag: 'Firmware and diagnostics', summary: 'A charger\'s diagnostics runs',
    description: '(v1.44.0) The last 20 runs: steps, findings, verdict, summary, work order.', pathParams: { cpId: 'The charge point (id).' },
    responses: { 200: { description: '{runs}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/diagnostics-bot/charge-points/:cpId', tag: 'Firmware and diagnostics', summary: 'Run the diagnostics bot on a charger',
    description: '(v1.44.0) allowReset (a SOFT reset only when a connector is Faulted and nothing is charging), openWorkOrder (when someone has to go or act). Reads the charger\'s connection and 7 days of errors; when connected, asks for a fresh status and reads its key configuration. Never a hard reset, never a configuration change. 202: the run continues in the background; poll it. Audited.',
    pathParams: { cpId: 'The charge point (id).' }, body: { schema: obj }, responses: { 202: { description: '{id}.', schema: obj } }, errors: [404, 409] },
  { method: 'GET', path: '/v1/diagnostics-bot/runs/:id', tag: 'Firmware and diagnostics', summary: 'A diagnostics run',
    description: '(v1.44.0) Its status (running, done, failed), steps, findings, verdict (healthy, fixed, needs_attention, needs_visit, unreachable), summary and work order.',
    pathParams: { id: 'The run.' }, responses: { 200: { description: 'The run.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/diagnostics-bot/runs/:id/work-order', tag: 'Firmware and diagnostics', summary: 'Open a work order from a run',
    description: '(v1.44.0) A corrective work order with the run\'s summary. Audited.', pathParams: { id: 'The run.' },
    responses: { 201: { description: '{id, number}.', schema: obj } }, errors: [404, 409] },
];
