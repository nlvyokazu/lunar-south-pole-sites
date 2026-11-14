// Phase 1 smoke test: fetch ./data/bundle.json, run the validator, print the result.
import type { Bundle } from './types';
import { validateBundle, summarizeFailures } from '../scripts/validate_core.mjs';

const out = document.getElementById('out');

function print(lines: string[]): void {
  if (out) out.textContent = lines.join('\n');
}

async function run(): Promise<void> {
  let raw: unknown;
  try {
    const res = await fetch('./data/bundle.json', { cache: 'no-store' });
    if (!res.ok) {
      print([`FAIL fetch ./data/bundle.json: HTTP ${res.status} ${res.statusText}`]);
      return;
    }
    raw = await res.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    print([`FAIL load ./data/bundle.json: ${msg}`]);
    return;
  }

  const report = validateBundle(raw);
  if (!report.ok) {
    print(summarizeFailures(report));
    return;
  }

  // Every rule passed, so the shape is guaranteed.
  const bundle = raw as Bundle;
  const first = bundle.sites[bundle.meta.sites[0]];
  const n = bundle.meta.sites.length;
  const m = first.t.length;
  print([`OK: ${n} sites, ${m} epochs, ${first.t[0]} to ${first.t[m - 1]}`]);
}

run().catch((e) => {
  print([`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`]);
});
