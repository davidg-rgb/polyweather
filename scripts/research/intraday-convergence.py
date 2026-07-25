"""
intraday-convergence — the MARKET + FLOOR halves of the Build-3 convergence read
(CITY-ORACLE-BUILDOUT Build 3; docs/INTRADAY-CONVERGENCE.md is the combined record).

Per resolved city-day in the live-distribution window (2026-06-13..07-24), at each
station-local hour h (6..23) of the RESOLUTION day, two Brier curves vs the resolved
winner:

  MARKET — the trade-print archive's implied distribution: forward-filled per-bucket
    mid LEVELS at h (ghost-quote law: a level read requires a print within 60 min;
    an event-hour is scored only when ≥ half its buckets have fresh levels),
    normalized to sum 1. ⚠ MID-BASIS (trap #1/#8) — descriptive scoring only,
    no executable claim.
  FLOOR — the zero-model baseline: uniform over the buckets still ALIVE under the
    IEM METAR rendered running max (a bucket is dead when its top < running max;
    the §resolution-oracle rendering, same code family as metar-kill-replay.py).

The HOUSE half (our house_gaussian, nowcast rebuilds included) cannot be computed
locally — distributions live only in bucket_probabilities — and the DB's
market_consensus is UNUSABLE for this read (poll-markets stops writing an event's
consensus before its resolution day — median forward-fill lag 15.5 h by local 23:00
— so its flat curve is censoring, NOT market behaviour; measured 2026-07-26). The
house curves in the doc come from the chunked scratch-table SQL recorded there.

Lock-in hour (both curves here): the first local hour h whose reverse running max
of Brier over [h..23] is ≤ 0.1 — "locked and it stayed locked".

Inputs (all local): out/market-history/{city}/*.json + out/iem-asos-archive/ +
city-map.json. Output: out/intraday-convergence.json + paste-ready doc tables.

RUN: python scripts/research/intraday-convergence.py [--start 2026-06-13 --end 2026-07-24]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
IEM_DIR = ROOT / "out" / "iem-asos-archive"
MH_DIR = ROOT / "out" / "market-history"
CITY_MAP = json.loads((ROOT / "city-map.json").read_text(encoding="utf-8"))["cities"]

STALE_S = 3600          # ghost-quote law: a mid level requires a print within 60 min
MIN_FRESH_FRACTION = 0.5  # score an event-hour only when ≥ half the buckets have fresh levels
LOCKIN_BRIER = 0.1
HOURS = list(range(6, 24))

def wu_round(x: float) -> int:
    return int(math.copysign(math.floor(abs(x) + 0.5), x))

def parse_label(label: str) -> tuple[float, float]:
    """Native-unit bounds; UNSIGNED regex (range dash ≠ minus — the summer-panel law)."""
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

MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]
# slugs use full ("july") AND abbreviated ("jan") month names — accept both
MONTH_NO = {name: i + 1 for i, name in enumerate(MONTHS)} | {name[:3]: i + 1 for i, name in enumerate(MONTHS)}

def slug_day(slug: str) -> str | None:
    m = re.search(r"on-([a-z]+)-(\d+)(?:-(\d{4}))?$", slug)
    if not m or not m.group(3) or m.group(1) not in MONTH_NO:
        return None
    return f"{m.group(3)}-{MONTH_NO[m.group(1)]:02d}-{int(m.group(2)):02d}"

def price_series(points: list) -> list[tuple[int, float]]:
    if points and isinstance(points[0], dict):
        return sorted((int(p["t"]), float(p["p"])) for p in points)
    return sorted((int(p[0]), float(p[1])) for p in points)

def level_at(series: list[tuple[int, float]], t: int) -> float | None:
    """Forward-filled level, ONLY if the underlying print is fresh enough (≤ STALE_S)."""
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= t:
            ans = series[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans[1] if ans and (t - ans[0]) <= STALE_S else None

def rendered(tmpf: float | None, tmpc: float | None, unit: str) -> int | None:
    if unit == "F":
        return wu_round(tmpf) if tmpf is not None else None
    if tmpc is not None:
        return wu_round(tmpc)
    return wu_round((tmpf - 32) * 5 / 9) if tmpf is not None else None

def load_iem_day_rows(icao: str, tz: ZoneInfo, unit: str, days: set[str]) -> dict[str, list[tuple[int, int]]]:
    """day -> [(epoch_s, rendered_int)] for the requested station-local days, sorted."""
    path = IEM_DIR / f"{icao}.ndjson"
    if not path.exists():
        return {}
    out: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        valid, tmpf, tmpc = json.loads(line)
        dt = datetime.strptime(valid, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("UTC"))
        day = dt.astimezone(tz).strftime("%Y-%m-%d")
        if day not in days:
            continue
        v = rendered(tmpf, tmpc, unit)
        if v is not None:
            out[day].append((int(dt.timestamp()), v))
    return {d: sorted(rows) for d, rows in out.items()}

def brier(probs: list[float], winner_idx: int) -> float:
    return sum((p - (1.0 if i == winner_idx else 0.0)) ** 2 for i, p in enumerate(probs))

def lockin_hour(curve: dict[int, float]) -> int | None:
    """First hour whose reverse running max over [h..23] is ≤ LOCKIN_BRIER; None if never."""
    revmax = math.inf
    best: int | None = None
    for h in sorted(curve, reverse=True):
        revmax = max(curve[h], revmax) if revmax is not math.inf else curve[h]
        if revmax <= LOCKIN_BRIER:
            best = h
        else:
            break  # once the reverse max exceeds the bar, earlier hours can only be worse
    return best

def med(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 3) if xs else None

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-06-13")
    ap.add_argument("--end", default="2026-07-24")
    args = ap.parse_args()
    lo_day, hi_day = args.start, args.end

    # per (city, h): brier samples · per (city): lock-in hours per day
    mkt_curve: dict[tuple[str, int], list[float]] = defaultdict(list)
    flr_curve: dict[tuple[str, int], list[float]] = defaultdict(list)
    mkt_lock: dict[str, list[int | None]] = defaultdict(list)
    flr_lock: dict[str, list[int | None]] = defaultdict(list)
    joined = skipped_thin_obs = skipped_no_winner = 0

    for city, (icao, tzname, unit, _cc, _st) in sorted(CITY_MAP.items()):
        tz = ZoneInfo(tzname)
        d = MH_DIR / city
        if not d.is_dir():
            continue
        events = []
        for f in sorted(d.glob("*.json")):
            try:
                ev = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            day = slug_day(ev.get("slug", ""))
            if day is None or not (lo_day <= day <= hi_day):
                continue
            events.append((day, ev))
        if not events:
            continue
        iem_days = load_iem_day_rows(icao, tz, unit, {day for day, _ in events})

        for day, ev in events:
            buckets = ev.get("buckets") or []
            winner_idx = next((i for i, b in enumerate(buckets) if b.get("resolvedOutcome") == "win"), None)
            if winner_idx is None:
                skipped_no_winner += 1
                continue
            series = [price_series(b.get("points") or []) for b in buckets]
            ranges = [parse_label(b.get("label") or "") for b in buckets]
            day_obs = iem_days.get(day) or []
            if len(day_obs) < 12:
                skipped_thin_obs += 1
                continue
            joined += 1

            day0 = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz)
            mcurve: dict[int, float] = {}
            fcurve: dict[int, float] = {}
            for h in HOURS:
                t = int((day0 + __import__("datetime").timedelta(hours=h)).timestamp())
                # MARKET: fresh mids → normalized probs (≥ half the ladder fresh, mass > 0)
                mids = [level_at(s, t) for s in series]
                fresh = [m for m in mids if m is not None]
                if len(fresh) >= max(2, math.ceil(len(mids) * MIN_FRESH_FRACTION)) and sum(fresh) > 0:
                    total = sum(m if m is not None else 0.0 for m in mids)
                    if total > 0:
                        probs = [(m if m is not None else 0.0) / total for m in mids]
                        mcurve[h] = brier(probs, winner_idx)
                # FLOOR: uniform over alive buckets under the rendered running max
                run_max = max((v for (ts, v) in day_obs if ts <= t), default=None)
                if run_max is not None:
                    alive = [i for i, (_lo2, hi2) in enumerate(ranges) if hi2 >= run_max]
                    if alive:
                        probs = [1.0 / len(alive) if i in alive else 0.0 for i in range(len(ranges))]
                        fcurve[h] = brier(probs, winner_idx)

            for h, v in mcurve.items():
                mkt_curve[(city, h)].append(v)
            for h, v in fcurve.items():
                flr_curve[(city, h)].append(v)
            mkt_lock[city].append(lockin_hour(mcurve) if mcurve else None)
            flr_lock[city].append(lockin_hour(fcurve) if fcurve else None)

    print(f"joined city-days: {joined} · skipped (no winner): {skipped_no_winner}"
          f" · skipped (thin METAR day): {skipped_thin_obs}")

    # pooled curves
    print("\nPOOLED (all cities) — median Brier by station-local hour:")
    print("  h    market(n)        floor(n)")
    pooled = {}
    for h in HOURS:
        mk = [v for (c, hh), vs in mkt_curve.items() if hh == h for v in vs]
        fl = [v for (c, hh), vs in flr_curve.items() if hh == h for v in vs]
        pooled[h] = {"market": med(mk), "nMarket": len(mk), "floor": med(fl), "nFloor": len(fl)}
        print(f"  {h:02d}   {med(mk)!s:7s}({len(mk):5d})   {med(fl)!s:7s}({len(fl):5d})")

    # per-city summary: key-hour medians + lock-ins
    print("\nPER-CITY — median market/floor Brier at local 08/12/16/20/23 + lock-in (≤0.1 stays):")
    print("| city | mkt08 | mkt12 | mkt16 | mkt20 | mkt23 | flr16 | flr20 | mkt lock med (locked%) | flr lock med (locked%) |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    cities_out = {}
    for city in sorted({c for (c, _h) in list(mkt_curve) + list(flr_curve)}):
        row = {}
        for h in (8, 12, 16, 20, 23):
            row[f"mkt{h:02d}"] = med(mkt_curve.get((city, h), []))
        for h in (16, 20):
            row[f"flr{h:02d}"] = med(flr_curve.get((city, h), []))
        ml = [x for x in mkt_lock[city] if x is not None]
        fl2 = [x for x in flr_lock[city] if x is not None]
        n_m, n_f = len(mkt_lock[city]), len(flr_lock[city])
        row["mktLock"] = med(ml)
        row["mktLockedPct"] = round(100 * len(ml) / n_m) if n_m else None
        row["flrLock"] = med(fl2)
        row["flrLockedPct"] = round(100 * len(fl2) / n_f) if n_f else None
        row["nDays"] = n_m
        cities_out[city] = row
        f = lambda k: (f"{row[k]:.3f}" if isinstance(row[k], float) else "—") if row.get(k) is not None else "—"
        print(f"| {city} | {f('mkt08')} | {f('mkt12')} | {f('mkt16')} | {f('mkt20')} | {f('mkt23')} |"
              f" {f('flr16')} | {f('flr20')} |"
              f" {row['mktLock'] if row['mktLock'] is not None else '—'} ({row['mktLockedPct']}%) |"
              f" {row['flrLock'] if row['flrLock'] is not None else '—'} ({row['flrLockedPct']}%) |")

    out = {
        "window": [lo_day, hi_day], "joinedCityDays": joined,
        "skippedNoWinner": skipped_no_winner, "skippedThinObs": skipped_thin_obs,
        "lockinBrier": LOCKIN_BRIER, "staleS": STALE_S,
        "pooled": pooled, "cities": cities_out,
    }
    (ROOT / "out" / "intraday-convergence.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwrote {ROOT / 'out' / 'intraday-convergence.json'}")

if __name__ == "__main__":
    main()
