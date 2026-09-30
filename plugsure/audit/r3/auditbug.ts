import { canonicalJson } from '../../src/services/audit.js';
// Simulate what the api-keys route passes as `after` when name is undefined
const afterWrite = { name: undefined as any, prefix: 'abc', permissions: [] as string[] };
// WRITE path: body.after = e.after ?? null  -> the object as-is (with name:undefined)
console.log('WRITE canonicalJson(after):', canonicalJson(afterWrite));
// STORED in DB: JSON.stringify(e.after)
const stored = JSON.stringify(afterWrite);
console.log('STORED json:', stored);
// VERIFY path: JSONB parsed back = object WITHOUT name key
const afterRead = JSON.parse(stored);
console.log('READ canonicalJson(after):', canonicalJson(afterRead));
console.log('WRITE==READ hash-input?', canonicalJson(afterWrite) === canonicalJson(afterRead));
