// Wrapper for the lit kernel (C++ compiled to WebAssembly).
// No DOM access: the caller passes the module URL or a loader function.

export interface LitModule {
  HEAPF64: Float64Array;
  _lit_capacity(): number;
  _lit_alt_ptr(): number;
  _lit_hor_ptr(): number;
  _lit_rad_ptr(): number;
  _lit_out_ptr(): number;
  _lit_compute(count: number, offsetDeg: number): number;
}

export type LitSource = string | (() => Promise<unknown>);
export type Nums = ArrayLike<number | null | undefined>;

export interface LitKernel {
  readonly capacity: number;
  compute(alt: Nums, hor: Nums, rad: Nums, offsetDeg: number): Float64Array;
}

export interface LitCheck {
  passed: boolean;
  maxDiff: number;
  flagMismatches: number;
  nanMismatches: number;
  count: number;
}

export const LIT_TOLERANCE = 6e-7;

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

export function makeKernel(mod: LitModule): LitKernel {
  const capacity = mod._lit_capacity();
  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('bad kernel capacity');
  const a = ptrIndex(mod._lit_alt_ptr(), 'alt');
  const h = ptrIndex(mod._lit_hor_ptr(), 'hor');
  const r = ptrIndex(mod._lit_rad_ptr(), 'rad');
  const o = ptrIndex(mod._lit_out_ptr(), 'out');
  const need = Math.max(a, h, r, o) + capacity;
  const heap = (): Float64Array => {
    const x = mod.HEAPF64;
    if (!(x instanceof Float64Array) || x.length < need) throw new Error('kernel buffers outside heap');
    return x;
  };

  const compute = (alt: Nums, hor: Nums, rad: Nums, offsetDeg: number): Float64Array => {
    const n = alt.length;
    if (hor.length !== n || rad.length !== n) throw new Error('input arrays differ in length');
    if (!Number.isFinite(offsetDeg)) throw new Error('offset must be finite');
    const out = new Float64Array(n);
    for (let s = 0; s < n; s += capacity) {
      const m = Math.min(capacity, n - s);
      const hp = heap();
      for (let i = 0; i < m; i++) {
        hp[a + i] = num(alt[s + i]);
        hp[h + i] = num(hor[s + i]);
        hp[r + i] = num(rad[s + i]);
      }
      const code = mod._lit_compute(m, offsetDeg);
      if (code !== m) throw new Error('kernel returned ' + String(code));
      out.set(heap().subarray(o, o + m), s);
    }
    return out;
  };

  return { capacity, compute };
}

export async function loadLit(source: LitSource): Promise<LitKernel> {
  const ns: unknown = typeof source === 'function' ? await source() : await import(/* @vite-ignore */ source);
  const factory = typeof ns === 'function' ? ns : isObj(ns) ? ns['default'] : undefined;
  if (typeof factory !== 'function') throw new Error('kernel module has no default export');
  const mod: unknown = await (factory as () => Promise<unknown>)();
  if (!isObj(mod)) throw new Error('kernel factory returned no object');
  for (const name of ['_lit_capacity', '_lit_alt_ptr', '_lit_hor_ptr', '_lit_rad_ptr', '_lit_out_ptr', '_lit_compute']) {
    if (typeof mod[name] !== 'function') throw new Error('kernel is missing ' + name);
  }
  if (!(mod['HEAPF64'] instanceof Float64Array)) throw new Error('kernel does not export HEAPF64');
  return makeKernel(mod as unknown as LitModule);
}

export function sunVisible(litValue: number): boolean {
  return litValue >= 0.5;
}

// Compare kernel output with the bundle lit series at margin 0.
// A flag disagreement counts only if the kernel value is farther than tol from 0.5.
export function checkAgainstBundle(out: ArrayLike<number>, bundleLit: Nums, tol: number = LIT_TOLERANCE): LitCheck {
  const count = out.length;
  if (bundleLit.length !== count) {
    return { passed: false, maxDiff: Number.POSITIVE_INFINITY, flagMismatches: 0, nanMismatches: 0, count };
  }
  let maxDiff = 0;
  let flagMismatches = 0;
  let nanMismatches = 0;
  for (let i = 0; i < count; i++) {
    const x = num(out[i]);
    const y = num(bundleLit[i]);
    const xOk = Number.isFinite(x);
    const yOk = Number.isFinite(y);
    if (!xOk && !yOk) continue;
    if (xOk !== yOk) {
      nanMismatches++;
      continue;
    }
    const d = Math.abs(x - y);
    if (d > maxDiff) maxDiff = d;
    if (sunVisible(x) !== sunVisible(y) && Math.abs(x - 0.5) > tol) flagMismatches++;
  }
  const passed = count > 0 && maxDiff <= tol && flagMismatches === 0 && nanMismatches === 0;
  return { passed, maxDiff, flagMismatches, nanMismatches, count };
}