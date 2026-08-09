"""
floor-veto-backtest — does an intraday METAR-floor veto improve the live buy-table lane?

THE LEVER UNDER TEST: at each would-be entry tick, compute the station's current running-max
floor (as our DB knew it at that moment, from intraday_advances.created_at). Veto the entry when
  (a) the picked bucket is already IMPOSSIBLE (bucket high < floor)  — "floor-dead", always on; or
  (b) the picked bucket's low sits ≥ G °C above the floor AND the station-local hour ≥ H
      — the day has mostly heated; a big remaining gap means our gaussian is fighting the thermometer.

PANEL (no synthetic anything): the opening-captures archive — the per-tick REAL book + houseProb,
exactly what the lane's selector sees. One hypothetical $1 entry per (event, UTC hour) in the lane
window (00–10Z clock, lead 2–12 h), pick = argmax houseProb over identity-complete buckets (the
0106 fold / selectBuyTableCandidates idiom), price = execAsk→bestAsk, lane gates applied
(dead-pick bid ≥ 0.02, favorite-veto 0.85). Outcome = pick idx vs resolved winner. Return per $1:
win → 1/ask − 1, loss → −1.

HONESTY RAILS:
  · shenzhen EXCLUDED (WU-resolution ≠ our METAR station — floor data not resolution-grade there);
  · today's motivating losses (07-28) are OUTSIDE the panel (07-05..07-27);
  · sweep (G, H) on TRAIN dates ≤ 07-16 only, freeze, report TEST 07-17..07-27;
  · clusters = city-day (primary) with a day-block sensitivity read;
  · selector validated against the 0106 fold (last pre-resolution capture must reproduce predicted_idx);
  · floor-dead rows that nonetheless WIN are counted and reported (floor-vs-resolution divergence probe).

Run:  python scripts/research/floor-veto-backtest.py
Out:  out/floor-veto/panel.csv, out/floor-veto/RESULT.json (+ stdout report)
"""
from __future__ import annotations

import csv
import glob
import gzip
import json
import math
import os
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
from analytics import clustered_ci  # the frozen gate's estimator — city-day t-CI on cluster means

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "out", "floor-veto")
ARCH = os.path.join(ROOT, "out", "opening-captures-archive")

WINDOW_START, WINDOW_END = "2026-07-05", "2026-07-27"
TRAIN_END = "2026-07-16"  # sweep here; freeze; report 07-17..07-27
EXCLUDED_CITIES = {"shenzhen"}  # WU-resolution station ≠ our METAR (city-oracle build 2) — floor not resolution-grade

# lane parity (config.csv, 2026-07-28)
CLOCK_START_H, CLOCK_END_H = 0, 10       # 00:00–10:00Z entry window
LEAD_MIN_H, LEAD_MAX_H = 2.0, 12.0       # buy_table.lead_min_h / lead_max_h
DEAD_PICK_MIN_BID = 0.02                 # buy_table.dead_pick_min_bid
FAVORITE_VETO_PROB = 0.85                # buy_table.favorite_veto_prob
ASK_MAX_BROAD = 0.50                     # broad-panel price ceiling (caps sweep reported by band)
CITY_CAPS = {"kuala-lumpur": 0.28, "madrid": 0.40, "singapore": 0.35, "wellington": 0.40}
STAKE_USD = 5.0

GAP_GRID = [0.5, 1.0, 1.5, 2.0, 3.0]     # °C above floor
HOUR_GRID = [8, 10, 12, 14]              # station-local hour cutoff


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace(" ", "T").replace("Z", "+00:00"))


def read_csv(name: str) -> list[dict]:
    with open(os.path.join(OUT, name), newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def to_c(native: float, unit: str) -> float:
    return native if unit == "C" else (native - 32.0) * 5.0 / 9.0


def load_advances() -> dict[tuple[str, str], tuple[list[datetime], list[float]]]:
    """(icao, date_local) → (sorted created_at, running max °C at that write)."""
    raw: dict[tuple[str, str], list[tuple[datetime, float]]] = defaultdict(list)
    for r in read_csv("advances.csv"):
        key = (r["icao"], r["date_local"][:10])
        raw[key].append((parse_ts(r["created_at"]), float(r["max_tenths_c"])))
    out: dict[tuple[str, str], tuple[list[datetime], list[float]]] = {}
    for key, rows in raw.items():
        rows.sort()
        ts, mx = [], []
        running = -math.inf
        for t, v in rows:
            running = max(running, v)
            ts.append(t)
            mx.append(running)
        out[key] = (ts, mx)
    return out


def floor_at(adv, icao: str, date_local: str, t: datetime) -> float | None:
    seq = adv.get((icao, date_local))
    if not seq:
        return None
    i = bisect_right(seq[0], t)
    return seq[1][i - 1] if i > 0 else None


def pick_bucket(buckets) -> dict | None:
    """The 0106 fold / lane selector: argmax houseProb among identity-complete buckets."""
    if not isinstance(buckets, list):
        return None
    cand = [b for b in buckets
            if isinstance(b.get("houseProb"), (int, float))
            and b.get("conditionId") and b.get("tokenYes")]
    if not cand:
        return None
    return max(cand, key=lambda b: b["houseProb"])


def veto_fires(row: dict, gap_c: float, hour_cut: int) -> bool:
    if row["floor_dead"]:
        return True
    return (row["gap_c"] is not None and row["gap_c"] >= gap_c
            and row["local_hour"] >= hour_cut)


def panel_stats(rows: list[dict], label: str) -> dict:
    if not rows:
        return {"label": label, "n": 0}
    ci_cd = clustered_ci(rows, key="cityday", value="net_return")
    ci_day = clustered_ci(rows, key="day", value="net_return")
    wins = sum(1 for r in rows if r["won"])
    return {
        "label": label, "n": len(rows),
        "nCities": len({r["city"] for r in rows}),
        "nDays": len({r["day"] for r in rows}),
        "winRate": round(wins / len(rows), 4),
        "meanRet": round(ci_cd["mean"], 4),
        "ciLowCityDay": round(ci_cd["ciLow"], 4), "ciHighCityDay": round(ci_cd["ciHigh"], 4),
        "ciLowDayBlock": round(ci_day["ciLow"], 4), "ciHighDayBlock": round(ci_day["ciHigh"], 4),
    }


def main() -> None:
    events: dict[str, dict] = {}
    for r in read_csv("events.csv"):
        events[r["event_id"]] = {
            "city": r["city"], "unit": r["unit"], "icao": r["icao"],
            "target_date": r["target_date"][:10],
            "winner_idx": int(r["winner_idx"]) if r["winner_idx"] else None,
            "mismatch": r["mismatch"] in ("true", "t", "True"),
            "fold_idx": int(r["fold_predicted_idx"]) if r["fold_predicted_idx"] else None,
        }
    adv = load_advances()

    tz_cache: dict[str, ZoneInfo] = {}
    hourly: dict[tuple[str, int], dict] = {}          # (event_id, utc_hour) → latest eligible tick
    last_capture: dict[str, tuple[datetime, int | None]] = {}   # fold validation
    lane_ticks: dict[str, list[dict]] = defaultdict(list)       # Panel B (allowlist cities, capped)

    n_rows = n_win_elig = 0
    for path in sorted(glob.glob(os.path.join(ARCH, "part-*.ndjson.gz"))):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                ev = events.get(row.get("event_id"))
                if ev is None or ev["winner_idx"] is None or ev["mismatch"]:
                    continue
                if ev["city"] in EXCLUDED_CITIES:
                    continue
                td = ev["target_date"]
                if not (WINDOW_START <= td <= WINDOW_END):
                    continue
                n_rows += 1
                cap_at = parse_ts(row["captured_at"])
                res_at = parse_ts(row["resolves_at"]) if row.get("resolves_at") else None
                pick = pick_bucket(row.get("buckets"))

                # fold validation: LAST pre-resolution capture per event
                if res_at is None or cap_at <= res_at:
                    prev = last_capture.get(row["event_id"])
                    if prev is None or cap_at > prev[0]:
                        last_capture[row["event_id"]] = (cap_at, pick["idx"] if pick else None)

                if pick is None or res_at is None or cap_at > res_at:
                    continue
                # lane window gates
                if not (CLOCK_START_H <= cap_at.hour < CLOCK_END_H):
                    continue
                lead_h = (res_at - cap_at).total_seconds() / 3600.0
                if not (LEAD_MIN_H <= lead_h <= LEAD_MAX_H):
                    continue
                ask = pick.get("execAsk") if isinstance(pick.get("execAsk"), (int, float)) else pick.get("bestAsk")
                bid = pick.get("bestBid")
                if not isinstance(ask, (int, float)) or not (0.0 < ask <= ASK_MAX_BROAD):
                    continue
                if not isinstance(bid, (int, float)) or bid < DEAD_PICK_MIN_BID:
                    continue
                others = [b for b in row["buckets"] if isinstance(b, dict) and b.get("idx") != pick["idx"]]
                if any(isinstance(b.get("bestBid"), (int, float)) and b["bestBid"] >= FAVORITE_VETO_PROB
                       for b in others):
                    continue
                n_win_elig += 1

                tz = tz_cache.setdefault(row["tz_name"], ZoneInfo(row["tz_name"]))
                local = cap_at.astimezone(tz)
                lo = pick.get("loF")
                hi = pick.get("hiF")
                fl = floor_at(adv, ev["icao"], td, cap_at)
                lo_c = to_c(lo, ev["unit"]) if isinstance(lo, (int, float)) else None
                hi_c = to_c(hi, ev["unit"]) if isinstance(hi, (int, float)) else None
                tick = {
                    "event_id": row["event_id"], "city": ev["city"], "day": td,
                    "cityday": f"{ev['city']}|{td}", "utc_hour": cap_at.hour,
                    "captured_at": row["captured_at"], "local_hour": local.hour + local.minute / 60.0,
                    "pick_idx": pick["idx"], "pick_label": pick.get("label"),
                    "house_prob": pick.get("houseProb"), "ask": float(ask), "bid": float(bid),
                    "floor_c": fl, "gap_c": (lo_c - fl) if (lo_c is not None and fl is not None) else None,
                    "floor_dead": (hi_c is not None and fl is not None and hi_c < fl - 1e-9),
                    "won": pick["idx"] == ev["winner_idx"],
                }
                tick["net_return"] = (1.0 / tick["ask"] - 1.0) if tick["won"] else -1.0
                tick["net_pnl_usd"] = tick["net_return"]  # $1 stake — analytics helpers want the key

                key = (row["event_id"], cap_at.hour)
                prev = hourly.get(key)
                if prev is None or tick["captured_at"] > prev["captured_at"]:
                    hourly[key] = tick
                cap_lim = CITY_CAPS.get(ev["city"])
                if cap_lim is not None and ask <= cap_lim:
                    lane_ticks[row["event_id"]].append(tick)

    panel = sorted(hourly.values(), key=lambda r: (r["day"], r["city"], r["utc_hour"]))

    # ── selector validation vs the 0106 fold ────────────────────────────────────────────────
    checked = matched = 0
    fold_mismatches = []
    for eid, (cap_at, idx) in last_capture.items():
        ev = events.get(eid)
        if ev is None or ev["fold_idx"] is None:
            continue
        checked += 1
        if idx == ev["fold_idx"]:
            matched += 1
        elif len(fold_mismatches) < 10:
            fold_mismatches.append({"event": eid, "city": ev["city"], "day": ev["target_date"],
                                    "mine": idx, "fold": ev["fold_idx"]})

    # ── floor-quality probe: do "impossible" rows ever win? ─────────────────────────────────
    dead_rows = [r for r in panel if r["floor_dead"]]
    dead_wins = [r for r in dead_rows if r["won"]]

    # ── sweep on TRAIN, freeze, evaluate on TEST ────────────────────────────────────────────
    train = [r for r in panel if r["day"] <= TRAIN_END]
    test = [r for r in panel if r["day"] > TRAIN_END]

    sweep = []
    for g in GAP_GRID:
        for h in HOUR_GRID:
            vet = [r for r in train if veto_fires(r, g, h)]
            if len(vet) < 20 or len({r["cityday"] for r in vet}) < 5:
                continue
            ci = clustered_ci(vet, key="cityday", value="net_return")
            sweep.append({"gap": g, "hour": h, "nVetoed": len(vet),
                          "vetoedMean": round(ci["mean"], 4),
                          "vetoedCiLow": round(ci["ciLow"], 4), "vetoedCiHigh": round(ci["ciHigh"], 4)})
    sweep.sort(key=lambda s: s["vetoedCiHigh"])
    best = sweep[0] if sweep else None

    result: dict = {
        "panel": {"nTicksScanned": n_rows, "nEligible": n_win_elig, "nPanel": len(panel),
                  "nEvents": len({r["event_id"] for r in panel}),
                  "nCities": len({r["city"] for r in panel}),
                  "days": [WINDOW_START, WINDOW_END], "trainEnd": TRAIN_END,
                  "excludedCities": sorted(EXCLUDED_CITIES)},
        "selectorValidation": {"checked": checked, "matched": matched,
                               "rate": round(matched / checked, 4) if checked else None,
                               "mismatches": fold_mismatches},
        "floorDeadProbe": {"nDead": len(dead_rows), "nDeadWins": len(dead_wins),
                           "deadWinExamples": [{"city": r["city"], "day": r["day"],
                                                "label": r["pick_label"], "floorC": r["floor_c"]}
                                               for r in dead_wins[:8]]},
        "sweepTrain": sweep,
        "frozen": best,
    }

    if best:
        g, h = best["gap"], best["hour"]
        for split_name, rows in (("train", train), ("test", test), ("full", panel)):
            vet = [r for r in rows if veto_fires(r, g, h)]
            keep = [r for r in rows if not veto_fires(r, g, h)]
            losses = [r for r in rows if not r["won"]]
            result[f"eval_{split_name}"] = {
                "baseline": panel_stats(rows, "baseline"),
                "kept": panel_stats(keep, "post-veto"),
                "vetoed": panel_stats(vet, "vetoed"),
                "precision": round(sum(1 for r in vet if not r["won"]) / len(vet), 4) if vet else None,
                "recallOfLosses": round(sum(1 for r in vet if not r["won"]) / len(losses), 4) if losses else None,
                "savedUsdPer100Entries": round(-100.0 * sum(r["net_return"] for r in vet) / len(rows), 2) if rows else None,
            }

        # ── Panel B: faithful current-config lane replay (allowlist + caps, first eligible tick) ──
        lane_entries = []
        for eid, ticks in lane_ticks.items():
            first = min(ticks, key=lambda t: t["captured_at"])
            lane_entries.append(first)
        lane_entries.sort(key=lambda r: r["captured_at"])
        base_pnl = sum(STAKE_USD * r["net_return"] for r in lane_entries)
        vetoed_lane = [r for r in lane_entries if veto_fires(r, g, h)]
        kept_pnl = sum(STAKE_USD * r["net_return"] for r in lane_entries if not veto_fires(r, g, h))
        result["laneReplay"] = {
            "config": {"caps": CITY_CAPS, "stakeUsd": STAKE_USD},
            "nEntries": len(lane_entries), "nVetoed": len(vetoed_lane),
            "baselinePnlUsd": round(base_pnl, 2), "postVetoPnlUsd": round(kept_pnl, 2),
            "savedUsd": round(kept_pnl - base_pnl, 2),
            "entries": [{"city": r["city"], "day": r["day"], "label": r["pick_label"],
                         "ask": r["ask"], "localHour": round(r["local_hour"], 1),
                         "floorC": r["floor_c"], "gapC": r["gap_c"],
                         "vetoed": veto_fires(r, g, h), "won": r["won"],
                         "pnlUsd": round(STAKE_USD * r["net_return"], 2)} for r in lane_entries],
        }

        # ── the actual live fills under the frozen veto ─────────────────────────────────────
        live = []
        city_tz = {"kuala-lumpur": "Asia/Kuala_Lumpur", "madrid": "Europe/Madrid",
                   "singapore": "Asia/Singapore", "wellington": "Pacific/Auckland",
                   "ankara": "Europe/Istanbul", "helsinki": "Europe/Helsinki"}
        for r in read_csv("live_fills.csv"):
            t = parse_ts(r["created_at"])
            td = r["target_date"][:10]
            tzn = city_tz.get(r["city"], "UTC")
            local = t.astimezone(ZoneInfo(tzn))
            fl = floor_at(adv, r["icao"], td, t)
            lo = float(r["low_native"]) if r["low_native"] else None
            hi = float(r["high_native"]) if r["high_native"] else None
            lo_c = to_c(lo, r["unit"]) if lo is not None else None
            hi_c = to_c(hi, r["unit"]) if hi is not None else None
            gap = (lo_c - fl) if (lo_c is not None and fl is not None) else None
            dead = hi_c is not None and fl is not None and hi_c < fl - 1e-9
            row = {"cityday": f"{r['city']}|{td}", "floor_dead": dead, "gap_c": gap,
                   "local_hour": local.hour + local.minute / 60.0}
            win = (int(r["winner_idx"]) == int(r["bucket_idx"])) if r["winner_idx"] else None
            cost = float(r["avg_price"]) * float(r["size_matched"])
            live.append({"filledAt": r["created_at"], "city": r["city"], "day": td,
                         "label": r["label"], "avgPrice": float(r["avg_price"]),
                         "costUsd": round(cost, 2), "localHour": round(row["local_hour"], 1),
                         "floorC": fl, "gapC": gap, "floorDead": dead,
                         "vetoed": veto_fires(row, g, h),
                         "won": win, "resolved": r["winner_idx"] != ""})
        result["liveFills"] = live

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "panel.csv"), "w", newline="", encoding="utf-8") as f:
        if panel:
            w = csv.DictWriter(f, fieldnames=list(panel[0].keys()))
            w.writeheader()
            w.writerows(panel)
    with open(os.path.join(OUT, "RESULT.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, default=str)

    print(json.dumps({k: v for k, v in result.items() if k not in ("sweepTrain", "liveFills")},
                     indent=1, default=str)[:6000])
    print("\nSWEEP (train, sorted by vetoedCiHigh — most confidently negative first):")
    for s in sweep[:10]:
        print(f"  gap≥{s['gap']:>3}°C hour≥{s['hour']:>2}  n={s['nVetoed']:>4}  "
              f"mean={s['vetoedMean']:+.3f}  CI[{s['vetoedCiLow']:+.3f},{s['vetoedCiHigh']:+.3f}]")
    print("\nRESULT " + json.dumps({"frozen": best,
                                    "test": result.get("eval_test", {}).get("vetoed"),
                                    "lane": {k: v for k, v in result.get("laneReplay", {}).items()
                                             if k != "entries"}}, default=str))


if __name__ == "__main__":
    main()
