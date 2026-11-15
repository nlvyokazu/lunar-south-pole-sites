# Lunar south pole site comparison

A static web page that compares three sites near the lunar south pole for two
things only: how much of the year the Sun is above the local terrain horizon, and
how much of the year the Earth is above it. You set a date range, a horizon margin
and your own thresholds, and the table shows which sites meet them.

Sites (fixed, no custom coordinates):

- Malapert A rim, 80.13 S, 1.44 E
- Nobile Crater west rim, 85.43 S, 31.32 E
- Amundsen area, 88.5 S, 124.0 E (supplied by the team and not checked against a
  published crater position, so read the label as "near Amundsen")

Geometry only. There is no power, thermal, panel or antenna model, and a passing
result means the site meets the thresholds you set, nothing more.

## Layout

- `src/` TypeScript page and the pure logic it uses
- `engine/` C++ source for the Sun-visibility kernel, plus its Node test
- `public/engine/` the built kernel (WebAssembly plus loader) used by the page
- `public/data/bundle.json` hourly Sun and Earth geometry for all three sites
- `horizon/` terrain horizon masks, one per site
- `scripts/` data pipeline: terrain masks, bundle generator, validator
- `test/` model tests

## Regenerating the data

Requires Python 3.12 with numpy and spiceypy, Node 22, and Emscripten 6.0.11.
The SPICE kernels and the elevation model are not in this repository; download
them from the sources below.

    python scripts/make_horizon.py --dem LDEM_75S_120M.IMG --out horizon
    python scripts/make_bundle.py --kernels KERNELS_DIR --horizon horizon --out public/data/bundle.json

make_bundle.py checks the size and SHA-256 of every kernel before it runs.

Build the WebAssembly kernel (optional, the built files are committed):

    emcc engine/lit_kernel.cpp -std=c++20 -O3 -fno-exceptions -fno-rtti -fno-math-errno -DNDEBUG -Wall -Wextra -Wpedantic --no-entry -o public/engine/lit_kernel.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLit -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=8MB -sEXPORTED_RUNTIME_METHODS=HEAPF64

Checks:

    node engine/test_lit.mjs
    npm run test:model
    npm run check
    npm run build

## Files and SHA-256

| File | SHA-256 |
| --- | --- |
| `public/data/bundle.json` | `d48d87e5d212e9e075290d328dab7b07a3a50396d63617bdb7dca783f6db5bff` |
| `horizon/malapert_a_horizon.json` | `3d83069b55839b85383f3ed4988015d785e00f912380aa7937f2dc797c7128bb` |
| `horizon/nobile_w_horizon.json` | `0a24a8fcc0eea3476fddbef7efd529867150f9079d160b1a473063af503e2332` |
| `horizon/amundsen_horizon.json` | `e54b32a6364379a4b71086779ac6d83fddeb0461da72dd71cac9fe3002ffda09` |
| `engine/lit_kernel.cpp` | `ca668fddfa17e566b085b7faa1e3b8cb0f1b9bf94ca56e87845be3c731b25bc4` |
| `public/engine/lit_kernel.mjs` | `b65bb7daa9cff079dbb41cfee542cb5e0bf4e6a3bc21a08d3f42b765adb8406d` |
| `public/engine/lit_kernel.wasm` | `ecdef1da5802fcf09fa5f7229565866ec9385758a4f18517c08ee55bd59b8ef3` |

## Sources

Positions, read with spiceypy:

- `de440s.bsp`, JPL NAIF planetary ephemeris, 32726016 bytes
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/
- `naif0012.tls`, leap seconds, 4953 bytes
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/
- `moon_pa_de440_200625.bpc`, lunar orientation, 12863488 bytes
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/
- `moon_de440_250416.tf`, frame definitions, 19478 bytes
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/

Terrain:

- LRO LOLA `LDEM_75S_120M`, 7624 x 7624 pixels, 120 m per pixel, 16 bit signed,
  scale 0.5 m, offset 1737400 m, polar stereographic centred on the south pole.
  PDS product LRO-L-LOLA-4-GDR-V1.0, version 2.0.
  https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/

Tools: Emscripten 6.0.11 (a0014542110d6078c3a1a7941fa1ddb3a2281f16),
Node 22, Python 3.12, numpy, spiceypy 8.3.0, Vite.

## Method notes

- Hourly samples for 365 days starting 2026-11-15 00:00 UTC.
- Sun-visible means at least half of the Sun's disk is above the horizon. The Sun's
  apparent radius is computed for each hour, and the visible fraction uses the usual
  circular-segment formula.
- Earth-in-view means the centre of the Earth is above the horizon.
- The horizon margin slider raises both horizons by the chosen number of degrees.
- Horizon masks: 720 azimuths at 0.5 degree steps, scanned from 0.12 km to 150 km.
- Windows that touch a range edge are shown with a leading ">=".

Known limits are listed on the limits page in the site itself.
