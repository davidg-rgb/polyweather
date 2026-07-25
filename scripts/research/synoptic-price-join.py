"""
synoptic-price-join — first-pass obs↔price transmission study (2026-07-25).

Joins the 5-min Synoptic obs archive (out/synoptic-obs-archive/*.ndjson) to the
minute-fidelity Polymarket price archive (out/market-history/{city}/*.json) for
the 11 US cities, and asks the operator's question: does fresh obs data LEAD
Polymarket price moves, and by what lag — or is the market already ahead?

Two measurements, both honest about staleness (prices-history `p` only ticks on
trades; deltas are computed between actual ticks, levels are forward-filled):

  A. FLOOR-KILL event study. Each time the observed running max ADVANCES to a
     value that kills a bucket (bucket's upper bound < the new floor, native °F),
     measure that bucket's price in windows around the obs timestamp T:
     level at T−30m, and Δp over [T−30,T), [T,T+15), [T+15,T+60). If the market
     is faster than the 5-min print, the drop concentrates in the PRE window.
     Only kills where the bucket still had p ≥ 0.05 at T−30 count (a dead-priced
     bucket can't reveal timing).

  B. Winner-bucket lead-lag. Per city-day, 5-min grids over the obs local day:
     obs innovation = Δ(running max) clipped ≥ 0; price series = Δp of the
     eventual winning bucket. Pearson r at lags −60..+60 min (negative lag =
     price moves BEFORE the obs print). Pooled mean r per lag + argmax counts.

Usage: python scripts/research/synoptic-price-join.py
Output: RESULT {json} on the last line + a readable summary above it.
"""
from __future__ import annotations

import json
import math
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
OBS_DIR = ROOT / "out" / "synoptic-obs-archive"
MH_DIR = ROOT / "out" / "market-history"

CITY_STATION = {
    "atlanta": ("KATL", "America/New_York"),
    "austin": ("KAUS", "America/Chicago"),
    "chicago": ("KORD", "America/Chicago"),
    "dallas": ("KDAL", "America/Chicago"),
    "denver": ("KBKF", "America/Denver"),
    "houston": ("KHOU", "America/Chicago"),
    "los-angeles": ("KLAX", "America/Los_Angeles"),
    "miami": ("KMIA", "America/New_York"),
    "nyc": ("KLGA", "America/New_York"),
    "san-francisco": ("KSFO", "America/Los_Angeles"),
    "seattle": ("KSEA", "America/Los_Angeles"),
}

def c_to_f_native(c: float) -> int:
    return round(c * 9 / 5 + 32)

def parse_label_f(label: str) -> tuple[float, float]:
    """'67°F or below' → (-inf, 67); '68-69°F' → (68, 69); '80°F or higher' → (80, inf).
    NOTE: unsigned regex — in '78-79°F' the '-' is a range dash, not a minus (the
    signed variant read hi=-79 and 'killed' every range bucket at the first ob).
    Summer-only corpus; revisit for genuinely sub-zero °F labels."""
    nums = [int(n) for n in re.findall(r"\d+", label)]
    lo, hi = -math.inf, math.inf
    if "below" in label or "lower" in label:
        hi = nums[0]
    elif "higher" in label or "above" in label:
        lo = nums[0]
    elif len(nums) >= 2:
        lo, hi = nums[0], nums[1]
    elif nums:
        lo = hi = nums[0]
    return lo, hi

def load_obs() -> dict[str, list[tuple[int, float]]]:
    """icao → sorted [(epoch_s, temp_c)]."""
    out: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for f in sorted(OBS_DIR.glob("*.ndjson")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            t = int(datetime.fromisoformat(r["obs_at"].replace("Z", "+00:00")).timestamp())
            out[r["icao"]].append((t, float(r["temp_tenths_c"])))
    return {k: sorted(set(v)) for k, v in out.items()}

def price_series(points: list) -> list[tuple[int, float]]:
    """Points are [t, p] pairs (or {t, p} dicts in older pulls)."""
    if points and isinstance(points[0], dict):
        return sorted((int(p["t"]), float(p["p"])) for p in points)
    return sorted((int(p[0]), float(p[1])) for p in points)

def level_at(series: list[tuple[int, float]], t: int) -> float | None:
    """Forward-filled level at t (last tick ≤ t)."""
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= t:
            ans = series[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans

def main() -> None:
    obs_by_icao = load_obs()
    skip_b: dict[str, int] = defaultdict(int)
    kills = []          # per floor-kill event measurements
    lag_r: dict[int, list[float]] = defaultdict(list)   # lag_min → [r per city-day]
    argmax_lags = []
    n_events = 0

    for city, (icao, tzname) in CITY_STATION.items():
        tz = ZoneInfo(tzname)
        obs = obs_by_icao.get(icao, [])
        if not obs:
            continue
        for f in sorted((MH_DIR / city).glob("*.json")):
            ev = json.loads(f.read_text())
            # THE ARCHIVE TRAP (DATA-SOURCES.md): `targetDate` is the RESOLUTION
            # date; the WEATHER day lives in the slug ('…-on-july-23-2026').
            m = re.search(r"on-([a-z]+)-(\d+)-(\d{4})$", ev["slug"])
            if m:
                months = ["january","february","march","april","may","june","july",
                          "august","september","october","november","december"]
                target = f"{m.group(3)}-{months.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"
            else:
                target = (datetime.strptime(ev["targetDate"][:10], "%Y-%m-%d")
                          - timedelta(days=1)).strftime("%Y-%m-%d")
            # obs for the market's LOCAL day
            day_obs = [
                (t, c) for (t, c) in obs
                if datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d") == target
            ]
            if len(day_obs) < 24:   # need a real 5-min day (KBKF hourly still passes ≥24)
                continue
            n_events += 1
            buckets = [
                {**b, "range": parse_label_f(b["label"]), "series": price_series(b["points"])}
                for b in ev["buckets"]
            ]
            winner = next((b for b in buckets if b.get("resolvedOutcome") == "win"), None)

            # ── A. floor-kill events ─────────────────────────────────────────
            run_max_f = -math.inf
            for (t, c) in day_obs:
                f_nat = c_to_f_native(c)
                if f_nat <= run_max_f:
                    continue
                prev_max, run_max_f = run_max_f, f_nat
                for b in buckets:
                    lo, hi = b["range"]
                    if not (prev_max <= hi < run_max_f):   # newly killed by THIS advance
                        continue
                    # °C→°F rounding at bucket boundaries can fabricate a "kill" of the
                    # eventual winner — timing is only readable on true losers.
                    if b.get("resolvedOutcome") != "lose":
                        continue
                    s = b["series"]
                    p_pre30 = level_at(s, t - 1800)
                    if p_pre30 is None or p_pre30 < 0.05:
                        continue
                    p_at = level_at(s, t)
                    p_15 = level_at(s, t + 900)
                    p_60 = level_at(s, t + 3600)
                    if p_at is None or p_15 is None or p_60 is None:
                        continue
                    kills.append({
                        "city": city, "date": target, "label": b["label"],
                        "p_pre30": p_pre30,
                        "d_pre": p_at - p_pre30,        # [T−30, T)
                        "d_post15": p_15 - p_at,        # [T, T+15)
                        "d_15_60": p_60 - p_15,         # [T+15, T+60)
                    })

            # ── B. winner lead-lag on 5-min grids ───────────────────────────
            if winner is None:
                skip_b["no_winner"] += 1
                continue
            if len(winner["series"]) < 30:
                skip_b["thin_series"] += 1
                continue
            day0 = datetime.strptime(target, "%Y-%m-%d").replace(tzinfo=tz, hour=6)
            grid = [int((day0 + timedelta(minutes=5 * i)).timestamp()) for i in range(0, 18 * 12)]
            # obs innovation per bin (Δ running max ≥ 0, °F)
            run, innov, dprice = -math.inf, [], []
            oi = 0
            prev_p = None
            for g in grid:
                while oi < len(day_obs) and day_obs[oi][0] <= g:
                    run = max(run, c_to_f_native(day_obs[oi][1]))
                    oi += 1
                innov.append(run if math.isfinite(run) else 0.0)
                p = level_at(winner["series"], g)
                dprice.append(0.0 if (p is None or prev_p is None) else p - prev_p)
                prev_p = p
            d_innov = [max(0.0, innov[i] - innov[i - 1]) if i else 0.0 for i in range(len(innov))]
            # drop the first-obs jump from -inf→level (a level artifact, not an innovation)
            first_real = next((i for i, v in enumerate(d_innov) if v > 0), None)
            if first_real is not None:
                d_innov[first_real] = 0.0
            if sum(d_innov) == 0:
                skip_b["no_innovation"] += 1
                continue
            best_lag, best_r = None, -2.0
            for lag_bins in range(-12, 13):     # −60..+60 min
                a, b2 = [], []
                for i in range(len(grid)):
                    j = i + lag_bins
                    if 0 <= j < len(grid):
                        a.append(d_innov[i])
                        b2.append(dprice[j])
                if len(a) > 20 and statistics.pstdev(a) > 0 and statistics.pstdev(b2) > 0:
                    r = statistics.correlation(a, b2)
                    lag_r[lag_bins * 5].append(r)
                    if r > best_r:
                        best_r, best_lag = r, lag_bins * 5
            if best_lag is not None:
                argmax_lags.append(best_lag)

    # ── report ───────────────────────────────────────────────────────────────
    def med(xs):
        return statistics.median(xs) if xs else None

    pre = [k["d_pre"] for k in kills]
    post15 = [k["d_post15"] for k in kills]
    d1560 = [k["d_15_60"] for k in kills]
    print(f"city-day events joined: {n_events}")
    print(f"\nA. FLOOR-KILL events (bucket alive ≥5c at T−30): n={len(kills)}")
    if kills:
        print(f"   median level at T−30: {med([k['p_pre30'] for k in kills]):.3f}")
        print(f"   median Δp [T−30,T):   {med(pre):+.4f}   ← drop BEFORE the 5-min print = market faster")
        print(f"   median Δp [T,T+15):   {med(post15):+.4f}")
        print(f"   median Δp [T+15,T+60):{med(d1560):+.4f}")
        frac_pre = sum(1 for k in kills if k["d_pre"] < -0.01) / len(kills)
        frac_post = sum(1 for k in kills if k["d_post15"] + k["d_15_60"] < -0.01) / len(kills)
        print(f"   frac dropping ≥1c pre: {frac_pre:.2f} · post: {frac_post:.2f}")
    print(f"\nB. winner-bucket lead-lag: {len(argmax_lags)} city-days with obs innovations"
          f" (skips: {dict(skip_b)})")
    if argmax_lags:
        pooled = {lag: statistics.mean(rs) for lag, rs in sorted(lag_r.items()) if len(rs) >= 5}
        top = sorted(pooled.items(), key=lambda kv: -kv[1])[:5]
        print("   pooled mean r by lag (top 5):", [(lag, round(r, 3)) for lag, r in top])
        neg = sum(1 for l in argmax_lags if l < 0)
        pos = sum(1 for l in argmax_lags if l > 0)
        print(f"   argmax-lag: price-leads(<0): {neg} · obs-leads(>0): {pos} · zero: {len(argmax_lags)-neg-pos}")
        print(f"   median argmax lag: {med(argmax_lags)} min")
    print("\nRESULT " + json.dumps({
        "cityDays": n_events, "nKills": len(kills),
        "killMedianPre30": med(pre), "killMedianPost15": med(post15), "killMedian1560": med(d1560),
        "lagArgmaxMedian": med(argmax_lags), "nLagDays": len(argmax_lags),
    }))

if __name__ == "__main__":
    main()
