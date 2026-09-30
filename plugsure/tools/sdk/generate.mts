// Writes the TypeScript SDK (sdk/typescript) from the published OpenAPI document
// (src/web/openapi.json), compiles it, and packs it for download at
// /sdk/plugsure-csms-sdk.tgz (src/web/sdk).
//
//     npm run sdk              regenerate, build and pack (run npm run openapi first)
//     npm run sdk -- --check   fail if sdk/typescript/src/generated.ts is out of date
//     npm run sdk -- --no-pack regenerate and build only
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildTsSdk } from '../../src/api/openapi/sdk-ts.js';
import { SPEC_FILE } from '../../src/api/openapi/generate.js';

const root = join(import.meta.dirname, '..', '..');
const SDK_FILE = 'plugsure-csms-sdk.tgz';
const sdkDir = join(root, 'sdk', 'typescript');
const out = join(sdkDir, 'src', 'generated.ts');
const spec = JSON.parse(readFileSync(join(root, SPEC_FILE), 'utf8'));
const { text, operations } = buildTsSdk(spec);

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error('sdk/typescript/src/generated.ts is out of date: run npm run sdk');
    process.exit(1);
  }
  console.log('sdk/typescript/src/generated.ts is up to date');
  process.exit(0);
}

writeFileSync(out, text);
console.log(`wrote sdk/typescript/src/generated.ts: ${operations.length} operations, ${Object.keys(spec.components.schemas).length} schemas`);

// The SDK carries the API's version.
const pkgFile = join(sdkDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
if (pkg.version !== spec.info.version) {
  pkg.version = spec.info.version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}

rmSync(join(sdkDir, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', sdkDir], { stdio: 'inherit' });
console.log('built sdk/typescript/dist');

if (!process.argv.includes('--no-pack')) {
  const dest = join(root, 'src', 'web', 'sdk');
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(dest)) if (f.endsWith('.tgz')) rmSync(join(dest, f));
  // npm's own CLI script through this Node (no shell), where it sits next to node; plain npm otherwise.
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => p && p.endsWith('.js') && existsSync(p));
  const args = ['pack', '--silent', '--pack-destination', dest];
  const packed = cli ? execFileSync(process.execPath, [cli, ...args], { cwd: sdkDir, encoding: 'utf8' }) : execFileSync('npm', args, { cwd: sdkDir, encoding: 'utf8' });
  // Served under a fixed name, so the console's download link does not change with the version.
  const name = packed.trim().split('\n').pop()!.trim();
  renameSync(join(dest, name), join(dest, SDK_FILE));
  console.log(`packed src/web/sdk/${SDK_FILE} (${name})`);
}
