import { readFileSync } from 'node:fs';
import createLit from '../public/engine/lit_kernel.mjs';

const bundle = JSON.parse(readFileSync(new URL('../public/data/bundle.json', import.meta.url), 'utf8'));
const mod = await createLit();
if (!mod.HEAPF64) { console.log('FAIL  HEAPF64 not exported by the module'); process.exit(2); }
const cap = mod._lit_capacity();
const view = (p) => new Float64Array(mod.HEAPF64.buffer, p >>> 0, cap);
const A = view(mod._lit_alt_ptr()), H = view(mod._lit_hor_ptr()), R = view(mod._lit_rad_ptr()), O = view(mod._lit_out_ptr());
let fails = 0;
const check = (ok, text) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + text); if (!ok) fails++; };
const load = (s) => { A.set(s.sunAlt); H.set(s.sunHorizon); R.set(s.sunRadius); return s.sunAlt.length; };
const run = (s, off) => { const n = load(s); const rc = mod._lit_compute(n, off); return { rc, n, out: Float64Array.from(O.subarray(0, n)) }; };
const hours = (a) => a.reduce((c, v) => c + (v >= 0.5 ? 1 : 0), 0);

check(cap === 10000, 'capacity ' + cap);
for (const [key, s] of Object.entries(bundle.sites)) {
  const base = run(s, 0);
  check(base.rc === s.lit.length, key + ': returned count ' + base.rc);
  let maxd = 0, flagBad = 0;
  for (let i = 0; i < base.n; i++) {
    const d = Math.abs(base.out[i] - s.lit[i]); if (d > maxd) maxd = d;
    if ((base.out[i] >= 0.5) !== (s.lit[i] >= 0.5) && Math.abs(base.out[i] - 0.5) > 6e-7) flagBad++;
  }
  check(maxd <= 6e-7, key + ': offset 0 vs bundle lit, max abs diff ' + maxd.toExponential(2) + ' (limit 6e-7, bundle lit is rounded to 6 decimals)');
  check(flagBad === 0, key + ': sunlit flag (lit >= 0.5) differs from bundle at ' + flagBad + ' samples away from the rounding edge');
  const up = run(s, 1), dn = run(s, -1);
  let mono = true;
  for (let i = 0; i < base.n; i++) if (up.out[i] > base.out[i] + 1e-12 || dn.out[i] < base.out[i] - 1e-12) mono = false;
  check(mono, key + ': raising the horizon never increases lit, lowering never decreases it');
  check(run(s, 90).out.every((v) => v === 0), key + ': offset +90 gives exactly 0 everywhere');
  check(run(s, -90).out.every((v) => v === 1), key + ': offset -90 gives exactly 1 everywhere');
  const again = run(s, 0);
  check(again.out.every((v, i) => v === base.out[i]), key + ': second identical call is bit-identical');
  console.log('      sunlit hours at offset 0 / 0.5 / 1 / 2 deg: ' + [0, 0.5, 1, 2].map((o) => hours(run(s, o).out)).join(' / '));
}
check(mod._lit_compute(-1, 0) === -1, 'count -1 returns -1');
check(mod._lit_compute(cap + 1, 0) === -1, 'count capacity+1 returns -1');
check(mod._lit_compute(1, NaN) === -2, 'NaN offset returns -2');
check(mod._lit_compute(0, 0) === 0, 'count 0 returns 0');
const s0 = Object.values(bundle.sites)[0];
load(s0); A[0] = NaN; R[1] = 0;
mod._lit_compute(3, 0);
check(Number.isNaN(O[0]) && Number.isNaN(O[1]) && Number.isFinite(O[2]), 'NaN altitude and zero radius give NaN, a good sample stays finite');
console.log(fails === 0 ? 'ALL PASS' : 'FAILED ' + fails);
process.exit(fails === 0 ? 0 : 1);
