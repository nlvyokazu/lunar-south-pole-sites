import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as M from '../src/model.ts';
import * as L from '../src/lit.ts';
import * as E from '../src/engine.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let cur = null;

function short(x) {
  let s;
  try {
    s = JSON.stringify(ArrayBuffer.isView(x) ? Array.from(x) : x);
  } catch {
    s = String(x);
  }
  if (s === undefined) return String(x);
  return s.length > 150 ? s.slice(0, 150) + '...' : s;
}

function group(name, fn) {
  cur = { name, n: 0, bad: 0, first: '' };
  fn();
  const g = cur;
  cur = null;
  if (g.bad > 0) failures++;
  const tail = g.bad > 0 ? ', ' + g.bad + ' differ, first: ' + g.first : '';
  process.stdout.write((g.bad > 0 ? 'FAIL ' : 'PASS ') + g.name + ' (' + g.n + ' comparisons' + tail + ')\n');
}

function eq(label, got, want) {
  cur.n++;
  if (!isDeepStrictEqual(got, want)) {
    cur.bad++;
    if (cur.first === '') cur.first = label + ' got ' + short(got) + ' want ' + short(want);
  }
}

const arr = (x) => Array.from(x);

function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    const xf = Number.isFinite(x);
    const yf = Number.isFinite(y);
    if (xf !== yf) return Infinity;
    if (xf && Math.abs(x - y) > m) m = Math.abs(x - y);
  }
  return m;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const eng = await E.loadEngine(pathToFileURL(path.join(root, 'public/engine/engine.mjs')).href);
const oldK = await L.loadLit(pathToFileURL(path.join(root, 'public/engine/lit_kernel.mjs')).href);
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'public/data/bundle.json'), 'utf8'));
const keys = ['amundsen', 'malapert_a', 'nobile_w'];
const CHECKS = ['PASS', 'FAIL', 'PASS_OPEN', 'NONE'];

// ---- 1. hand cases: flags
group('hand cases: flags', () => {
  const litIn = [NaN, 0.6, 0.4, 0.5, Infinity, null];
  eq('sunFlagsFromLit literal', arr(eng.sunFlagsFromLit(litIn)), [-1, 1, 0, 1, -1, -1]);
  eq('sunFlagsFromLit vs model', arr(eng.sunFlagsFromLit(litIn)), arr(M.sunFlags(litIn)));
  const earthCases = [
    [[1, 2], [0, 0], 1],
    [[1, 2], [0, 0], NaN],
    [[NaN, 1], [0, 0], 0],
    [[1, 1], [null, 0], 0],
    [[1, 1.0000001, 0.9], [0, 0, 0], 1],
    [[], [], 0],
  ];
  for (const [a, h, m] of earthCases) {
    eq('earth ' + short(a) + short(h) + ' m=' + m, arr(eng.earthFlags(a, h, m)), arr(M.earthFlags(a, h, m)));
  }
  const alt = [1, 0.5, -1, 0.26, 0, 0.27, -0.27, 5];
  const hor = alt.map(() => 0);
  const rad = alt.map(() => 0.27);
  for (const m of [0, 0.25, 0.5, 1]) {
    eq('bodies flags m=' + m, arr(eng.sunFlagsFromBodies(alt, hor, rad, m)), arr(M.sunFlags(oldK.compute(alt, hor, rad, m))));
    eq('lit values m=' + m, maxDiff(eng.lit(alt, hor, rad, m), oldK.compute(alt, hor, rad, m)) <= 1e-12, true);
  }
  eq('radius 0 gives unknown', arr(eng.sunFlagsFromBodies([1], [0], [0], 0)), [-1]);
  eq('NaN horizon gives unknown', arr(eng.sunFlagsFromBodies([1], [NaN], [0.27], 0)), [-1]);
  eq('null altitude gives unknown', arr(eng.sunFlagsFromBodies([null], [0], [0.27], 0)), [-1]);
  eq('empty lit', eng.lit([], [], [], 0).length, 0);
  let threw = false;
  try {
    eng.earthFlags(new Array(10001).fill(1), new Array(10001).fill(0), 0);
  } catch {
    threw = true;
  }
  eq('over capacity throws', threw, true);
});

// ---- 2. hand cases: runs and summaries
group('hand cases: summaries', () => {
  const flagSets = [[1, 1, 0, 0, 1], [1, -1, 1], [-1, -1], [], [0], [1], [0, 1, 0, 1, 0, 1, 1, 1, 0]];
  const ranges = [[0, 5], [1, 4], [3, 3], [4, 1], [-5, 0], [-3, 99], [0, 1], [2.7, 4.2], [NaN, 3], [0, Infinity], [-Infinity, 2]];
  for (const f of flagSets) {
    const flags = Int8Array.from(f);
    for (const [from, to] of ranges) {
      eq('summarize ' + short(f) + ' ' + from + ',' + to, eng.summarize(flags, from, to), M.summarize(flags, from, to));
    }
  }
});

// ---- 3. random flags: summaries and transitions
group('random flags: summaries and transitions', () => {
  const r = rng(12345);
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(r() * 300);
    const f = new Int8Array(n);
    let prev = Math.floor(r() * 3) - 1;
    for (let i = 0; i < n; i++) {
      if (r() > 0.8) prev = Math.floor(r() * 3) - 1;
      f[i] = prev;
    }
    const from = Math.floor(r() * (n + 20)) - 10 + (r() < 0.3 ? 0.5 : 0);
    const to = Math.floor(r() * (n + 20)) - 10 + (r() < 0.3 ? 0.5 : 0);
    eq('summarize trial ' + t, eng.summarize(f, from, to), M.summarize(f, from, to));
    const ref = Math.floor(r() * (n + 6)) - 3;
    for (const kind of ['fall', 'rise']) {
      eq('transition trial ' + t + ' ' + kind, eng.nextTransition(f, ref, kind), M.nextTransition(f, ref, kind));
    }
  }
});

// ---- 4. checks and overall
group('checks and overall', () => {
  for (const pct of [null, 0, 39.99, 40, 40.0000001, 100]) {
    for (const min of [null, 0, 40, 100, 150]) {
      eq('minCheck ' + pct + ' ' + min, eng.minCheck(pct, min), M.minCheck(pct, min));
    }
  }
  const w = (s, e, os, oe) => ({ start: s, end: e, samples: e - s + 1, openStart: os, openEnd: oe });
  const runSets = [
    [],
    [w(0, 9, false, false)],
    [w(0, 9, true, false)],
    [w(0, 9, false, true)],
    [w(0, 4, false, false), w(10, 29, false, false), w(40, 44, false, true)],
    [w(0, 4, true, false), w(10, 12, false, false)],
  ];
  for (const runs of runSets) {
    for (const mh of [null, 0, 9, 10, 11, 20, 1000]) {
      for (const rh of [0, 720]) {
        eq('maxRunCheckAll ' + short(runs) + ' ' + mh + ' ' + rh, eng.maxRunCheckAll(runs, mh, rh), M.maxRunCheckAll(runs, mh, rh));
      }
    }
  }
  const build = (len) => {
    if (len === 0) return [[]];
    const out = [];
    for (const rest of build(len - 1)) for (const c of CHECKS) out.push([c, ...rest]);
    return out;
  };
  for (let len = 0; len <= 4; len++) {
    for (const checks of build(len)) eq('overall ' + short(checks), eng.overall(checks), M.overall(checks));
  }
});

// ---- 5. ranking
group('ranking', () => {
  const row = (key, overall, fails, sunPct, earthPct) => ({ key, overall, fails, sunPct, earthPct });
  const hand = [
    [row('b', 'FAILS', 1, 50, 50), row('a', 'FAILS', 1, 50, 50)],
    [row('a', 'FAILS', 3, 10, 10), row('b', 'MEETS', 0, 1, 1), row('c', 'MEETS_OPEN', 0, 99, 99)],
    [row('a', 'NONE', 0, null, null), row('b', 'FAILS', 0, null, 5), row('c', 'FAILS', 0, 5, null)],
    [row('x', 'FAILS', 2, 20, 30), row('y', 'FAILS', 2, 20, 40), row('z', 'FAILS', 2, 25, 0)],
    [],
  ];
  hand.forEach((rows, i) => eq('hand ranking ' + i, eng.rankSites(rows), M.rankSites(rows)));
  const r = rng(777);
  const pool = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
  const overalls = ['MEETS', 'FAILS', 'MEETS_OPEN', 'NONE'];
  const pcts = [null, 0, 25, 50, 50, 100];
  for (let t = 0; t < 300; t++) {
    const p = pool.slice();
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    const n = 1 + Math.floor(r() * 6);
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(row(p[i], overalls[Math.floor(r() * 4)], Math.floor(r() * 5), pcts[Math.floor(r() * 6)], pcts[Math.floor(r() * 6)]));
    }
    eq('random ranking ' + t, eng.rankSites(rows), M.rankSites(rows));
  }
});

// ---- 6. real bundle: flags at several margins
const MARGINS = [0, 0.5, 1, 2, 3.7];
const fl = {};
group('real bundle: flags at margins 0, 0.5, 1, 2, 3.7', () => {
  for (const m of MARGINS) {
    fl[m] = {};
    for (const key of keys) {
      const s = bundle.sites[key];
      const label = key + ' m=' + m;
      const oldLit = oldK.compute(s.sunAlt, s.sunHorizon, s.sunRadius, m);
      eq(label + ' lit values', maxDiff(eng.lit(s.sunAlt, s.sunHorizon, s.sunRadius, m), oldLit) <= 1e-12, true);
      const mSun = M.sunFlags(oldLit);
      const eSun = eng.sunFlagsFromBodies(s.sunAlt, s.sunHorizon, s.sunRadius, m);
      eq(label + ' sun flags', arr(eSun), arr(mSun));
      const mEarth = M.earthFlags(s.earthAlt, s.earthHorizon, m);
      const eEarth = eng.earthFlags(s.earthAlt, s.earthHorizon, m);
      eq(label + ' earth flags', arr(eEarth), arr(mEarth));
      if (m === 0) eq(label + ' flags from bundle lit', arr(eng.sunFlagsFromLit(s.lit)), arr(M.sunFlags(s.lit)));
      fl[m][key] = { mSun, eSun, mEarth, eEarth };
    }
  }
});

// ---- 7. real bundle: summaries, checks, overall, ranking
group('real bundle: summaries, checks, ranking', () => {
  const ranges = [[0, 720], [0, 8760], [100, 500], [8000, 9000], [5, 5], [700, 100], [-10, 50], [720, 1440], [0, 1]];
  const thrs = [[40, 40, 200, 200], [0, 0, 10000, 10000], [90, 90, 50, 50]];
  for (const m of MARGINS) {
    for (const [from, to] of ranges) {
      const hrs = to - from;
      const sums = {};
      for (const key of keys) {
        const f = fl[m][key];
        sums[key] = {
          sM: M.summarize(f.mSun, from, to),
          sE: eng.summarize(f.eSun, from, to),
          eM: M.summarize(f.mEarth, from, to),
          eE: eng.summarize(f.eEarth, from, to),
        };
        eq(key + ' m=' + m + ' ' + from + ',' + to + ' sun summary', sums[key].sE, sums[key].sM);
        eq(key + ' m=' + m + ' ' + from + ',' + to + ' earth summary', sums[key].eE, sums[key].eM);
      }
      for (const thr of thrs) {
        const rowsM = [];
        const rowsE = [];
        for (const key of keys) {
          const { sM, sE, eM, eE } = sums[key];
          const cM = [M.minCheck(sM.pct, thr[0]), M.minCheck(eM.pct, thr[1]), M.maxRunCheckAll(sM.dark, thr[2], hrs), M.maxRunCheckAll(eM.dark, thr[3], hrs)];
          const cE = [eng.minCheck(sE.pct, thr[0]), eng.minCheck(eE.pct, thr[1]), eng.maxRunCheckAll(sE.dark, thr[2], hrs), eng.maxRunCheckAll(eE.dark, thr[3], hrs)];
          const label = key + ' m=' + m + ' ' + from + ',' + to + ' thr ' + thr.join('/');
          eq(label + ' checks', cE, cM);
          eq(label + ' overall', eng.overall(cE), M.overall(cM));
          rowsM.push({ key, overall: M.overall(cM), fails: cM.filter((c) => c === 'FAIL').length, sunPct: sM.pct, earthPct: eM.pct });
          rowsE.push({ key, overall: eng.overall(cE), fails: cE.filter((c) => c === 'FAIL').length, sunPct: sE.pct, earthPct: eE.pct });
        }
        eq('ranking m=' + m + ' ' + from + ',' + to + ' thr ' + thr.join('/'), eng.rankSites(rowsE), M.rankSites(rowsM));
      }
    }
  }
});

// ---- 8. real bundle: next transitions
group('real bundle: next sunset and Earthset searches', () => {
  const refs = [-1, 0, 1, 2, 100, 500, 4000, 8758, 8759, 8760, 9000];
  for (let i = 3; i < 8760; i += 97) refs.push(i);
  for (const m of MARGINS) {
    for (const key of keys) {
      const f = fl[m][key];
      for (const kind of ['fall', 'rise']) {
        for (const ref of refs) {
          eq(key + ' m=' + m + ' sun ' + kind + ' ref ' + ref, eng.nextTransition(f.eSun, ref, kind), M.nextTransition(f.mSun, ref, kind));
          eq(key + ' m=' + m + ' earth ' + kind + ' ref ' + ref, eng.nextTransition(f.eEarth, ref, kind), M.nextTransition(f.mEarth, ref, kind));
        }
      }
    }
  }
});

// ---- 9. fixtures from the browser run (C++ engine output only)
group('fixtures: browser results and full-year hours', () => {
  const when = (key, i) => (i === null ? null : M.formatUtc(M.parseUtc(bundle.sites[key].t[i])));
  const win = (key, w) => {
    const t = bundle.sites[key].t;
    return [M.formatUtc(M.parseUtc(t[w.start])).slice(5, 16), M.formatUtc(M.parseUtc(t[w.end])).slice(5, 16)];
  };
  const expPct = {
    0: { malapert_a: ['42.1', '100.0'], amundsen: ['58.8', '34.4'], nobile_w: ['28.8', '62.9'] },
    1: { malapert_a: ['39.2', '100.0'], amundsen: ['49.6', '29.4'], nobile_w: ['26.1', '56.0'] },
  };
  const expChecks = {
    0: { malapert_a: ['PASS', 'PASS', 'FAIL', 'PASS'], amundsen: ['PASS', 'FAIL', 'FAIL', 'FAIL'], nobile_w: ['FAIL', 'PASS', 'FAIL', 'FAIL'] },
    1: { malapert_a: ['FAIL', 'PASS', 'FAIL', 'PASS'], amundsen: ['PASS', 'FAIL', 'FAIL', 'FAIL'], nobile_w: ['FAIL', 'PASS', 'FAIL', 'FAIL'] },
  };
  const expSun = {
    0: { malapert_a: '2026-12-01 17:00 UTC', amundsen: '2026-11-24 13:00 UTC', nobile_w: '2026-11-29 19:00 UTC' },
    1: { malapert_a: '2026-12-01 03:00 UTC', amundsen: '2026-11-22 20:00 UTC', nobile_w: '2026-11-29 10:00 UTC' },
  };
  const expEarth = {
    0: { malapert_a: null, amundsen: '2026-11-29 23:00 UTC', nobile_w: '2026-12-01 14:00 UTC' },
    1: { malapert_a: null, amundsen: '2026-11-29 06:00 UTC', nobile_w: '2026-11-30 22:00 UTC' },
  };
  const expLit = {
    0: {
      malapert_a: [['11-19 02:00', '12-01 16:00']],
      nobile_w: [['11-21 04:00', '11-29 18:00']],
      amundsen: [['11-15 00:00', '11-24 12:00'], ['12-06 22:00', '12-14 23:00']],
    },
    1: {
      malapert_a: [['11-19 09:00', '12-01 02:00']],
      nobile_w: [['11-21 14:00', '11-29 09:00']],
      amundsen: [['11-15 00:00', '11-22 19:00'], ['11-22 23:00', '11-23 04:00'], ['11-23 10:00', '11-24 02:00'], ['12-08 22:00', '12-14 23:00']],
    },
  };
  for (const m of [0, 1]) {
    const rows = [];
    for (const key of keys) {
      const f = fl[m][key];
      const s = eng.summarize(f.eSun, 0, 720);
      const e = eng.summarize(f.eEarth, 0, 720);
      eq(key + ' m=' + m + ' percents', [s.pct.toFixed(1), e.pct.toFixed(1)], expPct[m][key]);
      const c = [eng.minCheck(s.pct, 40), eng.minCheck(e.pct, 40), eng.maxRunCheckAll(s.dark, 200, 720), eng.maxRunCheckAll(e.dark, 200, 720)];
      eq(key + ' m=' + m + ' checks', c, expChecks[m][key]);
      eq(key + ' m=' + m + ' overall', eng.overall(c), 'FAILS');
      eq(key + ' m=' + m + ' sun windows', s.lit.map((w) => win(key, w)), expLit[m][key]);
      eq(key + ' m=' + m + ' next sunset', when(key, eng.nextTransition(f.eSun, 0, 'fall').index), expSun[m][key]);
      eq(key + ' m=' + m + ' next Earthset', when(key, eng.nextTransition(f.eEarth, 0, 'fall').index), expEarth[m][key]);
      rows.push({ key, overall: eng.overall(c), fails: c.filter((x) => x === 'FAIL').length, sunPct: s.pct, earthPct: e.pct });
    }
    eq('m=' + m + ' rank order', eng.rankSites(rows), ['malapert_a', 'amundsen', 'nobile_w']);
  }
  const sunHours = {
    0: { amundsen: 3581, malapert_a: 3459, nobile_w: 2201 },
    0.5: { amundsen: 2939, malapert_a: 3347, nobile_w: 2050 },
    1: { amundsen: 2251, malapert_a: 3232, nobile_w: 1887 },
    2: { amundsen: 1193, malapert_a: 3026, nobile_w: 1511 },
  };
  const earthHours = {
    0: { malapert_a: 8760, nobile_w: 5517, amundsen: 3569 },
    1: { malapert_a: 8760, nobile_w: 5096, amundsen: 3033 },
  };
  const hours = (flags) => eng.summarize(flags, 0, 8760).lit.reduce((a, w) => a + w.samples, 0);
  for (const m of Object.keys(sunHours)) {
    for (const key of keys) eq(key + ' m=' + m + ' full-year Sun hours', hours(fl[Number(m)][key].eSun), sunHours[m][key]);
  }
  for (const m of Object.keys(earthHours)) {
    for (const key of keys) eq(key + ' m=' + m + ' full-year Earth hours', hours(fl[Number(m)][key].eEarth), earthHours[m][key]);
  }
});

// ---- timing (information only)
{
  const t0 = performance.now();
  const loops = 50;
  for (let k = 0; k < loops; k++) {
    for (const key of keys) {
      const s = bundle.sites[key];
      const sun = eng.sunFlagsFromBodies(s.sunAlt, s.sunHorizon, s.sunRadius, 1);
      const earth = eng.earthFlags(s.earthAlt, s.earthHorizon, 1);
      eng.summarize(sun, 0, 720);
      eng.summarize(earth, 0, 720);
      eng.nextTransition(sun, 0, 'fall');
      eng.nextTransition(earth, 0, 'fall');
    }
  }
  process.stdout.write('INFO engine recompute for 3 sites: ' + ((performance.now() - t0) / loops).toFixed(2) + ' ms per slider move\n');
}

process.stdout.write(failures === 0 ? 'ALL PASS\n' : 'FAILURES: ' + failures + ' group(s)\n');
process.exitCode = failures === 0 ? 0 : 1;