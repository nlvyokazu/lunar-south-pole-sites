// Writes public/data/bundle.json: SYNTHETIC sample data (3 sites x 7 days, hourly).
// The geometry is an invented smooth model for layout and testing only. It is not
// ephemeris output and the horizon is not terrain. Deterministic: fixed seed,
// no clock, no network. Usage: node scripts/make_sample.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEED = 20261115;
const DAYS = 7;
const STEP_H = 1;
const N = (DAYS * 24) / STEP_H;
const START_MS = Date.UTC(2026, 10, 15, 0, 0, 0);
const GENERATED_UTC = '2026-11-12T00:00:00Z'; // fixed constant, not a clock reading
const SUN_RADIUS_DEG = 0.265; // angular radius used only for the synthetic disk fraction

// Default definitions used to derive windows and stats (same as the UI defaults).
const S = 0.5; // sunlit epoch: lit >= S
const E = 0; // Earth visible epoch: earthAlt - earthHorizon > E (degrees)
const W_H = 1; // minimum window length in hours

const RAD = Math.PI / 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each site: Sun and Earth altitude are sums of sines plus tiny noise; the
// placeholder horizon is a smooth function of azimuth.
const SITES = {
  malapert_a: {
    label: 'Malapert A (sample)',
    lat: -85.9,
    lon: 0.0,
    sun: { mean: 4.6, amp: 1.2, periodH: 70, phase: 40, wobble: 0.25, azStart: 20 },
    earth: { mean: 1.5, amp: 2.4, periodH: 100, phase: 200, wobble: 0.2, azStart: 354 },
    hor: { base: 0.9, a1: 0.5, p1: 10, a2: 0.2, p2: 80 },
  },
  nobile_w: {
    label: 'Nobile W (sample)',
    lat: -85.2,
    lon: 53.0,
    sun: { mean: 1.2, amp: 2.0, periodH: 62, phase: 120, wobble: 0.2, azStart: 100 },
    earth: { mean: 2.2, amp: 2.2, periodH: 130, phase: 20, wobble: 0.2, azStart: 12 },
    hor: { base: 1.0, a1: 0.6, p1: 150, a2: 0.25, p2: 30 },
  },
  amundsen: {
    label: 'Amundsen (sample)',
    lat: -84.5,
    lon: 82.8,
    sun: { mean: -0.2, amp: 1.7, periodH: 110, phase: 250, wobble: 0.15, azStart: 200 },
    earth: { mean: 4.2, amp: 1.2, periodH: 90, phase: 60, wobble: 0.2, azStart: 300 },
    hor: { base: 1.1, a1: 0.5, p1: 220, a2: 0.2, p2: 300 },
  },
};

const mod360 = (x) => ((x % 360) + 360) % 360;
const r3 = (v) => Math.round(v * 1000) / 1000 + 0; // "+ 0" turns -0 into 0
const r4 = (v) => Math.round(v * 10000) / 10000 + 0;
function azRound(v) {
  const r = Math.round(mod360(v) * 100) / 100;
  return r >= 360 ? 0 : r;
}

function horizonAt(h, az) {
  return h.base + h.a1 * Math.sin((3 * az + h.p1) * RAD) + h.a2 * Math.sin((7 * az + h.p2) * RAD);
}

// Fraction of a disk of angular radius SUN_RADIUS_DEG above a flat horizon line,
// given the disk-centre height above that line (degrees).
function diskFraction(centreAboveHorizonDeg) {
  const x = centreAboveHorizonDeg / SUN_RADIUS_DEG;
  if (x >= 1) return 1;
  if (x <= -1) return 0;
  const c = -x;
  return (Math.acos(c) - c * Math.sqrt(1 - c * c)) / Math.PI;
}

function findRuns(flags, t) {
  const runs = [];
  let i = 0;
  while (i < flags.length) {
    if (!flags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    const samples = j - i + 1;
    if (samples * STEP_H >= W_H) {
      runs.push({ start: t[i], end: t[j], samples, whole_span: i === 0 && j === flags.length - 1 });
    }
    i = j + 1;
  }
  return runs;
}

const longestHours = (runs) => runs.reduce((m, w) => Math.max(m, w.samples * STEP_H), 0);
const countTrue = (flags) => flags.reduce((c, f) => c + (f ? 1 : 0), 0);

function buildSite(p, siteIndex) {
  const rand = mulberry32(SEED + siteIndex);
  const t = [];
  const sunAlt = [], sunAz = [], sunHorizon = [];
  const earthAlt = [], earthAz = [], earthHorizon = [], lit = [];

  for (let i = 0; i < N; i++) {
    const hours = i * STEP_H;
    t.push(new Date(START_MS + hours * 3600000).toISOString().slice(0, 23));

    const sAlt =
      p.sun.mean +
      p.sun.amp * Math.sin(((2 * Math.PI) * hours) / p.sun.periodH + p.sun.phase * RAD) +
      p.sun.wobble * Math.sin(((2 * Math.PI) * hours) / 24 + 1.1) +
      (rand() - 0.5) * 0.04;
    const sAz = p.sun.azStart + (360 * hours) / (29.53 * 24); // real synodic rate: slow sweep
    const eAlt =
      p.earth.mean +
      p.earth.amp * Math.sin(((2 * Math.PI) * hours) / p.earth.periodH + p.earth.phase * RAD) +
      p.earth.wobble * Math.sin(((2 * Math.PI) * hours) / 24 + 2.3) +
      (rand() - 0.5) * 0.04;
    const eAz = p.earth.azStart + 6 * Math.sin(((2 * Math.PI) * hours) / 150 + 0.7);

    const sAltR = r3(sAlt);
    const sAzR = azRound(sAz);
    const sHorR = r3(horizonAt(p.hor, sAzR));
    const eAltR = r3(eAlt);
    const eAzR = azRound(eAz);
    const eHorR = r3(horizonAt(p.hor, eAzR));

    sunAlt.push(sAltR);
    sunAz.push(sAzR);
    sunHorizon.push(sHorR);
    earthAlt.push(eAltR);
    earthAz.push(eAzR);
    earthHorizon.push(eHorR);
    lit.push(r4(diskFraction(sAltR - sHorR)));
  }

  // Windows and stats are derived from the rounded arrays above, so they are consistent.
  const sunlitFlags = lit.map((v) => v >= S);
  const darkFlags = sunlitFlags.map((f) => !f);
  const commsFlags = earthAlt.map((v, i) => v - earthHorizon[i] > E);
  const windows = {
    sunlit: findRuns(sunlitFlags, t),
    dark: findRuns(darkFlags, t),
    comms: findRuns(commsFlags, t),
  };
  const stats = {
    n_epochs: N,
    def_sunlit_min_fraction: S,
    def_earth_min_margin_deg: E,
    def_min_window_hours: W_H,
    sunlit_fraction: r4(countTrue(sunlitFlags) / N),
    earth_visible_fraction: r4(countTrue(commsFlags) / N),
    sunlit_hours: countTrue(sunlitFlags) * STEP_H,
    dark_hours: countTrue(darkFlags) * STEP_H,
    comms_hours: countTrue(commsFlags) * STEP_H,
    longest_sunlit_hours: longestHours(windows.sunlit),
    longest_dark_hours: longestHours(windows.dark),
    longest_comms_hours: longestHours(windows.comms),
    sunlit_window_count: windows.sunlit.length,
    dark_window_count: windows.dark.length,
    comms_window_count: windows.comms.length,
    sun_alt_min_deg: Math.min(...sunAlt),
    sun_alt_max_deg: Math.max(...sunAlt),
    earth_alt_min_deg: Math.min(...earthAlt),
    earth_alt_max_deg: Math.max(...earthAlt),
  };

  return {
    label: p.label,
    lat: p.lat,
    lon: p.lon,
    coordinates_note:
      'Illustrative sample position for layout only; site coordinates are user-reported and unverified.',
    t,
    sunAlt,
    sunAz,
    sunHorizon,
    earthAlt,
    earthAz,
    earthHorizon,
    lit,
    windows,
    stats,
  };
}

const keys = Object.keys(SITES);
const bundle = {
  meta: {
    schema: 1,
    generated_utc: GENERATED_UTC,
    sites: keys,
    step_hours: STEP_H,
    frame: 'synthetic sample (no reference frame used)',
    radius_km: 1737.4, // nominal lunar mean radius, stored as a label only
    ephemeris: 'synthetic sample (no ephemeris used)',
    kernels: [],
    horizon_source: 'synthetic placeholder function of azimuth (not LOLA terrain)',
    horizon_is_placeholder: true,
    synthetic: true,
  },
  sites: Object.fromEntries(keys.map((k, i) => [k, buildSite(SITES[k], i)])),
};

// Pretty-print, but keep arrays of plain numbers/strings on one line each.
const text = JSON.stringify(bundle, null, 2).replace(/\[\s*([^[\]{}]+?)\s*\]/g, (_m, inner) =>
  '[' + inner.replace(/\s*\n\s*/g, ' ') + ']',
);
if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(bundle)) {
  throw new Error('compact serialisation changed the data');
}

const outUrl = new URL('../public/data/bundle.json', import.meta.url);
mkdirSync(fileURLToPath(new URL('./', outUrl)), { recursive: true });
writeFileSync(outUrl, text + '\n');
console.log(`wrote public/data/bundle.json (${keys.length} sites x ${N} epochs)`);
