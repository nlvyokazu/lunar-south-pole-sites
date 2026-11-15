import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as M from '../src/model.ts';
import * as L from '../src/lit.ts';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  process.stdout.write((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' (' + detail + ')' : '') + '\n');
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countLit = (arr) => {
  let c = 0;
  for (const v of arr) if (v >= 0.5) c++;
  return c;
};
const countOnes = (arr) => {
  let c = 0;
  for (const v of arr) if (v === 1) c++;
  return c;
};

// ---- a) hand-made arrays
const f1 = Int8Array.from([1, 1, 0, 0, 1]);
check('a runs with edges', same(M.findRuns(f1, 1, 0, 5), [
  { start: 0, end: 1, samples: 2, openStart: true, openEnd: false },
  { start: 4, end: 4, samples: 1, openStart: false, openEnd: true },
]));
check('a runs in a sub-range', same(M.findRuns(f1, 1, 1, 4), [
  { start: 1, end: 1, samples: 1, openStart: true, openEnd: false },
]));
check('a empty and reversed ranges', M.findRuns(f1, 1, 3, 3).length === 0 && M.findRuns(f1, 1, 4, 1).length === 0 && M.findRuns(f1, 1, -5, 0).length === 0);
check('a range is clamped', same(M.findRuns(f1, 1, -3, 99), M.findRuns(f1, 1, 0, 5)));
const sAll1 = M.summarize(new Int8Array(10).fill(1), 0, 10);
check('a all lit', sAll1.pct === 100 && sAll1.lit.length === 1 && sAll1.lit[0].samples === 10 && sAll1.dark.length === 0 && sAll1.longestDark === null);
const sAll0 = M.summarize(new Int8Array(10).fill(0), 0, 10);
check('a all dark', sAll0.pct === 0 && sAll0.longestLit === null && sAll0.longestDark.samples === 10);
const sf = M.sunFlags([NaN, 0.6, 0.4, 0.5, Infinity]);
check('a sunFlags NaN and 0.5', same(Array.from(sf), [-1, 1, 0, 1, -1]));
const sNaN = M.summarize(sf, 0, 5);
check('a NaN is ignored in percent', sNaN.known === 3 && Math.abs(sNaN.pct - 200 / 3) < 1e-9);
check('a unknown sample breaks a run', M.findRuns(Int8Array.from([1, -1, 1]), 1, 0, 3).length === 2);
check('a summarize empty range', M.summarize(f1, 2, 2).pct === null && M.summarize(f1, 2, 2).known === 0);
check('a earthFlags margin', same(Array.from(M.earthFlags([1, 2], [0, 0], 1)), [0, 1]) && same(Array.from(M.earthFlags([1, 2], [0, 0], NaN)), [-1, -1]) && same(Array.from(M.earthFlags([NaN, 1], [0, 0], 0)), [-1, 1]));
check('a parseThreshold', M.parseThreshold('') === null && M.parseThreshold('  ') === null && M.parseThreshold('abc') === null && M.parseThreshold('Infinity') === null && M.parseThreshold('40') === 40 && M.parseThreshold('0') === 0 && M.parseThreshold('1e2') === 100 && M.parseThreshold('-1.5') === -1.5);
check('a minCheck', M.minCheck(40, 40) === 'PASS' && M.minCheck(39.9, 40) === 'FAIL' && M.minCheck(null, 40) === 'NONE' && M.minCheck(50, null) === 'NONE');
const closed = [{ start: 2, end: 4, samples: 3, openStart: false, openEnd: false }];
const openShort = [{ start: 7, end: 7, samples: 1, openStart: false, openEnd: true }];
const mixed = closed.concat(openShort);
check('a maxRunCheckAll closed', M.maxRunCheckAll(closed, 5, 8) === 'PASS' && M.maxRunCheckAll(closed, 2, 8) === 'FAIL');
check('a maxRunCheckAll open run never gives a clean PASS', M.maxRunCheckAll(openShort, 3, 8) === 'PASS_OPEN' && M.maxRunCheckAll(mixed, 5, 8) === 'PASS_OPEN');
check('a maxRunCheckAll open run too long still FAILS', M.maxRunCheckAll(openShort, 0.5, 8) === 'FAIL');
check('a maxRunCheckAll none and empty', M.maxRunCheckAll(closed, null, 8) === 'NONE' && M.maxRunCheckAll(closed, 5, 0) === 'NONE' && M.maxRunCheckAll([], 5, 8) === 'PASS');
check('a overall', M.overall(['PASS', 'PASS']) === 'MEETS' && M.overall(['PASS', 'PASS_OPEN']) === 'MEETS_OPEN' && M.overall(['PASS', 'FAIL', 'PASS_OPEN']) === 'FAILS' && M.overall(['PASS', 'NONE', 'FAIL']) === 'NONE');
const rows = [
  { key: 'a', overall: 'FAILS', fails: 2, sunPct: 50, earthPct: 50 },
  { key: 'b', overall: 'MEETS', fails: 0, sunPct: 30, earthPct: 20 },
  { key: 'c', overall: 'FAILS', fails: 1, sunPct: 20, earthPct: 90 },
  { key: 'd', overall: 'FAILS', fails: 1, sunPct: 60, earthPct: 10 },
  { key: 'e', overall: 'MEETS_OPEN', fails: 0, sunPct: 30, earthPct: 40 },
  { key: 'f', overall: 'FAILS', fails: 1, sunPct: null, earthPct: null },
];
check('a rank order', same(M.rankSites(rows), ['e', 'b', 'd', 'c', 'f', 'a']), M.rankSites(rows).join(','));
const t1 = Int8Array.from([1, 1, 0, 1, 0]);
check('a nextTransition fall and rise', same(M.nextTransition(t1, 0, 'fall'), { index: 2, within: false, startedUnknown: false }) && same(M.nextTransition(t1, 1, 'fall'), { index: 2, within: true, startedUnknown: false }) && M.nextTransition(t1, 0, 'rise').index === 3 && M.nextTransition(t1, 4, 'fall').index === null);
check('a nextTransition unknown start', same(M.nextTransition(Int8Array.from([-1, 1, 0]), 0, 'fall'), { index: 2, within: false, startedUnknown: true }));
check('a parseUtc and formatUtc', M.parseUtc('2026-11-15T00:00:00') === Date.UTC(2026, 10, 15) && M.parseUtc('2026-11-15 06:30') === Date.UTC(2026, 10, 15, 6, 30) && M.parseUtc('2026-11-15T00:00:00Z') === Date.UTC(2026, 10, 15) && Number.isNaN(M.parseUtc('2026-02-30')) && Number.isNaN(M.parseUtc('hello')) && M.formatUtc(Date.UTC(2026, 10, 16, 3, 0)) === '2026-11-16 03:00 UTC');
check('a fmtHours', M.fmtHours(26) === '1 d 2 h' && M.fmtHours(30) === '1 d 6 h' && M.fmtHours(48) === '2 d' && M.fmtHours(5) === '5 h' && M.fmtHours(0.5) === '0 h');

// ---- b) real bundle at margin 0
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'bundle.json'), 'utf8'));
const kernel = await L.loadLit(pathToFileURL(path.join(root, 'public', 'engine', 'lit_kernel.mjs')).href);
const keys = ['malapert_a', 'nobile_w', 'amundsen'];
check('b three site keys and hourly step', keys.every((k) => bundle.sites[k] !== undefined) && bundle.meta.step_hours === 1);
const expectedHours = { malapert_a: [3459, 3232], nobile_w: [2201, 1887], amundsen: [3581, 2251] };
let maxAll = 0;
for (const key of keys) {
  const s = bundle.sites[key];
  const n = s.t.length;
  check('b ' + key + ' has 8760 samples', n === 8760);
  const idx = new Map(s.t.map((x, i) => [x, i]));
  const toRuns = (wins) => wins.map((w) => ({ start: idx.get(w.start), end: idx.get(w.end), samples: w.samples, whole: w.whole_span }));
  const fromRuns = (runs) => runs.map((r) => ({ start: r.start, end: r.end, samples: r.samples, whole: r.start === 0 && r.end === n - 1 }));
  const out = kernel.compute(s.sunAlt, s.sunHorizon, s.sunRadius, 0);
  const chk = L.checkAgainstBundle(out, s.lit);
  if (chk.maxDiff > maxAll) maxAll = chk.maxDiff;
  check('b ' + key + ' kernel matches bundle lit', chk.passed, 'max diff ' + chk.maxDiff.toExponential(2) + ', flag mismatches ' + chk.flagMismatches + ', nan mismatches ' + chk.nanMismatches);
  const sunF = M.sunFlags(out);
  const lit = fromRuns(M.findRuns(sunF, 1, 0, n));
  const dark = fromRuns(M.findRuns(sunF, 0, 0, n));
  check('b ' + key + ' Sun-visible windows equal windows.sunlit', same(lit, toRuns(s.windows.sunlit)), lit.length + ' vs ' + s.windows.sunlit.length);
  check('b ' + key + ' dark windows equal windows.dark', same(dark, toRuns(s.windows.dark)), dark.length + ' vs ' + s.windows.dark.length);
  const earthF = M.earthFlags(s.earthAlt, s.earthHorizon, 0);
  const earth = fromRuns(M.findRuns(earthF, 1, 0, n));
  check('b ' + key + ' Earth-in-view windows equal windows.comms', same(earth, toRuns(s.windows.comms)), earth.length + ' vs ' + s.windows.comms.length);

  // ---- c) margin
  const h0 = countLit(out);
  const h1 = countLit(kernel.compute(s.sunAlt, s.sunHorizon, s.sunRadius, 1));
  check('c ' + key + ' sunlit hours at margin 0 and 1', h0 === expectedHours[key][0] && h1 === expectedHours[key][1], 'got ' + h0 + ' and ' + h1 + ', expected ' + expectedHours[key].join(' and '));
  let prev = Infinity;
  let mono = true;
  for (const mg of [0, 0.5, 1, 2, 5]) {
    const c = countLit(kernel.compute(s.sunAlt, s.sunHorizon, s.sunRadius, mg));
    if (c > prev) mono = false;
    prev = c;
  }
  check('c ' + key + ' Sun-visible hours never grow with margin', mono);
  const e0 = countOnes(M.earthFlags(s.earthAlt, s.earthHorizon, 0));
  const e1 = countOnes(M.earthFlags(s.earthAlt, s.earthHorizon, 1));
  check('c ' + key + ' Earth-in-view hours never grow with margin', e1 <= e0, e0 + ' then ' + e1);
}
process.stdout.write('max kernel difference vs bundle lit: ' + maxAll.toExponential(2) + '\n');
process.stdout.write(failures === 0 ? 'ALL PASS\n' : 'FAILURES: ' + failures + '\n');
process.exitCode = failures === 0 ? 0 : 1;