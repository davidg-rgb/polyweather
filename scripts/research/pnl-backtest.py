#!/usr/bin/env python3
"""scripts/research/pnl-backtest — "$X/day on our predicted bucket" net-P&L backtest, done honestly.

THE QUESTION (operator): if we had staked $10/day on OUR predicted daily-high bucket across all cities,
where would we have landed — net profit or loss?

WHY IT NEEDS CARE. Accuracy (does our bucket win) is NOT profit — you only profit if the bucket resolves
for more than you paid. This joins the market MID price path (the enriched archive) to a forecast and
scores $STAKE/bet held to resolution. Two forecasts, side by side, because the difference IS the finding:
  * CAUSAL   — the walk-forward blend μ emitted by city-accuracy.ts (`--emit-forecast`), bias-corrected on
               PRIOR data only. This is the deployable, honest forecast.
  * ARCHIVE  — the enriched archive's baked-in `pred_c_l1`, which is calibrated with model_stats LATEST
               version = HINDSIGHT (data from after the target date). Optimistic; shown to expose the leak.

Honesty rails (the traps that killed 12 signals — references/traps.md):
  * Match our prediction to a bucket by PARSING TEMPERATURE FROM label (bucket_idx is raw gamma order, trap #7).
  * Price is the MID (archive has no bid/ask); the realistic pass buys at ask = mid + half-spread (real
    top-of-book median ~1c), price-floored (can't fill $10 on a sub-floor longshot).
  * Cluster on the independent unit: DAY (weather is spatially correlated — 1794 bets sit on ~49 weather-days)
    and CITY. Point estimate + clustered bootstrap CI.
  * Offset robustness: bet at 6/12/24/48h before resolution. A real forecast edge persists near resolution;
    a convergence CARRY grows with time-to-resolution (and dies same-day).
  * MARKET-FAVORITE control: buy the market's own top bucket. If THAT also "profits", the edge is a market
    pricing/convergence artifact, not our skill.

Read-only. Reads the local parquet archive + the causal-forecast CSV; writes only out/. No trade, no DB.

Run:
  pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
  python scripts/research/pnl-backtest.py --stake 10 --lead 1
  python scripts/research/pnl-backtest.py --selftest
"""
import argparse
import csv
import json
import re
import sys

ARCHIVE = "scripts/research/out/market-history-flat-enriched.parquet"
CAUSAL_CSV = "scripts/research/out/causal-forecast.csv"
OFFSETS = [6, 12, 24, 48]

# slug -> the ICAO actually present in forecast_snapshots (city-catalog.ts, with the 6 forecast-station
# overrides where the captured airport differs from the catalog's canonical one).
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
    """(kind, value) from a bucket label; kind in exact|below|above. Robust to the ° encoding."""
    m = re.search(r"(-?\d+)", str(label))
    if not m:
        return None
    v = int(m.group(1))
    ll = str(label).lower()
    if any(w in ll for w in ("below", "lower", "under", "colder")):
        return ("below", v)
    if any(w in ll for w in ("higher", "above", "over", "hotter")):
        return ("above", v)
    return ("exact", v)


def choose(buckets, pred_int):
    """Pick the bucket whose native-degree range contains pred_int. buckets: list of (idx,kind,val,resolved)."""
    for idx, k, v, r in buckets:
        if k == "exact" and v == pred_int:
            return (idx, r)
    for idx, k, v, r in buckets:
        if k == "below" and pred_int <= v:
            return (idx, r)
    for idx, k, v, r in buckets:
        if k == "above" and pred_int >= v:
            return (idx, r)
    return None


def bet_pnl(price_buy, won, stake):
    """Net on one bet: buy `stake` of shares at price_buy; +stake*(1/p-1) if the bucket wins, else -stake."""
    return stake * (1.0 / price_buy - 1.0) if won else -stake


def selftest():
    assert parse_temp("15�C") == ("exact", 15)
    assert parse_temp("7�C or below") == ("below", 7)
    assert parse_temp("17�C or higher") == ("above", 17)
    bks = [(0, "below", 7, "lose"), (1, "exact", 15, "win"), (2, "above", 17, "lose")]
    assert choose(bks, 15) == (1, "win")          # exact
    assert choose(bks, 3) == (0, "lose")          # falls in the low tail
    assert choose(bks, 20) == (2, "lose")         # falls in the high tail
    assert abs(bet_pnl(0.25, True, 10) - 30.0) < 1e-9   # $10 at 0.25 wins -> +$30
    assert bet_pnl(0.25, False, 10) == -10.0
    print("selftest OK", file=sys.stderr)


def load_causal(path, lead):
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if int(row["lead"]) != lead:
                continue
            out[(row["icao"], row["target_date"])] = int(row["mu_native"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stake", type=float, default=10.0)
    ap.add_argument("--lead", type=int, default=1)
    ap.add_argument("--half-spread", type=float, default=0.01)   # real top-of-book median ~1c
    ap.add_argument("--floor", type=float, default=0.03)
    ap.add_argument("--archive", default=ARCHIVE)
    ap.add_argument("--causal", default=CAUSAL_CSV)
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

    STAKE = a.stake
    causal = load_causal(a.causal, a.lead)
    archive_pred_col = f"pred_c_l{a.lead}"
    dset = ds.dataset(a.archive, format="parquet")
    cities = sorted(pc.unique(dset.to_table(columns=["city"]).column("city")).to_pylist())

    rows = []
    for city in cities:
        icao = SLUG2ICAO.get(city)
        tbl = dset.to_table(
            filter=(pc.field("city") == city) & pc.field(archive_pred_col).is_valid(),
            columns=["event_id", "target_date", "end_ts", "bucket_idx", "label", "resolved_outcome", "t", "p", archive_pred_col],
        )
        df = tbl.to_pandas()
        if df.empty:
            continue
        for _, g in df.groupby("event_id", sort=False):
            end_ts = int(g.end_ts.iloc[0])
            date = str(g.target_date.iloc[0])
            arch_pred = float(g[archive_pred_col].iloc[0])
            paths, meta = {}, []
            for idx, bg in g.groupby("bucket_idx", sort=False):
                pt = parse_temp(bg.label.iloc[0])
                if not pt:
                    continue
                s = bg.sort_values("t")
                paths[int(idx)] = (s.t.values.astype(np.int64), s.p.values.astype(float))
                meta.append((int(idx), pt[0], pt[1], bg.resolved_outcome.iloc[0]))
            if not any(m[3] == "win" for m in meta):
                continue

            def price_at(idx, targ):
                ts, ps = paths[idx]
                j = int(np.searchsorted(ts, targ))
                j = min(max(j, 0), len(ts) - 1)
                if j > 0 and abs(ts[j - 1] - targ) < abs(ts[j] - targ):
                    j -= 1
                return float(ps[j])

            rec = {"city": city, "icao": icao, "date": date}
            # CAUSAL pick (our source-of-truth forecast); skip events with no causal forecast for that day
            cnat = causal.get((icao, date)) if icao else None
            cpick = choose(meta, int(cnat)) if cnat is not None else None
            # ARCHIVE (hindsight) pick
            apick = choose(meta, int(round(arch_pred))) if np.isfinite(arch_pred) else None
            if cpick is None and apick is None:
                continue
            rec["has_causal"] = cpick is not None
            rec["has_arch"] = apick is not None
            rec["causal_won"] = (cpick[1] == "win") if cpick else False
            rec["arch_won"] = (apick[1] == "win") if apick else False
            for off in OFFSETS:
                targ = end_ts - off * 3600
                rec[f"causal_p{off}"] = price_at(cpick[0], targ) if cpick else np.nan
                rec[f"arch_p{off}"] = price_at(apick[0], targ) if apick else np.nan
                fav = max(meta, key=lambda m: price_at(m[0], targ))
                rec[f"fav_p{off}"] = price_at(fav[0], targ)
                rec[f"fav_won{off}"] = (fav[3] == "win")
            rows.append(rec)

    b = pd.DataFrame(rows)
    cb = b[b.has_causal].copy()
    log = lambda *x: print(*x, file=sys.stderr)
    log(f"\nUNIVERSE  archive={len(b)} bets | causal={len(cb)} bets | {cb.city.nunique()} cities | "
        f"{cb.date.min()}->{cb.date.max()} | {cb.date.nunique()} distinct weather-days | lead {a.lead}")

    def roi(price, won, hs):
        price = np.asarray(price, float); won = np.asarray(won, bool)
        ok = np.isfinite(price)
        ask = np.minimum(price[ok] + hs, 0.999)
        net = np.where(won[ok], STAKE / ask - STAKE, -STAKE)
        return 100 * net.sum() / (STAKE * len(net)), net.sum(), int(won[ok].sum()), int(len(net))

    def offset_table(prefix, col, won_col, df):
        log(f"\n{prefix} — ROI by bet-timing (win rate fixed; only entry price changes):")
        log(f"  {'off':>4} {'n':>4} {'win%':>6} {'avgP':>6} | {'ROI mid':>8} {'ROI +1c':>8} {'ROI +2c':>8} | {'net mid$':>9}")
        for off in OFFSETS:
            pr = df[f"{col}_p{off}"]; wn = df[won_col]
            r0, n0, w, n = roi(pr, wn, 0.0); r1, _, _, _ = roi(pr, wn, a.half_spread); r2, _, _, _ = roi(pr, wn, 2 * a.half_spread)
            log(f"  {off:>3}h {n:>4} {100*w/n:>5.1f}% {np.nanmean(pr):>6.3f} | {r0:>+7.1f}% {r1:>+7.1f}% {r2:>+7.1f}% | {n0:>+9.0f}")

    offset_table("CAUSAL (our forecast)", "causal", "causal_won", cb)
    offset_table("ARCHIVE (hindsight-calibrated)", "arch", "arch_won", b[b.has_arch])
    # favorite control (won differs per offset)
    log("\nMARKET-FAVORITE (control) — ROI by bet-timing:")
    log(f"  {'off':>4} {'win%':>6} {'avgP':>6} | {'ROI mid':>8} {'ROI +1c':>8}")
    for off in OFFSETS:
        r0, _, w, n = roi(cb[f"fav_p{off}"], cb[f"fav_won{off}"], 0.0)
        r1, _, _, _ = roi(cb[f"fav_p{off}"], cb[f"fav_won{off}"], a.half_spread)
        log(f"  {off:>3}h {100*w/n:>5.1f}% {cb[f'fav_p{off}'].mean():>6.3f} | {r0:>+7.1f}% {r1:>+7.1f}%")

    # clustered bootstrap CI on the PRIMARY (causal, 24h)
    def clustered_ci(keys, price, won, hs, iters=4000, seed=42):
        rng = np.random.default_rng(seed)
        price = np.asarray(price, float); won = np.asarray(won, bool); keys = np.asarray(keys)
        ok = np.isfinite(price); price, won, keys = price[ok], won[ok], keys[ok]
        ask = np.minimum(price + hs, 0.999); net = np.where(won, STAKE / ask - STAKE, -STAKE)
        uk = np.array(sorted(set(keys))); idxby = {k: np.where(keys == k)[0] for k in uk}
        est = np.empty(iters)
        for i in range(iters):
            sel = np.concatenate([idxby[k] for k in rng.choice(uk, len(uk), replace=True)])
            est[i] = 100 * net[sel].sum() / (STAKE * len(sel))
        est.sort()
        return 100 * net.sum() / (STAKE * len(net)), est[int(0.025 * iters)], est[int(0.975 * iters)]

    log("\nPRIMARY — CAUSAL forecast, bet 24h before resolution:")
    for tag, hs in [("mid", 0.0), ("+1c ask", a.half_spread)]:
        for cl, keys in [("day", cb.date.values), ("city", cb.city.values)]:
            pt, lo, hi = clustered_ci(keys, cb["causal_p24"].values, cb["causal_won"].values, hs)
            log(f"  {cl}-clustered ROI ({tag}): {pt:+.1f}%  [{lo:+.1f}%, {hi:+.1f}%]")

    # per-city net (causal, 24h) — mid + realistic
    percity = []
    for city, g in cb.groupby("city"):
        pr = g.causal_p24.values; wn = g.causal_won.values
        r0, n0, w, n = roi(pr, wn, 0.0); r1, n1, _, _ = roi(pr, wn, a.half_spread)
        percity.append(dict(city=city, bets=n, won=w, lost=n - w, win_pct=round(100 * w / n, 1),
                            avg_price=round(float(np.nanmean(pr)), 3), staked=round(STAKE * n, 0),
                            net_mid=round(n0, 1), roi_mid=round(r0, 1), net_realistic=round(n1, 1), roi_realistic=round(r1, 1)))
    pc_df = pd.DataFrame(percity).sort_values("net_mid", ascending=False)
    pc_df.to_csv(f"scripts/research/out/pnl-causal-lead{a.lead}.csv", index=False)

    # pooled result + RESULT json
    r0, n0, w, n = roi(cb.causal_p24, cb.causal_won, 0.0)
    r1, n1, _, _ = roi(cb.causal_p24, cb.causal_won, a.half_spread)
    ar0, an0, aw, an = roi(b[b.has_arch].arch_p24, b[b.has_arch].arch_won, 0.0)
    print(json.dumps({
        "script": "pnl-backtest", "lead": a.lead, "stake": STAKE,
        "n_bets": int(n), "n_days": int(cb.date.nunique()), "n_cities": int(cb.city.nunique()),
        "date_range": [cb.date.min(), cb.date.max()],
        "causal_24h": {"win_pct": round(100 * w / n, 1), "avg_price": round(float(cb.causal_p24.mean()), 3),
                       "net_mid": round(n0, 0), "roi_mid": round(r0, 1), "net_realistic": round(n1, 0), "roi_realistic": round(r1, 1)},
        "archive_24h_hindsight": {"win_pct": round(100 * aw / an, 1), "net_mid": round(an0, 0), "roi_mid": round(ar0, 1)},
        "per_city_csv": f"scripts/research/out/pnl-causal-lead{a.lead}.csv",
    }))


if __name__ == "__main__":
    main()
