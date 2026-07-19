#!/usr/bin/env python3
"""scripts/research/breakeven-skill — THE BREAKEVEN SKILL TARGET (2026-07-09 project-review item).

THE QUESTION (framed as a bet, per the skill workflow): *"For a taker buying bucket B at the all-in
executable cost, how many percentage points of win-probability must a signal add BEYOND the price to
be +EV — and how many pp does OUR causal forecast actually add?"* This number adjudicates the entire
"invest in forecast skill to trade" route BEFORE spending on it (e.g. the >=12-month historical-forecast
backfill): if the required lift is an order of magnitude above the achieved lift, no incremental
forecast investment closes it, and forecast work is honestly re-scoped as analytics value.

METHOD (all prior traps respected):
  * Panel: per (event, bucket) at a fixed entry lead (24h primary / 48h robustness): archive MID,
    all-in cost c = CANONICAL calibrated-book exec ask + taker fee (cost_model.py — zero-drift mirror
    of core CALIBRATED_BOOK), won in {0,1}, is_pred = "our CAUSAL walk-forward forecast picks this
    bucket" (city-accuracy.ts --emit-forecast; no hindsight — trap: the archive's pred_c_l1 is
    look-ahead, NEVER used here).
  * Required lift per mid band:  delta_req = mean(all-in cost) - band win rate. This is what ANY
    signal must add within the band for taker-buying to break even (longshot tax + spread + fee).
  * Achieved lift per mid band:  delta_ours = P(won | ours, band) - P(won | band). Exactly the C22
    sufficient-statistic test E[won|price,feature] vs E[won|price], with our own forecast as the
    feature, priced against the requirement instead of only against zero.
  * CI: day-clustered bootstrap (city x date clusters) on delta_ours; band win rates are also
    reported event-clustered. Deterministic seed.
  * Bucket match by PARSING TEMPERATURE FROM label (bucket_idx is raw gamma order - trap #7).

Read-only. Reads the local parquet archive + the causal-forecast CSV; writes only out/. No DB, no trade.

Run:
  pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
  python scripts/research/breakeven-skill.py --entry-lead-h 24
  python scripts/research/breakeven-skill.py --selftest
"""
import argparse
import csv
import json
import re
import sys

import cost_model  # the canonical calibrated-book cost model (parses core's CALIBRATED_BOOK)

ARCHIVE = "scripts/research/out/market-history-flat-enriched.parquet"
CAUSAL_CSV = "scripts/research/out/causal-forecast.csv"
OUT_JSON = "scripts/research/out/breakeven-skill.json"

# mid-price bands (fractions). The tradable-cheap zone is where every dead buy strategy lived; the
# upper bands complete the curve (C19/C23 T1 calibration found the whole range efficient).
BANDS = [(0.03, 0.05), (0.05, 0.10), (0.10, 0.15), (0.15, 0.20), (0.20, 0.30), (0.30, 0.40), (0.40, 0.55)]

# slug -> forecast-station ICAO (mirrors city-buy-table.py / pnl-backtest.py SLUG2ICAO).
SLUG2ICAO = {
    "amsterdam": "EHAM", "beijing": "ZBAA", "chengdu": "ZUUU", "guangzhou": "ZGGG", "kuala-lumpur": "WMKK",
    "madrid": "LEMD", "manila": "RPLL", "paris": "LFPB", "qingdao": "ZSQD", "shanghai": "ZSPD",
    "ankara": "LTAC", "atlanta": "KATL", "austin": "KAUS", "buenos-aires": "SAEZ", "busan": "RKPK",
    "cape-town": "FACT", "chicago": "KORD", "chongqing": "ZUCK", "dallas": "KDAL", "denver": "KBKF",
    "helsinki": "EFHK", "houston": "KHOU", "jeddah": "OEJN", "karachi": "OPKC", "london": "EGLC",
    "los-angeles": "KLAX", "lucknow": "VILK", "mexico-city": "MMMX", "miami": "KMIA", "milan": "LIMC",
    "munich": "EDDM", "nyc": "KLGA", "panama-city": "MPMG", "san-francisco": "KSFO", "sao-paulo": "SBGR",
    "seattle": "KSEA", "seoul": "RKSI", "shenzhen": "ZGSZ", "singapore": "WSSS", "taipei": "RCSS",
    "tokyo": "RJTT", "toronto": "CYYZ", "warsaw": "EPWA", "wellington": "NZWN", "wuhan": "ZHHH",
}


def parse_temp(label):
    """(kind, lo, hi) from a bucket label; kind in exact|below|above (city-buy-table.py mirror). °F labels
    are 2-degree BANDS ("86-87°F") — the pre-2026-07-19 first-integer parse matched only the LOW edge, so
    a °F prediction landing on the band's upper degree missed its bucket (PERSISTENCE-BLEND.md rails)."""
    s = str(label)
    ll = s.lower()
    mr = re.search(r"(-?\d+)\s*-\s*(-?\d+)", s)
    m = re.search(r"(-?\d+)", s)
    if not m:
        return None
    if any(w in ll for w in ("below", "lower", "under", "colder")):
        return ("below", int(m.group(1)), int(m.group(1)))
    if any(w in ll for w in ("higher", "above", "over", "hotter")):
        return ("above", int(m.group(1)), int(m.group(1)))
    if mr:
        lo, hi = int(mr.group(1)), int(mr.group(2))
        return ("exact", min(lo, hi), max(lo, hi))
    v = int(m.group(1))
    return ("exact", v, v)


def choose(buckets, pred_int):
    """Pick the bucket idx whose native-degree range CONTAINS pred_int; buckets: (idx,kind,lo,hi)."""
    for idx, k, lo, hi in buckets:
        if k == "exact" and lo <= pred_int <= hi:
            return idx
    for idx, k, lo, _hi in buckets:
        if k == "below" and pred_int <= lo:
            return idx
    for idx, k, lo, _hi in buckets:
        if k == "above" and pred_int >= lo:
            return idx
    return None


def band_of(mid):
    for lo, hi in BANDS:
        if lo <= mid < hi:
            return f"{int(lo * 100)}-{int(hi * 100)}c"
    return None


def load_causal(path, lead):
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if int(row["lead"]) != lead:
                continue
            out[(row["icao"], row["target_date"])] = int(row["mu_native"])
    return out


def selftest():
    assert parse_temp("15C") == ("exact", 15, 15)
    assert parse_temp("7C or below") == ("below", 7, 7)
    assert parse_temp("86-87F") == ("exact", 86, 87)  # the °F 2-degree band
    bks = [(0, "below", 7, 7), (1, "exact", 14, 15), (2, "above", 17, 17)]
    assert choose(bks, 15) == 1 and choose(bks, 14) == 1  # both band edges contained
    assert choose(bks, 3) == 0 and choose(bks, 20) == 2
    assert band_of(0.12) == "10-15c" and band_of(0.05) == "5-10c" and band_of(0.60) is None
    cost_model.selftest()
    # all-in cost at a knot: exec 0.138 + fee 0.05*0.138*0.862
    c = all_in_cost(0.12)
    assert abs(c - (0.138 + 0.05 * 0.138 * (1 - 0.138))) < 1e-9
    print("selftest OK", file=sys.stderr)


def all_in_cost(mid):
    q = cost_model.synth_quote(mid)
    if q is None:
        return None
    return min(0.999, q["exec_ask"] + cost_model.taker_fee_per_share(q["exec_ask"], 0.05))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead", type=int, default=1, help="forecast lead-day (causal CSV)")
    ap.add_argument("--entry-lead-h", type=int, default=24, help="entry snapshot: hours before market close")
    ap.add_argument("--archive", default=ARCHIVE)
    ap.add_argument("--causal", default=CAUSAL_CSV)
    ap.add_argument("--emit", default=OUT_JSON)
    ap.add_argument("--iters", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return
    selftest()

    import pyarrow.parquet as _pq  # noqa: F401  (precede dataset import on this Windows build)
    import pyarrow.dataset as ds
    import pyarrow.compute as pc
    import numpy as np
    import pandas as pd

    causal = load_causal(a.causal, a.lead)
    dset = ds.dataset(a.archive, format="parquet")
    cities = sorted(pc.unique(dset.to_table(columns=["city"]).column("city")).to_pylist())
    L = a.entry_lead_h

    rows = []
    for city in cities:
        icao = SLUG2ICAO.get(city)
        if not icao:
            continue
        tbl = dset.to_table(
            filter=(pc.field("city") == city),
            columns=["event_id", "target_date", "end_ts", "bucket_idx", "label", "resolved_outcome", "t", "p"],
        )
        df = tbl.to_pandas()
        if df.empty:
            continue
        for _, g in df.groupby("event_id", sort=False):
            date = str(g.target_date.iloc[0])
            cnat = causal.get((icao, date))
            if cnat is None:
                continue  # only events where a causal forecast exists (keeps ours/band populations aligned)
            end_ts = int(g.end_ts.iloc[0])
            targ = end_ts - L * 3600
            meta, mids, outcomes = [], {}, {}
            for idx, bg in g.groupby("bucket_idx", sort=False):
                pt = parse_temp(bg.label.iloc[0])
                if not pt:
                    continue
                s = bg.sort_values("t")
                ts = s.t.values.astype(np.int64)
                ps = s.p.values.astype(float)
                j = int(np.searchsorted(ts, targ))
                j = min(max(j, 0), len(ts) - 1)
                if j > 0 and abs(ts[j - 1] - targ) < abs(ts[j] - targ):
                    j -= 1
                meta.append((int(idx), pt[0], pt[1], pt[2]))
                mids[int(idx)] = float(ps[j])
                outcomes[int(idx)] = str(bg.resolved_outcome.iloc[0])
            if not any(v == "win" for v in outcomes.values()):
                continue  # unresolved / grading-ambiguous event
            pred_idx = choose(meta, int(cnat))
            for idx, _k, _lo, _hi in meta:
                mid = mids[idx]
                band = band_of(mid)
                if band is None:
                    continue
                c = all_in_cost(mid)
                if c is None:
                    continue
                rows.append({
                    "city": city, "date": date, "band": band,
                    "mid": mid, "cost": c,
                    "won": outcomes[idx] == "win",
                    "ours": pred_idx is not None and idx == pred_idx,
                })

    b = pd.DataFrame(rows)
    log = lambda *x: print(*x, file=sys.stderr)
    if b.empty:
        log("no rows — check the archive/causal paths")
        return
    rng = np.random.default_rng(a.seed)

    def day_boot(d, iters, stat):
        """Day-clustered bootstrap 95% CI on an arbitrary panel statistic (pp units)."""
        keys = (d.city + "|" + d.date).values
        uk = np.array(sorted(set(keys)))
        idxby = {k: np.where(keys == k)[0] for k in uk}
        won = d.won.values.astype(float)
        ours = d.ours.values
        cost = d.cost.values
        est = []
        for _ in range(iters):
            sel = np.concatenate([idxby[k] for k in rng.choice(uk, len(uk), replace=True)])
            v = stat(won[sel], ours[sel], cost[sel])
            if v == v:  # skip NaN resamples (no ours rows drawn)
                est.append(v)
        if not est:
            return (float("nan"), float("nan"))
        est = np.sort(np.array(est))
        return float(est[int(0.025 * len(est))]), float(est[int(0.975 * len(est))])

    def stat_lift(w, o, _c):
        return 100 * (w[o].mean() - w.mean()) if o.sum() > 0 else float("nan")

    def stat_ev_ours(w, o, c):
        # the decision-relevant number: EV per $1 of BUYING our bucket at its own all-in cost —
        # immune to the within-band composition artifact (our bucket clusters at the band's top,
        # and price carries win-prob even inside a 10c band, inflating the naive lift-vs-req read).
        return 100 * (w[o].mean() - c[o].mean()) if o.sum() > 0 else float("nan")

    log(f"\nBREAKEVEN SKILL TARGET — entry {L}h before close, causal lead {a.lead}, calibrated all-in cost")
    log(f"  {'band':>8} {'n':>6} {'n_ours':>6} | {'win%':>6} {'cost%':>6} {'REQ Δ':>7} | {'OURS Δ':>7} {'Δ 95% CI':>16} | {'mid all/ours':>12} | {'EV(buy ours)':>12} {'EV 95% CI':>16}")
    per_band = []
    for lo, hi in BANDS:
        band = f"{int(lo * 100)}-{int(hi * 100)}c"
        d = b[b.band == band]
        if len(d) < 50:
            continue
        w_band = 100 * d.won.mean()
        c_band = 100 * d.cost.mean()
        req = c_band - w_band
        do = d[d.ours]
        w_ours = 100 * do.won.mean() if len(do) else float("nan")
        ours_lift = w_ours - w_band if len(do) else float("nan")
        thin = len(do) < 5
        clo, chi = (float("nan"), float("nan")) if thin else day_boot(d, a.iters, stat_lift)
        # the composition diagnostic + the composition-free decision number
        mid_all = 100 * d.mid.mean()
        mid_ours = 100 * do.mid.mean() if len(do) else float("nan")
        ev = 100 * (do.won.mean() - do.cost.mean()) if len(do) else float("nan")
        elo, ehi = (float("nan"), float("nan")) if thin else day_boot(d, a.iters, stat_ev_ours)
        per_band.append({
            "band": band, "n": int(len(d)), "n_ours": int(len(do)),
            "win_pct": round(w_band, 2), "cost_pct": round(c_band, 2), "req_lift_pp": round(req, 2),
            "ours_win_pct": round(w_ours, 2) if w_ours == w_ours else None,
            "ours_lift_pp": round(ours_lift, 2) if ours_lift == ours_lift else None,
            "ours_lift_ci_pp": [round(clo, 2), round(chi, 2)] if clo == clo else None,
            "mid_all_pct": round(mid_all, 2), "mid_ours_pct": round(mid_ours, 2) if mid_ours == mid_ours else None,
            "ev_buy_ours_pct": round(ev, 2) if ev == ev else None,
            "ev_buy_ours_ci_pct": [round(elo, 2), round(ehi, 2)] if elo == elo else None,
        })
        log(f"  {band:>8} {len(d):>6} {len(do):>6} | {w_band:>5.1f}% {c_band:>5.1f}% {req:>+6.1f}pp | "
            f"{ours_lift:>+6.1f}pp [{clo:>+5.1f},{chi:>+5.1f}] | {mid_all:>4.1f}/{mid_ours:>4.1f}¢ | "
            f"{ev:>+10.1f}% [{elo:>+5.1f},{ehi:>+5.1f}]")

    # pooled over the buyable cheap zone (mid 5–40¢ — where every dead buy strategy lived)
    zone = b[b.band.isin(["5-10c", "10-15c", "15-20c", "20-30c", "30-40c"])]
    zo = zone[zone.ours]
    req_pool = 100 * (zone.cost.mean() - zone.won.mean())
    ours_pool = 100 * (zo.won.mean() - zone.won.mean())
    plo, phi = day_boot(zone, a.iters, stat_lift)
    # EV of actually buying our bucket at all-in cost, per $1 — the composition-free verdict number
    ev_ours = 100 * (zo.won.mean() - zo.cost.mean())
    evlo, evhi = day_boot(zone, a.iters, stat_ev_ours)
    log(f"\nPOOLED cheap zone (mid 5–40¢): required lift {req_pool:+.1f}pp · naive ours lift {ours_pool:+.1f}pp "
        f"[{plo:+.1f},{phi:+.1f}] (composition-inflated: mid|ours {100 * zo.mid.mean():.1f}¢ vs {100 * zone.mid.mean():.1f}¢ all)")
    log(f"VERDICT NUMBER — buy-our-bucket EV at all-in cost: {ev_ours:+.1f}% per $1 [{evlo:+.1f},{evhi:+.1f}] "
        f"(negative/0-straddling = the market already prices our forecast)")

    result = {
        "script": "breakeven-skill",
        "params": {"entry_lead_h": L, "forecast_lead": a.lead, "iters": a.iters, "seed": a.seed,
                   "cost_basis": "calibrated_book_plus_taker_fee"},
        "universe": {"n_rows": int(len(b)), "n_events_approx": int(b.groupby(["city", "date"]).ngroups),
                     "n_cities": int(b.city.nunique()), "n_days": int(b.date.nunique()),
                     "date_range": [str(b.date.min()), str(b.date.max())]},
        "per_band": per_band,
        "pooled_cheap_zone": {
            "bands": "5-40c", "n": int(len(zone)), "n_ours": int(len(zo)),
            "req_lift_pp": round(req_pool, 2), "ours_lift_pp": round(ours_pool, 2),
            "ours_lift_ci_pp": [round(plo, 2), round(phi, 2)],
            "mid_all_pct": round(100 * zone.mid.mean(), 2), "mid_ours_pct": round(100 * zo.mid.mean(), 2),
            "ev_buy_ours_pct": round(ev_ours, 2),
            "ev_buy_ours_ci_pct": [round(evlo, 2), round(evhi, 2)],
        },
    }
    print("RESULT " + json.dumps(result))
    if a.emit:
        with open(a.emit, "w") as f:
            json.dump(result, f, indent=2)
        log(f"wrote {a.emit}")


if __name__ == "__main__":
    main()
