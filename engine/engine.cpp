// Calculation engine for the lunar south pole site comparison page.
// Compiled to WebAssembly. All data moves through fixed buffers of doubles.
// Flags: 1 = yes, 0 = no, -1 = unknown (breaks a run).
// Check codes: 0 PASS, 1 FAIL, 2 PASS_OPEN, 3 NONE.
// Overall codes use the same numbers: 0 MEETS, 1 FAILS, 2 MEETS_OPEN, 3 NONE.
// A run is 5 doubles: start, end (inclusive), samples, openStart, openEnd.
#include <cmath>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

constexpr int kCapacity = 10000;
constexpr int kRunFields = 5;
constexpr int kMaxRows = 64;
constexpr int kRowFields = 5;
constexpr double kPi = 3.14159265358979323846;

alignas(64) double g_a[kCapacity];
alignas(64) double g_b[kCapacity];
alignas(64) double g_c[kCapacity];
alignas(64) double g_vals[kCapacity];
alignas(64) double g_flags[kCapacity];
alignas(64) double g_runs[kCapacity * kRunFields];
alignas(64) double g_sum[16];

bool valid_count(int count) { return count >= 0 && count <= kCapacity; }

// Same as clampRange() in model.ts: floor both ends, clamp to [0, len], need lo < hi.
bool clamp_range(int len, double from, double to, int* lo, int* hi) {
  if (std::isnan(from) || std::isnan(to)) return false;
  double l = std::floor(from);
  double h = std::floor(to);
  if (l < 0.0) l = 0.0;
  if (h > static_cast<double>(len)) h = static_cast<double>(len);
  if (!(l < h)) return false;
  *lo = static_cast<int>(l);
  *hi = static_cast<int>(h);
  return true;
}

// Runs of `value` inside [lo, hi). End is inclusive in the output.
int extract_runs(int lo, int hi, double value, double* out) {
  int n = 0;
  int i = lo;
  while (i < hi) {
    if (g_flags[i] == value) {
      const int s = i;
      while (i < hi && g_flags[i] == value) ++i;
      const int e = i - 1;
      double* r = out + n * kRunFields;
      r[0] = s;
      r[1] = e;
      r[2] = e - s + 1;
      r[3] = (s == lo) ? 1.0 : 0.0;
      r[4] = (e == hi - 1) ? 1.0 : 0.0;
      ++n;
    } else {
      ++i;
    }
  }
  return n;
}

// Index of the longest run. The earlier run wins a tie. -1 if there are none.
int longest_run(const double* runs, int n) {
  int best = -1;
  for (int i = 0; i < n; ++i) {
    if (best < 0 || runs[i * kRunFields + 2] > runs[best * kRunFields + 2]) best = i;
  }
  return best;
}

// Visible fraction of an ideal Sun disc above a straight horizon.
int compute_lit(int count, double offset_deg) {
  if (!valid_count(count)) return -1;
  if (!std::isfinite(offset_deg)) return -2;
  for (int i = 0; i < count; ++i) {
    const double a = g_a[i];
    const double h = g_b[i];
    const double r = g_c[i];
    if (!std::isfinite(a) || !std::isfinite(h) || !std::isfinite(r) || !(r > 0.0)) {
      g_vals[i] = std::nan("");
      continue;
    }
    double x = (a - (h + offset_deg)) / r;
    if (x > 1.0) x = 1.0;
    if (x < -1.0) x = -1.0;
    g_vals[i] = 0.5 + (x * std::sqrt(1.0 - x * x) + std::asin(x)) / kPi;
  }
  return count;
}

int flags_from_vals(int count) {
  if (!valid_count(count)) return -1;
  for (int i = 0; i < count; ++i) {
    const double v = g_vals[i];
    g_flags[i] = std::isfinite(v) ? (v >= 0.5 ? 1.0 : 0.0) : -1.0;
  }
  return count;
}

int meets_rank(double code) { return (code == 0.0 || code == 2.0) ? 0 : 1; }

int cmp_desc_null_last(double a, double b) {
  const bool an = !std::isfinite(a);
  const bool bn = !std::isfinite(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const double d = b - a;
  return d < 0.0 ? -1 : (d > 0.0 ? 1 : 0);
}

// Row fields: overall code, fails, sunPct, earthPct, keyRank.
int cmp_rows(const double* x, const double* y) {
  const int m = meets_rank(x[0]) - meets_rank(y[0]);
  if (m != 0) return m;
  if (x[1] != y[1]) return x[1] < y[1] ? -1 : 1;
  const int s = cmp_desc_null_last(x[2], y[2]);
  if (s != 0) return s;
  const int e = cmp_desc_null_last(x[3], y[3]);
  if (e != 0) return e;
  if (x[4] < y[4]) return -1;
  if (x[4] > y[4]) return 1;
  return 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uintptr_t eng_a_ptr() { return reinterpret_cast<uintptr_t>(g_a); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_b_ptr() { return reinterpret_cast<uintptr_t>(g_b); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_c_ptr() { return reinterpret_cast<uintptr_t>(g_c); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_vals_ptr() { return reinterpret_cast<uintptr_t>(g_vals); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_flags_ptr() { return reinterpret_cast<uintptr_t>(g_flags); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_runs_ptr() { return reinterpret_cast<uintptr_t>(g_runs); }
EMSCRIPTEN_KEEPALIVE uintptr_t eng_sum_ptr() { return reinterpret_cast<uintptr_t>(g_sum); }
EMSCRIPTEN_KEEPALIVE int eng_capacity() { return kCapacity; }

// a = Sun altitude, b = horizon, c = Sun radius (degrees). Result in vals.
EMSCRIPTEN_KEEPALIVE int eng_lit(int count, double offset_deg) { return compute_lit(count, offset_deg); }

// Same inputs as eng_lit. Result in vals (lit fraction) and flags (lit >= 0.5).
EMSCRIPTEN_KEEPALIVE int eng_sun_flags(int count, double offset_deg) {
  const int code = compute_lit(count, offset_deg);
  if (code != count) return code;
  return flags_from_vals(count);
}

// Flags from lit values already placed in vals (used by tests).
EMSCRIPTEN_KEEPALIVE int eng_flags_from_vals(int count) { return flags_from_vals(count); }

// a = Earth altitude, b = horizon. Flag is 1 when alt - (horizon + margin) > 0.
EMSCRIPTEN_KEEPALIVE int eng_earth_flags(int count, double margin) {
  if (!valid_count(count)) return -1;
  for (int i = 0; i < count; ++i) {
    const double a = g_a[i];
    const double h = g_b[i];
    if (!std::isfinite(a) || !std::isfinite(h) || !std::isfinite(margin)) {
      g_flags[i] = -1.0;
    } else {
      g_flags[i] = (a - (h + margin) > 0.0) ? 1.0 : 0.0;
    }
  }
  return count;
}

// Summary of the flags buffer over [from, to).
// sum: 0 known, 1 pct (NaN if none), 2 lit run count, 3 dark run count,
//      4 longest lit index (-1 none), 5 longest dark index (-1 none).
// runs: lit runs first, then dark runs.
EMSCRIPTEN_KEEPALIVE int eng_summarize(int count, double from, double to) {
  if (!valid_count(count)) return -1;
  g_sum[0] = 0.0;
  g_sum[1] = std::nan("");
  g_sum[2] = 0.0;
  g_sum[3] = 0.0;
  g_sum[4] = -1.0;
  g_sum[5] = -1.0;
  int lo = 0;
  int hi = 0;
  if (!clamp_range(count, from, to, &lo, &hi)) return 0;
  const int nl = extract_runs(lo, hi, 1.0, g_runs);
  double* dark = g_runs + nl * kRunFields;
  const int nd = extract_runs(lo, hi, 0.0, dark);
  double ones = 0.0;
  double zeros = 0.0;
  for (int i = 0; i < nl; ++i) ones += g_runs[i * kRunFields + 2];
  for (int i = 0; i < nd; ++i) zeros += dark[i * kRunFields + 2];
  const double known = ones + zeros;
  g_sum[0] = known;
  g_sum[1] = known > 0.0 ? (100.0 * ones) / known : std::nan("");
  g_sum[2] = nl;
  g_sum[3] = nd;
  g_sum[4] = longest_run(g_runs, nl);
  g_sum[5] = longest_run(dark, nd);
  return 0;
}

// NaN means "no value" for either argument.
EMSCRIPTEN_KEEPALIVE int eng_min_check(double pct, double min_pct) {
  if (std::isnan(pct) || std::isnan(min_pct)) return 3;
  return pct >= min_pct ? 0 : 1;
}

// Reads n runs from the runs buffer. max_hours NaN means "no limit given".
EMSCRIPTEN_KEEPALIVE int eng_max_run_check_all(int n, double max_hours, double range_hours) {
  if (n < 0 || n > kCapacity) return -1;
  if (std::isnan(max_hours) || range_hours == 0.0) return 3;
  bool open = false;
  for (int i = 0; i < n; ++i) {
    const double* r = g_runs + i * kRunFields;
    if (r[2] > max_hours) return 1;
    if (r[3] != 0.0 || r[4] != 0.0) open = true;
  }
  return open ? 2 : 0;
}

// Reads n check codes from a.
EMSCRIPTEN_KEEPALIVE int eng_overall(int n) {
  if (n < 0 || n > kCapacity) return -1;
  bool none = false;
  bool fail = false;
  bool open = false;
  for (int i = 0; i < n; ++i) {
    const int c = static_cast<int>(g_a[i]);
    if (c == 3) none = true;
    if (c == 1) fail = true;
    if (c == 2) open = true;
  }
  if (none) return 3;
  if (fail) return 1;
  if (open) return 2;
  return 0;
}

// Reads n rows from a (5 doubles each). Writes the sorted row indexes to vals.
EMSCRIPTEN_KEEPALIVE int eng_rank(int n) {
  if (n < 0 || n > kMaxRows) return -1;
  int order[kMaxRows];
  for (int i = 0; i < n; ++i) order[i] = i;
  for (int i = 1; i < n; ++i) {
    const int cur = order[i];
    int j = i - 1;
    while (j >= 0 && cmp_rows(g_a + order[j] * kRowFields, g_a + cur * kRowFields) > 0) {
      order[j + 1] = order[j];
      --j;
    }
    order[j + 1] = cur;
  }
  for (int i = 0; i < n; ++i) g_vals[i] = order[i];
  return n;
}

// Searches the flags buffer. fall = 1 looks for 1 then 0, fall = 0 for 0 then 1.
// sum: 0 index (-1 none), 1 within the hour, 2 started unknown.
EMSCRIPTEN_KEEPALIVE int eng_next_transition(int count, int ref, int fall) {
  if (!valid_count(count)) return -1;
  const double before = fall ? 1.0 : 0.0;
  const double after = fall ? 0.0 : 1.0;
  g_sum[0] = -1.0;
  g_sum[1] = 0.0;
  g_sum[2] = (ref >= 0 && ref < count && g_flags[ref] == -1.0) ? 1.0 : 0.0;
  int start = ref + 1;
  if (start < 1) start = 1;
  for (int i = start; i < count; ++i) {
    if (g_flags[i] == after && g_flags[i - 1] == before) {
      g_sum[0] = i;
      g_sum[1] = (i == ref + 1) ? 1.0 : 0.0;
      return 0;
    }
  }
  return 0;
}

}  // extern "C"