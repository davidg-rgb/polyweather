#!/usr/bin/env python3
"""
nonprice_conditional — the SUFFICIENT-STATISTIC test for the non-price winner fingerprint.

Question: at any instant the market MID `p` is its own win-probability estimate. Does any NON-PRICE
path feature (momentum, drawdown, oscillation count, dwell, vol, ...) carry RESIDUAL predictive power
about the eventual outcome BEYOND the price — E[won | p, feature] != E[won | p] — by more than the
cost hurdle? If not, price is a sufficient statistic and there is no fingerprint edge.

Method (price-controlled, cluster-honest):
  1. Restrict to the tradable band p in [BAND_LO, BAND_HI].
  2. Bin instants by price (BIN_W wide). Within each price bin, split each feature at its median into
     hi/lo. Because the split is WITHIN a price bin, the hi and lo groups have MATCHED price
     distributions — so winrate(hi) - winrate(lo) is the pure price-controlled residual info ("lift").
  3. Cluster on CITY: per city compute (winrate_hi - winrate_lo) and each group's frictionless EV
     (won - p); aggregate mean +- t*SE across cities (the frozen-gate independent unit). A feature is
     a candidate ONLY if the lift CI excludes 0 AND a tradeable side's EV beats the cost hurdle.

Input:  scripts/research/out/nonprice-fingerprint-panel.csv  (from nonprice-fingerprint-panel.ts)
Output: prints a ranked table + per-decile resid curves for the top features; writes
        out/nonprice-conditional-summary.json and, for any survivor, a gate panel CSV.

Run: python scripts/research/nonprice_conditional.py
"""
import csv
import json
import math
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PANEL = os.path.join(HERE, "out", "nonprice-fingerprint-panel.csv")
OUT_JSON = os.path.join(HERE, "out", "nonprice-conditional-summary.json")

BAND_LO, BAND_HI = 0.05, 0.60
BIN_W = 0.05
COST_HURDLE = 0.04       # frictionless EV must beat ~fee+half-spread to be a tradeable side
MIN_CITY_N = 40          # drop a city from a group if it has <this many instants (noisy per-city lift)
Z = 1.959963984540054

FEATURES = ["mom1h", "mom3h", "mom6h", "accel", "drawdown", "runup",
            "hrs_since_peak", "osc_count", "vol_so_far", "dwell_frac"]


def t_crit(df):
    if df <= 0:
        return float("nan")
    if df >= 30:
        return Z
    table = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
             8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 25: 2.060, 29: 2.045}
    keys = sorted(table)
    for k in keys:
        if df <= k:
            return table[k]
    return Z


def mean_ci(vals):
    n = len(vals)
    if n == 0:
        return float("nan"), float("nan"), float("nan"), 0
    m = sum(vals) / n
    if n == 1:
        return m, float("nan"), float("nan"), 1
    var = sum((v - m) ** 2 for v in vals) / (n - 1)
    se = math.sqrt(var / n)
    h = t_crit(n - 1) * se
    return m, m - h, m + h, n


def load():
    rows = []
    with open(PANEL, newline="") as f:
        r = csv.DictReader(f)
        for d in r:
            try:
                p = float(d["p"])
            except (ValueError, KeyError):
                continue
            if not (BAND_LO <= p <= BAND_HI):
                continue
            rec = {"city": d["city"], "date": d["target_date"], "won": int(d["won"]), "p": p,
                   "pbin": int((p - BAND_LO) / BIN_W)}
            for feat in FEATURES:
                v = d.get(feat, "")
                rec[feat] = float(v) if v not in ("", None) else None
            rows.append(rec)
    return rows


def analyze_feature(rows, feat):
    """Within-price-bin median split on `feat`; city-clustered lift + hi/lo frictionless EV."""
    # per (pbin) median of the feature over non-null instants
    by_bin = defaultdict(list)
    for r in rows:
        if r[feat] is not None:
            by_bin[r["pbin"]].append(r[feat])
    med = {b: sorted(v)[len(v) // 2] for b, v in by_bin.items() if len(v) >= 4}

    # per city accumulate hi/lo won and (won-p)
    # groups[city] = {'hi_won':[], 'lo_won':[], 'hi_res':[], 'lo_res':[]}
    g = defaultdict(lambda: {"hw": 0, "hn": 0, "lw": 0, "ln": 0, "hres": 0.0, "lres": 0.0})
    pooled = {"hw": 0, "hn": 0, "lw": 0, "ln": 0, "hres": 0.0, "lres": 0.0}
    # per-decile resid curve (pooled, price-controlled by demeaning within pbin)
    binbase = {}
    tmp = defaultdict(lambda: [0, 0])
    for r in rows:
        tmp[r["pbin"]][0] += r["won"]
        tmp[r["pbin"]][1] += 1
    for b, (w, n) in tmp.items():
        binbase[b] = w / n if n else 0.0

    decile_vals = []  # (feat_value, won - p, adj = won - binbase)
    for r in rows:
        v = r[feat]
        if v is None or r["pbin"] not in med:
            continue
        hi = v >= med[r["pbin"]]
        c = g[r["city"]]
        res = r["won"] - r["p"]
        if hi:
            c["hw"] += r["won"]; c["hn"] += 1; c["hres"] += res
            pooled["hw"] += r["won"]; pooled["hn"] += 1; pooled["hres"] += res
        else:
            c["lw"] += r["won"]; c["ln"] += 1; c["lres"] += res
            pooled["lw"] += r["won"]; pooled["ln"] += 1; pooled["lres"] += res
        decile_vals.append((v, res, r["won"] - binbase[r["pbin"]]))

    # EXTREME-TAIL check: within each price bin, the TOP/BOTTOM feature-decile's absolute frictionless
    # EV (won - p), city-clustered. Answers "is even the most extreme feature value tradeable?"
    # per bin, sort instants by feature, take top/bottom 10%.
    by_bin_rows = defaultdict(list)
    for r in rows:
        if r[feat] is not None and r["pbin"] in med:
            by_bin_rows[r["pbin"]].append(r)
    td = defaultdict(lambda: {"tres": 0.0, "tn": 0, "bres": 0.0, "bn": 0})  # per city
    for b, rr in by_bin_rows.items():
        rr.sort(key=lambda x: x[feat])
        k10 = max(1, len(rr) // 10)
        for x in rr[-k10:]:
            td[x["city"]]["tres"] += x["won"] - x["p"]; td[x["city"]]["tn"] += 1
        for x in rr[:k10]:
            td[x["city"]]["bres"] += x["won"] - x["p"]; td[x["city"]]["bn"] += 1

    # per-city lift + EVs (drop cities with thin groups)
    lifts, hires, lores, tev, bev = [], [], [], [], []
    for city, c in g.items():
        if c["hn"] < MIN_CITY_N or c["ln"] < MIN_CITY_N:
            continue
        lifts.append(c["hw"] / c["hn"] - c["lw"] / c["ln"])
        hires.append(c["hres"] / c["hn"])
        lores.append(c["lres"] / c["ln"])
        t = td.get(city, {})
        if t.get("tn", 0) >= MIN_CITY_N // 2:
            tev.append(t["tres"] / t["tn"])
        if t.get("bn", 0) >= MIN_CITY_N // 2:
            bev.append(t["bres"] / t["bn"])

    lift_m, lift_lo, lift_hi, ncity = mean_ci(lifts)
    hi_m, hi_lo, hi_hi, _ = mean_ci(hires)
    lo_m, lo_lo, lo_hi, _ = mean_ci(lores)
    tev_m, tev_lo, tev_hi, _ = mean_ci(tev)
    bev_m, bev_lo, bev_hi, _ = mean_ci(bev)

    # pooled point estimates
    pooled_lift = (pooled["hw"] / pooled["hn"] if pooled["hn"] else float("nan")) - \
                  (pooled["lw"] / pooled["ln"] if pooled["ln"] else float("nan"))
    pooled_hi_res = pooled["hres"] / pooled["hn"] if pooled["hn"] else float("nan")
    pooled_lo_res = pooled["lres"] / pooled["ln"] if pooled["ln"] else float("nan")

    # decile resid curve (adj = price-demeaned won) — reveals non-monotonic structure the split misses
    decile_vals.sort(key=lambda x: x[0])
    ndec = 10
    curve = []
    if decile_vals:
        per = max(1, len(decile_vals) // ndec)
        for d in range(ndec):
            chunk = decile_vals[d * per:(d + 1) * per] if d < ndec - 1 else decile_vals[d * per:]
            if not chunk:
                continue
            fv = sum(x[0] for x in chunk) / len(chunk)
            adj = sum(x[2] for x in chunk) / len(chunk)  # price-controlled residual win-rate
            curve.append((round(fv, 4), round(adj, 4), len(chunk)))

    return {
        "feature": feat, "n_cities": ncity,
        "lift": lift_m, "lift_ci": [lift_lo, lift_hi], "pooled_lift": pooled_lift,
        "hi_ev": hi_m, "hi_ev_ci": [hi_lo, hi_hi], "pooled_hi_ev": pooled_hi_res,
        "lo_ev": lo_m, "lo_ev_ci": [lo_lo, lo_hi], "pooled_lo_ev": pooled_lo_res,
        "top_decile_ev": tev_m, "top_decile_ev_ci": [tev_lo, tev_hi],
        "bot_decile_ev": bev_m, "bot_decile_ev_ci": [bev_lo, bev_hi],
        "decile_curve": curve,
    }


def pct(x):
    return f"{x*100:+.2f}pp" if isinstance(x, float) and math.isfinite(x) else "  n/a "


def main():
    if not os.path.exists(PANEL):
        print(f"no panel at {PANEL} — run nonprice-fingerprint-panel.ts first", file=sys.stderr)
        sys.exit(1)
    rows = load()
    cities = len({r["city"] for r in rows})
    days = len({r["date"] for r in rows})
    print(f"loaded {len(rows):,} in-band instants · {cities} cities · {days} days · band [{BAND_LO},{BAND_HI}]\n")

    results = [analyze_feature(rows, f) for f in FEATURES]
    # rank by |city-clustered lift|
    results.sort(key=lambda r: -(abs(r["lift"]) if math.isfinite(r["lift"]) else 0))

    print("SUFFICIENT-STATISTIC TEST — residual info of each feature BEYOND price (city-clustered)")
    print("  lift = winrate(hi-feature) - winrate(lo-feature) at matched price (price-controlled)")
    print("  hi_EV/lo_EV = frictionless EV (won - p) of the hi/lo group; beat +/-{:.0f}pp to trade\n".format(COST_HURDLE*100))
    print(f"  {'feature':<14} {'lift':>9} {'lift 95% CI':>22}  {'hi_EV':>8} {'lo_EV':>8}  cities  verdict")
    print("  " + "-" * 88)
    survivors = []
    for r in results:
        lift_ci = f"[{pct(r['lift_ci'][0])},{pct(r['lift_ci'][1])}]"
        lift_sig = math.isfinite(r["lift_ci"][0]) and (r["lift_ci"][0] > 0 or r["lift_ci"][1] < 0)
        # a tradeable side needs a group whose frictionless EV beats the cost hurdle — check the median
        # split AND the extreme decile (the strongest form of the feature)
        hi_trade = (math.isfinite(r["hi_ev_ci"][0]) and r["hi_ev_ci"][0] > COST_HURDLE) or \
                   (math.isfinite(r["top_decile_ev_ci"][0]) and r["top_decile_ev_ci"][0] > COST_HURDLE)
        lo_trade = (math.isfinite(r["lo_ev_ci"][1]) and r["lo_ev_ci"][1] < -COST_HURDLE) or \
                   (math.isfinite(r["bot_decile_ev_ci"][1]) and r["bot_decile_ev_ci"][1] < -COST_HURDLE)
        verdict = "CANDIDATE" if (lift_sig and (hi_trade or lo_trade)) else ("lift≠0" if lift_sig else "null")
        if verdict == "CANDIDATE":
            survivors.append(r)
        print(f"  {r['feature']:<14} {pct(r['lift']):>9} {lift_ci:>22}  {pct(r['hi_ev']):>8} {pct(r['lo_ev']):>8}   {r['n_cities']:>3}   {verdict}")

    print("\nEXTREME-TAIL EV — frictionless EV (won - p) of the TOP / BOTTOM feature-DECILE, within-price-bin, city-clustered")
    print("  (the strongest form of each feature; must beat +4pp to BUY the top or -4pp to FADE the bottom):")
    print(f"  {'feature':<14} {'top-decile EV':>16} {'bottom-decile EV':>18}")
    for r in results:
        tci = f"[{pct(r['top_decile_ev_ci'][0])},{pct(r['top_decile_ev_ci'][1])}]"
        bci = f"[{pct(r['bot_decile_ev_ci'][0])},{pct(r['bot_decile_ev_ci'][1])}]"
        print(f"  {r['feature']:<14} {pct(r['top_decile_ev']):>7} {tci:<24} {pct(r['bot_decile_ev']):>7} {bci}")

    print("\nDECILE RESID CURVES (price-controlled won-rate residual by feature decile; flat = no info):")
    for r in results[:4]:
        curve = " ".join(f"{c[1]*100:+.1f}" for c in r["decile_curve"])
        print(f"  {r['feature']:<14} D1..D10: {curve}")

    with open(OUT_JSON, "w") as f:
        json.dump({"n": len(rows), "cities": cities, "days": days, "cost_hurdle": COST_HURDLE,
                   "results": results, "survivors": [s["feature"] for s in survivors]}, f, indent=1)
    print(f"\n{'CANDIDATE(S): ' + ', '.join(s['feature'] for s in survivors) if survivors else 'NO CANDIDATE — price is a sufficient statistic (no non-price fingerprint edge).'}")
    print(f"summary → {OUT_JSON}")


if __name__ == "__main__":
    main()
