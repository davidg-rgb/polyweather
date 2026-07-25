#!/usr/bin/env python3
"""
bid-path-discovery.py — a from-scratch, unsupervised-leaning discovery pass over the FULL
historic market price-path panel (market-history-flat-enriched.parquet, ~238M rows / 45 cities /
522 dates), asking the one question the 12 killed signals never asked head-on across all history:

    Does the SHAPE of a bucket's implied-probability price path predict its resolution
    beyond the current price LEVEL?  (i.e. is the market price a martingale / sufficient statistic?)

If price is a sufficient statistic, E[win | full path so far] = p_now, and NO path feature adds
out-of-sample predictive lift beyond a recalibrated p_now. Any lift is a candidate "missed pattern"
to then gate against the REAL bid/ask (opening-captures) + taker costs + the §9R-E gate.

Two modes:
  extract  — stream the parquet per-city, resample each (event,bucket) path to fixed
             times-to-resolution, emit a compact feature table to out/bid-path-features.parquet
  analyze  — calibration of p_now + OOS predictive-lift (baseline logit(p_now) vs +path features),
             per horizon, train/test split BY DATE (winner's-curse-aware), report to out/.

Read-only: reads the local parquet only; writes only scripts/research/out/. No DB, no trades, no keys.
"""
import argparse, os, sys, json, math
import numpy as np
import pandas as pd
import pyarrow.dataset as ds
import pyarrow.compute as pc

OUT = os.path.join(os.path.dirname(__file__), "out")
ENRICHED = os.path.join(OUT, "market-history-flat-enriched.parquet")
FEATURES = os.path.join(OUT, "bid-path-features.parquet")

# times-to-resolution (hours) at which we snapshot each bucket's path and its history-so-far.
# Chosen to span the tradable pre-resolution window (the buy lane trades [2,12]h) + a long look.
TAUS_H = [24.0, 12.0, 6.0, 3.0, 2.0, 1.0]
# look-back offsets (hours BEFORE tau) used to build momentum features (no look-ahead: all ≥ tau)
LOOKBACKS_H = [1.0, 3.0, 6.0]


def _cols():
    return ["city", "target_date", "event_id", "bucket_idx", "end_ts", "t", "p", "resolved_outcome"]


def extract(cities=None, limit_events=None):
    dset = ds.dataset(ENRICHED, format="parquet")
    all_cities = [c.as_py() for c in pc.unique(dset.to_table(columns=["city"]).column("city"))] \
        if cities is None else cities
    rows = []
    for ci, city in enumerate(sorted(all_cities)):
        filt = pc.field("city") == city
        tbl = dset.to_table(columns=_cols(), filter=filt)
        df = tbl.to_pandas()
        if df.empty:
            continue
        df["won"] = (df["resolved_outcome"] == "win").astype(np.int8)
        n_ev = 0
        for (eid, bidx), g in df.groupby(["event_id", "bucket_idx"], sort=False):
            g = g.sort_values("t")
            t = g["t"].to_numpy()
            p = g["p"].to_numpy()
            end_ts = g["end_ts"].iloc[0]
            won = int(g["won"].iloc[0])
            city_ = g["city"].iloc[0]
            tdate = g["target_date"].iloc[0]
            listing_t = t[0]
            if len(t) < 5:
                continue
            for tau_h in TAUS_H:
                cut = end_ts - tau_h * 3600.0
                # last tick at or before the horizon (no look-ahead)
                j = np.searchsorted(t, cut, side="right") - 1
                if j < 0:
                    continue
                p_now = float(p[j])
                age_h = (t[j] - listing_t) / 3600.0
                stale_h = (cut - t[j]) / 3600.0  # how old is this "current" price vs the horizon (censoring check)
                # path-so-far window = ticks[0..j]
                ph = p[: j + 1]
                th = t[: j + 1]
                feat = {
                    "city": city_, "target_date": tdate, "event_id": eid, "bucket_idx": int(bidx),
                    "tau_h": tau_h, "won": won, "p_now": p_now, "age_h": age_h, "stale_h": stale_h,
                    "pmax": float(ph.max()), "pmin": float(ph.min()),
                    "vol6": float(_win_std(th, ph, cut, 6.0)),
                    "n_ticks": int(j + 1),
                }
                feat["draw_from_max"] = p_now - feat["pmax"]
                feat["draw_from_min"] = p_now - feat["pmin"]
                for lb in LOOKBACKS_H:
                    k = np.searchsorted(t, cut - lb * 3600.0, side="right") - 1
                    feat[f"mom{int(lb)}"] = p_now - float(p[k]) if k >= 0 else 0.0
                rows.append(feat)
            n_ev += 1
            if limit_events and n_ev >= limit_events:
                break
        print(f"[{ci+1}/{len(all_cities)}] {city}: {n_ev} events, cum rows {len(rows)}", file=sys.stderr)
    out = pd.DataFrame(rows)
    out.to_parquet(FEATURES, index=False)
    print(json.dumps({"features": FEATURES, "rows": len(out),
                      "events": int(out.event_id.nunique()), "cities": int(out.city.nunique()),
                      "dates": int(out.target_date.nunique())}))


def _win_std(t, p, cut, hours):
    lo = cut - hours * 3600.0
    m = (t >= lo) & (t <= cut)
    return p[m].std() if m.sum() >= 2 else 0.0


def _logit(x, eps=1e-4):
    x = np.clip(x, eps, 1 - eps)
    return np.log(x / (1 - x))


def _logloss(y, phat, eps=1e-6):
    phat = np.clip(phat, eps, 1 - eps)
    return -np.mean(y * np.log(phat) + (1 - y) * np.log(1 - phat))


def _auc(y, s):
    # rank-based AUC (Mann-Whitney); no sklearn dependency
    order = np.argsort(s)
    r = np.empty(len(s)); r[order] = np.arange(1, len(s) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def _fit_logreg(X, y, l2=1.0, iters=200):
    # plain Newton-ish IRLS with L2; X includes intercept col
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        z = X @ w
        pr = 1 / (1 + np.exp(-z))
        Wd = pr * (1 - pr) + 1e-9
        grad = X.T @ (pr - y) + l2 * w
        H = X.T @ (X * Wd[:, None]) + l2 * np.eye(X.shape[1])
        try:
            step = np.linalg.solve(H, grad)
        except np.linalg.LinAlgError:
            break
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def _predict(X, w):
    return 1 / (1 + np.exp(-(X @ w)))


PATH_FEATS = ["draw_from_max", "draw_from_min", "vol6", "mom1", "mom3", "mom6", "age_h", "n_ticks"]


def analyze(split_frac=0.6, min_p=0.01, max_p=0.99, cheap=False, per_city=False, max_stale=None):
    df = pd.read_parquet(FEATURES)
    df = df[(df.p_now >= min_p) & (df.p_now <= max_p)].copy()
    if max_stale is not None:
        df = df[df.stale_h <= max_stale].copy()
    if cheap:
        df = df[df.p_now < 0.30].copy()
    dates = np.sort(df.target_date.unique())
    cut = dates[int(len(dates) * split_frac)]
    tr, te = df[df.target_date < cut], df[df.target_date >= cut]
    report = {"n_total": len(df), "n_train": len(tr), "n_test": len(te),
              "split_date": str(cut), "cheap_only": cheap, "horizons": {}}
    for tau in sorted(df.tau_h.unique(), reverse=True):
        a_tr = tr[tr.tau_h == tau]; a_te = te[te.tau_h == tau]
        if len(a_te) < 200 or a_tr.won.nunique() < 2:
            continue
        ytr, yte = a_tr.won.to_numpy().astype(float), a_te.won.to_numpy().astype(float)
        # ---- baseline: recalibrated logit(p_now) ----
        b_tr = np.column_stack([np.ones(len(a_tr)), _logit(a_tr.p_now.to_numpy())])
        b_te = np.column_stack([np.ones(len(a_te)), _logit(a_te.p_now.to_numpy())])
        wb = _fit_logreg(b_tr, ytr, l2=1.0)
        pb = _predict(b_te, wb)
        # raw p_now (no recalibration) for a calibration read
        ll_raw = _logloss(yte, a_te.p_now.to_numpy())
        # ---- +path features (standardized on train) ----
        F = PATH_FEATS
        mu = a_tr[F].mean(); sd = a_tr[F].std().replace(0, 1)
        Xtr = np.column_stack([np.ones(len(a_tr)), _logit(a_tr.p_now.to_numpy()),
                               ((a_tr[F] - mu) / sd).to_numpy()])
        Xte = np.column_stack([np.ones(len(a_te)), _logit(a_te.p_now.to_numpy()),
                               ((a_te[F] - mu) / sd).to_numpy()])
        wf = _fit_logreg(Xtr, ytr, l2=1.0)
        pf = _predict(Xte, wf)
        report["horizons"][f"{tau:g}h"] = {
            "n_test": int(len(a_te)), "base_rate": float(yte.mean()),
            "logloss_raw_pnow": round(float(ll_raw), 5),
            "logloss_base_recal": round(float(_logloss(yte, pb)), 5),
            "logloss_with_path": round(float(_logloss(yte, pf)), 5),
            "delta_logloss": round(float(_logloss(yte, pb) - _logloss(yte, pf)), 5),
            "auc_base": round(float(_auc(yte, pb)), 4),
            "auc_with_path": round(float(_auc(yte, pf)), 4),
            "delta_auc": round(float(_auc(yte, pf) - _auc(yte, pb)), 4),
            "path_coefs": {f: round(float(c), 4) for f, c in zip(F, wf[2:])},
        }
    if per_city:
        # per-city OOS delta_auc at the tradable 6h horizon: does ANY city's book carry path signal?
        pc_out = {}
        for city, cg in df.groupby("city"):
            ctr = cg[(cg.target_date < cut) & (cg.tau_h == 6.0)]
            cte = cg[(cg.target_date >= cut) & (cg.tau_h == 6.0)]
            if len(cte) < 100 or ctr.won.nunique() < 2 or cte.won.nunique() < 2:
                continue
            ytr, yte = ctr.won.to_numpy().astype(float), cte.won.to_numpy().astype(float)
            b_tr = np.column_stack([np.ones(len(ctr)), _logit(ctr.p_now.to_numpy())])
            b_te = np.column_stack([np.ones(len(cte)), _logit(cte.p_now.to_numpy())])
            wb = _fit_logreg(b_tr, ytr); pb = _predict(b_te, wb)
            mu = ctr[PATH_FEATS].mean(); sd = ctr[PATH_FEATS].std().replace(0, 1)
            Xtr = np.column_stack([np.ones(len(ctr)), _logit(ctr.p_now.to_numpy()), ((ctr[PATH_FEATS]-mu)/sd).to_numpy()])
            Xte = np.column_stack([np.ones(len(cte)), _logit(cte.p_now.to_numpy()), ((cte[PATH_FEATS]-mu)/sd).to_numpy()])
            wf = _fit_logreg(Xtr, ytr); pf = _predict(Xte, wf)
            pc_out[city] = {"n_test": int(len(cte)), "delta_auc_6h": round(float(_auc(yte, pf) - _auc(yte, pb)), 4)}
        report["per_city_6h"] = dict(sorted(pc_out.items(), key=lambda kv: -kv[1]["delta_auc_6h"]))
    print(json.dumps(report, indent=2))


def calib(min_p=0.005, max_p=0.995, max_stale=None):
    """Calibration of the market price + a cost-adjusted tradability read per price band.
    For each horizon and price decile: realized win rate vs mean price (favorite-longshot bias),
    and whether the mid-basis miscalibration even survives a taker round-trip (buy the ask ≈ p+half-spread,
    fee both legs). A positive band that clears cost is a PASS_PENDING_REAL_BOOK candidate, never a GO.
    max_stale (hours): drop snapshots whose 'current' price is older than this vs the horizon — the
    censoring control (a ghost price you could never actually trade is not a mispricing)."""
    from analytics import taker_fee_per_share  # the frozen fee model
    df = pd.read_parquet(FEATURES)
    df = df[(df.p_now >= min_p) & (df.p_now <= max_p)].copy()
    if max_stale is not None:
        df = df[df.stale_h <= max_stale].copy()
    rep = {"note": "mid-basis (p=implied prob, NO bid/ask); tradability read assumes a nominal 2.3c half-spread from the convergence-capture measurement",
           "max_stale_h": max_stale, "horizons": {}, "staleness_median_h": {}}
    HALF_SPREAD = 0.023  # measured taker half-spread on cheap weather buckets (CONVERGENCE-CAPTURE-RESULTS §4)
    for tau in sorted(df.tau_h.unique(), reverse=True):
        a = df[df.tau_h == tau].copy()
        if len(a) < 500:
            continue
        rep["staleness_median_h"][f"{tau:g}h"] = round(float(a.stale_h.median()), 3)
        a["band"] = pd.cut(a.p_now, bins=[0,0.05,0.10,0.15,0.20,0.30,0.50,0.70,1.0], include_lowest=True)
        bands = []
        for b, g in a.groupby("band", observed=True):
            n = len(g); wins = int(g.won.sum())
            wr = wins / n
            mp = float(g.p_now.mean())
            # Wilson 95% on the win rate
            z = 1.96; ph = wr; den = 1 + z*z/n
            centre = (ph + z*z/(2*n))/den; half = z*math.sqrt(ph*(1-ph)/n + z*z/(4*n*n))/den
            lo, hi = centre-half, centre+half
            # taker YES tradability: pay ask≈mp+half_spread, win pays 1; net EV/contract, fee both leg-equivalents
            ask = mp + HALF_SPREAD
            fee = taker_fee_per_share(ask, 0.05) + taker_fee_per_share(1.0, 0.05)*0  # entry fee (settlement no fee)
            ev_taker = wr*(1-ask) - (1-wr)*ask - fee
            bands.append({"band": str(b), "n": n, "mean_price": round(mp,4),
                          "win_rate": round(wr,4), "wilson95": [round(lo,4), round(hi,4)],
                          "calib_gap": round(wr-mp,4), "ev_taker_per_contract": round(float(ev_taker),4)})
        rep["horizons"][f"{tau:g}h"] = bands
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract"); e.add_argument("--cities", nargs="*"); e.add_argument("--limit-events", type=int)
    a = sub.add_parser("analyze"); a.add_argument("--split-frac", type=float, default=0.6)
    a.add_argument("--cheap", action="store_true"); a.add_argument("--per-city", action="store_true")
    a.add_argument("--max-stale", type=float, default=None)
    cp = sub.add_parser("calib"); cp.add_argument("--max-stale", type=float, default=None)
    args = ap.parse_args()
    if args.cmd == "extract":
        extract(cities=args.cities, limit_events=args.limit_events)
    elif args.cmd == "calib":
        calib(max_stale=args.max_stale)
    else:
        analyze(split_frac=args.split_frac, cheap=args.cheap, per_city=args.per_city, max_stale=args.max_stale)
