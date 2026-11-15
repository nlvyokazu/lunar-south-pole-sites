// Sun-disk visibility above a terrain horizon, one value per sample.
// Same formula as lit_fraction() in scripts/make_bundle.py:
//   x = clip((sunAlt - (horizon + offset)) / sunRadius, -1, 1)
//   lit = 0.5 + (x * sqrt(1 - x^2) + asin(x)) / pi
// All values are degrees and doubles. No allocation, no SIMD, no intrinsics.
#include <cmath>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {
constexpr int kCapacity = 10000;
constexpr double kPi = 3.14159265358979323846;
alignas(64) double g_alt[kCapacity];
alignas(64) double g_hor[kCapacity];
alignas(64) double g_rad[kCapacity];
alignas(64) double g_out[kCapacity];
}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uintptr_t lit_alt_ptr() { return reinterpret_cast<uintptr_t>(g_alt); }
EMSCRIPTEN_KEEPALIVE uintptr_t lit_hor_ptr() { return reinterpret_cast<uintptr_t>(g_hor); }
EMSCRIPTEN_KEEPALIVE uintptr_t lit_rad_ptr() { return reinterpret_cast<uintptr_t>(g_rad); }
EMSCRIPTEN_KEEPALIVE uintptr_t lit_out_ptr() { return reinterpret_cast<uintptr_t>(g_out); }
EMSCRIPTEN_KEEPALIVE int lit_capacity() { return kCapacity; }

// Returns count, -1 for a bad count, -2 for a non-finite offset.
// A sample with a non-finite input or a radius <= 0 gives NaN, never a number.
EMSCRIPTEN_KEEPALIVE int lit_compute(int count, double offset_deg) {
  if (count < 0 || count > kCapacity) return -1;
  if (!std::isfinite(offset_deg)) return -2;
  for (int i = 0; i < count; ++i) {
    const double a = g_alt[i], h = g_hor[i], r = g_rad[i];
    if (!std::isfinite(a) || !std::isfinite(h) || !std::isfinite(r) || !(r > 0.0)) {
      g_out[i] = std::nan("");
      continue;
    }
    double x = (a - (h + offset_deg)) / r;
    if (x > 1.0) x = 1.0;
    if (x < -1.0) x = -1.0;
    g_out[i] = 0.5 + (x * std::sqrt(1.0 - x * x) + std::asin(x)) / kPi;
  }
  return count;
}

}  // extern "C"
