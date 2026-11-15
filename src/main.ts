import type { Bundle, SiteData } from './types';
import type { Win, Check } from './model';
import {
  sunFlags, earthFlags, summarize, parseThreshold, minCheck, maxRunCheckAll,
  overall, rankSites, nextTransition, parseUtc, formatUtc, fmtHours,
} from './model';
import type { Engine, Summary, RankRow, Transition, Overall } from './engine';
import { loadEngine } from './engine';
import { checkAgainstBundle } from './lit';
import { showSweep, clearSweep, runBenchmark } from './sweep';
import { showElevation } from './elevation';

const KEYS = ['malapert_a', 'nobile_w', 'amundsen'] as const;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const COLS = 14;
const MAX_WINDOWS = 60;

// Display names. The data file is not edited, so the page chooses its own labels.
const DISPLAY: Record<string, string> = {
  malapert_a: 'Malapert A rim',
  nobile_w: 'Nobile Crater W rim',
  amundsen: 'Near Amundsen',
};

function labelOf(key: string, s: SiteData): string {
  const d = DISPLAY[key];
  return d !== undefined ? d : s.label;
}

// One set of calculation functions. The C++ engine fills it when it is running.
// The TypeScript model fills it when the engine is not available.
interface Calc {
  sunFlags(s: SiteData, margin: number): Int8Array;
  earthFlags(s: SiteData, margin: number): Int8Array;
  summarize(flags: ArrayLike<number>, from: number, to: number): Summary;
  minCheck(pct: number | null, min: number | null): 'PASS' | 'FAIL' | 'NONE';
  maxRunCheckAll(runs: Win[], maxHours: number | null, rangeHours: number): Check;
  overall(checks: Check[]): Overall;
  rankSites(rows: RankRow[]): string[];
  nextTransition(flags: ArrayLike<number>, ref: number, kind: 'fall' | 'rise'): Transition;
}

// Fallback. The margin is always 0 in this mode, so Sun flags come from the bundle lit values.
const tsCalc: Calc = {
  sunFlags: (s) => sunFlags(s.lit),
  earthFlags: (s, margin) => earthFlags(s.earthAlt, s.earthHorizon, margin),
  summarize,
  minCheck,
  maxRunCheckAll,
  overall,
  rankSites,
  nextTransition,
};

function engineCalc(e: Engine): Calc {
  return {
    sunFlags: (s, margin) => e.sunFlagsFromBodies(s.sunAlt, s.sunHorizon, s.sunRadius, margin),
    earthFlags: (s, margin) => e.earthFlags(s.earthAlt, s.earthHorizon, margin),
    summarize: (f, from, to) => e.summarize(f, from, to),
    minCheck: (p, m) => e.minCheck(p, m),
    maxRunCheckAll: (r, m, h) => e.maxRunCheckAll(r, m, h),
    overall: (c) => e.overall(c),
    rankSites: (r) => e.rankSites(r),
    nextTransition: (f, r, k) => e.nextTransition(f, r, k),
  };
}

interface Row {
  key: string;
  site: SiteData;
  sun: Summary;
  earth: Summary;
  checks: Check[];
  verdict: Overall;
  fails: number;
  nextSunset: string;
  nextEarthset: string;
}

interface Analysis {
  rows: Row[];
  order: string[];
}

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error('missing element ' + id);
  return e as T;
}

const startIn = byId<HTMLInputElement>('start');
const endIn = byId<HTMLInputElement>('end');
const marginIn = byId<HTMLInputElement>('margin');
const marginOut = byId<HTMLElement>('margin-out');
const elevEl = byId<HTMLElement>('elevation');
const elevNote = byId<HTMLElement>('elevation-note');
const thSun = byId<HTMLInputElement>('th-sun');
const thEarth = byId<HTMLInputElement>('th-earth');
const thDark = byId<HTMLInputElement>('th-dark');
const thOut = byId<HTMLInputElement>('th-out');
const refIn = byId<HTMLInputElement>('ref');
const onlyMeets = byId<HTMLInputElement>('only-meets');
const statusEl = byId<HTMLElement>('status');
const messagesEl = byId<HTMLElement>('messages');
const warningsEl = byId<HTMLElement>('warnings');
const rangeNote = byId<HTMLElement>('range-note');
const tbody = byId<HTMLTableSectionElement>('rows');
const windowsEl = byId<HTMLElement>('windows');
const detailsEl = byId<HTMLElement>('details');
const sweepEl = byId<HTMLElement>('sweep');
const sweepNote = byId<HTMLElement>('sweep-note');
const benchBtn = byId<HTMLButtonElement>('bench-run');
const benchOut = byId<HTMLElement>('bench-out');

let bundle: Bundle | null = null;
let engine: Engine | null = null;
let calc: Calc = tsCalc;
let engineState: 'loading' | 'ok' | 'failed' = 'loading';
let engineMaxDiff = 0;
let lastRange: { from: number; to: number } | null = null;

function validate(raw: unknown): Bundle {
  if (typeof raw !== 'object' || raw === null) throw new Error('data file is not an object');
  const b = raw as Bundle;
  if (typeof b.meta !== 'object' || b.meta === null || b.meta.step_hours !== 1) {
    throw new Error('data file does not have hourly steps');
  }
  if (typeof b.sites !== 'object' || b.sites === null) throw new Error('data file has no sites');
  let n = -1;
  for (const key of KEYS) {
    const s = b.sites[key];
    if (typeof s !== 'object' || s === null) throw new Error('site ' + key + ' is missing');
    const arrays = [s.t, s.sunAlt, s.sunAz, s.sunHorizon, s.earthAlt, s.earthAz, s.earthHorizon, s.lit, s.sunRadius];
    for (const a of arrays) {
      if (!Array.isArray(a)) throw new Error('site ' + key + ' has a missing series');
      if (n < 0) n = a.length;
      if (a.length !== n) throw new Error('site ' + key + ' has series of different lengths');
    }
    const first = parseUtc(s.t[0]);
    const last = parseUtc(s.t[n - 1]);
    if (last - first !== (n - 1) * HOUR_MS) throw new Error('site ' + key + ' time axis is not hourly');
    if (s.t[0] !== b.sites[KEYS[0]].t[0]) throw new Error('sites do not share a time axis');
  }
  if (n < 48) throw new Error('data file is too short');
  return b;
}

function horizonProblem(s: SiteData): string | null {
  const src = typeof s.horizon_source === 'string' ? s.horizon_source.trim() : '';
  const low = src.toLowerCase();
  if (src === '') return 'no horizon source is recorded';
  if (low.includes('synthetic') || low.includes('placeholder') || /\bnone\b/.test(low)) {
    return 'the horizon source says this is not measured terrain';
  }
  if (s.horizon_is_placeholder === true) return 'the horizon is marked as a placeholder';
  return null;
}

function pctText(p: number | null): string {
  return p === null ? 'n/a' : p.toFixed(1) + ' %';
}

function longestText(w: Win | null): string {
  if (w === null) return 'none';
  return ((w.openStart || w.openEnd) ? '>= ' : '') + fmtHours(w.samples);
}

function checkText(c: Check): string {
  if (c === 'PASS') return 'PASS';
  if (c === 'FAIL') return 'FAIL';
  if (c === 'PASS_OPEN') return 'PASS (run continues past range edge)';
  return '-';
}

function verdictText(v: string): string {
  if (v === 'MEETS') return 'Meets your thresholds';
  if (v === 'MEETS_OPEN') return 'Meets your thresholds (a run continues past the range edge)';
  if (v === 'FAILS') return 'Does not meet your thresholds';
  return '-';
}

function eventText(c: Calc, flags: Int8Array, ref: number, kind: 'fall' | 'rise', t: string[]): string {
  const r = c.nextTransition(flags, ref, kind);
  let txt: string;
  if (r.index === null) txt = 'none before ' + formatUtc(parseUtc(t[t.length - 1]));
  else if (r.within) txt = 'within the hour (by ' + formatUtc(parseUtc(t[r.index])) + ')';
  else txt = formatUtc(parseUtc(t[r.index]));
  if (r.startedUnknown) txt += ' (reference sample unknown)';
  return txt;
}

function winText(w: Win, t: string[]): string {
  const open = w.openStart || w.openEnd;
  let s = formatUtc(parseUtc(t[w.start])) + ' to ' + formatUtc(parseUtc(t[w.end])) + ', ' + (open ? '>= ' : '') + fmtHours(w.samples);
  if (w.openStart && w.openEnd) s += ' (touches both range edges)';
  else if (w.openStart) s += ' (touches range start)';
  else if (w.openEnd) s += ' (touches range end)';
  return s;
}

function cell(text: string, cls?: string): HTMLTableCellElement {
  const c = document.createElement('td');
  c.textContent = text;
  if (cls !== undefined) c.className = cls;
  return c;
}

function messageRow(text: string): void {
  const tr = document.createElement('tr');
  const c = cell(text);
  c.colSpan = COLS;
  tr.appendChild(c);
  tbody.appendChild(tr);
}

function banner(label: string, text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'banner';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  d.appendChild(l);
  d.appendChild(document.createTextNode(' ' + text));
  return d;
}

function windowList(label: string, wins: Win[], t: string[]): HTMLLIElement {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = label + ' (' + wins.length + ')';
  li.appendChild(strong);
  if (wins.length === 0) {
    li.appendChild(document.createTextNode(': none in this range'));
    return li;
  }
  const ul = document.createElement('ul');
  for (const w of wins.slice(0, MAX_WINDOWS)) {
    const x = document.createElement('li');
    x.textContent = winText(w, t);
    ul.appendChild(x);
  }
  if (wins.length > MAX_WINDOWS) {
    const x = document.createElement('li');
    x.textContent = 'and ' + (wins.length - MAX_WINDOWS) + ' more';
    ul.appendChild(x);
  }
  li.appendChild(ul);
  return li;
}

function applyEngineState(): void {
  marginIn.disabled = engine === null;
  benchBtn.disabled = engine === null;
  if (engineState === 'ok') {
    statusEl.textContent = 'Calculations run in C++ compiled to WebAssembly, in this browser: Sun-disc visibility, Sun and Earth flags, windows, percentages, threshold checks, ranking, next sunset and Earthset, and the margin sweep. The page code reads inputs, formats dates and draws the table and the sweep chart. Self-check at margin 0 against the precomputed data: passed (max difference ' + engineMaxDiff.toExponential(2) + ').';
  } else if (engineState === 'failed') {
    statusEl.textContent = 'Margin slider unavailable: the calculation module did not load. Results use the TypeScript fallback and the precomputed Sun values at margin 0.';
  } else {
    statusEl.textContent = 'Loading the calculation module. Until it is ready, results use the TypeScript fallback and the precomputed Sun values at margin 0.';
  }
}

function updateSweep(b: Bundle, rangeOk: boolean, from: number, to: number, margin: number): void {
  if (!rangeOk) {
    clearSweep(sweepEl, sweepNote, 'Fix the date range to see the sweep.');
    return;
  }
  if (engine === null) {
    clearSweep(sweepEl, sweepNote, engineState === 'loading'
      ? 'Waiting for the calculation module.'
      : 'The sweep needs the calculation engine, which did not load.');
    return;
  }
  try {
    const sites = KEYS.map((k) => b.sites[k]);
    const labels = KEYS.map((k) => labelOf(k, b.sites[k]));
    showSweep(sweepEl, sweepNote, engine, sites, labels, from, to, margin);
  } catch (err) {
    clearSweep(sweepEl, sweepNote, 'The sweep could not be drawn: ' + (err instanceof Error ? err.message : 'unknown error'));
  }
}

function analyse(
  c: Calc, b: Bundle, margin: number, from: number, to: number,
  thr: (number | null)[], thrOk: boolean, refOk: boolean, refIdx: number,
): Analysis {
  const hrs = to - from;
  const rows: Row[] = [];
  for (const key of KEYS) {
    const site = b.sites[key];
    const sunF = c.sunFlags(site, margin);
    const earthF = c.earthFlags(site, margin);
    const sun = c.summarize(sunF, from, to);
    const earth = c.summarize(earthF, from, to);
    const checks: Check[] = [
      c.minCheck(sun.pct, thr[0]),
      c.minCheck(earth.pct, thr[1]),
      c.maxRunCheckAll(sun.dark, thr[2], hrs),
      c.maxRunCheckAll(earth.dark, thr[3], hrs),
    ];
    rows.push({
      key, site, sun, earth, checks,
      verdict: c.overall(checks),
      fails: checks.filter((x) => x === 'FAIL').length,
      nextSunset: refOk ? eventText(c, sunF, refIdx, 'fall', site.t) : 'n/a',
      nextEarthset: refOk ? eventText(c, earthF, refIdx, 'fall', site.t) : 'n/a',
    });
  }
  let order: string[] = rows.map((r) => r.key);
  if (thrOk) {
    order = c.rankSites(rows.map((r) => ({ key: r.key, overall: r.verdict, fails: r.fails, sunPct: r.sun.pct, earthPct: r.earth.pct })));
  }
  return { rows, order };
}

function render(): void {
  if (bundle === null) return;
  const b = bundle;
  const base = b.sites[KEYS[0]];
  const n = base.t.length;
  const t0 = parseUtc(base.t[0]);
  const tEnd = parseUtc(base.t[n - 1]);
  const msgs: string[] = [];

  let from = 0;
  let to = 0;
  let rangeOk = false;
  const sd = parseUtc(startIn.value);
  const ed = parseUtc(endIn.value);
  if (Number.isNaN(sd) || Number.isNaN(ed)) {
    msgs.push('Enter a start day and an end day.');
  } else {
    const d0 = Math.round((sd - t0) / DAY_MS);
    const d1 = Math.round((ed - t0) / DAY_MS);
    if (d1 < d0) {
      msgs.push('The end day must not be before the start day.');
    } else if (d0 < 0 || (d1 + 1) * 24 > n) {
      msgs.push('The range must lie inside the data: ' + formatUtc(t0).slice(0, 10) + ' to ' + formatUtc(tEnd).slice(0, 10) + '.');
    } else {
      from = d0 * 24;
      to = (d1 + 1) * 24;
      rangeOk = true;
    }
  }
  lastRange = rangeOk ? { from, to } : null;

  let margin = 0;
  if (engine !== null) {
    const m = Number(marginIn.value);
    margin = Number.isFinite(m) ? Math.min(5, Math.max(0, m)) : 0;
  }
  marginOut.textContent = margin.toFixed(1);

  const thr = [parseThreshold(thSun.value), parseThreshold(thEarth.value), parseThreshold(thDark.value), parseThreshold(thOut.value)];
  const thrOk = thr.every((x) => x !== null);
  if (!thrOk) msgs.push('Enter a number in all four threshold fields. No verdict is shown until you do.');

  const refMs = parseUtc(refIn.value);
  const refIdx = Math.round((refMs - t0) / HOUR_MS);
  const refOk = Number.isFinite(refIdx) && refIdx >= 0 && refIdx < n;
  if (!refOk) msgs.push('The reference time is not valid or is outside the data. Use the form 2026-11-15 06:00 (UTC). Next sunset and Earthset are not shown.');

  messagesEl.replaceChildren();
  for (const m of msgs) messagesEl.appendChild(banner('Notice:', m));

  warningsEl.replaceChildren();
  for (const key of KEYS) {
    const s = b.sites[key];
    const p = horizonProblem(s);
    if (p !== null) warningsEl.appendChild(banner('Warning:', labelOf(key, s) + ': ' + p + '. Results for this site do not use measured terrain.'));
  }
  const sources = new Set(KEYS.map((k) => b.sites[k].horizon_source));
  if (sources.size > 1) warningsEl.appendChild(banner('Warning:', 'The three sites use different horizon sources, so they may not be directly comparable.'));

  let result: Analysis = { rows: [], order: [] };
  if (rangeOk) {
    try {
      result = analyse(calc, b, margin, from, to, thr, thrOk, refOk, refIdx);
    } catch (err) {
      if (calc === tsCalc) throw err;
      engine = null;
      engineState = 'failed';
      calc = tsCalc;
      margin = 0;
      marginOut.textContent = margin.toFixed(1);
      applyEngineState();
      result = analyse(tsCalc, b, margin, from, to, thr, thrOk, refOk, refIdx);
    }
  }
  const rows = result.rows;

  updateSweep(b, rangeOk, from, to, margin);
showElevation(elevEl, elevNote, b, Object.fromEntries(Object.entries(b.sites).map(([k, s]) => [k, labelOf(k, s)])), rangeOk, from, to, margin);

  tbody.replaceChildren();
  windowsEl.replaceChildren();
  if (!rangeOk) {
    rangeNote.textContent = 'The data set covers ' + formatUtc(t0).slice(0, 10) + ' to ' + formatUtc(tEnd).slice(0, 10) + ' (one year of hourly samples).';
    messageRow('No results: fix the range above.');
    return;
  }

  rangeNote.textContent = 'Range: ' + formatUtc(t0 + from * HOUR_MS) + ' to ' + formatUtc(t0 + (to - 1) * HOUR_MS) + ' (' + (to - from) + ' hourly samples). Horizon margin: ' + margin.toFixed(1) + ' deg on both horizons. The data set covers ' + formatUtc(t0).slice(0, 10) + ' to ' + formatUtc(tEnd).slice(0, 10) + ' (one year of hourly samples).';

  const verdictOn = thrOk;
  const order = result.order;
  const rankOf = new Map<string, number>();
  if (verdictOn) order.forEach((k, i) => rankOf.set(k, i + 1));
  const byKey = new Map<string, Row>(rows.map((r) => [r.key, r]));
  const meets = (r: Row): boolean => r.verdict === 'MEETS' || r.verdict === 'MEETS_OPEN';
  const shown = order.filter((k) => {
    const r = byKey.get(k);
    return r !== undefined && (!(onlyMeets.checked && verdictOn) || meets(r));
  });

  if (shown.length === 0) messageRow('No site meets all your thresholds in this range.');
  for (const k of shown) {
    const r = byKey.get(k);
    if (r === undefined) continue;
    const tr = document.createElement('tr');
    const first = document.createElement('th');
    first.scope = 'row';
    first.textContent = labelOf(r.key, r.site);
    tr.appendChild(first);
    tr.appendChild(cell(pctText(r.sun.pct), 'num'));
    tr.appendChild(cell(longestText(r.sun.longestLit), 'num'));
    tr.appendChild(cell(longestText(r.sun.longestDark), 'num'));
    tr.appendChild(cell(pctText(r.earth.pct), 'num'));
    tr.appendChild(cell(longestText(r.earth.longestDark), 'num'));
    tr.appendChild(cell(r.nextSunset));
    tr.appendChild(cell(r.nextEarthset));
    for (const c of r.checks) tr.appendChild(cell(verdictOn ? checkText(c) : '-'));
    tr.appendChild(cell(verdictOn ? verdictText(r.verdict) : '-'));
    tr.appendChild(cell(verdictOn ? String(rankOf.get(k)) : '-', 'num'));
    tbody.appendChild(tr);
  }

  for (const key of KEYS) {
    const r = byKey.get(key);
    if (r === undefined) continue;
    const h = document.createElement('h3');
    h.textContent = labelOf(r.key, r.site);
    windowsEl.appendChild(h);
    const ul = document.createElement('ul');
    ul.appendChild(windowList('Sun-visible windows', r.sun.lit, r.site.t));
    ul.appendChild(windowList('Dark windows', r.sun.dark, r.site.t));
    ul.appendChild(windowList('Earth-in-view windows', r.earth.lit, r.site.t));
    ul.appendChild(windowList('Earth-out windows', r.earth.dark, r.site.t));
    windowsEl.appendChild(ul);
  }
}

function showDetails(b: Bundle): void {
  detailsEl.replaceChildren();
  const ab = typeof b.meta.aberration === 'string' ? b.meta.aberration : JSON.stringify(b.meta.aberration);
  const p0 = document.createElement('p');
  p0.className = 'small muted';
  p0.textContent = 'Aberration setting in the data: ' + String(ab) + '.';
  detailsEl.appendChild(p0);
  for (const key of KEYS) {
    const s = b.sites[key];
    const p = document.createElement('p');
    p.className = 'small muted';
    p.textContent = labelOf(key, s) + ': ' + String(s.coordinates_note) + ' Horizon source: ' + String(s.horizon_source);
    detailsEl.appendChild(p);
  }
}

async function startEngine(b: Bundle): Promise<void> {
  try {
    const url = new URL('./engine/engine.mjs', document.baseURI).href;
    const e = await loadEngine(url);
    let maxDiff = 0;
    for (const key of KEYS) {
      const s = b.sites[key];
      const c = checkAgainstBundle(e.lit(s.sunAlt, s.sunHorizon, s.sunRadius, 0), s.lit);
      if (!c.passed) throw new Error('Sun self-check failed');
      if (c.maxDiff > maxDiff) maxDiff = c.maxDiff;
      const got = e.earthFlags(s.earthAlt, s.earthHorizon, 0);
      const want = earthFlags(s.earthAlt, s.earthHorizon, 0);
      if (got.length !== want.length) throw new Error('Earth self-check failed');
      for (let i = 0; i < got.length; i++) {
        if (got[i] !== want[i]) throw new Error('Earth self-check failed');
      }
    }
    engine = e;
    calc = engineCalc(e);
    engineState = 'ok';
    engineMaxDiff = maxDiff;
  } catch {
    engine = null;
    calc = tsCalc;
    engineState = 'failed';
  }
  applyEngineState();
  render();
}

async function main(): Promise<void> {
  try {
    const res = await fetch(new URL('./data/bundle.json', document.baseURI).href);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bundle = validate(await res.json());
  } catch (e) {
    statusEl.textContent = 'Could not load the data: ' + (e instanceof Error ? e.message : 'unknown error');
    tbody.replaceChildren();
    messageRow('No data loaded.');
    clearSweep(sweepEl, sweepNote, 'No data loaded.');
    return;
  }
  const b = bundle;
  const base = b.sites[KEYS[0]];
  const n = base.t.length;
  const t0 = parseUtc(base.t[0]);
  startIn.value = formatUtc(t0).slice(0, 10);
  endIn.value = formatUtc(t0 + 29 * DAY_MS).slice(0, 10);
  startIn.min = endIn.min = formatUtc(t0).slice(0, 10);
  startIn.max = endIn.max = formatUtc(t0 + (n / 24 - 1) * DAY_MS).slice(0, 10);
  refIn.value = formatUtc(t0).replace(' UTC', '');
  showDetails(b);
  applyEngineState();
  render();
  for (const el of [startIn, endIn, marginIn, thSun, thEarth, thDark, thOut, refIn]) el.addEventListener('input', render);
  onlyMeets.addEventListener('change', render);
  benchBtn.addEventListener('click', () => {
    const e = engine;
    const r = lastRange;
    if (e === null || r === null) {
      benchOut.textContent = 'The benchmark needs the calculation engine and a valid date range.';
      return;
    }
    void runBenchmark(e, KEYS.map((k) => b.sites[k]), r.from, r.to, benchBtn, benchOut);
  });
  await startEngine(b);
}

void main();