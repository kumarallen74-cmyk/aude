import { issueApiKey } from '../../src/services/auth.js';
import { SYSTEM_ROLES } from '../../src/services/authz.js';
import { one, pool } from '../../src/db/pool.js';

async function main() {
  const b = await one<{id:string}>(`SELECT id FROM organisation WHERE slug='rival-charge'`);
  const k = await issueApiKey({ orgId: b!.id, name: 'orgB-owner', permissions: SYSTEM_ROLES.org_owner!, scopeType: 'org', scopeId: null });
  console.log('ORGB_KEY=' + k.key);
  await pool.end();
}
main();
