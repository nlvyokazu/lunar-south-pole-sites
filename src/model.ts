export type Win = { start: number; end: number; samples: number; openStart: boolean; openEnd: boolean };
export type Check = 'PASS' | 'FAIL' | 'PASS_OPEN' | 'NONE';

function clampRange(len: number, from: number, to: number): [number, number] | null {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(len, Math.floor(to));
  return lo < hi ? [lo, hi] : null;
}

function pickLongest(wins: Win[]): Win | null {
  let best: Win | null = null;
  for (const w of wins) {
    if (best === null || w.samples > best.samples) best = w;
  }
  return best;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function sunFlags(lit: ArrayLike<number>): Int8Array {
  const out = new Int8Array(lit.length);
  for (let i = 0; i < lit.length; i++) {
    const v = lit[i];
    out[i] = Number.isFinite(v) ? (v >= 0.5 ? 1 : 0) : -1;
  }
  return out;
}

export function earthFlags(alt: ArrayLike<number>, hor: ArrayLike<number>, margin: number): Int8Array {
  const out = new Int8Array(alt.length);
  for (let i = 0; i < alt.length; i++) {
    const a = alt[i];
    const h = hor[i];
    if (!Number.isFinite(a) || !Number.isFinite(h) || !Number.isFinite(margin)) {
      out[i] = -1;
    } else {
      out[i] = a - (h + margin) > 0 ? 1 : 0;
    }
  }
  return out;
}

export function findRuns(flags: ArrayLike<number>, value: 0 | 1, from: number, to: number): Win[] {
  const r = clampRange(flags.length, from, to);
  if (r === null) return [];
  const lo = r[0];
  const hi = r[1];
  const out: Win[] = [];
  let i = lo;
  while (i < hi) {
    if (flags[i] === value) {
      const s = i;
      while (i < hi && flags[i] === value) i++;
      const e = i - 1;
      out.push({ start: s, end: e, samples: e - s + 1, openStart: s === lo, openEnd: e === hi - 1 });
    } else {
      i++;
    }
  }
  return out;
}

export function summarize(flags: ArrayLike<number>, from: number, to: number): {
  known: number;
  pct: number | null;
  lit: Win[];
  dark: Win[];
  longestLit: Win | null;
  longestDark: Win | null;
} {
  const lit = findRuns(flags, 1, from, to);
  const dark = findRuns(flags, 0, from, to);
  let ones = 0;
  let zeros = 0;
  for (const w of lit) ones += w.samples;
  for (const w of dark) zeros += w.samples;
  const known = ones + zeros;
  return {
    known,
    pct: known > 0 ? (100 * ones) / known : null,
    lit,
    dark,
    longestLit: pickLongest(lit),
    longestDark: pickLongest(dark),
  };
}

export function parseThreshold(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function minCheck(pct: number | null, min: number | null): 'PASS' | 'FAIL' | 'NONE' {
  if (pct === null || min === null) return 'NONE';
  return pct >= min ? 'PASS' : 'FAIL';
}

export function maxRunCheck(longest: Win | null, maxHours: number | null, rangeHours: number): Check {
  if (maxHours === null || rangeHours === 0) return 'NONE';
  if (longest === null) return 'PASS';
  if (longest.samples > maxHours) return 'FAIL';
  if (longest.openStart || longest.openEnd) return 'PASS_OPEN';
  return 'PASS';
}

export function maxRunCheckAll(runs: Win[], maxHours: number | null, rangeHours: number): Check {
  if (maxHours === null || rangeHours === 0) return 'NONE';
  let open = false;
  for (const w of runs) {
    if (w.samples > maxHours) return 'FAIL';
    if (w.openStart || w.openEnd) open = true;
  }
  return open ? 'PASS_OPEN' : 'PASS';
}

export function overall(checks: Check[]): 'MEETS' | 'FAILS' | 'MEETS_OPEN' | 'NONE' {
  if (checks.includes('NONE')) return 'NONE';
  if (checks.includes('FAIL')) return 'FAILS';
  if (checks.includes('PASS_OPEN')) return 'MEETS_OPEN';
  return 'MEETS';
}

function cmpDescNullLast(a: number | null, b: number | null): number {
  const an = a === null || !Number.isFinite(a);
  const bn = b === null || !Number.isFinite(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return (b as number) - (a as number);
}

export function rankSites(rows: { key: string; overall: string; fails: number; sunPct: number | null; earthPct: number | null }[]): string[] {
  const meets = (o: string): number => (o === 'MEETS' || o === 'MEETS_OPEN' ? 0 : 1);
  return rows
    .slice()
    .sort((x, y) => {
      const m = meets(x.overall) - meets(y.overall);
      if (m !== 0) return m;
      if (x.fails !== y.fails) return x.fails - y.fails;
      const s = cmpDescNullLast(x.sunPct, y.sunPct);
      if (s !== 0) return s;
      const e = cmpDescNullLast(x.earthPct, y.earthPct);
      if (e !== 0) return e;
      return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
    })
    .map((r) => r.key);
}

export function nextTransition(flags: ArrayLike<number>, ref: number, kind: 'fall' | 'rise'): { index: number | null; within: boolean; startedUnknown: boolean } {
  const startedUnknown = flags[ref] === -1;
  const before = kind === 'fall' ? 1 : 0;
  const after = kind === 'fall' ? 0 : 1;
  for (let i = Math.max(ref + 1, 1); i < flags.length; i++) {
    if (flags[i] === after && flags[i - 1] === before) {
      return { index: i, within: i === ref + 1, startedUnknown };
    }
  }
  return { index: null, within: false, startedUnknown };
}

export function parseUtc(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?Z?$/i.exec(s.trim());
  if (m === null) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number((m[7] + '00').slice(0, 3));
  const d = new Date(0);
  d.setUTCFullYear(y, mo - 1, da);
  d.setUTCHours(h, mi, sec, ms);
  const ok = d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da &&
    d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === sec;
  return ok ? d.getTime() : NaN;
}

export function formatUtc(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'Invalid date';
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)} UTC`;
}

export function fmtHours(h: number): string {
  const total = Number.isFinite(h) && h > 0 ? Math.floor(h) : 0;
  const d = Math.floor(total / 24);
  const r = total % 24;
  if (d === 0) return `${r} h`;
  if (r === 0) return `${d} d`;
  return `${d} d ${r} h`;
}