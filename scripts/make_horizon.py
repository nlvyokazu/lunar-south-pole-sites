#!/usr/bin/env python3
"""Horizon masks for the three sites from LOLA LDEM_75S_120M (PDS3 IMG).

Usage: python scripts/make_horizon.py --dem FILE.IMG --out DIR [--range-km 150] [--variant N]

For each site and each of 720 azimuths (0.5 deg, clockwise from north, north toward the
lunar north pole, east toward increasing longitude) it walks outward over the terrain and
keeps the highest elevation angle above the local horizontal plane of the site. Sphere
R = 1737.4 km plus DEM height, curvature included, no refraction.
Exit 0 ok, 2 check failed.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import sys

import numpy as np

R_M = 1737400.0
N = 7624
PX_M = 120.0
C0 = (N - 1) / 2.0  # pole position, 0-based pixel-centre coordinates (label offset 3811.5)
SCALE = 0.5
DN_MIN, DN_MAX = -15526, 14050  # from the label

VARIANTS = [
    ("u=x, v=y", lambda x, y: (x, y)),
    ("u=-x, v=y", lambda x, y: (-x, y)),
    ("u=x, v=-y", lambda x, y: (x, -y)),
    ("u=-x, v=-y", lambda x, y: (-x, -y)),
    ("u=y, v=x", lambda x, y: (y, x)),
    ("u=-y, v=x", lambda x, y: (-y, x)),
    ("u=y, v=-x", lambda x, y: (y, -x)),
    ("u=-y, v=-x", lambda x, y: (-y, -x)),
]

# Landmarks written from memory (IAU names, approximate): lat, lon east, diameter km.
CRATERS = [
    ("Haworth", -87.5, -5.0, 51), ("Shoemaker", -88.1, 44.9, 51),
    ("Faustini", -87.3, 77.0, 39), ("Amundsen", -84.5, 82.8, 105),
    ("Cabeus", -84.9, -35.5, 98), ("Nobile", -85.2, 53.3, 73),
    ("de Gerlache", -88.5, -87.1, 32), ("Sverdrup", -88.5, -152.0, 35),
]
MM = (-85.99, 0.12)  # Mons Malapert, approximate


def load_sites():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("make_bundle", os.path.join(here, "make_bundle.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [tuple(s) for s in mod.SITES]


def destination(lat_deg, lon_deg, az_deg, dist_m):
    lat1, lon1 = np.radians(lat_deg), np.radians(lon_deg)
    az, d = np.radians(az_deg), np.asarray(dist_m, dtype=float) / R_M
    sin2 = np.sin(lat1) * np.cos(d) + np.cos(lat1) * np.sin(d) * np.cos(az)
    lat2 = np.arcsin(np.clip(sin2, -1.0, 1.0))
    lon2 = lon1 + np.arctan2(np.sin(az) * np.sin(d) * np.cos(lat1), np.cos(d) - np.sin(lat1) * sin2)
    return np.degrees(lat2), np.degrees(lon2)


def to_rc(lat_deg, lon_deg, variant):
    rho = 2.0 * R_M * np.tan(np.radians(np.asarray(lat_deg) + 90.0) / 2.0)
    lam = np.radians(lon_deg)
    u, v = VARIANTS[variant][1](rho * np.sin(lam), rho * np.cos(lam))
    return C0 - v / PX_M, C0 + u / PX_M  # row, col


def height_m(dem, row, col):
    row = np.asarray(row, dtype=np.float64)
    col = np.asarray(col, dtype=np.float64)
    ok = (row >= 0) & (col >= 0) & (row <= N - 1) & (col <= N - 1)
    r0 = np.clip(np.floor(row), 0, N - 2).astype(np.int64)
    c0 = np.clip(np.floor(col), 0, N - 2).astype(np.int64)
    fr = np.clip(row - r0, 0.0, 1.0)
    fc = np.clip(col - c0, 0.0, 1.0)
    d00 = dem[r0, c0].astype(np.float64)
    d01 = dem[r0, c0 + 1].astype(np.float64)
    d10 = dem[r0 + 1, c0].astype(np.float64)
    d11 = dem[r0 + 1, c0 + 1].astype(np.float64)
    h = ((d00 * (1 - fc) + d01 * fc) * (1 - fr) + (d10 * (1 - fc) + d11 * fc) * fr) * SCALE
    return np.where(ok, h, np.nan)


def elev_deg(r_obs_m, h_target_m, s_m):
    d = np.asarray(s_m, dtype=float) / R_M
    rt = R_M + np.asarray(h_target_m, dtype=float)
    return np.degrees(np.arctan2(rt * np.cos(d) - r_obs_m, rt * np.sin(d)))


def say(ok, text):
    print(("PASS  " if ok else "FAIL  ") + text)
    return ok


def selfcheck(sites):
    ok = True
    e = float(elev_deg(R_M, 0.0, 100000.0))
    ok &= say(abs(e + math.degrees(100000.0 / R_M / 2)) < 1e-9, "flat sphere, 100 km: elevation = -(angle/2), got %.6f deg" % e)
    for ho, ht, s in [(0, 1000, 10000), (500, 3000, 80000), (2000, -1000, 40000)]:
        dl = s / R_M
        obs = np.array([0.0, 0.0, R_M + ho])
        tgt = (R_M + ht) * np.array([math.sin(dl), 0.0, math.cos(dl)])
        v = tgt - obs
        want = math.degrees(math.asin(v[2] / np.linalg.norm(v)))
        got = float(elev_deg(R_M + ho, ht, s))
        ok &= say(abs(got - want) < 1e-6, "3D vector check h_obs=%d h_t=%d s=%d km: %.6f vs %.6f" % (ho, ht, s // 1000, got, want))
    for key, label, lat, lon in sites:
        la, lo = destination(lat, lon, 180.0, 10000.0)
        ok &= say(float(la) < lat, "%s: azimuth 180 moves toward the south pole" % key)
        la, lo = destination(lat, lon, 90.0, 10000.0)
        ok &= say(float(lo) > lon, "%s: azimuth 90 moves toward increasing longitude" % key)
    return ok


def ring_mean(dem, lat, lon, rmin_km, rmax_km, variant):
    rad = np.linspace(rmin_km, rmax_km, 5) * 1000.0
    azs = np.arange(0.0, 360.0, 15.0)
    la, lo = destination(lat, lon, azs[:, None], rad[None, :])
    rr, cc = to_rc(la, lo, variant)
    h = height_m(dem, rr, cc)
    h = h[np.isfinite(h)]
    return float(h.mean()) if h.size else float("nan")


def landmark_results(dem, variant):
    res = []
    for name, lat, lon, dia in CRATERS:
        rim = ring_mean(dem, lat, lon, 0.44 * dia, 0.56 * dia, variant)
        floor = ring_mean(dem, lat, lon, 0.0, 0.2 * dia, variant)
        res.append((name + " (rim minus floor)", rim - floor, rim - floor > 500.0))
    peak = ring_mean(dem, MM[0], MM[1], 0.0, 8.0, variant)
    around = ring_mean(dem, MM[0], MM[1], 35.0, 55.0, variant)
    res.append(("Mons Malapert (peak minus surroundings)", peak - around, peak - around > 1000.0))
    return res


def choose_variant(dem, forced):
    passes = []
    for v in range(len(VARIANTS)):
        passes.append(sum(1 for r in landmark_results(dem, v) if r[2]))
    print("orientation check: landmarks passed out of %d, per map orientation" % (len(CRATERS) + 1))
    for v, p in enumerate(passes):
        print("  variant %d (%s): %d" % (v, VARIANTS[v][0], p))
    order = sorted(range(len(passes)), key=lambda i: -passes[i])
    best, second = order[0], order[1]
    if forced is not None:
        best = forced
        print("variant forced to %d" % best)
    elif not (passes[best] >= 7 and passes[best] - passes[second] >= 3):
        print("FAIL  no orientation is clearly right (need at least 7 passes and a lead of 3). Not writing files.")
        return None, passes
    for name, val, ok in landmark_results(dem, best):
        print("  %s %-42s %8.0f m" % ("ok  " if ok else "FAIL", name, val))
    return best, passes


def scan(dem, lat, lon, variant, range_km, step_m=60.0, start_m=120.0, n_az=720):
    azs = np.arange(n_az) * (360.0 / n_az)
    r_s, c_s = to_rc(lat, lon, variant)
    h_site = float(height_m(dem, r_s, c_s))
    if not math.isfinite(h_site):
        raise SystemExit("site is outside the DEM")
    s = np.arange(start_m, range_km * 1000.0 + 0.5 * step_m, step_m)
    la, lo = destination(lat, lon, azs[:, None], s[None, :])
    rr, cc = to_rc(la, lo, variant)
    ht = height_m(dem, rr, cc)
    el = elev_deg(R_M + h_site, ht, s[None, :])
    valid = np.isfinite(el)
    elf = np.where(valid, el, -np.inf)
    mask = elf.max(axis=1)
    if not np.isfinite(mask).all():
        raise SystemExit("some azimuths have no terrain samples")
    bad = ~valid
    first = np.where(bad.any(axis=1), bad.argmax(axis=1), valid.shape[1])
    covered_km = float((start_m + first.min() * step_m) / 1000.0)
    return azs, s, elf, mask, h_site, covered_km


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--range-km", type=float, default=150.0)
    ap.add_argument("--variant", type=int, default=None)
    args = ap.parse_args()

    sites = load_sites()
    print("== geometry self-checks")
    if not selfcheck(sites):
        return 2

    size = os.path.getsize(args.dem)
    if size != N * N * 2:
        print("FAIL  DEM size %d, expected %d" % (size, N * N * 2))
        return 2
    h = hashlib.sha256()
    with open(args.dem, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    sha = h.hexdigest()
    dem = np.fromfile(args.dem, dtype="<i2").reshape(N, N)
    print("== DEM %s sha256 %s" % (os.path.basename(args.dem), sha))
    if int(dem.min()) != DN_MIN or int(dem.max()) != DN_MAX:
        print("FAIL  DN range %d..%d does not match label" % (int(dem.min()), int(dem.max())))
        return 2

    print("== orientation")
    variant, _ = choose_variant(dem, args.variant)
    if variant is None:
        return 2

    os.makedirs(args.out, exist_ok=True)
    src = ("LRO LOLA GDR LDEM_75S_120M v2.0 (PDS3 LRO-L-LOLA-4-GDR-V1.0, IMG from imbrium.mit.edu, "
           "sha256 %s); horizon scan to %g km, bilinear, sphere R=1737.4 km" % (sha, args.range_km))
    for key, label, lat, lon in sites:
        azs, s, elf, mask, h_site, covered = scan(dem, lat, lon, variant, args.range_km)
        i = int(mask.argmax())
        print("[%s] DEM height at site %.1f m, scan %.2f..%.0f km every 60 m, 720 azimuths" % (key, h_site, s[0] / 1000, s[-1] / 1000))
        print("  mask min %.3f mean %.3f max %.3f deg; max at azimuth %.1f from terrain %.1f km away"
              % (mask.min(), mask.mean(), mask.max(), azs[i], s[int(elf[i].argmax())] / 1000))
        sens = []
        for r in (50, 100, 150):
            if r <= args.range_km:
                m = elf[:, s <= r * 1000.0].max(axis=1)
                sens.append("%d km: max %.3f mean %.3f" % (r, m.max(), m.mean()))
        print("  range sensitivity: " + " | ".join(sens))
        print("  mask at azimuth 0/90/180/270: %.3f / %.3f / %.3f / %.3f deg"
              % tuple(mask[int(a / 0.5)] for a in (0, 90, 180, 270)))
        if covered < args.range_km - 0.5:
            print("  WARNING: terrain data ends at %.1f km in some direction (range limited there)" % covered)
        edge = (s[elf.argmax(axis=1)] > (args.range_km - 3.0) * 1000.0).sum()
        if edge:
            print("  NOTE: %d azimuths have their highest terrain within 3 km of the range limit" % edge)
        doc = {"site": key, "lat_deg": lat, "lon_deg": lon, "n_az": 720, "az_step_deg": 0.5,
               "mask_deg": [round(float(v), 4) for v in mask], "valid_azimuths": 720,
               "h_site_m": round(h_site, 2), "source": src,
               "method": {"azimuth": "clockwise from north, north toward lunar north pole, east toward +longitude",
                          "map_orientation": VARIANTS[variant][0], "range_km": args.range_km,
                          "covered_range_km": covered, "step_m": 60.0, "start_m": 120.0,
                          "frame_note": "DEM label says Mean Earth / polar axis of DE421; bundle uses DE440 ME421, offset under 1 arcsec"}}
        path = os.path.join(args.out, key + "_horizon.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(doc, separators=(",", ":"), allow_nan=False))
        print("  wrote " + path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
