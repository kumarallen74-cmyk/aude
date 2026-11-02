import { type Op, type Schema } from '../types.js';

/**
 * Phase 37 (v1.49.0): src/api/phase37-routes.ts. Two-wheeler battery swap (Sites, with the cabinets' own API), mobile
 * and roadside charging (Sessions), warranty and RMA (Chargers), accessibility and site amenities (Sites). The
 * driver's side is in the driver API (GET /d/v1/swap, POST /d/v1/swap/subscription, GET /d/v1/roadside,
 * POST /d/v1/roadside/requests, POST /d/v1/roadside/cancel, POST /d/v1/sites/{siteId}/accessibility-reports, and the
 * amenities on /d/v1/stations).
 */

const obj: Schema = { type: 'object' };
const id = (what: string) => ({ id: what });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ battery swap
  { method: 'GET', path: '/v1/battery-swap', tag: 'Sites', summary: 'Battery swap overview',
    description: '(v1.49.0) The settings, each cabinet (online, packs ready and charging, swaps in 24 hours) and the figures: swaps, refusals, credit paid, energy, riders, monthly fees, packs by status.',
    responses: { 200: { description: '{settings, cabinets, kpis}.', schema: obj } } },
  { method: 'PUT', path: '/v1/battery-swap/settings', tag: 'Sites', summary: 'Battery swap settings',
    description: '(v1.49.0) enabled, pricePerSwapMinor (without a plan, or beyond it; paid from the rider\'s credit), minSocOut (a pack is ready at this charge, 50–100), retireSoh (below it a pack is flagged, 40–95). Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/battery-swap/cabinets', tag: 'Sites', summary: 'Add a swap cabinet',
    description: '(v1.49.0) siteId, code, name, slots. The key its controller posts with is shown once. Audited.', body: { required: true, schema: obj },
    responses: { 201: { description: 'The cabinet, with its key.', schema: obj } }, errors: [409, 422] },
  { method: 'PUT', path: '/v1/battery-swap/cabinets/:id', tag: 'Sites', summary: 'Change, re-key or archive a swap cabinet',
    description: '(v1.49.0) The fields above, status (active, maintenance), rotateKey: true (a new key, shown once) or archive: true. Audited.', pathParams: id('The cabinet.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The cabinet.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/battery-swap/packs', tag: 'Sites', summary: 'Swap battery packs',
    description: '(v1.49.0) Every pack: where it is (a cabinet and slot, a rider, maintenance), its charge, health, temperature, cycles and fault; status filters (retired: the retired ones).',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{packs, byStatus, retireSoh}.', schema: obj } } },
  { method: 'POST', path: '/v1/battery-swap/packs', tag: 'Sites', summary: 'Register a battery pack',
    description: '(v1.49.0) serial, model, capacityWh. It starts in maintenance until a cabinet reports it. Audited.', body: { required: true, schema: obj },
    responses: { 201: { description: 'The pack.', schema: obj } }, errors: [409, 422] },
  { method: 'PUT', path: '/v1/battery-swap/packs/:id', tag: 'Sites', summary: 'Change a battery pack',
    description: '(v1.49.0) model, capacityWh, fault; status maintenance or retired (or back from maintenance into a cabinet). Audited.', pathParams: id('The pack.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The pack.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/battery-swap/plans', tag: 'Sites', summary: 'Swap plans', description: '(v1.49.0) Each plan: the monthly fee, the swaps included (null: unlimited) and its subscribers.',
    responses: { 200: { description: '{plans}.', schema: obj } } },
  { method: 'POST', path: '/v1/battery-swap/plans', tag: 'Sites', summary: 'Add a swap plan',
    description: '(v1.49.0) name, monthlyMinor, swapsIncluded (null: unlimited; a plan of 0 with 0 included is pay per swap). Audited.', body: { required: true, schema: obj },
    responses: { 201: { description: 'The plan.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/battery-swap/plans/:id', tag: 'Sites', summary: 'Change or archive a swap plan',
    description: '(v1.49.0) The fields above, or archive: true (no new subscribers; current ones lapse at their renewal). Audited.', pathParams: id('The plan.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The plan.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/battery-swap/riders', tag: 'Sites', summary: 'Swap riders', description: '(v1.49.0) Subscriptions: the rider (last digits of the phone), plan, period, swaps used and the pack they hold.',
    responses: { 200: { description: '{riders}.', schema: obj } } },
  { method: 'GET', path: '/v1/battery-swap/swaps', tag: 'Sites', summary: 'The swap log',
    description: '(v1.49.0) The last 500 swaps (cabinetId filters): the packs in and out, their charge, the energy, included, paid or refused (and why).',
    query: [{ name: 'cabinetId', schema: { type: 'string' } }], responses: { 200: { description: '{swaps}.', schema: obj } } },
  { method: 'POST', path: '/v1/swap/cabinets/:key', tag: 'Sites', summary: 'A swap cabinet reports (the cabinet\'s API)',
    description: '(v1.49.0) type status {slots: [{slot, serial, soc, soh, tempC, fault}]}: the packs in its slots; type authorize {riderCode}: may this rider swap (allowed, outcome, amountMinor, reason)?; type swap {reference, riderCode, batteryIn: {serial, soc, slot}, batteryOut: {serial, soc}}: a swap done, idempotent by reference — 402 when refused (no active plan, not enough credit). Authenticated by the cabinet\'s key in the path.',
    pathParams: { key: 'The cabinet\'s key.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The result.', schema: obj } }, errors: [401, 402, 422], permissions: [] },

  // ------------------------------------------------------------------ roadside
  { method: 'GET', path: '/v1/roadside', tag: 'Sessions', summary: 'Roadside charging',
    description: '(v1.49.0) The settings, the open requests (status=all: also the last day\'s), the vans, and the last 30 days: done, revenue, kWh, cancelled, the median time to arrive.',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{settings, requests, kpis, vans}.', schema: obj } } },
  { method: 'PUT', path: '/v1/roadside/settings', tag: 'Sessions', summary: 'Roadside settings',
    description: '(v1.49.0) enabled, calloutMinor, perKwhMinor, radiusKm (from each van\'s base), maxKwh (the most a request asks for), phone (the dispatch desk, shown in the app). Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/roadside/requests', tag: 'Sessions', summary: 'Take a roadside request',
    description: '(v1.49.0) lat, lon, address, name, phone, vehicle, plate, connector (CCS2, Type 2, CHAdeMO, GB/T), soc, kwh, note. Quoted at the call-out fee plus the kWh at the price; refused outside every van\'s radius. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The request.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/roadside/requests/:id', tag: 'Sessions', summary: 'A roadside request',
    description: '(v1.49.0) The request and, while open, the vans that can take it, nearest first (distance, ETA, energy left).', pathParams: id('The request.'),
    responses: { 200: { description: 'The request, with candidates.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/roadside/requests/:id/status', tag: 'Sessions', summary: 'Move a roadside request on',
    description: '(v1.49.0) status: assigned (vanId; sets the ETA), requested (unassign), en_route, charging, done (kwhDelivered; paid from the driver\'s credit as far as it goes, the rest collectedBy cash, qris, card_terminal or invoice), cancelled (reason). Audited.',
    pathParams: id('The request.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The request.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/roadside/vans', tag: 'Sessions', summary: 'Roadside vans', description: '(v1.49.0) Each van: its battery and charger, energy left, base and last position, technician, status.',
    responses: { 200: { description: '{vans}.', schema: obj } } },
  { method: 'POST', path: '/v1/roadside/vans', tag: 'Sessions', summary: 'Add a roadside van',
    description: '(v1.49.0) name, plate, kwhCapacity, kwOutput, baseLat, baseLon, technicianId. Audited.', body: { required: true, schema: obj },
    responses: { 201: { description: 'The van.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/roadside/vans/:id', tag: 'Sessions', summary: 'Change a van, or report its position',
    description: '(v1.49.0) The fields above and status (available, off_duty), archive: true; or only {lat, lon, kwhLeft}: a position report from the technician\'s phone or the van\'s tracker.',
    pathParams: id('The van.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The van.', schema: obj } }, errors: [404, 409, 422] },

  // ------------------------------------------------------------------ warranty and RMA
  { method: 'GET', path: '/v1/warranty/chargers', tag: 'Chargers', summary: 'Chargers\' warranties',
    description: '(v1.49.0) Every charger with its warranty now (the one ending last): covered, expiring (60 days or less), expired or none; the supplier, what it covers and open RMA cases. state filters.',
    query: [{ name: 'state', schema: { type: 'string' } }], responses: { 200: { description: '{chargers, counts}.', schema: obj } } },
  { method: 'GET', path: '/v1/warranty/chargers/:id', tag: 'Chargers', summary: 'A charger\'s warranties and RMA cases', description: '(v1.49.0) Every warranty (and extension) and every RMA case of the charger.',
    pathParams: id('The charger.'), responses: { 200: { description: '{warranties, rma}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/warranties', tag: 'Chargers', summary: 'Record a charger warranty',
    description: '(v1.49.0) chargePointId, supplierId, startsOn, endsOn, covers (parts, labour, shipping, on_site), terms, reference, extended. Audited.', body: { required: true, schema: obj },
    responses: { 201: { description: 'The warranty.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/warranties/:id', tag: 'Chargers', summary: 'Change or remove a warranty', description: '(v1.49.0) The fields above, or remove: true. Audited.',
    pathParams: id('The warranty.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The warranty.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/rma', tag: 'Chargers', summary: 'RMA cases',
    description: '(v1.49.0) Open cases and those closed in the last 60 days (status=all: every one), with the figures: open, waiting on the manufacturer, the median turnaround, rejected and out-of-warranty cost (12 months).',
    query: [{ name: 'status', schema: { type: 'string' } }, { name: 'chargePointId', schema: { type: 'string' } }], responses: { 200: { description: '{cases, kpis}.', schema: obj } } },
  { method: 'POST', path: '/v1/rma', tag: 'Chargers', summary: 'Open an RMA case',
    description: '(v1.49.0) chargePointId, part, partSerial, fault, supplierId (default: the warranty\'s), workOrderId. In warranty or not is worked out from the charger\'s warranty today. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The case.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/rma/:id', tag: 'Chargers', summary: 'An RMA case', description: '(v1.49.0) The case with its history.', pathParams: id('The case.'),
    responses: { 200: { description: 'The case.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/rma/:id', tag: 'Chargers', summary: 'Update or move an RMA case',
    description: '(v1.49.0) vendorRef, trackingOut, trackingBack, replacementSerial, costMinor, outcome, note; status: requested, approved (needs vendorRef), shipped (trackingOut), replaced (replacementSerial; updateChargerSerial: true for a whole charger), closed, rejected (outcome). Audited.',
    pathParams: id('The case.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The case.', schema: obj } }, errors: [404, 409, 422] },

  // ------------------------------------------------------------------ amenities and accessibility
  { method: 'GET', path: '/v1/site-amenities', tag: 'Sites', summary: 'Sites\' amenities and accessibility',
    description: '(v1.49.0) Every site: its amenities, accessibility (bays, step-free, bay width, cable reach, screen height; the score of 5 and accessible or not), hours and open reports.',
    responses: { 200: { description: '{sites, amenities, summary}.', schema: obj } } },
  { method: 'GET', path: '/v1/sites/:id/amenities', tag: 'Sites', summary: 'A site\'s amenities and accessibility', description: '(v1.49.0) As above, for one site.', pathParams: id('The site.'),
    responses: { 200: { description: 'The site\'s amenities.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/sites/:id/amenities', tag: 'Sites', summary: 'Set a site\'s amenities and accessibility',
    description: '(v1.49.0) amenities (toilet, prayer_room, food, shop, wifi, covered, lit, security, lounge, free_parking), accessibleBays, stepFree, bayWidthM, cableReachM, maxScreenHeightCm, open24h, hours, notes, verified: true (checked today). Shown in the driver app. Audited.',
    pathParams: id('The site.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The site\'s amenities.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/accessibility-reports', tag: 'Sites', summary: 'Drivers\' accessibility reports',
    description: '(v1.49.0) Open reports from the app (status=all: every one): the site, what is wrong (blocked_bay, no_step_free, cable_short, screen_high, amenity_wrong, other) and the details.',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{reports}.', schema: obj } } },
  { method: 'POST', path: '/v1/accessibility-reports/:id/resolve', tag: 'Sites', summary: 'Resolve an accessibility report', description: '(v1.49.0) status (resolved, dismissed) and resolution (what was done). Audited.',
    pathParams: id('The report.'), body: { required: true, schema: obj }, responses: { 200: { description: '{id, status}.', schema: obj } }, errors: [404, 422] },
];
