import { type Op, type Schema } from '../types.js';

/**
 * Phase 36 (v1.48.0): src/api/phase36-routes.ts. Hotels (Sites), the installation pipeline (Sites), data privacy
 * (Users and roles) and EV battery health (Load management). The driver's privacy requests and consents are in the
 * driver API (POST /d/v1/privacy/requests, GET/PUT /d/v1/privacy/consents).
 */

const obj: Schema = { type: 'object' };
const bin = (contentType: string, description: string) => ({ description, contentType, schema: { type: 'string', format: 'binary' } as Schema });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ hotels
  { method: 'GET', path: '/v1/hotels', tag: 'Sites', summary: 'Hotels', description: '(v1.48.0) Each hotel: its site, how charges are billed (pms: to the guest\'s folio; statement: to the hotel monthly), guests in house.',
    responses: { 200: { description: '{hotels}.', schema: obj } } },
  { method: 'POST', path: '/v1/hotels', tag: 'Sites', summary: 'Add a hotel',
    description: '(v1.48.0) siteId, name, posting (pms, statement), pmsUrl (charges are POSTed there, signed with pmsSecret). The key the PMS posts check-ins with is shown once. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The hotel, with its PMS key.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/hotels/:id', tag: 'Sites', summary: 'Change, re-key or archive a hotel',
    description: '(v1.48.0) The fields above, rotatePmsKey: true (a new key, shown once), or archive: true (no guest in house). Audited.', pathParams: { id: 'The hotel.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The hotel.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/hotels/:id/valet', tag: 'Sites', summary: 'A new valet link',
    description: '(v1.48.0) The staff page at /valet/{token}, shown once; the old link stops working. Audited.', pathParams: { id: 'The hotel.' }, responses: { 200: { description: '{token, path}.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/hotels/:id/stays', tag: 'Sites', summary: 'A hotel\'s guests', description: '(v1.48.0) In house (status=all: also checked out), with their charges so far.',
    pathParams: { id: 'The hotel.' }, query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{stays}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/hotels/:id/stays', tag: 'Sites', summary: 'Check a guest in',
    description: '(v1.48.0) room, guestName, reservationRef, arrivalOn, departureOn, plate. The stay gets its own guest card (charging is started with it). One guest in house per room. Audited.',
    pathParams: { id: 'The hotel.' }, body: { required: true, schema: obj }, responses: { 201: { description: 'The stay.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'PUT', path: '/v1/hotel-stays/:id', tag: 'Sites', summary: 'Change a stay, or check out',
    description: '(v1.48.0) room, departureOn, plate; or action: check_out (the guest card stops; a session still running is still charged to the stay). Audited.', pathParams: { id: 'The stay.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The stay.', schema: obj } }, errors: [404, 409] },
  { method: 'GET', path: '/v1/hotels/:id/charges', tag: 'Sites', summary: 'A hotel\'s charges',
    description: '(v1.48.0) month: each session charged to a room — kWh, amount, posted to the folio, on the statement, or not posted (with the error).', pathParams: { id: 'The hotel.' }, query: [{ name: 'month', schema: { type: 'string' } }],
    responses: { 200: { description: '{charges}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/hotel-charges/:id/retry', tag: 'Sites', summary: 'Post a charge to the folio again', description: '(v1.48.0) A charge the PMS did not accept is tried again.',
    pathParams: { id: 'The charge.' }, responses: { 200: { description: '{id, status}.', schema: obj } }, errors: [409] },
  { method: 'GET', path: '/v1/hotels/:id/statement', tag: 'Sites', summary: 'A hotel\'s monthly statement', description: '(v1.48.0) month (default this month): the charges billed to the hotel, kWh and the total.',
    pathParams: { id: 'The hotel.' }, query: [{ name: 'month', schema: { type: 'string' } }], responses: { 200: { description: 'The statement.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/hotels/:id/statement.xlsx', tag: 'Sites', summary: 'A hotel\'s monthly statement as a spreadsheet', description: '(v1.48.0) month (default this month).',
    pathParams: { id: 'The hotel.' }, query: [{ name: 'month', schema: { type: 'string' } }], responses: { 200: bin('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'An .xlsx file.') }, errors: [404] },
  { method: 'POST', path: '/v1/hotels/pms/:key', tag: 'Sites', summary: 'A check-in, check-out or room move (the hotel\'s PMS)',
    description: '(v1.48.0) event: check_in {room, guestName, reservationRef, arrivalOn, departureOn, plate}, check_out {reservationRef or room}, room_move {reservationRef or room, newRoom}. A repeated check-in with the same reservation is the same stay. Authenticated by the hotel\'s key in the path.',
    pathParams: { key: 'The hotel\'s PMS key.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{stayId, …}.', schema: obj } }, errors: [404, 409, 422], permissions: [] },
  { method: 'GET', path: '/v1/valet/:token', tag: 'Sites', summary: 'The valet page (data)',
    description: '(v1.48.0) The hotel\'s connectors with their state and who is charging, and the rooms in house (guest initial only). Authenticated by the link\'s token.',
    pathParams: { token: 'The valet link token.' }, responses: { 200: { description: 'The page.', schema: obj } }, errors: [404], permissions: [] },
  { method: 'POST', path: '/v1/valet/:token', tag: 'Sites', summary: 'The valet: start or stop charging for a room',
    description: '(v1.48.0) action: start {stayId, connectorId} (the car plugged in; started with the stay\'s guest card) or stop {sessionId}. Recorded in the audit log.',
    pathParams: { token: 'The valet link token.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{started | stopped, room}.', schema: obj } }, errors: [404, 409, 422], permissions: [] },

  // ------------------------------------------------------------------ installations
  { method: 'GET', path: '/v1/installations', tag: 'Sites', summary: 'Installation projects',
    description: '(v1.48.0) Open projects (and those live in the last 90 days; status=all: every one) by stage — survey, design, permit, grid, install, commission, live, cancelled — with days in stage, open tasks, documents and whether past the target date.',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{projects, byStage, stages}.', schema: obj } } },
  { method: 'POST', path: '/v1/installations', tag: 'Sites', summary: 'Start an installation project',
    description: '(v1.48.0) name, address, candidateId (Demand & planning), capexProjectId, siteId, ownerId, chargersPlanned, kwPlanned, targetLiveOn, notes. It starts at survey with that stage\'s usual tasks. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The project.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/installations/:id', tag: 'Sites', summary: 'An installation project',
    description: '(v1.48.0) The project, its tasks by stage, documents, stage history and its capex project\'s budget and spend.', pathParams: { id: 'The project.' }, responses: { 200: { description: 'The project.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/installations/:id', tag: 'Sites', summary: 'Change an installation project', description: '(v1.48.0) The fields above.',
    pathParams: { id: 'The project.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The project.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/installations/:id/stage', tag: 'Sites', summary: 'Move a project on, or cancel it',
    description: '(v1.48.0) action: advance (the stage\'s required tasks done; live needs the site linked) or cancel (note: why); note. The next stage\'s usual tasks are added. Audited.',
    pathParams: { id: 'The project.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The project.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/installations/:id/tasks', tag: 'Sites', summary: 'Add a task', description: '(v1.48.0) title, stage (default the current one), required, dueOn, assigneeId.',
    pathParams: { id: 'The project.' }, body: { required: true, schema: obj }, responses: { 201: { description: 'The project.', schema: obj } }, errors: [404, 422] },
  { method: 'PUT', path: '/v1/installations/:id/tasks/:taskId', tag: 'Sites', summary: 'Change, tick or remove a task', description: '(v1.48.0) done, title, required, dueOn, assigneeId, or remove: true.',
    pathParams: { id: 'The project.', taskId: 'The task.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The project.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/installations/:id/documents', tag: 'Sites', summary: 'Add a document',
    description: '(v1.48.0) kind (survey, drawing, permit, grid, photo, commissioning, contract, other), name, dataUrl (PDF, JPEG, PNG, Word, Excel or DWG; at most 15 MB; the type is checked). Audited.',
    pathParams: { id: 'The project.' }, body: { required: true, schema: obj }, responses: { 201: { description: '{id, name, kind}.', schema: obj } }, errors: [404, 413, 422] },
  { method: 'GET', path: '/v1/installations/documents/:docId', tag: 'Sites', summary: 'A document', description: '(v1.48.0) The file.',
    pathParams: { docId: 'The document.' }, responses: { 200: bin('application/octet-stream', 'The file, with its own content type.') }, errors: [404] },
  { method: 'DELETE', path: '/v1/installations/documents/:docId', tag: 'Sites', summary: 'Remove a document', description: '(v1.48.0) Hidden from the project (the file is kept). Audited.',
    pathParams: { docId: 'The document.' }, responses: { 200: { description: '{id, removed}.', schema: obj } }, errors: [404] },

  // ------------------------------------------------------------------ privacy
  { method: 'GET', path: '/v1/privacy/settings', tag: 'Users and roles', summary: 'Privacy settings',
    description: '(v1.48.0) The data protection officer, the response time for requests (hours, default 72) and the retention of plates, survey comments and closed support cases (days; none: kept).',
    responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/privacy/settings', tag: 'Users and roles', summary: 'Change the privacy settings', description: '(v1.48.0) dpoName, dpoEmail, responseHours (24–2160), plateRetentionDays, surveyCommentDays, supportCaseDays. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/privacy/requests', tag: 'Users and roles', summary: 'Data subject requests',
    description: '(v1.48.0) Open requests (status=all: every one), soonest due first: kind (access, export, correction, erasure, objection), the person, when due, verified, the outcome.',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{requests}.', schema: obj } } },
  { method: 'POST', path: '/v1/privacy/requests', tag: 'Users and roles', summary: 'Record a data subject request',
    description: '(v1.48.0) kind, channel (email, console, other), appDriverId or subjectPhone or subjectEmail, subjectName, details. Due after the response time. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The request.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/privacy/requests/:id/verify', tag: 'Users and roles', summary: 'Record how the person\'s identity was checked',
    description: '(v1.48.0) verification (how), appDriverId (the account it is about). Audited.', pathParams: { id: 'The request.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The request.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/privacy/requests/:id/close', tag: 'Users and roles', summary: 'Complete or reject a request',
    description: '(v1.48.0) action: complete — access/export: the copy is ready (export.json); correction: name, email; erasure: the account is deleted as the app\'s own deletion does (refused while a charge is unpaid or running); objection: purposes withdrawn — or reject with outcome (why). Audited.',
    pathParams: { id: 'The request.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The request.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/privacy/requests/:id/export.json', tag: 'Users and roles', summary: 'The copy of a person\'s data',
    description: '(v1.48.0) For a completed access or export request: the account, charges, payments, saved cards, support cases, surveys, credit and consents, as JSON. Audited.',
    pathParams: { id: 'The request.' }, responses: { 200: { description: 'JSON.', contentType: 'application/json', schema: obj } }, errors: [404, 409] },
  { method: 'GET', path: '/v1/privacy/consents', tag: 'Users and roles', summary: 'Consent records',
    description: '(v1.48.0) purpose: how many drivers have each consent now, and the latest 500 grants and withdrawals.', query: [{ name: 'purpose', schema: { type: 'string' } }],
    responses: { 200: { description: '{summary, log}.', schema: obj } } },
  { method: 'GET', path: '/v1/privacy/inventory', tag: 'Users and roles', summary: 'The personal data inventory',
    description: '(v1.48.0) Each category of personal data held: what, where, why, the legal basis, the retention and how many records.', responses: { 200: { description: '{inventory}.', schema: obj } } },

  // ------------------------------------------------------------------ battery health
  { method: 'GET', path: '/v1/battery-health', tag: 'Load management', summary: 'Fleet battery health',
    description: '(v1.48.0) Each fleet vehicle: estimated usable capacity and state of health (the median of the last 90 days), degradation per year, the latest flags; and the fleet\'s median, how many are under 80 % and how many were flagged.',
    responses: { 200: { description: '{vehicles, fleet}.', schema: obj } } },
  { method: 'GET', path: '/v1/battery-health/:vehicleId', tag: 'Load management', summary: 'A vehicle\'s battery health',
    description: '(v1.48.0) The monthly medians and each session\'s estimate: state of charge at the start and end (and where from), kWh, the capacity, the peak power and flags.',
    pathParams: { vehicleId: 'The fleet vehicle.' }, responses: { 200: { description: 'The vehicle.', schema: obj } }, errors: [404] },
];
