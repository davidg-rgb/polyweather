"""
metar-kill-replay — the DEEP-HISTORY, fabrication-free version of the
OBS-TRANSMISSION study: METAR/SPECI-grade floor-kills (the exact resolution
stream, docs/DATA-SOURCES.md §resolution-oracle) replayed against the
market-history price archive across all 45 cities.

What the METAR stream buys us that we lacked: the historical RESOLUTION-STATE
PATH — when, along each day, the table max structurally killed each bucket.
Kills here are fabrication-free BY CONSTRUCTION (the kill value IS a rendered
resolution row), unlike the 5-min-obs kills that fabricated 19/19
winner-"kills" in the July window.

Measurements per kill (bucket B, first row whose rendered running max clears
B's top):
  A. Winner-replication guard: events where the replica daily max lands outside
     the resolved winner bucket are QUARANTINED (reported, excluded) — extends
     the 66/66 oracle validation to the deep panel incl. °C cities.
  B. Denominator: mid at T−30 (freshness-filtered) — alive / marginal / dead.
  C. Timing: mid levels at T−30 / T / T+15 / T+60 (level reads REQUIRE a print
     within 60 min — the ghost-quote staleness law from BID-PATH-DISCOVERY).
  D. The fade trade (mid-basis, canonical cost model): at the FIRST real print
     in [T, T+15] with p ≥ bar, sell YES (== buy NO) at cost_model.exec_bid(p)
     − taker fee; winner-kills (should be ≈0) at full loss. City-day-clustered
     bootstrap CI; constant-outcome flag; quarterly regime table.

⚠ VERDICT CAP: prices are trade-print MIDs (trap #1/#8) — any positive here is
at most PASS_PENDING_REAL_BOOK (the July+ opening_captures window is the
executable stage; synoptic-realbook-crosscheck.py already covers 07-19..25).

Usage:
    python scripts/research/metar-kill-replay.py                 # default: last 90 days
    python scripts/research/metar-kill-replay.py --start 2026-04-26 --end 2026-07-25
Requires: out/iem-asos-archive/ (run iem-backfill.py first) + out/market-history/.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import cost_model as cm

IEM_DIR = ROOT / "out" / "iem-asos-archive"
MH_DIR = ROOT / "out" / "market-history"
CITY_MAP = json.loads((ROOT / "city-map.json").read_text(encoding="utf-8"))["cities"]

STALE_S = 3600          # a level read requires a print within 60 min (ghost-quote law)
# Entry window: a METAR's valid time precedes its PUBLICATION by 2–6 min (AWC
# measured latency, §resolution-oracle) — entering at the first print ≥ T is
# LOOK-AHEAD (the first run's +0.78..+1.08/$1 "edge" was exactly this mirage).
# Honest window: [T+6min, T+21min] — info public, same 15-min width.
ENTRY_DELAY_S = 360
ENTRY_WINDOW_S = 900

def wu_round(x: float) -> int:
    return int(math.copysign(math.floor(abs(x) + 0.5), x))

def parse_label(label: str) -> tuple[float, float]:
    """Native-unit bounds; unsigned regex (range dash ≠ minus — summer panel)."""
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

def load_iem(icao: str) -> list[tuple[int, float | None, float | None]]:
    """[(epoch_s, tmpf, tmpc)] sorted; None temps dropped by callers as needed."""
    path = IEM_DIR / f"{icao}.ndjson"
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        valid, tmpf, tmpc = json.loads(line)
        dt = datetime.strptime(valid, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("UTC"))
        out.append((int(dt.timestamp()), tmpf, tmpc))
    return sorted(out)

def rendered(tmpf: float | None, tmpc: float | None, unit: str) -> int | None:
    """The WU-table integer for one row (§resolution-oracle rounding)."""
    if unit == "F":
        return wu_round(tmpf) if tmpf is not None else None
    if tmpc is not None:
        return wu_round(tmpc)
    return wu_round((tmpf - 32) * 5 / 9) if tmpf is not None else None

def price_series(points: list) -> list[tuple[int, float]]:
    if points and isinstance(points[0], dict):
        return sorted((int(p["t"]), float(p["p"])) for p in points)
    return sorted((int(p[0]), float(p[1])) for p in points)

def level_at(series: list[tuple[int, float]], t: int, max_stale_s: int = STALE_S) -> float | None:
    """Forward-filled level, ONLY if the underlying print is fresh enough."""
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= t:
            ans = series[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans[1] if ans and (t - ans[0]) <= max_stale_s else None

def first_print_in(series: list[tuple[int, float]], t0: int, t1: int) -> tuple[int, float] | None:
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] >= t0:
            ans = series[mid]
            hi = mid - 1
        else:
            lo = mid + 1
    return ans if ans and ans[0] <= t1 else None

MONTHS = ["january","february","march","april","may","june","july",
          "august","september","october","november","december"]

def slug_day(slug: str) -> str | None:
    m = re.search(r"on-([a-z]+)-(\d+)(?:-(\d{4}))?$", slug)
    if not m or not m.group(3):
        return None
    return f"{m.group(3)}-{MONTHS.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=str, default=None)
    ap.add_argument("--end", type=str, default=None)
    ap.add_argument("--days", type=int, default=90)
    args = ap.parse_args()
    end = date.fromisoformat(args.end) if args.end else date.today()
    start = date.fromisoformat(args.start) if args.start else end - timedelta(days=args.days)
    lo_day, hi_day = start.isoformat(), end.isoformat()

    iem_by_icao = {icao: load_iem(icao) for icao, *_ in
                   ((v[0],) for v in CITY_MAP.values())}

    kills, quarantined, joined = [], 0, 0
    repl_ok = repl_total = 0
    missing_obs_days = 0

    for city, (icao, tzname, unit, _cc, _st) in sorted(CITY_MAP.items()):
        tz = ZoneInfo(tzname)
        obs_all = iem_by_icao.get(icao) or []
        d = MH_DIR / city
        if not d.is_dir() or not obs_all:
            continue
        for f in sorted(d.glob("*.json")):
            # filename prefix = a date near the event; pad ±3d for the prefilter
            fd = f.name[:10]
            if not (lo_day <= fd <= hi_day or
                    abs((date.fromisoformat(fd) - start).days) <= 3 or
                    abs((date.fromisoformat(fd) - end).days) <= 3):
                if not (lo_day <= fd <= hi_day):
                    continue
            try:
                ev = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            day = slug_day(ev.get("slug", ""))
            if day is None or not (lo_day <= day <= hi_day):
                continue
            winner = next((b["label"] for b in ev["buckets"] if b.get("resolvedOutcome") == "win"), None)
            if winner is None:
                continue
            # station-local-day resolution rows
            day_rows = []
            for (t, tmpf, tmpc) in obs_all:
                if datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d") == day:
                    v = rendered(tmpf, tmpc, unit)
                    if v is not None:
                        day_rows.append((t, v))
            if len(day_rows) < 12:
                missing_obs_days += 1
                continue
            # A. winner-replication guard. Divergence events (replica max outside
            # the resolved winner bucket, 3–4%) are NOT dropped: a forward trader
            # cannot know a day will diverge, so their kills stay in the trade
            # panel as the honest fabrication/loss channel. They are only
            # excluded from the timing/denominator reads.
            replica_max = max(v for _, v in day_rows)
            wlo, whi = parse_label(winner)
            repl_total += 1
            diverged = not (wlo <= replica_max <= whi)
            if diverged:
                quarantined += 1
            else:
                repl_ok += 1
            joined += 1

            buckets = [{"label": b["label"], "outcome": b.get("resolvedOutcome"),
                        "range": parse_label(b["label"]),
                        "series": price_series(b["points"])} for b in ev["buckets"]]
            run_max = -math.inf
            for (t, v) in day_rows:
                if v <= run_max:
                    continue
                prev_max, run_max = run_max, v
                for b in buckets:
                    _lo, hi = b["range"]
                    if not (prev_max <= hi < run_max) or hi is math.inf:
                        continue
                    s = b["series"]
                    entry = first_print_in(s, t + ENTRY_DELAY_S, t + ENTRY_DELAY_S + ENTRY_WINDOW_S)
                    kills.append({
                        "city": city, "day": day, "label": b["label"],
                        "outcome": b["outcome"], "t": t, "diverged": diverged,
                        "pre30": level_at(s, t - 1800),
                        "at": level_at(s, t),
                        "p15": level_at(s, t + 900),
                        "p60": level_at(s, t + 3600),
                        "entry": entry[1] if entry else None,
                        "entryLagS": (entry[0] - t) if entry else None,
                    })

    clean = [k for k in kills if not k["diverged"]]
    losers = [k for k in clean if k["outcome"] == "lose"]
    winner_kills = [k for k in kills if k["outcome"] == "win"]

    print(f"events joined: {joined} · winner-replication {repl_ok}/{repl_total} "
          f"({repl_ok / repl_total:.1%}) · divergence events kept in trade panel: {quarantined}"
          f" · thin-obs days skipped {missing_obs_days}")
    print(f"METAR-grade kills: {len(kills)} (clean {len(clean)} · winner-'kills' {len(winner_kills)}"
          f" = {len(winner_kills) / len(kills):.2%} of all — ALL from divergence events, the real"
          f" fabrication channel a forward trader eats)")

    def med(xs):
        xs = [x for x in xs if x is not None]
        return round(statistics.median(xs), 4) if xs else None

    classes = defaultdict(int)
    for k in losers:
        b = k["pre30"]
        if b is None:
            classes["no_fresh_print"] += 1
        elif b >= 0.05:
            classes["alive_ge5c"] += 1
        elif b >= 0.01:
            classes["marginal_1_5c"] += 1
        else:
            classes["dead_lt1c"] += 1
    n_d = sum(classes.values())
    print(f"\nDENOMINATOR (mid at T−30, fresh ≤60min): n={n_d}")
    for k2 in ("alive_ge5c", "marginal_1_5c", "dead_lt1c", "no_fresh_print"):
        print(f"   {k2:16s} {classes[k2]:5d}  ({classes[k2] / n_d:.1%})" if n_d else "")

    alive = [k for k in losers if (k["pre30"] or 0) >= 0.05]
    print(f"\nTIMING (alive ≥5c at T−30, fresh levels only): n={len(alive)}")
    for name in ("pre30", "at", "p15", "p60"):
        print(f"   median mid @ {name:5s}: {med([k[name] for k in alive])}")

    # D. the fade trade — mid-basis, canonical executable haircut, honest timing
    print(f"\nFADE TRADE (first real print in [T+{ENTRY_DELAY_S // 60}m, T+{(ENTRY_DELAY_S + ENTRY_WINDOW_S) // 60}m]"
          f" — post-publication; sell at cost_model exec_bid − fee; divergence-event kills included):")
    print("   ⚠ MID-BASIS: any positive is at most PASS_PENDING_REAL_BOOK (law).")
    rng = random.Random(20260726)
    ev_cells = []
    for bar in (0.02, 0.05):
        trades = []
        for k in kills:
            p = k["entry"]
            if p is None or p < bar:
                continue
            xb = cm.exec_bid(p)
            if xb <= 0:
                continue
            fee = cm.taker_fee_per_share(xb)
            net = (xb - fee) if k["outcome"] == "lose" else (-(1 - xb) - fee)
            trades.append({**k, "net": net, "ret": net / (1 - xb) if xb < 1 else 0.0})
        if not trades:
            print(f"   bar {bar:.2f}: no trades")
            continue
        n_win = sum(1 for t in trades if t["outcome"] == "win")
        # entry-price bands: high-priced entries are the market REFUSING the kill
        # (adverse selection — the July lesson); show where the P&L actually sits
        bands = defaultdict(lambda: [0, 0.0, 0])
        for t in trades:
            b2 = "<0.10" if t["entry"] < 0.10 else "0.10-0.30" if t["entry"] < 0.30 else "0.30-0.60" if t["entry"] < 0.60 else ">=0.60"
            bands[b2][0] += 1
            bands[b2][1] += t["ret"]
            bands[b2][2] += t["outcome"] == "win"
        band_tab = {b3: (n, round(s / n, 3), w) for b3, (n, s, w) in sorted(bands.items())}
        by_day = defaultdict(list)
        for t in trades:
            by_day[(t["city"], t["day"])].append(t["ret"])
        days_l = list(by_day.values())
        boots = []
        for _ in range(4000):
            flat = [r for dcl in (rng.choice(days_l) for _ in days_l) for r in dcl]
            boots.append(statistics.mean(flat))
        boots.sort()
        ci = (round(boots[int(0.025 * len(boots))], 4), round(boots[int(0.975 * len(boots))], 4))
        const = n_win == 0 or n_win == len(trades)
        mean_ret = round(statistics.mean([t["ret"] for t in trades]), 4)
        # quarterly regime split
        byq = defaultdict(list)
        for t in trades:
            q = f"{t['day'][:4]}Q{(int(t['day'][5:7]) - 1) // 3 + 1}"
            byq[q].append(t["ret"])
        qtab = {q: (len(v), round(statistics.mean(v), 3)) for q, v in sorted(byq.items())}
        print(f"   bar {bar:.2f}: n={len(trades)} ({n_win} winner-'kills') · mean ret/$1 {mean_ret:+.4f}"
              f" CI[{ci[0]:+.4f},{ci[1]:+.4f}] ({len(days_l)} city-day clusters)"
              f"{' ⚠ CONSTANT-OUTCOME (CI = price dispersion, not risk)' if const else ''}")
        print(f"        by quarter (n, mean): {qtab}")
        print(f"        by entry band (n, mean ret, winner-hits): {band_tab}")
        ev_cells.append({"bar": bar, "n": len(trades), "nWin": n_win, "meanRet": mean_ret,
                         "ciLo": ci[0], "ciHi": ci[1], "clusters": len(days_l),
                         "constantOutcome": const, "byQuarter": qtab, "byEntryBand": band_tab})

    if winner_kills:
        wc = defaultdict(int)
        for k in winner_kills:
            wc[k["city"]] += 1
        print("\nwinner-'kills' by city (each is an IEM≠WU divergence — investigate if >0.5%):",
              dict(sorted(wc.items(), key=lambda x: -x[1])))

    out = {
        "window": [lo_day, hi_day], "eventsJoined": joined,
        "winnerReplication": {"ok": repl_ok, "total": repl_total},
        "kills": len(kills), "winnerKills": len(winner_kills),
        "denom": dict(classes), "aliveN": len(alive),
        "medMids": {n: med([k[n] for k in alive]) for n in ("pre30", "at", "p15", "p60")},
        "evCells": ev_cells,
    }
    (ROOT / "out" / "metar-kill-replay-result.json").write_text(json.dumps(out, indent=1))
    print("\nRESULT " + json.dumps(out))

if __name__ == "__main__":
    main()
