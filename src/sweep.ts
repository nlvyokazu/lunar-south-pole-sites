// Horizon margin sweep and in-browser benchmark.
// The sweep values come from the C++ engine through engine.ts.
// The TypeScript sweep below exists only to time against the engine and to cross-check it.
// It is not used for the comparison table.
import type { SiteData } from './types';
import type { Engine, Nums } from './engine';
import { summarize as tsSummarize } from './model';

const NS = 'http://www.w3.org/2000/svg';
export const SWEEP_POINTS = 51;

export interface SweepData {
  margins: number[];
  pct: (number | null)[][];
}

function marginList(): number[] {
  const out: number[] = [];
  for (let i = 0; i < SWEEP_POINTS; i++) out.push(i / 10);
  return out;
}

function tsSunFlags(alt: Nums, hor: Nums, rad: Nums, margin: number): Int8Array {
  const n = alt.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const a = alt[i];
    const h = hor[i];
    const r = rad[i];
    if (typeof a !== 'number' || typeof h !== 'number' || typeof r !== 'number') {
      out[i] = -1;
      continue;
    }
    let x = (a - h - margin) / r;
    if (Number.isNaN(x)) {
      out[i] = -1;
      continue;
    }
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    const lit = 0.5 + (x * Math.sqrt(1 - x * x) + Math.asin(x)) / Math.PI;
    out[i] = lit >= 0.5 ? 1 : 0;
  }
  return out;
}

export function sweepWithEngine(e: Engine, sites: SiteData[], from: number, to: number): SweepData {
  const margins = marginList();
  const pct: (number | null)[][] = [];
  for (const site of sites) {
    const row: (number | null)[] = [];
    for (const m of margins) {
      const flags = e.sunFlagsFromBodies(site.sunAlt, site.sunHorizon, site.sunRadius, m);
      row.push(e.summarize(flags, from, to).pct);
    }
    pct.push(row);
  }
  return { margins, pct };
}

export function sweepWithTs(sites: SiteData[], from: number, to: number): SweepData {
  const margins = marginList();
  const pct: (number | null)[][] = [];
  for (const site of sites) {
    const row: (number | null)[] = [];
    for (const m of margins) {
      const flags = tsSunFlags(site.sunAlt, site.sunHorizon, site.sunRadius, m);
      row.push(tsSummarize(flags, from, to).pct);
    }
    pct.push(row);
  }
  return { margins, pct };
}

function svgEl(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(NS, name) as SVGElement;
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  if (text !== undefined) el.textContent = text;
  return el;
}

function para(text: string, cls?: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  if (cls !== undefined) p.className = cls;
  return p;
}

function pctLabel(p: number | null): string {
  return p === null ? 'n/a' : p.toFixed(1) + ' %';
}

export function drawSweep(host: HTMLElement, data: SweepData, labels: string[], marginNow: number): void {
  const W = 900;
  const H = 380;
  const L = 56;
  const R = 170;
  const T = 28;
  const B = 48;
  const pw = W - L - R;
  const ph = H - T - B;
  const xOf = (m: number): number => L + (m / 5) * pw;
  const yOf = (p: number): number => T + (1 - p / 100) * ph;
  const last = SWEEP_POINTS - 1;

  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: '0 0 ' + W + ' ' + H,
    role: 'img',
    'aria-labelledby': 'sweep-title sweep-desc',
  });
  svg.style.minWidth = '36rem';
  svg.appendChild(svgEl('title', { id: 'sweep-title' }, 'Sun-visible share against horizon margin for three lunar south pole sites'));
  const parts = labels.map((name, i) => name + ': ' + pctLabel(data.pct[i][0]) + ' at margin 0.0, ' + pctLabel(data.pct[i][last]) + ' at margin 5.0');
  svg.appendChild(svgEl('desc', { id: 'sweep-desc' }, 'Line chart of the Sun-visible percentage of the selected range against horizon margin in degrees. ' + parts.join('; ') + '.'));

  for (const p of [0, 25, 50, 75, 100]) {
    svg.appendChild(svgEl('line', { class: 'grid', x1: L, y1: yOf(p), x2: L + pw, y2: yOf(p) }));
    svg.appendChild(svgEl('text', { x: L - 8, y: yOf(p) + 4, 'text-anchor': 'end' }, String(p)));
  }
  for (let m = 0; m <= 5; m++) {
    svg.appendChild(svgEl('line', { class: 'grid', x1: xOf(m), y1: T + ph, x2: xOf(m), y2: T + ph + 5 }));
    svg.appendChild(svgEl('text', { x: xOf(m), y: T + ph + 20, 'text-anchor': 'middle' }, String(m)));
  }
  svg.appendChild(svgEl('rect', { class: 'frame', x: L, y: T, width: pw, height: ph }));
  svg.appendChild(svgEl('text', { x: L, y: 16 }, 'Sun-visible share of the selected range (%)'));
  svg.appendChild(svgEl('text', { x: L + pw / 2, y: H - 6, 'text-anchor': 'middle' }, 'Horizon margin (deg)'));

  const mx = Math.min(5, Math.max(0, marginNow));
  svg.appendChild(svgEl('line', { class: 'cursor', x1: xOf(mx), y1: T, x2: xOf(mx), y2: T + ph }));

  labels.forEach((_name, i) => {
    let d = '';
    let pen = false;
    data.margins.forEach((m, k) => {
      const p = data.pct[i][k];
      if (p === null) {
        pen = false;
        return;
      }
      d += (pen ? 'L' : 'M') + xOf(m).toFixed(1) + ' ' + yOf(p).toFixed(1) + ' ';
      pen = true;
    });
    if (d !== '') svg.appendChild(svgEl('path', { class: 'line l' + i, d: d.trim() }));
    data.margins.forEach((m, k) => {
      const p = data.pct[i][k];
      if (p !== null && k % 10 === 0) svg.appendChild(svgEl('circle', { class: 'mark', cx: xOf(m), cy: yOf(p), r: 3.5 }));
    });
  });

  const ends: { name: string; y: number }[] = [];
  labels.forEach((name, i) => {
    const p = data.pct[i][last];
    if (p !== null) ends.push({ name, y: yOf(p) + 4 });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
  }
  for (const en of ends) svg.appendChild(svgEl('text', { x: L + pw + 10, y: en.y }, en.name));

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.style.overflowX = 'auto';
  wrap.appendChild(svg);

  const ul = document.createElement('ul');
  ul.className = 'legend';
  labels.forEach((name, i) => {
    const li = document.createElement('li');
    const s = svgEl('svg', { class: 'chart', viewBox: '0 0 40 12', 'aria-hidden': 'true' });
    s.appendChild(svgEl('line', { class: 'line l' + i, x1: 1, y1: 6, x2: 39, y2: 6 }));
    li.appendChild(s);
    li.appendChild(document.createTextNode(name));
    ul.appendChild(li);
  });
  const cur = document.createElement('li');
  const cs = svgEl('svg', { class: 'chart', viewBox: '0 0 40 12', 'aria-hidden': 'true' });
  cs.appendChild(svgEl('line', { class: 'cursor', x1: 1, y1: 6, x2: 39, y2: 6 }));
  cur.appendChild(cs);
  cur.appendChild(document.createTextNode('Margin on the slider: ' + mx.toFixed(1) + ' deg'));
  ul.appendChild(cur);

  host.replaceChildren(wrap, ul);
}

let cacheKey = '';
let cacheEngine: Engine | null = null;
let cacheData: SweepData | null = null;
let cacheMs = 0;

export function clearSweep(host: HTMLElement, note: HTMLElement, text: string): void {
  host.replaceChildren(para(text, 'muted'));
  note.textContent = '';
}

export function showSweep(
  host: HTMLElement, note: HTMLElement, e: Engine | null, sites: SiteData[],
  labels: string[], from: number, to: number, marginNow: number,
): void {
  if (e === null) {
    clearSweep(host, note, 'The sweep needs the calculation engine, which is not running.');
    return;
  }
  const key = from + ':' + to;
  if (cacheData === null || key !== cacheKey || e !== cacheEngine) {
    const t0 = performance.now();
    cacheData = sweepWithEngine(e, sites, from, to);
    cacheMs = performance.now() - t0;
    cacheKey = key;
    cacheEngine = e;
  }
  drawSweep(host, cacheData, labels, marginNow);
  note.textContent = 'The engine last computed all ' + (SWEEP_POINTS * sites.length) + ' points in ' + cacheMs.toFixed(1) + ' ms in this browser, including copying data in and out. Moving the margin slider redraws the chart without recomputing it.';
}

let benchSink = 0;

function sinkOf(d: SweepData): number {
  let t = 0;
  for (const row of d.pct) for (const p of row) if (p !== null) t += p;
  return t;
}

function timeLoop(fn: () => SweepData, budgetMs: number, minRuns: number, maxRuns: number): { runs: number; ms: number } {
  const start = performance.now();
  let now = start;
  let runs = 0;
  while (runs < maxRuns && (runs < minRuns || now - start < budgetMs)) {
    benchSink += sinkOf(fn());
    runs++;
    now = performance.now();
  }
  return { runs, ms: now - start };
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

function th(text: string): HTMLTableCellElement {
  const c = document.createElement('th');
  c.scope = 'col';
  c.textContent = text;
  return c;
}

function td(text: string, num: boolean): HTMLTableCellElement {
  const c = document.createElement('td');
  c.textContent = text;
  if (num) c.className = 'num';
  return c;
}

export async function runBenchmark(
  e: Engine, sites: SiteData[], from: number, to: number,
  button: HTMLButtonElement, out: HTMLElement,
): Promise<void> {
  button.disabled = true;
  out.replaceChildren(para('Running. This takes about 3 seconds.', 'muted'));
  await pause();
  try {
    const viaEngine = (): SweepData => sweepWithEngine(e, sites, from, to);
    const viaTs = (): SweepData => sweepWithTs(sites, from, to);
    const a = viaEngine();
    const b = viaTs();
    let total = 0;
    let diff = 0;
    for (let i = 0; i < a.pct.length; i++) {
      for (let k = 0; k < a.pct[i].length; k++) {
        total++;
        const x = a.pct[i][k];
        const y = b.pct[i][k];
        if (x === null || y === null) {
          if (x !== y) diff++;
        } else if (Math.abs(x - y) > 1e-9) {
          diff++;
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      viaEngine();
      viaTs();
    }
    await pause();
    const r1 = timeLoop(viaEngine, 1000, 5, 5000);
    await pause();
    const r2 = timeLoop(viaTs, 1000, 5, 5000);

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Version', 'Sweeps timed', 'Total time (ms)', 'Time per sweep (ms)', 'Time per point (us)']) hr.appendChild(th(h));
    head.appendChild(hr);
    table.appendChild(head);
    const body = document.createElement('tbody');
    const rows: { name: string; r: { runs: number; ms: number } }[] = [
      { name: 'C++ engine (WebAssembly)', r: r1 },
      { name: 'TypeScript, same formula', r: r2 },
    ];
    for (const row of rows) {
      const tr = document.createElement('tr');
      const first = document.createElement('th');
      first.scope = 'row';
      first.textContent = row.name;
      tr.appendChild(first);
      tr.appendChild(td(String(row.r.runs), true));
      tr.appendChild(td(row.r.ms.toFixed(0), true));
      tr.appendChild(td((row.r.ms / row.r.runs).toFixed(2), true));
      tr.appendChild(td((row.r.ms / row.r.runs / total * 1000).toFixed(1), true));
      body.appendChild(tr);
    }
    table.appendChild(body);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(table);

    const ratio = (r2.ms / r2.runs) / (r1.ms / r1.runs);
    const n = sites[0].t.length;
    out.replaceChildren(
      wrap,
      para('Time per sweep, TypeScript divided by engine: ' + ratio.toFixed(2) + '. A value above 1 means the engine was faster in this run.'),
      para('Agreement check: the two versions gave the same Sun-visible percentage at ' + (total - diff) + ' of ' + total + ' points.' + (diff > 0 ? ' The table on this page does not use the TypeScript version.' : '')),
      para('One point is one site at one margin: Sun-disc flags for ' + n + ' hourly samples, then the window summary for the selected range. Both versions had three untimed warm-up sweeps, then ran for about one second each. The numbers change between runs and between devices.', 'small muted'),
    );
  } catch (err) {
    out.replaceChildren(para('Benchmark stopped: ' + (err instanceof Error ? err.message : 'unknown error')));
  } finally {
    button.disabled = false;
  }
}

export function benchmarkSink(): number {
  return benchSink;
}