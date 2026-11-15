#!/usr/bin/env python3
"""Generate public/data/bundle.json for the lunar south-pole site comparison tool.

Geometry only: Sun and Earth elevation/azimuth seen from three fixed points on a
spherical Moon (R = 1737.4 km), against an optional terrain-horizon mask.
No refraction, no power/thermal/antenna model, no custom coordinates.

    python make_bundle.py --selftest
    python make_bundle.py --kernels DIR --out PATH [--horizon DIR]
                          [--start 2026-11-15T00:00:00] [--days 365]
                          [--step-hours 1] [--generated-utc STRING]

Exit codes: 0 ok, 1 hard failure, 2 usage / kernel / frame error.
Needs Python 3, numpy, and (kernel path only) spiceypy.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import io
import json
import math
import os
import sys
import tempfile

import numpy as np

R_MOON = 1737.4
SUN_RADIUS_KM = 695700.0
EARTH_RADIUS_KM = 6371.0
FRAME = "MOON_ME_DE440_ME421"
NO_HORIZON = "none (flat 0 deg horizon)"
COORD_NOTE = "user-reported, unverified; treated as Mean Earth (ME) coordinates"

SITES = (
    ("malapert_a", "Malapert A rim", -80.13, 1.44),
    ("nobile_w", "Nobile Crater W rim", -85.43, 31.32),
    ("amundsen", "Amundsen rim", -88.5, 124.0),
)

KERNELS = (  # (file name, size in bytes, SHA-256)
    ("naif0012.tls", 4953,
     "8fc8e2885c4d8b6c50019e469329d9db7e35edd249e5c8cd7d461ec9d9054399"),
    ("de440s.bsp", 32726016,
     "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"),
    ("moon_pa_de440_200625.bpc", 12863488,
     "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f"),
    ("moon_de440_250416.tf", 19478,
     "a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768"),
)


class Fail(Exception):
    """Fatal error; .code is the process exit code (1 hard failure, 2 usage/kernel)."""

    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class HorizonError(ValueError):
    """A horizon file was rejected."""


# ----------------------------------------------------------------- small helpers
def fmt_t(d):
    """UTC datetime -> 'YYYY-MM-DDTHH:MM:SS.000' (no timezone suffix)."""
    return d.strftime("%Y-%m-%dT%H:%M:%S") + ".000"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_file(path, size, sha):
    """None if the file has exactly this size and SHA-256, else a message."""
    if not os.path.isfile(path):
        return "missing"
    actual = os.path.getsize(path)
    if actual != size:
        return f"size {actual} B, expected {size} B"
    got = sha256_file(path)
    if got != sha:
        return f"SHA-256 {got}, expected {sha}"
    return None


def dumps(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _r5(a):
    return np.round(a, 5) + 0.0  # + 0.0 turns -0.0 into 0.0


def _az5(a):
    r = np.round(a, 5)
    r[r >= 360.0] = 0.0  # 359.999996 rounds to 360.0, which must be 0.0
    return r + 0.0


def _isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# -------------------------------------------------------------------- geometry
def enu_basis(lat_deg, lon_deg):
    """Site vector (km, ME frame) and its unit up/east/north vectors."""
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    s = R_MOON * np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    up = s / np.linalg.norm(s)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    north = np.cross(up, east)
    return s, up, east, north


def alt_az(d, up, east, north):
    """Altitude and azimuth (deg, az from north clockwise, in [0,360)) of vectors d (N,3)."""
    d = np.asarray(d, dtype=float).reshape(-1, 3)
    alt = np.degrees(np.arcsin(np.clip(d @ up / np.linalg.norm(d, axis=1), -1.0, 1.0)))
    az = np.degrees(np.arctan2(d @ east, d @ north)) % 360.0
    return alt, az


def lit_fraction(x):
    """Fraction of the Sun disc above the horizon line; x = centre height / angular radius."""
    x = np.clip(x, -1.0, 1.0)
    return 0.5 + (x * np.sqrt(1.0 - x * x) + np.arcsin(x)) / np.pi


def find_windows(flags, t):
    """Maximal runs of True; 'end' is the LAST sample of the run (inclusive)."""
    f = np.asarray(flags, dtype=bool)
    n, out, i = len(f), [], 0
    while i < n:
        if not f[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and f[j + 1]:
            j += 1
        out.append({"start": t[i], "end": t[j], "samples": j - i + 1,
                    "whole_span": i == 0 and j == n - 1})
        i = j + 1
    return out


# --------------------------------------------------------------------- horizon
class Horizon:
    """Terrain mask for one site; Horizon() is the flat 0 deg horizon (not real)."""

    def __init__(self, mask=None, step=None, source=None, sha=None, name=None, h_site_m=None):
        self.mask, self.step, self.source = mask, step, source
        self.sha, self.name, self.h_site_m = sha, name, h_site_m

    @property
    def real(self):
        return self.mask is not None

    def at(self, az):
        """Mask elevation (deg) at azimuth(s) az: linear, periodic. Flat -> 0.0."""
        az = np.asarray(az, dtype=float)
        if not self.real:
            return np.zeros_like(az)
        pos = (az % 360.0) / self.step
        i0 = np.floor(pos).astype(int)
        f = pos - i0
        n = len(self.mask)
        return self.mask[i0 % n] * (1.0 - f) + self.mask[(i0 + 1) % n] * f


def _check_site_match(doc, key, label, lat, lon, path):
    holders = [doc]
    site = doc.get("site")
    if isinstance(site, dict):
        holders.append(site)
    elif isinstance(site, str) and site.strip().lower() not in (key.lower(), label.lower()):
        raise HorizonError(f"{path}: site {site!r} does not match {key!r}")
    for h in holders:
        for k, want in (("lat_deg", lat), ("lon_deg", lon)):
            if k in h:
                v = h[k]
                if not _isnum(v) or not math.isfinite(v) or abs(v - want) >= 1e-6:
                    raise HorizonError(f"{path}: {k}={v!r} does not match site {key} ({want})")


def horizon_from_doc(doc, path, sha, key, label, lat, lon):
    """Parsed horizon JSON -> Horizon. Raises HorizonError if a real mask is invalid."""
    if not isinstance(doc, dict):
        raise HorizonError(f"{path}: top level is not a JSON object")
    src = doc.get("source")
    if not (isinstance(src, str) and src.strip()
            and "synthetic" not in src.lower() and "placeholder" not in src.lower()):
        print(f"WARNING: {path} is synthetic/placeholder, ignored, flat 0 deg horizon used")
        return Horizon()
    missing = [k for k in ("n_az", "az_step_deg", "mask_deg") if k not in doc]
    if missing:
        raise HorizonError(f"{path}: missing required key(s) {missing}")
    n, step, mask = doc["n_az"], doc["az_step_deg"], doc["mask_deg"]
    if not _isnum(n) or not float(n).is_integer() or n < 1:
        raise HorizonError(f"{path}: n_az must be a positive integer, got {n!r}")
    n = int(n)
    if not _isnum(step) or not math.isfinite(step) or step <= 0:
        raise HorizonError(f"{path}: az_step_deg must be a positive finite number, got {step!r}")
    if abs(n * step - 360.0) >= 1e-9:
        raise HorizonError(f"{path}: n_az*az_step_deg = {n * step} != 360")
    if not isinstance(mask, list) or len(mask) != n:
        got = len(mask) if isinstance(mask, list) else type(mask).__name__
        raise HorizonError(f"{path}: mask_deg must be a list of n_az={n} values, got {got}")
    if not all(_isnum(v) for v in mask):
        raise HorizonError(f"{path}: mask_deg has a null / non-numeric value")
    m = np.array(mask, dtype=float)
    if not np.isfinite(m).all():
        raise HorizonError(f"{path}: mask_deg has NaN or inf")
    if (np.abs(m) > 90.0).any():
        raise HorizonError(f"{path}: mask_deg has a value outside -90..90")
    _check_site_match(doc, key, label, lat, lon, path)
    if "valid_azimuths" in doc and doc["valid_azimuths"] != n:
        print(f"WARNING: {path} valid_azimuths != n_az "
              "(confirm what the mask holds at invalid azimuths)")
    h = doc.get("h_site_m")
    if "h_site_m" in doc and not (_isnum(h) and math.isfinite(h)):
        print(f"WARNING: {path} h_site_m is not a finite number, not recorded")
        h = None
    return Horizon(m, float(step), src, sha, os.path.basename(path), h)


def load_horizons(hdir):
    """{site key: Horizon} from DIR/<key>_horizon.json (flat horizon where absent)."""
    out = {}
    for key, label, lat, lon in SITES:
        if hdir is None:
            out[key] = Horizon()
            continue
        path = os.path.join(hdir, key + "_horizon.json")
        if not os.path.isfile(path):
            print(f"NOTE: {path} not found, flat 0 deg horizon used for {key}")
            out[key] = Horizon()
            continue
        with open(path, "rb") as f:
            raw = f.read()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except ValueError as e:
            raise HorizonError(f"{path}: not valid JSON ({e})")
        out[key] = horizon_from_doc(doc, path, hashlib.sha256(raw).hexdigest(), key, label, lat, lon)
    return out


# ------------------------------------------------------------- series + bundle
def check_series(t, arrays):
    """Hard-failure checks (exit 1) on the rounded series that go into the file."""
    n, errs = len(t), []
    if any(t[i] >= t[i + 1] for i in range(n - 1)):
        errs.append("t is not strictly ascending")
    for name, a in arrays.items():
        a = np.asarray(a, dtype=float)
        if len(a) != n:
            errs.append(f"{name}: length {len(a)} != {n}")
            continue
        if not np.isfinite(a).all():
            errs.append(f"{name}: NaN or inf")
            continue
        lo, hi, hi_open = ((0.0, 1.0, False) if name == "lit"
                           else (0.0, 360.0, True) if name.endswith("Az")
                           else (-90.0, 90.0, False))
        if (a < lo).any() or ((a >= hi).any() if hi_open else (a > hi).any()):
            errs.append(f"{name}: value outside [{lo}, {hi}{')' if hi_open else ']'}")
    if errs:
        raise Fail(1, "; ".join(errs))


def site_series(key, label, lat, lon, t, sun_me, earth_me, hor, step_hours):
    """One site's bundle entry plus printable diagnostics."""
    for name, v in (("Sun", sun_me), ("Earth", earth_me)):
        if v.shape != (len(t), 3) or not np.isfinite(v).all():
            raise Fail(1, f"{key}: {name} vectors have the wrong shape or contain NaN/inf")
    s, up, east, north = enu_basis(lat, lon)
    d_sun, d_earth = sun_me - s, earth_me - s  # topocentric
    sun_alt, sun_az = alt_az(d_sun, up, east, north)
    earth_alt, earth_az = alt_az(d_earth, up, east, north)
    r_sun = _r5(np.degrees(np.arcsin(SUN_RADIUS_KM / np.linalg.norm(d_sun, axis=1))))
    r_earth = np.degrees(np.arcsin(EARTH_RADIUS_KM / np.linalg.norm(d_earth, axis=1)))

    # round first, derive after
    sun_alt, earth_alt = _r5(sun_alt), _r5(earth_alt)
    sun_az, earth_az = _az5(sun_az), _az5(earth_az)
    sun_h, earth_h = _r5(hor.at(sun_az)), _r5(hor.at(earth_az))
    x = np.clip((sun_alt - sun_h) / r_sun, -1.0, 1.0)
    lit = np.round(lit_fraction(x), 6) + 0.0
    sunlit = lit >= 0.5
    comms = (earth_alt - earth_h) > 0

    check_series(t, {"sunAlt": sun_alt, "sunAz": sun_az, "sunHorizon": sun_h,
                     "earthAlt": earth_alt, "earthAz": earth_az, "earthHorizon": earth_h,
                     "lit": lit})

    site = {
        "label": label, "lat": lat, "lon": lon, "coordinates_note": COORD_NOTE, "t": t,
        "sunAlt": sun_alt.tolist(), "sunAz": sun_az.tolist(), "sunHorizon": sun_h.tolist(),
        "earthAlt": earth_alt.tolist(), "earthAz": earth_az.tolist(),
        "earthHorizon": earth_h.tolist(), "lit": lit.tolist(), "sunRadius": r_sun.tolist(),
        "windows": {"sunlit": find_windows(sunlit, t), "dark": find_windows(~sunlit, t),
                    "comms": find_windows(comms, t)},
        "horizon_is_placeholder": not hor.real,
        "horizon_source": hor.source if hor.real else NO_HORIZON,
    }
    if hor.real and hor.h_site_m is not None:
        site["h_site_m"] = hor.h_site_m

    colat = 90.0 - abs(lat)
    se_lon = np.arctan2(earth_me[:, 1], earth_me[:, 0])
    se_lon = math.degrees(math.atan2(np.sin(se_lon).sum(), np.cos(se_lon).sum()))
    rel = earth_alt - earth_h
    hrs = [float((rel > thr).sum()) * step_hours for thr in (-r_earth, 0.0, r_earth)]
    w = site["windows"]
    lines = [
        f"[{key}] {label} (lat {lat}, lon {lon} E), horizon: "
        + (f"real mask '{hor.source}'" if hor.real else "flat 0 deg"),
        f"  sunAlt   min {sun_alt.min():8.3f}  max {sun_alt.max():8.3f} deg",
        f"  earthAlt min {earth_alt.min():8.3f}  max {earth_alt.max():8.3f} deg",
        f"  Earth-in-view hours (earthAlt - earthHorizon > thr): thr=-r_E {hrs[0]:.1f} h"
        f" | thr=0 {hrs[1]:.1f} h | thr=+r_E {hrs[2]:.1f} h",
        f"  windows: sunlit {len(w['sunlit'])}, dark {len(w['dark'])}, comms {len(w['comms'])}",
        f"  eyeball: Sun peak expected about (90-|lat|) = {colat:.2f} +/- 1.54 deg"
        f" -> {colat - 1.54:.2f}..{colat + 1.54:.2f}; observed max sunAlt {sun_alt.max():.2f}",
        f"  eyeball: Earth centre about (90-|lat|)*cos(lon - sub-Earth lon {se_lon:.2f})"
        f" = {colat * math.cos(math.radians(lon - se_lon)):.2f} deg, libration swing up to"
        f" 6.7 deg; observed mean earthAlt {earth_alt.mean():.2f}"
        f" (range {earth_alt.min():.2f}..{earth_alt.max():.2f})",
    ]
    if np.abs(sun_alt).max() > colat + 1.7:
        lines.append(f"  WARNING: max |sunAlt| {np.abs(sun_alt).max():.2f} > (90-|lat|)+1.7"
                     f" = {colat + 1.7:.2f}")
    if earth_alt.max() > colat + 7.5:
        lines.append(f"  WARNING: max earthAlt {earth_alt.max():.2f} > (90-|lat|)+7.5"
                     f" = {colat + 7.5:.2f}")
    return site, lines


def build_meta(generated_utc, step_hours, toolkit, kernel_meta, hors):
    reals = [hors[k[0]].real for k in SITES]
    complete = all(reals)
    srcs = [hors[k[0]].source for k in SITES if hors[k[0]].real]
    if complete:
        hsrc = srcs[0] if len(set(srcs)) == 1 else "mixed: see sites.<key>.horizon_source"
    elif any(reals):
        hsrc = "partial: see sites.<key>.horizon_source"
    else:
        hsrc = NO_HORIZON
    return {
        "schema": 1, "generated_utc": generated_utc, "sites": [k[0] for k in SITES],
        "step_hours": int(step_hours) if float(step_hours).is_integer() else step_hours,
        "frame": FRAME, "radius_km": R_MOON,
        "ephemeris": f"DE440s (de440s.bsp), SPICE {toolkit}",
        "kernels": kernel_meta, "horizon_source": hsrc,
        "horizon_is_placeholder": not complete, "synthetic": False,
        "aberration": "LT+S at Moon centre; site rotation not modelled",
        "sun_radius_km": 695700, "sunlit_rule": "lit >= 0.5",
        "comms_rule": "earthAlt - earthHorizon > 0", "site_model": "sphere",
        "horizon_complete": complete,
        "horizon_files": [{"name": hors[k[0]].name, "sha256": hors[k[0]].sha}
                          for k in SITES if hors[k[0]].real],
    }


def build_bundle(t, sun_me, earth_me, hors, step_hours, generated_utc, toolkit, kernel_meta):
    sites, lines = {}, []
    for key, label, lat, lon in SITES:
        sites[key], ls = site_series(key, label, lat, lon, t, sun_me, earth_me,
                                     hors[key], step_hours)
        lines += ls
    meta = build_meta(generated_utc, step_hours, toolkit, kernel_meta, hors)
    return {"meta": meta, "sites": sites}, lines


# ----------------------------------------------------------------- kernel path
def verify_kernels(kdir):
    if not os.path.isdir(kdir):
        raise Fail(2, f"--kernels {kdir!r} is not a directory")
    bad = []
    for name, size, sha in KERNELS:
        problem = verify_file(os.path.join(kdir, name), size, sha)
        if problem:
            bad.append(f"  {name}: {problem}")
    if bad:
        raise Fail(2, "kernel check failed in " + repr(kdir) + ":\n" + "\n".join(bad))
    print("kernels OK: " + ", ".join(k[0] for k in KERNELS) + " (size and SHA-256 match)")
    return [{"name": name, "sha256": sha} for name, _, sha in KERNELS]


def spice_vectors(kdir, utc):
    """Moon-centre Sun and Earth vectors (km) in the ME frame for each UTC string."""
    try:
        import spiceypy as sp  # lazy: --selftest must not need it
    except ImportError:
        raise Fail(2, "spiceypy is not installed (pip install numpy spiceypy)")
    sp.kclear()
    try:
        for name, _, _ in KERNELS:  # exactly these four, nothing else
            sp.furnsh(os.path.join(kdir, name))
    except Exception as e:
        raise Fail(2, f"furnsh failed: {e}")
    if sp.ktotal("ALL") != len(KERNELS):
        raise Fail(2, f"ktotal('ALL') = {sp.ktotal('ALL')}, expected {len(KERNELS)}")
    if sp.namfrm(FRAME) == 0:
        raise Fail(2, f"frame {FRAME} is not defined by the loaded kernels")
    toolkit = sp.tkvrsn("TOOLKIT")
    sun, earth = np.empty((len(utc), 3)), np.empty((len(utc), 3))
    for i, s in enumerate(utc):
        try:
            et = sp.str2et(s)  # per epoch; never start et + TDB seconds
            rot = np.asarray(sp.pxform("J2000", FRAME, et))
            sun[i] = rot @ sp.spkpos("SUN", et, "J2000", "LT+S", "MOON")[0]
            earth[i] = rot @ sp.spkpos("EARTH", et, "J2000", "LT+S", "MOON")[0]
        except Exception as e:
            raise Fail(1, f"SPICE error at {s}: {e}")
    sp.kclear()
    return sun, earth, toolkit


def parse_start(s):
    try:
        d = dt.datetime.fromisoformat(s[:-1] if s.endswith("Z") else s)
    except ValueError:
        raise Fail(2, f"--start {s!r} is not an ISO UTC time like 2026-11-15T00:00:00")
    if d.tzinfo is not None or d.microsecond:
        raise Fail(2, "--start must be naive UTC with whole seconds")
    return d


def epochs(start, days, step_hours):
    step_s = round(step_hours * 3600)
    if step_hours <= 0 or step_s < 1 or abs(step_hours * 3600 - step_s) > 1e-6:
        raise Fail(2, "--step-hours must be a positive whole number of seconds")
    if days < 1 or (days * 86400) % step_s:
        raise Fail(2, "--days must be >= 1 and a whole number of steps")
    return [fmt_t(start + dt.timedelta(seconds=i * step_s)) for i in range(days * 86400 // step_s)]


def run(a):
    t = epochs(parse_start(a.start), a.days, a.step_hours)
    kernel_meta = verify_kernels(a.kernels)
    if a.horizon is not None and not os.path.isdir(a.horizon):
        raise Fail(2, f"--horizon {a.horizon!r} is not a directory")
    hors = load_horizons(a.horizon)
    print(f"accepted real horizon masks: {sum(h.real for h in hors.values())}/{len(SITES)}")
    sun_me, earth_me, toolkit = spice_vectors(a.kernels, t)
    gen = a.generated_utc or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle, lines = build_bundle(t, sun_me, earth_me, hors, a.step_hours, gen, toolkit, kernel_meta)
    print("\n".join(lines))
    print("note: Earth-in-front-of-Sun events (eclipses seen from the Moon) are not modelled")
    text = dumps(bundle)  # after rounding; allow_nan=False backstops NaN/inf
    folder = os.path.dirname(a.out)
    if folder:
        os.makedirs(folder, exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(text.encode("utf-8"))
    os.replace(tmp, a.out)
    size = os.path.getsize(a.out)
    print(f"wrote {a.out}: {size} bytes ({size / 1e6:.2f} MB), {len(t)} samples per site")
    return 0


# -------------------------------------------------------------------- selftest
def _ok(cond, msg=""):
    if not cond:
        raise AssertionError(msg or "check failed")


def _raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    raise AssertionError(f"expected {exc.__name__}")


def _capture(fn):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = fn()
    return r, buf.getvalue()


def _circ(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _doc(n=720, step=0.5, **kw):
    d = {"n_az": n, "az_step_deg": step, "mask_deg": [0.0] * n,
         "source": "LDEM_75S_120M v1 (test string)"}
    d.update(kw)
    return d


def _load(doc, key="malapert_a", label="Malapert A rim", lat=-80.13, lon=1.44):
    return horizon_from_doc(doc, "x_horizon.json", "0" * 64, key, label, lat, lon)


def _fake_vectors(n):
    """Smooth analytic Sun/Earth vectors, for exercising the pipeline without kernels."""
    k = np.arange(n)
    th, e = 2 * np.pi * k / (29.53 * 24), math.radians(1.54)
    sun = 1.496e8 * np.stack([math.cos(e) * np.cos(th), math.cos(e) * np.sin(th),
                              np.full(n, math.sin(e))], axis=1)
    b = np.radians(6.7) * np.sin(2 * np.pi * k / (27.2 * 24))
    lo = np.radians(7.0) * np.sin(2 * np.pi * k / (27.55 * 24))
    earth = 384400.0 * np.stack([np.cos(b) * np.cos(lo), np.cos(b) * np.sin(lo), np.sin(b)], axis=1)
    return sun, earth


def t_enu():
    for lat, lon in ((-85.0, 0.0), (-88.5, 124.0), (-80.13, 1.44), (-85.43, 31.32)):
        s, up, east, north = enu_basis(lat, lon)
        la, lo = math.radians(lat), math.radians(lon)
        _ok(np.allclose(east, [-math.sin(lo), math.cos(lo), 0.0], atol=1e-12), "east vs textbook")
        _ok(np.allclose(north, [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo),
                                math.cos(la)], atol=1e-12), "north vs textbook")
        alt, _ = alt_az(5000.0 * up, up, east, north)
        _ok(abs(alt[0] - 90.0) < 1e-5, f"up alt {alt[0]}")  # asin is ill-conditioned at 90 deg
        alt, az = alt_az(5000.0 * north, up, east, north)
        _ok(abs(alt[0]) < 1e-9 and _circ(az[0], 0.0) < 1e-9, f"north alt {alt[0]} az {az[0]}")
        alt, az = alt_az(5000.0 * east, up, east, north)
        _ok(abs(alt[0]) < 1e-9 and abs(az[0] - 90.0) < 1e-9, f"east alt {alt[0]} az {az[0]}")


def t_lit():
    _ok(abs(lit_fraction(1.0) - 1.0) < 1e-15 and abs(lit_fraction(0.0) - 0.5) < 1e-15
        and abs(lit_fraction(-1.0)) < 1e-15, "endpoints")
    v = lit_fraction(np.linspace(-1.0, 1.0, 2001))
    _ok((np.diff(v) >= 0).all(), "not monotonic")


def t_windows():
    t = [f"t{i}" for i in range(9)]
    w = find_windows([True] * 9, t)
    _ok(len(w) == 1 and w[0]["whole_span"] and w[0]["samples"] == 9, "all-true")
    _ok(find_windows([False] * 9, t) == [], "all-false")
    got = find_windows([0, 1, 1, 0, 1, 0, 1, 1, 1], t)
    _ok(got == [{"start": "t1", "end": "t2", "samples": 2, "whole_span": False},
                {"start": "t4", "end": "t4", "samples": 1, "whole_span": False},
                {"start": "t6", "end": "t8", "samples": 3, "whole_span": False}], "mixed")
    _ok(find_windows([1, 1, 0], t[:3])[0]["whole_span"] is False, "edge run")


def t_tformat():
    s = fmt_t(dt.datetime(2026, 11, 15))
    _ok(s == "2026-11-15T00:00:00.000" and not s.endswith("Z") and "+" not in s, s)


def t_sha():
    with tempfile.TemporaryDirectory() as d:
        p, data = os.path.join(d, "k.bin"), bytes(range(256)) * 40
        with open(p, "wb") as f:
            f.write(data)
        sha = hashlib.sha256(data).hexdigest()
        _ok(verify_file(p, len(data), sha) is None, "good file rejected")
        with open(p, "wb") as f:
            f.write(data[:100] + bytes([data[100] ^ 1]) + data[101:])
        _ok(verify_file(p, len(data), sha) is not None, "changed byte not detected")
        _ok(verify_file(os.path.join(d, "none"), 1, sha) == "missing", "missing")


def t_h_n_az():
    _raises(HorizonError, lambda: _load(_doc(720, 0.4)))


def t_h_length():
    _raises(HorizonError, lambda: _load(_doc(mask_deg=[0.0] * 719)))


def t_h_nan():
    bad = [0.0] * 720
    bad[5] = float("nan")
    _raises(HorizonError, lambda: _load(_doc(mask_deg=bad)))
    bad[5] = None
    _raises(HorizonError, lambda: _load(_doc(mask_deg=bad)))
    bad[5] = 91.0
    _raises(HorizonError, lambda: _load(_doc(mask_deg=bad)))


def t_h_extra():
    h = _load(_doc(extra_key={"a": 1}, other=[1, 2]))
    _ok(h.real and h.source == "LDEM_75S_120M v1 (test string)", "extra keys")


def t_h_3600():
    h = _load(_doc(3600, 0.1))
    _ok(h.real and len(h.mask) == 3600, "3600 bins")


def t_h_latlon():
    _raises(HorizonError, lambda: _load(_doc(lat_deg=-80.13, lon_deg=1.45)))
    _raises(HorizonError, lambda: _load(_doc(lat_deg=-80.0, lon_deg=1.44)))
    _ok(_load(_doc(lat_deg=-80.13, lon_deg=1.44)).real, "matching lat/lon rejected")


def t_h_periodic():
    m = (np.arange(720) * 0.1).tolist()
    h = _load(_doc(mask_deg=m))
    _ok(abs(float(h.at(359.75)) - 0.5 * (m[719] + m[0])) < 1e-12, "wrap interpolation")
    _ok(abs(float(h.at(0.25)) - 0.5 * (m[0] + m[1])) < 1e-12, "forward interpolation")
    _ok(abs(float(h.at(360.0)) - m[0]) < 1e-12
        and abs(float(h.at(-0.25)) - float(h.at(359.75))) < 1e-12, "az wrap")


def t_h_flat():
    h = Horizon()
    _ok(not h.real and (h.at(np.array([0.0, 123.4])) == 0.0).all(), "flat")
    meta = build_meta("x", 1, "T", [], {k[0]: h for k in SITES})
    _ok(meta["horizon_is_placeholder"] is True and meta["horizon_complete"] is False
        and meta["horizon_source"] == NO_HORIZON and meta["horizon_files"] == [], "no mask meta")


def t_h_synthetic():
    for src in ("Synthetic test mask", "my PLACEHOLDER", "", None):
        h, out = _capture(lambda: _load(_doc(source=src)))
        _ok(not h.real, f"source {src!r} accepted")
        _ok("is synthetic/placeholder, ignored, flat 0 deg horizon used" in out, "warning text")
    h, _ = _capture(lambda: _load(_doc(mask_deg=[5.0] * 720, source="synthetic")))
    _ok(not h.real and h.mask is None and h.at(10.0) == 0.0, "synthetic mask leaked")


def t_h_real():
    h = _load(_doc(source="LDEM_75S_120M v1 (test string)", h_site_m=12.5))
    _ok(h.real and h.h_site_m == 12.5, "real mask")


def t_h_valid_az():
    _, out = _capture(lambda: _load(_doc(valid_azimuths=700)))
    _ok("valid_azimuths != n_az (confirm what the mask holds at invalid azimuths)" in out, out)
    _, out = _capture(lambda: _load(_doc(valid_azimuths=720)))
    _ok("valid_azimuths" not in out, "spurious warning")


def t_hard_checks():
    t = [f"2026-11-15T{i:02d}:00:00.000" for i in range(4)]
    good = {"sunAlt": [0.0] * 4, "sunAz": [0.0, 90.0, 180.0, 359.99999], "lit": [0.0, 0.5, 1.0, 0.2]}
    check_series(t, good)
    cases = [
        ({**good, "sunAlt": [0.0, float("nan"), 0.0, 0.0]}, t),
        ({**good, "sunAlt": [0.0, float("inf"), 0.0, 0.0]}, t),
        ({**good, "sunAlt": [0.0] * 3}, t),
        ({**good, "lit": [0.0, 0.5, 1.1, 0.2]}, t),
        ({**good, "sunAz": [0.0, 90.0, 180.0, 360.0]}, t),
        ({**good, "sunAlt": [0.0, 0.0, 91.0, 0.0]}, t),
        (good, [t[0], t[1], t[1], t[3]]),
    ]
    for arrays, tt in cases:
        try:
            check_series(tt, arrays)
        except Fail as e:
            _ok(e.code == 1, "wrong exit code")
        else:
            raise AssertionError("hard failure not raised")


def t_meta():
    def hz(src):
        return Horizon(np.zeros(4), 90.0, src, "a" * 64, "f.json") if src else Horizon()
    cases = (({"malapert_a": "S", "nobile_w": "S", "amundsen": "S"}, "S", True, False),
             ({"malapert_a": "S", "nobile_w": "T", "amundsen": "S"},
              "mixed: see sites.<key>.horizon_source", True, False),
             ({"malapert_a": "S", "nobile_w": None, "amundsen": None},
              "partial: see sites.<key>.horizon_source", False, True),
             ({"malapert_a": None, "nobile_w": None, "amundsen": None}, NO_HORIZON, False, True))
    for srcs, want, complete, placeholder in cases:
        m = build_meta("g", 1, "T", [], {k: hz(v) for k, v in srcs.items()})
        _ok(m["horizon_source"] == want and m["horizon_complete"] is complete
            and m["horizon_is_placeholder"] is placeholder, f"{srcs} -> {m['horizon_source']}")


def t_pipeline():
    n = 72
    t = [fmt_t(dt.datetime(2026, 11, 15) + dt.timedelta(hours=i)) for i in range(n)]
    sun, earth = _fake_vectors(n)
    kern = [{"name": k[0], "sha256": k[2]} for k in KERNELS]
    flat = {k[0]: Horizon() for k in SITES}
    b1, _ = build_bundle(t, sun, earth, flat, 1, "GEN", "TEST", kern)
    b2, _ = build_bundle(t, sun, earth, flat, 1, "GEN", "TEST", kern)
    _ok(dumps(b1) == dumps(b2), "not deterministic")
    meta_keys = {"schema", "generated_utc", "sites", "step_hours", "frame", "radius_km", "ephemeris",
                 "kernels", "horizon_source", "horizon_is_placeholder", "synthetic", "aberration",
                 "sun_radius_km", "sunlit_rule", "comms_rule", "site_model", "horizon_complete",
                 "horizon_files"}
    site_keys = {"label", "lat", "lon", "coordinates_note", "t", "sunAlt", "sunAz", "sunHorizon",
                 "earthAlt", "earthAz", "earthHorizon", "lit", "sunRadius", "windows",
                 "horizon_is_placeholder", "horizon_source"}
    _ok(set(b1["meta"]) == meta_keys, set(b1["meta"]) ^ meta_keys)
    _ok(all(set(s) == site_keys for s in b1["sites"].values()), "site keys")
    _ok(b1["meta"]["sites"] == ["malapert_a", "nobile_w", "amundsen"], "site order")
    real = dict(flat)
    real["amundsen"] = Horizon(np.full(720, 1.0), 0.5, "SRC", "b" * 64, "amundsen_horizon.json", 3.0)
    b3, _ = build_bundle(t, sun, earth, real, 1, "GEN", "TEST", kern)
    _ok("h_site_m" in b3["sites"]["amundsen"] and "h_site_m" not in b3["sites"]["malapert_a"], "h_site_m")
    _ok(b3["meta"]["horizon_source"].startswith("partial") and b3["meta"]["horizon_files"]
        == [{"name": "amundsen_horizon.json", "sha256": "b" * 64}], "partial meta")
    _ok(set(b3["sites"]["amundsen"]["sunHorizon"]) == {1.0}, "mask applied")


def t_kernel_table():
    _ok(len(KERNELS) == 4, "four kernels")
    for name, size, sha in KERNELS:
        _ok(len(sha) == 64 and set(sha) <= set("0123456789abcdef") and size > 0, name)


TESTS = (
    ("ENU basis: up alt 90, north alt 0 az 0, east az 90", t_enu),
    ("lit: x=+1 ->1, x=0 ->0.5, x=-1 ->0, monotonic", t_lit),
    ("windows: whole_span, empty, mixed, edge run", t_windows),
    ("t formatter has no timezone suffix", t_tformat),
    ("SHA-256 check detects one changed byte", t_sha),
    ("horizon: wrong n_az rejected", t_h_n_az),
    ("horizon: wrong length rejected", t_h_length),
    ("horizon: NaN / null / out-of-range rejected", t_h_nan),
    ("horizon: extra keys ignored", t_h_extra),
    ("horizon: 3600 bins x 0.1 deg accepted", t_h_3600),
    ("horizon: lat/lon mismatch rejected", t_h_latlon),
    ("horizon: periodic interpolation", t_h_periodic),
    ("horizon: no mask -> flat 0, placeholder true", t_h_flat),
    ("horizon: synthetic/placeholder source -> flat 0, placeholder true", t_h_synthetic),
    ("horizon: real source accepted", t_h_real),
    ("horizon: valid_azimuths warning", t_h_valid_az),
    ("hard-failure checks raise exit-1 errors", t_hard_checks),
    ("meta horizon_source: equal / mixed / partial / none", t_meta),
    ("pipeline on analytic vectors: deterministic, exact key sets", t_pipeline),
    ("kernel table well-formed (4 entries, 64-hex SHA-256)", t_kernel_table),
)


def selftest():
    failed = 0
    for name, fn in TESTS:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    if "spiceypy" in sys.modules:
        failed += 1
        print("FAIL selftest imported spiceypy")
    else:
        print("PASS selftest did not import spiceypy")
    print(f"selftest: {len(TESTS) + 1 - failed}/{len(TESTS) + 1} passed (no kernels were used)")
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate bundle.json (lunar south-pole sites).")
    ap.add_argument("--selftest", action="store_true", help="run built-in checks; no kernels needed")
    ap.add_argument("--kernels", help="directory holding the four required SPICE kernels")
    ap.add_argument("--out", help="output path, e.g. public/data/bundle.json")
    ap.add_argument("--horizon", help="directory with <site key>_horizon.json files (optional)")
    ap.add_argument("--start", default="2026-11-15T00:00:00", help="first epoch, UTC")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--step-hours", type=float, default=1.0)
    ap.add_argument("--generated-utc", help="override meta.generated_utc (for reproducible files)")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.kernels or not a.out:
        ap.error("--kernels and --out are required (or use --selftest)")
    try:
        return run(a)
    except Fail as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return e.code
    except HorizonError as e:
        print(f"ERROR: horizon file rejected: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
