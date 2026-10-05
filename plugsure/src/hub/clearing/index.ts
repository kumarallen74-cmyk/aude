import { setCdrLedger } from '../ledger-tap.js';
import { admitCdr, tapCdr } from './intake.js';

/**
 * PlugSure Hub clearing and settlement (WP H2, docs/HUB-DESIGN.md §8 and "H2 as built").
 *
 *   intake.ts      admit / tap routed CDRs into the ledger (hub_cdr), validation flags, credit pairing
 *   accept.ts      dispute window → accepted (fees frozen)
 *   fees.ts        hub commission plans and arithmetic
 *   disputes.ts    the dispute state machine
 *   netting.ts     bilateral netting (pure)
 *   period.ts      settlement periods in each currency's time zone (pure)
 *   settlement.ts  runs (draft → finalised), positions, statements, payments, overdue
 *   invoices.ts    hub fee invoices from the PlugSure entities, with the tax engines
 *   documents.ts   statement / invoice HTML, PDF and CSV
 *   queries.ts     read models of the clearing API
 */

/** Wire the ledger to the router (only when HUB_ENABLED: called next to registerHubApi). */
export function registerClearingLedger(): void {
  setCdrLedger({
    admit: (e) => admitCdr(e),
    onCdrRouted: async (e, forward) => { await tapCdr(e, forward); },
  });
}

export { autoAccept } from './accept.js';
export { escalateOverdue } from './disputes.js';
export { markOverdue, scheduleRuns } from './settlement.js';
