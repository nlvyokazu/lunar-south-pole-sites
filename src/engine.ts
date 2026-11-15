// Wrapper for the calculation engine (C++ compiled to WebAssembly).
// It copies data into the module's buffers and reads results back.
// No calculation logic lives here. No DOM access.
import type { Win, Check } from './model';

export type Overall = 'MEETS' | 'FAILS' | 'MEETS_OPEN' | 'NONE';
export type Nums = ArrayLike<number | null | undefined>;

export interface Summary {
  known: number;
  pct: number | null;
  lit: Win[];
  dark: Win[];
  longestLit: Win | null;
  longestDark: Win | null;
}

export interface RankRow {
  key: string;
  overall: string;
  fails: number;
  sunPct: number | null;
  earthPct: number | null;
}

export interface Transition {
  index: number | null;
  within: boolean;
  startedUnknown: boolean;
}

export interface EngineModule {
  HEAPF64: Float64Array;
  _eng_a_ptr(): number;
  _eng_b_ptr(): number;
  _eng_c_ptr(): number;
  _eng_vals_ptr(): number;
  _eng_flags_ptr(): number;
  _eng_runs_ptr(): number;
  _eng_sum_ptr(): number;
  _eng_capacity(): number;
  _eng_lit(count: number, offsetDeg: number): number;
  _eng_sun_flags(count: number, offsetDeg: number): number;
  _eng_flags_from_vals(count: number): number;
  _eng_earth_flags(count: number, margin: number): number;
  _eng_summarize(count: number, from: number, to: number): number;
  _eng_min_check(pct: number, minPct: number): number;
  _eng_max_run_check_all(n: number, maxHours: number, rangeHours: number): number;
  _eng_overall(n: number): number;
  _eng_rank(n: number): number;
  _eng_next_transition(count: number, ref: number, fall: number): number;
}

export interface Engine {
  readonly capacity: number;
  lit(alt: Nums, hor: Nums, rad: Nums, marginDeg: number): Float64Array;
  sunFlagsFromBodies(alt: Nums, hor: Nums, rad: Nums, marginDeg: number): Int8Array;
  sunFlagsFromLit(lit: Nums): Int8Array;
  earthFlags(alt: Nums, hor: Nums, marginDeg: number): Int8Array;
  summarize(flags: ArrayLike<number>, from: number, to: number): Summary;
  minCheck(pct: number | null, min: number | null): 'PASS' | 'FAIL' | 'NONE';
  maxRunCheckAll(runs: Win[], maxHours: number | null, rangeHours: number): Check;
  overall(checks: Check[]): Overall;
  rankSites(rows: RankRow[]): string[];
  nextTransition(flags: ArrayLike<number>, ref: number, kind: 'fall' | 'rise'): Transition;
}

export type EngineSource = string | (() => Promise<unknown>);

const RUN_FIELDS = 5;
const ROW_FIELDS = 5;
const MAX_ROWS = 64;
const SUM_SIZE = 16;
const CHECKS: Check[] = ['PASS', 'FAIL', 'PASS_OPEN', 'NONE'];
const CHECK_CODE: Record<Check, number> = { PASS: 0, FAIL: 1, PASS_OPEN: 2, NONE: 3 };
const OVERALLS: Overall[] = ['MEETS', 'FAILS', 'MEETS_OPEN', 'NONE'];
const EXPORT_NAMES = [
  '_eng_a_ptr', '_eng_b_ptr', '_eng_c_ptr', '_eng_vals_ptr', '_eng_flags_ptr', '_eng_runs_ptr',
  '_eng_sum_ptr', '_eng_capacity', '_eng_lit', '_eng_sun_flags', '_eng_flags_from_vals',
  '_eng_earth_flags', '_eng_summarize', '_eng_min_check', '_eng_max_run_check_all', '_eng_overall',
  '_eng_rank', '_eng_next_transition',
];

function num(v: number | null | undefined): number {
  return typeof v === 'number' ? v : Number.NaN;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

function ptrIndex(p: number, name: string): number {
  if (!Number.isInteger(p) || p < 0 || p % 8 !== 0) throw new Error('bad pointer from ' + name);
  return p / 8;
}

export function makeEngine(mod: EngineModule): Engine {
  const capacity = mod._eng_capacity();
  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('bad engine capacity');
  const a = ptrIndex(mod._eng_a_ptr(), 'a');
  const b = ptrIndex(mod._eng_b_ptr(), 'b');
  const c = ptrIndex(mod._eng_c_ptr(), 'c');
  const v = ptrIndex(mod._eng_vals_ptr(), 'vals');
  const f = ptrIndex(mod._eng_flags_ptr(), 'flags');
  const r = ptrIndex(mod._eng_runs_ptr(), 'runs');
  const s = ptrIndex(mod._eng_sum_ptr(), 'sum');
  const need = Math.max(a, b, c, v, f, s + SUM_SIZE - capacity, r + capacity * RUN_FIELDS - capacity) + capacity;

  const heap = (): Float64Array => {
    const x = mod.HEAPF64;
    if (!(x instanceof Float64Array) || x.length < need) throw new Error('engine buffers outside heap');
    return x;
  };

  const limit = (n: number, what: string): void => {
    if (n > capacity) throw new Error(what + ' longer than engine capacity');
  };

  const fill = (hp: Float64Array, at: number, src: Nums): void => {
    for (let i = 0; i < src.length; i++) hp[at + i] = num(src[i]);
  };

  const putFlags = (flags: ArrayLike<number>): void => {
    const hp = heap();
    for (let i = 0; i < flags.length; i++) hp[f + i] = flags[i];
  };

  const readFlags = (n: number): Int8Array => {
    const hp = heap();
    const out = new Int8Array(n);
    for (let i = 0; i < n; i++) out[i] = hp[f + i];
    return out;
  };

  const readRuns = (hp: Float64Array, first: number, n: number): Win[] => {
    const out: Win[] = [];
    for (let i = 0; i < n; i++) {
      const p = r + (first + i) * RUN_FIELDS;
      out.push({
        start: hp[p],
        end: hp[p + 1],
        samples: hp[p + 2],
        openStart: hp[p + 3] !== 0,
        openEnd: hp[p + 4] !== 0,
      });
    }
    return out;
  };

  const sameLength = (x: Nums, y: Nums, z?: Nums): number => {
    const n = x.length;
    if (y.length !== n || (z !== undefined && z.length !== n)) throw new Error('input arrays differ in length');
    limit(n, 'input');
    return n;
  };

  const lit = (alt: Nums, hor: Nums, rad: Nums, marginDeg: number): Float64Array => {
    const n = sameLength(alt, hor, rad);
    if (!Number.isFinite(marginDeg)) throw new Error('margin must be finite');
    const hp = heap();
    fill(hp, a, alt);
    fill(hp, b, hor);
    fill(hp, c, rad);
    const code = mod._eng_lit(n, marginDeg);
    if (code !== n) throw new Error('engine returned ' + String(code));
    return heap().slice(v, v + n);
  };

  const sunFlagsFromBodies = (alt: Nums, hor: Nums, rad: Nums, marginDeg: number): Int8Array => {
    const n = sameLength(alt, hor, rad);
    if (!Number.isFinite(marginDeg)) throw new Error('margin must be finite');
    const hp = heap();
    fill(hp, a, alt);
    fill(hp, b, hor);
    fill(hp, c, rad);
    const code = mod._eng_sun_flags(n, marginDeg);
    if (code !== n) throw new Error('engine returned ' + String(code));
    return readFlags(n);
  };

  const sunFlagsFromLit = (litValues: Nums): Int8Array => {
    const n = litValues.length;
    limit(n, 'input');
    fill(heap(), v, litValues);
    const code = mod._eng_flags_from_vals(n);
    if (code !== n) throw new Error('engine returned ' + String(code));
    return readFlags(n);
  };

  const earthFlags = (alt: Nums, hor: Nums, marginDeg: number): Int8Array => {
    const n = sameLength(alt, hor);
    const hp = heap();
    fill(hp, a, alt);
    fill(hp, b, hor);
    const code = mod._eng_earth_flags(n, marginDeg);
    if (code !== n) throw new Error('engine returned ' + String(code));
    return readFlags(n);
  };

  const summarize = (flags: ArrayLike<number>, from: number, to: number): Summary => {
    const n = flags.length;
    limit(n, 'flags');
    putFlags(flags);
    const code = mod._eng_summarize(n, from, to);
    if (code !== 0) throw new Error('engine returned ' + String(code));
    const hp = heap();
    const known = hp[s];
    const pct = hp[s + 1];
    const nl = hp[s + 2];
    const nd = hp[s + 3];
    const il = hp[s + 4];
    const id = hp[s + 5];
    const litRuns = readRuns(hp, 0, nl);
    const darkRuns = readRuns(hp, nl, nd);
    return {
      known,
      pct: Number.isNaN(pct) ? null : pct,
      lit: litRuns,
      dark: darkRuns,
      longestLit: il >= 0 ? litRuns[il] : null,
      longestDark: id >= 0 ? darkRuns[id] : null,
    };
  };

  const minCheck = (pct: number | null, min: number | null): 'PASS' | 'FAIL' | 'NONE' => {
    const code = mod._eng_min_check(pct === null ? Number.NaN : pct, min === null ? Number.NaN : min);
    if (code !== 0 && code !== 1 && code !== 3) throw new Error('engine returned ' + String(code));
    return CHECKS[code] as 'PASS' | 'FAIL' | 'NONE';
  };

  const maxRunCheckAll = (runs: Win[], maxHours: number | null, rangeHours: number): Check => {
    const n = runs.length;
    limit(n, 'runs');
    const hp = heap();
    for (let i = 0; i < n; i++) {
      const w = runs[i];
      const p = r + i * RUN_FIELDS;
      hp[p] = w.start;
      hp[p + 1] = w.end;
      hp[p + 2] = w.samples;
      hp[p + 3] = w.openStart ? 1 : 0;
      hp[p + 4] = w.openEnd ? 1 : 0;
    }
    const code = mod._eng_max_run_check_all(n, maxHours === null ? Number.NaN : maxHours, rangeHours);
    const out = CHECKS[code];
    if (out === undefined) throw new Error('engine returned ' + String(code));
    return out;
  };

  const overall = (checks: Check[]): Overall => {
    const n = checks.length;
    limit(n, 'checks');
    const hp = heap();
    for (let i = 0; i < n; i++) hp[a + i] = CHECK_CODE[checks[i]];
    const code = mod._eng_overall(n);
    const out = OVERALLS[code];
    if (out === undefined) throw new Error('engine returned ' + String(code));
    return out;
  };

  const rankSites = (rows: RankRow[]): string[] => {
    const n = rows.length;
    if (n > MAX_ROWS) throw new Error('too many rows to rank');
    const keys = rows.map((x) => x.key).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const keyRank = new Map<string, number>();
    keys.forEach((k, i) => {
      if (!keyRank.has(k)) keyRank.set(k, i);
    });
    const code = (o: string): number => (o === 'MEETS' ? 0 : o === 'MEETS_OPEN' ? 2 : o === 'NONE' ? 3 : 1);
    const hp = heap();
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const p = a + i * ROW_FIELDS;
      hp[p] = code(row.overall);
      hp[p + 1] = row.fails;
      hp[p + 2] = row.sunPct === null ? Number.NaN : row.sunPct;
      hp[p + 3] = row.earthPct === null ? Number.NaN : row.earthPct;
      hp[p + 4] = keyRank.get(row.key) ?? 0;
    }
    const got = mod._eng_rank(n);
    if (got !== n) throw new Error('engine returned ' + String(got));
    const out: string[] = [];
    const after = heap();
    for (let i = 0; i < n; i++) out.push(rows[after[v + i]].key);
    return out;
  };

  const nextTransition = (flags: ArrayLike<number>, ref: number, kind: 'fall' | 'rise'): Transition => {
    if (!Number.isInteger(ref)) throw new Error('reference index must be an integer');
    const n = flags.length;
    limit(n, 'flags');
    putFlags(flags);
    const code = mod._eng_next_transition(n, ref, kind === 'fall' ? 1 : 0);
    if (code !== 0) throw new Error('engine returned ' + String(code));
    const hp = heap();
    const idx = hp[s];
    return { index: idx >= 0 ? idx : null, within: hp[s + 1] === 1, startedUnknown: hp[s + 2] === 1 };
  };

  return {
    capacity,
    lit,
    sunFlagsFromBodies,
    sunFlagsFromLit,
    earthFlags,
    summarize,
    minCheck,
    maxRunCheckAll,
    overall,
    rankSites,
    nextTransition,
  };
}

export async function loadEngine(source: EngineSource): Promise<Engine> {
  const ns: unknown = typeof source === 'function' ? await source() : await import(/* @vite-ignore */ source);
  const factory = typeof ns === 'function' ? ns : isObj(ns) ? ns['default'] : undefined;
  if (typeof factory !== 'function') throw new Error('engine module has no default export');
  const mod: unknown = await (factory as () => Promise<unknown>)();
  if (!isObj(mod)) throw new Error('engine factory returned no object');
  for (const name of EXPORT_NAMES) {
    if (typeof mod[name] !== 'function') throw new Error('engine is missing ' + name);
  }
  if (!(mod['HEAPF64'] instanceof Float64Array)) throw new Error('engine does not export HEAPF64');
  return makeEngine(mod as unknown as EngineModule);
}