#!/usr/bin/env python3
"""
nonprice_fade_gate — gate the two STRONGEST extreme-cohort trades from the sufficient-statistic test.

The cheap gate (nonprice_conditional.py) found NO feature lifts a group to positive EV, but the
extreme deciles of the top features are the closest thing to a signal:
  - TOP-decile runup (bucket has climbed most from its low, at a given price) -> BUY YES, hold.
  - BOTTOM-decile runup (unmoved cheap bucket, overpriced ~-4.5pp) -> FADE (buy NO), hold.
This builds each as a hold-to-resolution trade net of REAL costs (execAsk via the committed
CALIBRATED_BOOK synthetic-book spread model + 0.05*p*(1-p) fee) and emits a §9R-E gate panel.
Buying YES: cost=execAsk(p)+fee, proceeds = won?1:0. Fading (buy NO): cost=execAsk(1-p)+fee,
proceeds = won?0:1. One trade per (event,bucket) at its FIRST qualifying instant (no pseudo-rep).

Run: python scripts/research/nonprice_fade_gate.py
Then: python <skill>/analytics.py gate --panel out/nonprice-fade-buy.csv   (and -fade.csv)
"""
import csv
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PANEL = os.path.join(HERE, "out", "nonprice-fingerprint-panel.csv")
OUT_BUY = os.path.join(HERE, "out", "nonprice-fade-buy.csv")
OUT_FADE = os.path.join(HERE, "out", "nonprice-fade-fade.csv")

BAND_LO, BAND_HI = 0.05, 0.60
BIN_W = 0.05
FEE = 0.05
FEATURE = "runup"

# CALIBRATED_BOOK (history-replay-ingest.ts): (mid, askOver, bidOver)
BOOK = [(0.07, 0.04, 0.022), (0.12, 0.018, 0.019), (0.17, 0.015, 0.014), (0.23, 0.0125, 0.011),
        (0.27, 0.01, 0.01), (0.33, 0.01, 0.01), (0.37, 0.01, 0.01), (0.43, 0.005, 0.005), (0.48, 0.005, 0.005)]


def _interp(mid, col):
    if mid <= BOOK[0][0]:
        return BOOK[0][col]
    if mid >= BOOK[-1][0]:
        return BOOK[-1][col]
    for i in range(1, len(BOOK)):
        a, b = BOOK[i - 1], BOOK[i]
        if mid <= b[0]:
            w = (mid - a[0]) / (b[0] - a[0])
            return a[col] + w * (b[col] - a[col])
    return BOOK[-1][col]


def ask_over(mid):
    return _interp(mid, 1)


def bid_over(mid):
    return _interp(mid, 2)


def fee(p):
    return FEE * p * (1 - p)


def load():
    rows = []
    with open(PANEL, newline="") as f:
        for d in csv.DictReader(f):
            try:
                p = float(d["p"]); ru = d.get(FEATURE, "")
            except (ValueError, KeyError):
                continue
            if ru in ("", None) or not (BAND_LO <= p <= BAND_HI):
                continue
            rows.append({"city": d["city"], "date": d["target_date"], "ev": d["event_id"],
                         "bk": d["bucket_idx"], "won": int(d["won"]), "p": p, "ru": float(ru),
                         "pbin": int((p - BAND_LO) / BIN_W)})
    return rows


def buy_yes(p, won, mult=1.0):
    ea = min(0.999, p + ask_over(p) * mult)
    cost = ea + fee(ea)
    proceeds = 1.0 if won else 0.0
    return proceeds - cost, cost


def buy_no(p, won, mult=1.0):
    # CORRECT fade cost: buying NO at ask == crossing the YES BID. NO_ask = (1-p) + bidOver(p).
    # bidOver is evaluated at the YES price p (the cheap zone, where CALIBRATED_BOOK IS valid) — NOT
    # askOver(1-p), which clamps to 0.5c at NO~0.9 and grossly understates the real fade cost.
    no_ask = min(0.999, (1 - p) + bid_over(p) * mult)
    cost = no_ask + fee(no_ask)
    proceeds = 0.0 if won else 1.0   # NO redeems $1 iff the bucket LOST
    return proceeds - cost, cost


def compute_thr(rows_for_fit):
    by_bin = defaultdict(list)
    for r in rows_for_fit:
        by_bin[r["pbin"]].append(r["ru"])
    thr = {}
    for b, v in by_bin.items():
        v.sort()
        n = len(v)
        thr[b] = (v[int(n * 0.9)] if n >= 10 else v[-1], v[int(n * 0.1)] if n >= 10 else v[0])  # (top10%, bot10%)
    return thr


def emit_fade_oos(rows, split_date):
    """OOS: fit decile thresholds on TRAIN dates, apply to TEST; emit a TEST-only fade panel (x1.0)."""
    train = [r for r in rows if r["date"] < split_date]
    test = [r for r in rows if r["date"] >= split_date]
    thr = compute_thr(train)
    seen = set()
    lines = ["city,target_date,net_return,net_pnl_usd"]
    for r in test:
        if r["pbin"] not in thr:
            continue
        _, bot = thr[r["pbin"]]
        key = (r["ev"], r["bk"])
        if r["ru"] <= bot and key not in seen:
            seen.add(key)
            pnl, cost = buy_no(r["p"], r["won"], 1.0)
            lines.append(f"{r['city']},{r['date']},{pnl / cost:.6f},{pnl:.6f}")
    path = OUT_FADE.replace(".csv", "-OOS-test.csv")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"OOS FADE (thresholds fit on TRAIN<{split_date}, TEST-only): {len(lines)-1} trades -> {path}")


def main():
    rows = load()
    # OOS split (fit runup-decile thresholds on TRAIN, apply to TEST) — split ~70/30 by date
    dates = sorted({r["date"] for r in rows})
    split_date = dates[int(len(dates) * 0.7)]
    emit_fade_oos(rows, split_date)
    thr = compute_thr(rows)

    # one trade per (event,bucket): first qualifying instant. FADE emitted at 3 spread multiples.
    seen_buy, seen_fade = set(), set()
    buy_lines = ["city,target_date,net_return,net_pnl_usd"]
    fade_lines = {m: ["city,target_date,net_return,net_pnl_usd"] for m in (1.0, 1.5, 2.0)}
    nb = nf = 0
    faded_prices = []
    for r in rows:
        top, bot = thr[r["pbin"]]
        key = (r["ev"], r["bk"])
        if r["ru"] >= top and key not in seen_buy:
            seen_buy.add(key)
            pnl, cost = buy_yes(r["p"], r["won"])
            buy_lines.append(f"{r['city']},{r['date']},{pnl / cost:.6f},{pnl:.6f}")
            nb += 1
        if r["ru"] <= bot and key not in seen_fade:
            seen_fade.add(key)
            faded_prices.append(r["p"])
            for m in (1.0, 1.5, 2.0):
                pnl, cost = buy_no(r["p"], r["won"], m)
                fade_lines[m].append(f"{r['city']},{r['date']},{pnl / cost:.6f},{pnl:.6f}")
            nf += 1

    with open(OUT_BUY, "w") as f:
        f.write("\n".join(buy_lines) + "\n")
    for m in (1.0, 1.5, 2.0):
        path = OUT_FADE.replace(".csv", f"-x{m}.csv")
        with open(path, "w") as f:
            f.write("\n".join(fade_lines[m]) + "\n")
    mean_p = sum(faded_prices) / len(faded_prices) if faded_prices else float("nan")
    print(f"BUY (top-decile {FEATURE}, hold YES): {nb} trades -> {OUT_BUY}")
    print(f"FADE (bottom-decile {FEATURE}, buy NO): {nf} trades · mean faded YES price {mean_p:.3f} "
          f"(cheap-longshot cohort if low) -> {OUT_FADE.replace('.csv','-x{1.0,1.5,2.0}.csv')}")


if __name__ == "__main__":
    main()
