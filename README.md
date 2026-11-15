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

Geometry only. There is no power, thermal, panel or antenna model. A passing
result means the site meets the thresholds you set, nothing more. The rank column
only orders the sites by fixed rules and is not a recommendation.

## Where the code runs

- `engine/engine.cpp` is the calculation engine, written in C++ and compiled to
  WebAssembly. In the browser it computes Sun-disc visibility, Sun and Earth flags,
  windows, percentages, threshold checks, ranking and the next sunset and Earthset.
- `src/engine.ts` loads the engine and moves data in and out of its memory.
- `src/main.ts` is the page. It reads inputs, formats dates and draws the table.
- `src/model.ts` is a TypeScript copy of the same logic. It is the fallback if the
  engine does not load, and the reference the engine is tested against.
- At start-up the page runs the engine at margin 0 and compares the Sun output with
  the precomputed data. If the engine fails to load or the check fails, the page
  says so, disables the margin slider and uses `src/model.ts` with the precomputed
  Sun values at margin 0.
- `engine/lit_kernel.cpp` is an earlier, smaller C++ kernel (Sun-disc visibility
  only). The page does not load it. It is kept for tests.
- The data in `public/data/bundle.json` is made offline by Python scripts in
  `scripts/`. That part is Python, not C++. The page loads the result as a fixed
  file.

## Layout

- `src/` TypeScript page, engine wrapper and the TypeScript model
- `engine/` C++ sources and the Node test for the earlier kernel
- `public/engine/` built WebAssembly and loader files used by the page
- `public/data/bundle.json` hourly Sun and Earth geometry for all three sites
- `horizon/` terrain horizon masks, one per site
- `scripts/` offline Python data scripts, plus the bundle validator
- `test/` model tests and engine tests

## Regenerating the data

Needs Python with numpy and spiceypy, Node 22, and Emscripten 6.0.11. The versions
installed on the development machine are Python 3.12.10, spiceypy 8.3.0 and
numpy 2.5.4. The SPICE kernels and the elevation model are not in this repository.
Download them from the sources below.

    python scripts/make_horizon.py --dem LDEM_75S_120M.IMG --out horizon
    python scripts/make_bundle.py --kernels KERNELS_DIR --horizon horizon --out public/data/bundle.json

make_bundle.py checks the size and SHA-256 of every kernel before it runs.

Build the engine (optional, the built files are committed):

    emcc engine/engine.cpp -std=c++20 -O3 -fno-exceptions -fno-rtti -fno-math-errno -DNDEBUG -Wall -Wextra -Wpedantic --no-entry -o public/engine/engine.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngine -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=8MB -sEXPORTED_RUNTIME_METHODS=HEAPF64

Build the earlier kernel (optional, used only by tests):

    emcc engine/lit_kernel.cpp -std=c++20 -O3 -fno-exceptions -fno-rtti -fno-math-errno -DNDEBUG -Wall -Wextra -Wpedantic --no-entry -o public/engine/lit_kernel.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLit -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=8MB -sEXPORTED_RUNTIME_METHODS=HEAPF64

Checks:

    node engine/test_lit.mjs
    npm run test:model
    npm run test:engine
    npm run check
    npm run build

## What the tests show

The C++ engine, the TypeScript model and the tests were all written to the same
specification, with AI help (see below). The tests show that the engine, the
TypeScript model and the precomputed data agree with each other. They are not an
independent check of the astronomy. The numbers have not been compared with JPL
Horizons output by this project.

## Files and SHA-256

Text files are hashed as stored in Git, with LF line endings. A Windows checkout
with `core.autocrlf=true` has CRLF in the working copy and gives different hashes.
To check one, use `git show HEAD:PATH | sha256sum`. The `.wasm` files are binary.
Nobody has tested whether they rebuild byte for byte from the sources.

| File | SHA-256 |
| --- | --- |
| `public/data/bundle.json` | `d48d87e5d212e9e075290d328dab7b07a3a50396d63617bdb7dca783f6db5bff` |
| `horizon/malapert_a_horizon.json` | `3d83069b55839b85383f3ed4988015d785e00f912380aa7937f2dc797c7128bb` |
| `horizon/nobile_w_horizon.json` | `0a24a8fcc0eea3476fddbef7efd529867150f9079d160b1a473063af503e2332` |
| `horizon/amundsen_horizon.json` | `e54b32a6364379a4b71086779ac6d83fddeb0461da72dd71cac9fe3002ffda09` |
| `engine/engine.cpp` | `43ef7c1be47c8506e3edfcfe733b119202e473252801337f66b337b53b4792ea` |
| `public/engine/engine.mjs` | `ac8424f3211c82ee8d5dc404aa717df85a2e182c451e1b6a2190e1f985e82e56` |
| `public/engine/engine.wasm` | `85fe1b241166401fc462a595d5534ec87b6b904f5592f7cfdb8ed273a91992ed` |
| `engine/lit_kernel.cpp` | `ca668fddfa17e566b085b7faa1e3b8cb0f1b9bf94ca56e87845be3c731b25bc4` |
| `public/engine/lit_kernel.mjs` | `8b70c66a1c2a2376b88ffa9335fe397369742114b96d9ce16a8cbb39646429fe` |
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
  SHA-256 of the IMG file used: `ae3afc3c75c33d43666ca06c83ca08f0b12ef03b7d36d2d791d972730794391b`
  https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/

Tools: Emscripten 6.0.11 (a0014542110d6078c3a1a7941fa1ddb3a2281f16),
Node 22, TypeScript, Vite, Python, numpy, spiceypy.

## Method notes

- Hourly samples for 365 days starting 2026-11-15 00:00 UTC.
- Sun-visible means at least half of the Sun's disk is above the horizon. The Sun's
  apparent radius is computed for each hour, and the visible fraction uses the usual
  circular-segment formula.
- Earth-in-view means the centre of the Earth is above the horizon.
- The horizon margin slider raises both horizons by the chosen number of degrees.
- Horizon masks: 720 azimuths at 0.5 degree steps, scanned from 0.12 km to 150 km.
- Windows that touch a range edge are shown with a leading ">=".
- Aberration is applied at the Moon's centre only. Site rotation is not modelled.

Known limits are listed on the limits page in the site itself.

## AI use

Most of the code in this project was written with AI chat assistants, including
Claude and ChatGPT. That covers the C++ engine, the TypeScript page, the Python data
scripts and the tests. The team chose the scope and the three sites, and ran every
command and test on its own machine.