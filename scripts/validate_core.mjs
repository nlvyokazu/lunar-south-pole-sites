// Pure bundle validator. No imports and no Node APIs, so the same code runs in
// Node (scripts/validate_bundle.mjs) and in the browser (src/main.ts).
// Timestamps mean UTC: they carry no timezone suffix and are parsed by appending "Z".

const SERIES = ['sunAlt', 'sunAz', 'sunHorizon', 'earthAlt', 'earthAz', 'earthHorizon', 'lit'];
const WINDOW_KINDS = ['sunlit', 'dark', 'comms'];
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

function show(v) {
  if (typeof v === 'number') return String(v);
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s;
}

/** Returns null when s is a valid UTC timestamp without suffix, else a reason. */
export function timestampProblem(s) {
  if (typeof s !== 'string') return `is not a string (${show(s)})`;
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    return `"${s}" has a timezone suffix; the contract says none`;
  }
  if (!TS_RE.test(s)) return `"${s}" does not match YYYY-MM-DDTHH:MM:SS[.fff]`;
  const ms = Date.parse(s + 'Z');
  if (!Number.isFinite(ms)) return `"${s}" does not parse as UTC when "Z" is appended`;
  if (new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)) {
    return `"${s}" is not a real calendar date/time`;
  }
  return null;
}

/** UTC milliseconds, or NaN when the string is not a valid contract timestamp. */
export function parseUtcMs(s) {
  return timestampProblem(s) === null ? Date.parse(s + 'Z') : NaN;
}

export function validateBundle(bundle) {
  const results = [];

  function rule(id, title, body) {
    const failures = [];
    const notes = [];
    try {
      body(failures, notes);
    } catch (e) {
      failures.push('validator error: ' + (e && e.message ? e.message : String(e)));
    }
    results.push({ id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes });
  }

  const meta = isObj(bundle) && isObj(bundle.meta) ? bundle.meta : null;
  const sites = isObj(bundle) && isObj(bundle.sites) ? bundle.sites : null;
  const metaKeys =
    meta && Array.isArray(meta.sites) && meta.sites.every(isStr) ? meta.sites : null;
  // Sites that are checked: those listed in meta.sites, else every key in sites.
  const keys = metaKeys ?? (sites ? Object.keys(sites) : []);
  const present = keys.filter((k) => sites && isObj(sites[k]));

  // Parsed t per site (array of ms, NaN where invalid), cached.
  const tCache = new Map();
  function tMs(key) {
    if (!tCache.has(key)) {
      const t = sites[key].t;
      tCache.set(key, Array.isArray(t) ? t.map(parseUtcMs) : null);
    }
    return tCache.get(key);
  }
  const tAllValid = (key) => {
    const a = tMs(key);
    return a !== null && a.length > 0 && a.every(Number.isFinite);
  };

  // ---- 1 ----
  rule('bundle-structure', 'top level is an object with "meta" and "sites" objects', (f) => {
    if (!isObj(bundle)) return f.push('top level is not a JSON object');
    if (!isObj(bundle.meta)) f.push('"meta" is missing or not an object');
    if (!isObj(bundle.sites)) f.push('"sites" is missing or not an object');
  });

  // ---- 2 ----
  rule('meta-fields', 'required meta fields present and correctly typed', (f) => {
    if (!meta) return f.push('meta is missing');
    if (typeof meta.schema !== 'number') f.push(`meta.schema is not a number (${show(meta.schema)})`);
    else if (meta.schema !== 1) f.push(`meta.schema must be 1, got ${show(meta.schema)}`);

    if (!isStr(meta.generated_utc)) {
      f.push('meta.generated_utc is missing or not a string');
    } else {
      const g = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(meta.generated_utc)
        ? meta.generated_utc
        : meta.generated_utc + 'Z';
      if (!Number.isFinite(Date.parse(g))) f.push(`meta.generated_utc "${meta.generated_utc}" does not parse as a UTC time`);
    }

    if (!Array.isArray(meta.sites) || meta.sites.length === 0) {
      f.push('meta.sites must be a non-empty array of site keys');
    } else {
      if (!meta.sites.every(isNonEmptyStr)) f.push('meta.sites must contain only non-empty strings');
      if (new Set(meta.sites).size !== meta.sites.length) f.push('meta.sites contains duplicate keys');
    }

    if (typeof meta.step_hours !== 'number') f.push(`meta.step_hours is not a number (${show(meta.step_hours)})`);
    else if (Number.isFinite(meta.step_hours) && meta.step_hours <= 0) f.push(`meta.step_hours must be > 0, got ${meta.step_hours}`);

    if (!isNonEmptyStr(meta.frame)) f.push('meta.frame is missing or not a non-empty string');
    if (typeof meta.radius_km !== 'number') f.push(`meta.radius_km is not a number (${show(meta.radius_km)})`);
    else if (Number.isFinite(meta.radius_km) && meta.radius_km <= 0) f.push(`meta.radius_km must be > 0, got ${meta.radius_km}`);
    if (!isNonEmptyStr(meta.ephemeris)) f.push('meta.ephemeris is missing or not a non-empty string');

    if (!Array.isArray(meta.kernels)) {
      f.push('meta.kernels is missing or not an array');
    } else {
      meta.kernels.forEach((k, i) => {
        if (!isObj(k)) return f.push(`meta.kernels[${i}] is not an object`);
        if (!isNonEmptyStr(k.name)) f.push(`meta.kernels[${i}].name is missing or empty`);
        if (!isStr(k.sha256) || !SHA256_RE.test(k.sha256)) f.push(`meta.kernels[${i}].sha256 is not 64 hex characters`);
      });
    }

    if (!isNonEmptyStr(meta.horizon_source)) f.push('meta.horizon_source is missing or not a non-empty string');
    if (typeof meta.horizon_is_placeholder !== 'boolean') f.push('meta.horizon_is_placeholder is missing or not a boolean');
    if (typeof meta.synthetic !== 'boolean') f.push('meta.synthetic is missing or not a boolean');
  });

  // ---- 3 ----
  rule('meta-sites-present', 'every meta.sites key is present in sites', (f, n) => {
    if (!metaKeys) return f.push('meta.sites is missing or not an array of strings');
    if (!sites) return f.push('sites is missing');
    for (const k of metaKeys) {
      if (!isObj(sites[k])) f.push(`meta.sites lists "${k}" but sites["${k}"] is missing or not an object`);
    }
    for (const k of Object.keys(sites)) {
      if (!metaKeys.includes(k)) n.push(`sites contains "${k}" which is not listed in meta.sites (not validated)`);
    }
  });

  // ---- 4 ----
  rule('site-fields', 'every site has every required field with the right type', (f) => {
    for (const k of present) {
      const s = sites[k];
      if (!isStr(s.label)) f.push(`${k}: label is missing or not a string`);
      if (typeof s.lat !== 'number') f.push(`${k}: lat is missing or not a number`);
      if (typeof s.lon !== 'number') f.push(`${k}: lon is missing or not a number`);
      if (!isStr(s.coordinates_note)) f.push(`${k}: coordinates_note is missing or not a string`);
      for (const name of ['t', ...SERIES]) {
        if (!Array.isArray(s[name])) f.push(`${k}: ${name} is missing or not an array`);
      }
      if (!isObj(s.windows)) f.push(`${k}: windows is missing or not an object`);
      if (!isObj(s.stats)) f.push(`${k}: stats is missing or not an object`);
    }
  });

  // ---- 5 ----
  rule('arrays-equal-length', 't and all seven data arrays of a site have equal length (>= 1)', (f) => {
    for (const k of present) {
      const s = sites[k];
      const names = ['t', ...SERIES];
      if (!names.every((nm) => Array.isArray(s[nm]))) continue; // reported by site-fields
      const lens = names.map((nm) => s[nm].length);
      if (new Set(lens).size > 1) {
        f.push(`${k}: length mismatch: ${names.map((nm, i) => `${nm}=${lens[i]}`).join(', ')}`);
      } else if (lens[0] === 0) {
        f.push(`${k}: arrays are empty`);
      }
    }
  });

  // ---- 6 ----
  rule('numbers-finite', 'all numbers are finite (every data-array entry is a finite number)', (f) => {
    if (meta) {
      for (const nm of ['schema', 'step_hours', 'radius_km']) {
        if (typeof meta[nm] === 'number' && !Number.isFinite(meta[nm])) f.push(`meta.${nm} = ${meta[nm]} is not finite`);
      }
    }
    const walk = (v, path) => {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) f.push(`${path} = ${v} is not finite`);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (isObj(v)) {
        for (const [kk, x] of Object.entries(v)) walk(x, `${path}.${kk}`);
      }
    };
    for (const k of present) {
      const s = sites[k];
      for (const nm of ['lat', 'lon']) {
        if (typeof s[nm] === 'number' && !Number.isFinite(s[nm])) f.push(`${k}.${nm} = ${s[nm]} is not finite`);
      }
      for (const nm of SERIES) {
        if (!Array.isArray(s[nm])) continue;
        s[nm].forEach((v, i) => {
          if (!isFin(v)) f.push(`${k}.${nm}[${i}] = ${show(v)} is not a finite number`);
        });
      }
      if (isObj(s.windows)) walk(s.windows, `${k}.windows`);
      if (isObj(s.stats)) walk(s.stats, `${k}.stats`);
    }
  });

  // ---- 7 ----
  rule('t-utc-ascending', 't has no timezone suffix, parses as UTC with "Z" appended, and is strictly ascending', (f) => {
    for (const k of present) {
      const t = sites[k].t;
      if (!Array.isArray(t)) continue;
      let prev = NaN;
      t.forEach((s, i) => {
        const problem = timestampProblem(s);
        if (problem) {
          f.push(`${k}.t[${i}] ${problem}`);
          prev = NaN;
          return;
        }
        const ms = Date.parse(s + 'Z');
        if (Number.isFinite(prev) && ms <= prev) f.push(`${k}.t[${i}] "${s}" is not after t[${i - 1}] "${t[i - 1]}"`);
        prev = ms;
      });
    }
  });

  // ---- 8 ----
  rule('t-step-matches-meta', 'spacing of t equals meta.step_hours', (f) => {
    if (!meta || !isFin(meta.step_hours) || meta.step_hours <= 0) return f.push('meta.step_hours unusable');
    const stepMs = meta.step_hours * 3600000;
    for (const k of present) {
      if (!tAllValid(k)) continue; // reported by t-utc-ascending / arrays-equal-length
      const a = tMs(k);
      for (let i = 1; i < a.length; i++) {
        if (Math.abs(a[i] - a[i - 1] - stepMs) > 1) {
          f.push(`${k}.t[${i}]: spacing from t[${i - 1}] is ${(a[i] - a[i - 1]) / 3600000} h, meta.step_hours is ${meta.step_hours}`);
          break;
        }
      }
    }
  });

  // ---- 9 ----
  rule('t-axis-shared', 'all sites share one t axis', (f) => {
    const ref = present.find((k) => Array.isArray(sites[k].t));
    if (!ref) return;
    const rt = sites[ref].t;
    for (const k of present) {
      const t = sites[k].t;
      if (k === ref || !Array.isArray(t)) continue;
      if (t.length !== rt.length) {
        f.push(`${k}: t has ${t.length} epochs, ${ref} has ${rt.length}`);
        continue;
      }
      const i = t.findIndex((x, j) => x !== rt[j]);
      if (i >= 0) f.push(`${k}.t[${i}] "${t[i]}" differs from ${ref}.t[${i}] "${rt[i]}"`);
    }
  });

  // ---- 10 ----
  rule('alt-range', 'sunAlt and earthAlt are within [-90, 90] degrees', (f) => {
    for (const k of present) {
      for (const nm of ['sunAlt', 'earthAlt']) {
        const a = sites[k][nm];
        if (!Array.isArray(a)) continue;
        a.forEach((v, i) => {
          if (isFin(v) && (v < -90 || v > 90)) f.push(`${k}.${nm}[${i}] = ${v} is outside [-90, 90]`);
        });
      }
    }
  });

  // ---- 11 ----
  rule('az-range', 'sunAz and earthAz are within [0, 360) degrees', (f) => {
    for (const k of present) {
      for (const nm of ['sunAz', 'earthAz']) {
        const a = sites[k][nm];
        if (!Array.isArray(a)) continue;
        a.forEach((v, i) => {
          if (isFin(v) && (v < 0 || v >= 360)) f.push(`${k}.${nm}[${i}] = ${v} is outside [0, 360)`);
        });
      }
    }
  });

  // ---- 12 ----
  rule('lit-range', 'lit is within [0, 1]', (f) => {
    for (const k of present) {
      const a = sites[k].lit;
      if (!Array.isArray(a)) continue;
      a.forEach((v, i) => {
        if (isFin(v) && (v < 0 || v > 1)) f.push(`${k}.lit[${i}] = ${v} is outside [0, 1]`);
      });
    }
  });

  // ---- 13 ----
  rule('windows-fields', 'windows.sunlit/dark/comms are arrays of {start, end, samples, whole_span}', (f) => {
    for (const k of present) {
      const w = sites[k].windows;
      if (!isObj(w)) continue; // reported by site-fields
      for (const kind of WINDOW_KINDS) {
        if (!Array.isArray(w[kind])) {
          f.push(`${k}.windows.${kind} is missing or not an array`);
          continue;
        }
        w[kind].forEach((x, i) => {
          const p = `${k}.windows.${kind}[${i}]`;
          if (!isObj(x)) return f.push(`${p} is not an object`);
          if (!isStr(x.start)) f.push(`${p}.start is missing or not a string`);
          if (!isStr(x.end)) f.push(`${p}.end is missing or not a string`);
          if (typeof x.samples !== 'number' || (Number.isFinite(x.samples) && (!Number.isInteger(x.samples) || x.samples < 1))) {
            f.push(`${p}.samples must be an integer >= 1, got ${show(x.samples)}`);
          }
          if (typeof x.whole_span !== 'boolean') f.push(`${p}.whole_span is missing or not a boolean`);
        });
      }
    }
  });

  // ---- 14 ----
  rule('windows-in-range', 'window start/end parse as UTC, start <= end, and lie inside the t range', (f) => {
    for (const k of present) {
      const w = sites[k].windows;
      if (!isObj(w)) continue;
      const a = tMs(k);
      const haveRange = a !== null && a.length > 0 && Number.isFinite(a[0]) && Number.isFinite(a[a.length - 1]);
      const t0 = haveRange ? a[0] : NaN;
      const t1 = haveRange ? a[a.length - 1] : NaN;
      for (const kind of WINDOW_KINDS) {
        if (!Array.isArray(w[kind])) continue;
        w[kind].forEach((x, i) => {
          if (!isObj(x) || !isStr(x.start) || !isStr(x.end)) return; // reported by windows-fields
          const p = `${k}.windows.${kind}[${i}]`;
          const ps = timestampProblem(x.start);
          const pe = timestampProblem(x.end);
          if (ps) f.push(`${p}.start ${ps}`);
          if (pe) f.push(`${p}.end ${pe}`);
          if (ps || pe) return;
          const s = Date.parse(x.start + 'Z');
          const e = Date.parse(x.end + 'Z');
          if (s > e) f.push(`${p}: start "${x.start}" is after end "${x.end}"`);
          if (!haveRange) return f.push(`${p}: t range of ${k} is unusable, window cannot be range-checked`);
          if (s < t0 || e > t1) f.push(`${p}: ${x.start} to ${x.end} is outside the t range ${sites[k].t[0]} to ${sites[k].t[sites[k].t.length - 1]}`);
        });
      }
    }
  });

  // ---- 15 (never fails) ----
  rule('windows-whole-span-flagged', 'whole_span windows are flagged, not rejected', (f, n) => {
    for (const k of present) {
      const w = sites[k].windows;
      if (!isObj(w)) continue;
      for (const kind of WINDOW_KINDS) {
        if (!Array.isArray(w[kind])) continue;
        w[kind].forEach((x, i) => {
          if (!isObj(x) || x.whole_span !== true) return;
          let msg = `${k}.windows.${kind}[${i}] is whole_span: no event in this span, never show it as an event`;
          const a = tMs(k);
          if (a && a.length && isStr(x.start) && isStr(x.end)) {
            const s = parseUtcMs(x.start);
            const e = parseUtcMs(x.end);
            if (Number.isFinite(s) && Number.isFinite(e) && (s !== a[0] || e !== a[a.length - 1])) {
              msg += ' (note: it does not cover the full t range)';
            }
          }
          n.push(msg);
        });
      }
    }
  });

  return { ok: results.every((r) => r.status === 'PASS'), results };
}

/** One line per failed rule: "FAIL <id>: <first details> (+N more)". */
export function summarizeFailures(report, maxDetails = 3) {
  return report.results
    .filter((r) => r.status === 'FAIL')
    .map((r) => {
      const shown = r.failures.slice(0, maxDetails).join('; ');
      const more = r.failures.length > maxDetails ? ` (+${r.failures.length - maxDetails} more)` : '';
      return `FAIL ${r.id}: ${shown}${more}`;
    });
}
