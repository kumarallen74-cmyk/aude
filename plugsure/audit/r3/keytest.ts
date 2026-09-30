import { issueApiKey, splitApiKey } from '../../src/services/auth.js';
import { SYSTEM_ROLES } from '../../src/services/authz.js';
import { one, pool } from '../../src/db/pool.js';
async function main() {
  const a = await one<{id:string}>(`SELECT id FROM organisation WHERE slug='nusantara-charge'`);
  let withUnderscore = 0, tested = 0;
  const keys: string[] = [];
  for (let i=0;i<20;i++){
    const k = await issueApiKey({ orgId: a!.id, name: 'ktest'+i, permissions: ['charge_point:read'], scopeType:'org', scopeId:null });
    const secret = k.key.split('_').slice(2).join('_');
    const p = splitApiKey(k.key);
    if (secret.includes('_')) { withUnderscore++; keys.push(k.key); }
    tested++;
    // verify split reconstructs
    if (!p || p.secret !== secret) console.log('SPLIT MISMATCH', k.key, p);
  }
  console.log(`issued ${tested}, ${withUnderscore} had '_' in secret`);
  for (const k of keys.slice(0,3)) console.log('UKEY='+k);
  await pool.end();
}
main();
