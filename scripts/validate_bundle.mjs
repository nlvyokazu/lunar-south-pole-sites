// CLI: node scripts/validate_bundle.mjs [path]   (default: public/data/bundle.json)
// Dependency-free. The rules live in validate_core.mjs so the browser smoke
// test runs exactly the same code. Prints PASS or FAIL per rule; exits 1 on any FAIL.
import { readFileSync } from 'node:fs';
import { validateBundle } from './validate_core.mjs';

const MAX_DETAILS = 10;
const path = process.argv[2] ?? 'public/data/bundle.json';

let bundle;
try {
  bundle = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.log(`FAIL  file-readable-json  ${path}: ${e.message}`);
  console.log('RESULT: FAIL (file could not be read or is not valid JSON)');
  process.exit(1);
}

const report = validateBundle(bundle);
for (const r of report.results) {
  console.log(`${r.status}  ${r.id}  ${r.title}`);
  for (const f of r.failures.slice(0, MAX_DETAILS)) console.log(`      - ${f}`);
  if (r.failures.length > MAX_DETAILS) console.log(`      - ... and ${r.failures.length - MAX_DETAILS} more`);
  for (const n of r.notes) console.log(`      NOTE ${n}`);
}

const failed = report.results.filter((r) => r.status === 'FAIL').length;
const total = report.results.length;
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${total - failed}/${total} rules pass)`);
process.exitCode = failed === 0 ? 0 : 1;
