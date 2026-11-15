import type { Bundle, SiteData } from './types';

const NS = 'http://www.w3.org/2000/svg';
const W = 900;
const H = 250;
const PL = 54;
const PR = 14;
const PT = 12;
const PB = 30;

const SUN = '#f2b84b';
const EARTH = '#5db7e8';
const HORIZON = '#6b7480';
const GRID = '#3a424d';
const TEXT = '#aab3bf';

let selected = '';

function el(name: string, attrs: Record<string, string | number>, parent?: Element): SVGElement {
  const e = document.createElementNS(NS, name) as SVGElement;
  for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function label(s: string, attrs: Record<string, string | number>, parent: Element): void {
  const e = el('text', attrs, parent);
  e.textContent = s;
}

function niceStep(span: number): number {
  const raw = span / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return m * pow;
}

function decimate(v: number[], from: number, to: number): Array<[number, number]> {
  const n = to - from;
  const out: Array<[number, number]> = [];
  if (n <= 2000) {
    for (let i = from; i < to; i++) out.push([i, v[i]]);
    return out;
  }
  const buckets = 800;
  for (let k = 0; k < buckets; k++) {
    const a = from + Math.floor((k * n) / buckets);
    const b = from + Math.floor(((k + 1) * n) / buckets);
    let lo = Infinity;
    let hi = -Infinity;
    let iLo = -1;
    let iHi = -1;
    for (let i = a; i < b; i++) {
      const y = v[i];
      if (!Number.isFinite(y)) continue;
      if (y < lo) { lo = y; iLo = i; }
      if (y > hi) { hi = y; iHi = i; }
    }
    if (iLo < 0) { out.push([a, NaN]); continue; }
    if (iLo <= iHi) {
      out.push([iLo, lo]);
      if (iHi !== iLo) out.push([iHi, hi]);
    } else {
      out.push([iHi, hi]);
      out.push([iLo, lo]);
    }
  }
  return out;
}

function pathOf(pts: Array<[number, number]>, sx: (i: number) => number, sy: (v: number) => number): string {
  let d = '';
  let pen = false;
  for (const [i, y] of pts) {
    if (!Number.isFinite(y)) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(y).toFixed(1) + ' ';
    pen = true;
  }
  return d;
}

interface Spec {
  body: string;
  site: string;
  alt: number[];
  hor: number[];
  color: string;
  dashed: boolean;
  square: boolean;
}

function buildChart(spec: Spec, t: string[], from: number, to: number, margin: number): SVGElement {
  const n = to - from;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < to; i++) {
    const a = spec.alt[i];
    const h = spec.hor[i] + margin;
    if (Number.isFinite(a)) { lo = Math.min(lo, a); hi = Math.max(hi, a); }
    if (Number.isFinite(h)) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = -1; hi = 1; }
  if (hi - lo < 0.5) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const sx = (i: number): number => PL + ((i - from) / Math.max(1, n - 1)) * plotW;
  const sy = (v: number): number => PT + ((y1 - v) / (y1 - y0)) * plotH;

  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', class: 'chart', preserveAspectRatio: 'xMidYMid meet' });
  const title = el('title', {}, svg);
  title.textContent = spec.body + ' elevation at ' + spec.site + ' against the terrain horizon';
  const desc = el('desc', {}, svg);
  desc.textContent = spec.body + ' elevation in degrees from ' + t[from].slice(0, 10) + ' to ' + t[to - 1].slice(0, 10) + '. The vertical axis runs from ' + y0.toFixed(1) + ' to ' + y1.toFixed(1) + ' degrees. The grey area is the terrain horizon plus the margin of ' + margin.toFixed(1) + ' degrees. The ' + spec.body + ' is visible while its line is on or above the grey area.';

  const step = niceStep(y1 - y0);
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
    const y = sy(v);
    el('line', { x1: PL, x2: W - PR, y1: y.toFixed(1), y2: y.toFixed(1), stroke: GRID, 'stroke-width': 1 }, svg);
    label(v.toFixed(dec), { x: PL - 6, y: (y + 4).toFixed(1), 'text-anchor': 'end', fill: TEXT, 'font-size': 11, 'font-family': 'monospace' }, svg);
  }
  for (let k = 0; k < 5; k++) {
    const idx = from + Math.round((k * (n - 1)) / 4);
    const anchor = k === 0 ? 'start' : k === 4 ? 'end' : 'middle';
    label(t[idx].slice(0, 10), { x: sx(idx).toFixed(1), y: H - 10, 'text-anchor': anchor, fill: TEXT, 'font-size': 11, 'font-family': 'monospace' }, svg);
  }
  label('Elevation (deg)', { x: 12, y: PT + plotH / 2, 'text-anchor': 'middle', fill: TEXT, 'font-size': 11, transform: 'rotate(-90 12 ' + (PT + plotH / 2) + ')' }, svg);

  const horPts = decimate(spec.hor.map((h) => h + margin), from, to).filter((p) => Number.isFinite(p[1]));
  if (horPts.length > 0) {
    const bottom = (PT + plotH).toFixed(1);
    let d = 'M' + sx(horPts[0][0]).toFixed(1) + ' ' + bottom + ' ';
    for (const [i, y] of horPts) d += 'L' + sx(i).toFixed(1) + ' ' + sy(y).toFixed(1) + ' ';
    d += 'L' + sx(horPts[horPts.length - 1][0]).toFixed(1) + ' ' + bottom + ' Z';
    el('path', { d, fill: HORIZON, stroke: 'none' }, svg);
  }

  const altPts = decimate(spec.alt, from, to);
  const line: Record<string, string | number> = { d: pathOf(altPts, sx, sy), fill: 'none', stroke: spec.color, 'stroke-width': 1.8 };
  if (spec.dashed) line['stroke-dasharray'] = '7 4';
  el('path', line, svg);

  const marks = n > 1 ? 10 : 1;
  for (let k = 0; k < marks; k++) {
    const idx = from + (n > 1 ? Math.round((k * (n - 1)) / (marks - 1)) : 0);
    const a = spec.alt[idx];
    if (!Number.isFinite(a)) continue;
    const x = sx(idx);
    const y = sy(a);
    if (spec.square) el('rect', { x: (x - 3.5).toFixed(1), y: (y - 3.5).toFixed(1), width: 7, height: 7, fill: spec.color }, svg);
    else el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 3.5, fill: spec.color }, svg);
  }

  el('rect', { x: PL, y: PT, width: plotW, height: plotH, fill: 'none', stroke: GRID, 'stroke-width': 1 }, svg);
  return svg;
}

function message(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}

export function showElevation(
  container: HTMLElement,
  note: HTMLElement,
  b: Bundle,
  labels: Record<string, string>,
  rangeOk: boolean,
  from: number,
  to: number,
  margin: number,
): void {
  const keys = Object.keys(b.sites);
  if (!rangeOk) {
    container.replaceChildren(message('Fix the date range to see the elevation charts.'));
    note.textContent = '';
    return;
  }
  if (keys.length === 0) {
    container.replaceChildren(message('No sites loaded.'));
    note.textContent = '';
    return;
  }
  if (!keys.includes(selected)) selected = keys[0];
  const site: SiteData = b.sites[selected];
  const need = Math.max(site.sunAlt.length, 0);
  if (to > need || to > site.earthAlt.length || to > site.sunHorizon.length || to > site.earthHorizon.length || to > site.t.length || to - from < 1) {
    container.replaceChildren(message('The elevation charts could not be drawn for this range.'));
    note.textContent = '';
    return;
  }

  const wrap = document.createElement('label');
  wrap.className = 'inline';
  wrap.appendChild(document.createTextNode('Site '));
  const sel = document.createElement('select');
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = labels[k] ?? k;
    if (k === selected) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    selected = sel.value;
    showElevation(container, note, b, labels, rangeOk, from, to, margin);
  });
  wrap.appendChild(sel);

  const name = labels[selected] ?? selected;
  const sunSvg = buildChart({ body: 'Sun', site: name, alt: site.sunAlt, hor: site.sunHorizon, color: SUN, dashed: false, square: false }, site.t, from, to, margin);
  const earthSvg = buildChart({ body: 'Earth', site: name, alt: site.earthAlt, hor: site.earthHorizon, color: EARTH, dashed: true, square: true }, site.t, from, to, margin);

  const h1 = document.createElement('h3');
  h1.textContent = 'Sun (solid line, circles)';
  const h2 = document.createElement('h3');
  h2.textContent = 'Earth (dashed line, squares)';

  container.replaceChildren(wrap, h1, sunSvg, h2, earthSvg);
  note.textContent = 'Drawn by the page code from the precomputed Sun and Earth positions in the data file, for the range and margin above. The grey area is the terrain horizon plus the margin. A body counts as visible while its line is on or above the grey area. The PASS and FAIL results do not use this drawing.' + (to - from > 2000 ? ' With more than 2,000 samples the chart keeps the lowest and highest value of each group of samples.' : '');
}