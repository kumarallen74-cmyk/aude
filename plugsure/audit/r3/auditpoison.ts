import { writeAudit, verifyChain } from '../../src/services/audit.js';
import { one, pool } from '../../src/db/pool.js';
async function main(){
  const o = (await one<{id:string}>(`INSERT INTO organisation (name,slug,licence_scheme) VALUES ('PoisonCo','poison-'||floor(random()*1e6)::text,'POPO') RETURNING id`))!.id;
  console.log('fresh org clean chain:', (await verifyChain(o)).ok);
  // ONE audit write exactly like POST /v1/api-keys with no name, or /v1/tariffs w/o name, or budget w/o reserveW
  await writeAudit({ orgId:o, actorType:'user', actorId:'u', action:'api_key.issued', targetType:'api_key', targetId:'k1',
    after:{ name: undefined as any, prefix:'abc', permissions:['charge_point:read'] } });
  const r = await verifyChain(o);
  console.log('after ONE ordinary audited op (undefined field):', r.ok, r.problems.map((p:any)=>p.kind));
  await pool.end();
}
main();
