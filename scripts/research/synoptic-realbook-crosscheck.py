"""
synoptic-realbook-crosscheck — the REAL-BOOK cross-check of the obs->price
transmission finding (2026-07-25 first pass, synoptic-price-join.py).

The first pass measured floor-kill timing on the trade-print MID (trap #1/#8:
prints only tick on trades; no bid/ask; selection excluded kills the market made
BEFORE the obs). This script re-measures the SAME floor-kill events against the
5-min REAL order-book snapshots in out/opening-captures-archive (bestBid /
walked execBid / sellback depth captured live from the CLOB /book), and answers
the two questions the first pass could not:

  1. EXECUTABLE MEAT: right after the 5-min obs print (first snapshot >= T),
     what YES bid actually remains on a structurally-killed bucket, at what
     depth, and does bid - taker fee clear zero (the "buy NO on fresh kills"
     form)? EV counts winner-"kills" (deg-F rounding fabrications) at full loss.

  2. THE PRE-KILL DENOMINATOR: of ALL buckets the obs floor kills, how many had
     the market already killed (bid < 1c) before the print - the "market
     faster" cases the first pass's p>=5c-at-T-30 filter silently dropped?

Join: city + target_date (VERIFIED = the WEATHER day in opening_captures;
gamma's targetDate in market-history is the RESOLUTION day - weather day parsed
from the slug) + bucket-label-set equality. Outcomes from market-history.

Usage: python scripts/research/synoptic-realbook-crosscheck.py
Output: readable summary + RESULT {json} on the last line.
"""
from __future__ import annotations

import gzip
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import cost_model as cm  # canonical fee model (fees.ts mirror)

OBS_DIR = ROOT / "out" / "synoptic-obs-archive"
MH_DIR = ROOT / "out" / "market-history"
CAP_DIR = ROOT / "out" / "opening-captures-archive"

DAY_LO, DAY_HI = "2026-07-19", "2026-07-25"

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
    """Unsigned regex (range dash != minus; see synoptic-price-join)."""
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

def iso_epoch(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())

def load_obs() -> dict[str, list[tuple[int, float]]]:
    out: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for f in sorted(OBS_DIR.glob("*.ndjson")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            out[r["icao"]].append((iso_epoch(r["obs_at"]), float(r["temp_tenths_c"])))
    return {k: sorted(set(v)) for k, v in out.items()}

def load_outcomes() -> dict[tuple[str, str], dict]:
    """(city, weather_day) -> {label -> 'win'|'lose'} (slug-parsed day, deduped)."""
    months = ["january","february","march","april","may","june","july",
              "august","september","october","november","december"]
    out: dict[tuple[str, str], dict] = {}
    for city in CITY_STATION:
        d = MH_DIR / city
        if not d.is_dir():
            continue
        for f in d.glob("*.json"):
            ev = json.loads(f.read_text(encoding="utf-8"))
            m = re.search(r"on-([a-z]+)-(\d+)(?:-(\d{4}))?$", ev.get("slug", ""))
            if not m or not m.group(3):
                continue
            day = f"{m.group(3)}-{months.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"
            if not (DAY_LO <= day <= DAY_HI):
                continue
            oc = {b["label"]: b.get("resolvedOutcome") for b in ev["buckets"]}
            if "win" in oc.values():
                out[(city, day)] = oc
    return out

def load_captures() -> dict[tuple[str, str], dict[str, list]]:
    """(city, weather_day) -> label -> sorted [(ts, bestBid, execBid, sellUsd, sellDepthUsd)]."""
    cities = set(CITY_STATION)
    city_probe = [f'"{c}"' for c in cities]
    out: dict[tuple[str, str], dict[str, list]] = defaultdict(lambda: defaultdict(list))
    n_rows = 0
    for f in sorted(CAP_DIR.glob("part-*.ndjson.gz")):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            for line in fh:
                if "2026-07-1" not in line and "2026-07-2" not in line:
                    continue
                if not any(p in line for p in city_probe):
                    continue
                r = json.loads(line)
                if r["city"] not in cities or not (DAY_LO <= r["target_date"] <= DAY_HI):
                    continue
                ts = iso_epoch(r["captured_at"])
                key = (r["city"], r["target_date"])
                for b in r["buckets"]:
                    out[key][b["label"]].append((
                        ts,
                        b.get("bestBid"),
                        b.get("execBid"),
                        b.get("sellbackUsd"),
                        b.get("sellbackDepthUsd"),
                    ))
                n_rows += 1
    for ev in out.values():
        for lbl in ev:
            ev[lbl].sort()
    print(f"capture rows joined: {n_rows} across {len(out)} city-days", file=sys.stderr)
    return out

def snap_at_or_before(series: list, t: int, max_age_s: int) -> tuple | None:
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= t:
            ans = series[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans if ans and (t - ans[0]) <= max_age_s else None

def snap_at_or_after(series: list, t: int, max_wait_s: int) -> tuple | None:
    lo, hi, ans = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] >= t:
            ans = series[mid]
            hi = mid - 1
        else:
            lo = mid + 1
    return ans if ans and (ans[0] - t) <= max_wait_s else None

def main() -> None:
    obs_by_icao = load_obs()
    outcomes = load_outcomes()
    caps = load_captures()

    kills = []              # every structurally-killed bucket (denominator rows)
    joined_days, label_mismatch = 0, 0

    for (city, day), oc in sorted(outcomes.items()):
        icao, tzname = CITY_STATION[city]
        tz = ZoneInfo(tzname)
        cap = caps.get((city, day))
        if not cap:
            continue
        # label-set integrity: captures and market-history must be the same market
        if set(cap.keys()) != set(oc.keys()):
            label_mismatch += 1
            continue
        day_obs = [
            (t, c) for (t, c) in obs_by_icao.get(icao, [])
            if datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d") == day
        ]
        if len(day_obs) < 20:
            continue
        joined_days += 1
        ranges = {lbl: parse_label_f(lbl) for lbl in oc}

        # one kill record per (bucket, margin rule M): T_M = first obs print whose
        # running max clears the bucket top by >= M deg-F (M=1 == the first pass's rule)
        run_max_f = -math.inf
        killed_at: dict[tuple[str, int], int] = {}
        for (t, c) in day_obs:
            f_nat = c_to_f_native(c)
            if f_nat <= run_max_f:
                continue
            run_max_f = f_nat
            for lbl, (lo, hi) in ranges.items():
                if hi is math.inf:
                    continue
                for m_rule in (1, 2, 3):
                    if (lbl, m_rule) in killed_at or run_max_f < hi + m_rule:
                        continue
                    killed_at[(lbl, m_rule)] = t
        for (lbl, m_rule), t in killed_at.items():
            s = cap.get(lbl, [])
            pre30 = snap_at_or_before(s, t - 1800, 5400)   # <=90min stale
            prev = snap_at_or_before(s, t - 1, 900)        # last book before the print
            s0 = snap_at_or_after(s, t, 360)               # first book after (bot-hit window)
            s15 = snap_at_or_after(s, t + 900, 600)
            s60 = snap_at_or_after(s, t + 3600, 900)
            kills.append({
                "city": city, "day": day, "label": lbl,
                "outcome": oc[lbl],                        # 'lose' | 'win' (rounding fabrication)
                "t": t, "m_rule": m_rule,
                "pre30": pre30, "prev": prev, "s0": s0, "s15": s15, "s60": s60,
            })

    # ── report ───────────────────────────────────────────────────────────────
    def med(xs):
        xs = [x for x in xs if x is not None]
        return statistics.median(xs) if xs else None

    def bid(snap):
        return (snap[1] if snap and snap[1] is not None else None)

    m1 = [k for k in kills if k["m_rule"] == 1]
    losers = [k for k in m1 if k["outcome"] == "lose"]
    winner_kills = [k for k in m1 if k["outcome"] == "win"]

    print(f"city-days joined: {joined_days} (label mismatches dropped: {label_mismatch})")
    print(f"structural kills (margin-1 rule): {len(m1)}  (losers {len(losers)} · WINNER-'kills' {len(winner_kills)} ← fabrications)")
    for m_rule in (1, 2, 3):
        km = [k for k in kills if k["m_rule"] == m_rule]
        fw = sum(1 for k in km if k["outcome"] == "win")
        print(f"   margin>={m_rule}: kills {len(km)} · fabrications {fw} ({fw / len(km):.1%})" if km else "")

    # 2. THE DENOMINATOR — where was the real bid at T−30 for EVERY kill?
    classes = defaultdict(int)
    for k in losers:
        b = bid(k["pre30"])
        if b is None:
            classes["no_pre30_snapshot"] += 1
        elif b >= 0.05:
            classes["alive_ge5c"] += 1
        elif b >= 0.01:
            classes["marginal_1_5c"] += 1
        else:
            classes["dead_lt1c"] += 1
    n_denom = sum(classes.values())
    print(f"\nDENOMINATOR (loser kills, real bid at T-30): n={n_denom}")
    for k2 in ("alive_ge5c", "marginal_1_5c", "dead_lt1c", "no_pre30_snapshot"):
        n = classes[k2]
        print(f"   {k2:20s} {n:4d}  ({n / n_denom:.1%})" if n_denom else "   none")

    # 1. TIMING on real quotes, alive cohort (mirror of the first pass's selection)
    alive = [k for k in losers if (bid(k["pre30"]) or 0) >= 0.05]
    print(f"\nTIMING on real bids (alive >=5c at T-30): n={len(alive)}")
    if alive:
        for name in ("pre30", "prev", "s0", "s15", "s60"):
            print(f"   median bestBid @ {name:5s}: {med([bid(k[name]) for k in alive])}")
        d_pre = [bid(k["prev"]) - bid(k["pre30"]) for k in alive if bid(k["prev"]) is not None and bid(k["pre30"]) is not None]
        d_cross = [bid(k["s0"]) - bid(k["prev"]) for k in alive if bid(k["s0"]) is not None and bid(k["prev"]) is not None]
        d_post = [bid(k["s15"]) - bid(k["s0"]) for k in alive if bid(k["s15"]) is not None and bid(k["s0"]) is not None]
        print(f"   median dBid [T-30 -> prev): {med(d_pre):+.4f}   (pre-print, quote basis)")
        print(f"   median dBid [prev -> S0]:   {med(d_cross):+.4f}   (across the print)")
        print(f"   median dBid [S0 -> S15]:    {med(d_post):+.4f}   (post-print)")

    # complete-snapshot trajectory (same denominator at every point — no compositional drift)
    complete = [k for k in alive if all(bid(k[n]) is not None for n in ("pre30", "prev", "s0", "s15", "s60"))]
    if complete:
        print(f"   trajectory, complete-snapshot cohort n={len(complete)}: "
              + " -> ".join(f"{med([bid(k[n]) for k in complete]):.3f}" for n in ("pre30", "prev", "s0", "s15", "s60")))

    # EXECUTABLE EV — hit the bid at S0 on every kill with bid >= bar (incl. winner-kills at full loss).
    # Per-share basis = SELL YES at bid == BUY NO at 1-bid (negRisk book identity); fee symmetric.
    print("\nEXECUTABLE 'buy NO on fresh kills' (hit bid at first snapshot after the print):")
    import random
    rng = random.Random(20260725)
    ev_cells: list[dict] = []
    for m_rule in (1, 2, 3):
      print(f"  -- margin >= {m_rule} deg-F --")
      for bar in (0.02, 0.05):
        for px_name, px_idx in (("bestBid", 1), ("execBid", 2)):
            trades = []
            for k in kills:
                if k["m_rule"] != m_rule:
                    continue
                p = k["s0"][px_idx] if k["s0"] and k["s0"][px_idx] is not None else None
                if p is None or p < bar:
                    continue
                fee = cm.taker_fee_per_share(p)
                net = (p - fee) if k["outcome"] == "lose" else (-(1 - p) - fee)
                # return per $1 of NO capital deployed (cost 1-p per share)
                ret = net / (1 - p) if p < 1 else 0.0
                trades.append({**k, "px": p, "net": net, "ret": ret})
            if not trades:
                print(f"   bar {bar:.2f} @ {px_name}: no trades")
                continue
            n_win = sum(1 for t in trades if t["outcome"] == "win")
            # day-clustered bootstrap on mean return/$1 (clusters = city-day)
            by_day = defaultdict(list)
            for t in trades:
                by_day[(t["city"], t["day"])].append(t["ret"])
            days = list(by_day.values())
            boots = []
            for _ in range(4000):
                sample = [rng.choice(days) for _ in days]
                flat = [r for d in sample for r in d]
                boots.append(statistics.mean(flat))
            boots.sort()
            lo_ci, hi_ci = boots[int(0.025 * len(boots))], boots[int(0.975 * len(boots))]
            pot = sum(t["net"] * ((t["s0"][3] or 0) / t["px"]) for t in trades if t["px"] > 0)
            pot_band = sum(t["net"] * ((t["s0"][4] or 0) / t["px"]) for t in trades if t["px"] > 0)
            # 2026-07-24 convergence-capture guard: a cell where every trade shares one outcome
            # has ZERO outcome variance — its CI measures price dispersion, not risk. Flag it.
            const_flag = " ⚠ CONSTANT-OUTCOME (CI unreliable — measures price dispersion, not fabrication risk)" \
                if n_win == 0 or n_win == len(trades) else ""
            print(f"   bar {bar:.2f} @ {px_name:7s}: n={len(trades)} ({n_win} winner-'kills')"
                  f" · mean ret/$1 {statistics.mean([t['ret'] for t in trades]):+.4f}"
                  f" CI[{lo_ci:+.4f},{hi_ci:+.4f}] ({len(days)} city-day clusters)"
                  f" · pot top ${pot:+.0f} / band ${pot_band:+.0f}{const_flag}")
            ev_cells.append({
                "mRule": m_rule, "bar": bar, "px": px_name, "n": len(trades), "nWin": n_win,
                "meanRet": round(statistics.mean([t["ret"] for t in trades]), 4),
                "ciLo": round(lo_ci, 4), "ciHi": round(hi_ci, 4), "clusters": len(days),
                "potTop": round(pot), "potBand": round(pot_band),
                "constantOutcome": n_win == 0 or n_win == len(trades),
            })

    # winner-'kill' anatomy — where do the fabrications cluster?
    if winner_kills:
        wc = defaultdict(int)
        for k in winner_kills:
            wc[k["city"]] += 1
        print("\nwinner-'kill' fabrications by city:", dict(sorted(wc.items(), key=lambda x: -x[1])))
        for k in winner_kills[:25]:
            print(f"   {k['city']:14s} {k['day']}  {k['label']:16s} bidS0={bid(k['s0'])}")

    print("\nRESULT " + json.dumps({
        "cityDays": joined_days,
        "nKillsLoser": len(losers), "nWinnerKills": len(winner_kills),
        "fabricationByMargin": {
            str(m): {"kills": len([k for k in kills if k["m_rule"] == m]),
                     "fabrications": len([k for k in kills if k["m_rule"] == m and k["outcome"] == "win"])}
            for m in (1, 2, 3)
        },
        "denom": dict(classes),
        "aliveN": len(alive),
        "medBidPre30": med([bid(k["pre30"]) for k in alive]),
        "medBidPrev": med([bid(k["prev"]) for k in alive]),
        "medBidS0": med([bid(k["s0"]) for k in alive]),
        "medBidS15": med([bid(k["s15"]) for k in alive]),
        "medBidS60": med([bid(k["s60"]) for k in alive]),
        "evCells": ev_cells,
    }))

if __name__ == "__main__":
    main()
