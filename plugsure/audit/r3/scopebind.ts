import { enterOrgScope, currentScopeOrg, query, one } from '../../src/db/pool.js';
import { pool } from '../../src/db/pool.js';

// Mirror Fastify: a preHandler calls enterOrgScope (enterWith), then the handler
// runs as a LATER await continuation. Simulate that boundary.
async function simulateRequest(orgId: string) {
  // preHandler
  const handle = await enterOrgScope(orgId);
  // cross an await boundary like Fastify does between hook and handler
  await new Promise((r) => setImmediate(r));
  // handler:
  const seenOrg = currentScopeOrg();
  const guc = await one<{v:string}>(`SELECT current_setting('app.current_org_id', true) AS v`);
  const txn = await one<{t:boolean}>(`SELECT now() != statement_timestamp() AS t`); // inside txn markers differ? weak
  await handle.commit();
  return { seenOrg, guc: guc?.v };
}

async function main() {
  const org = (await one<{id:string}>(`SELECT id FROM organisation WHERE slug='rival-charge'`))!.id;
  const r = await simulateRequest(org);
  console.log('bound orgId in handler continuation:', r.seenOrg);
  console.log('app.current_org_id GUC in handler query:', r.guc);
  console.log('MATCH:', r.seenOrg === org && r.guc === org);
  await pool.end();
}
main();
