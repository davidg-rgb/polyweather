#!/usr/bin/env python3
"""scripts/research/swing-bias.py — do BIG TEMPERATURE SWINGS (heatwave onsets / cold-front arrivals)
carry a directional forecast bias we could correct? (operator ask 2026-07-19, the follow-up to the
PERSISTENCE-BLEND KILL: not a flat blend, but a CONDITIONAL hot/cold bias on regime-transition days.)

THE MECHANISM WORTH TESTING. The blend's bias correction is learned on TRAILING residuals (model_stats),
so it is stale exactly when the regime flips: after a stable warm stretch a cold front arrives and the
learned warm-regime correction points the wrong way. WO-L3-b killed feature-MOS on anomaly/season/
disagreement/lead — it never tested a RECENT-SWING feature; WO-3 killed regime WEIGHTING, not
swing-conditional bias. This is the cheap diagnostic + honest corrector for that one untested seam.

DESIGN (diagnostic FIRST — if the model does not err directionally on swing days, nothing can be corrected):
  1. Panel per lead: (city, date) with a causal mu, a winner, and a COMPLETE 7-day truth window ending
     D-lead-1 (leakage-shifted, as in persistence-blend.py). All temps normalized to deg-C-equivalent
     (F values /1.8 for deltas) so cities pool.
  2. Conditioners (all knowable at forecast time):
       A obs-swing  = mean(last 2 obs) - mean(last 7 obs)   -- the operator's "small daily cluster vs average"
       B pred-swing = mu - mean(last 5 obs)                 -- the model itself calling a regime change
       C accel      = last obs - obs before it              -- day-over-day front signature
  3. Diagnostic: signed error e = mu - actual (EXACT winners only; actual = expected value of the winner
     band) binned by conditioner + a per-city OLS slope with a t-CI over the 45 city slopes (the clustered
     read). If the stale-correction story is real: warming swing -> e < 0 (model too cold), slope < 0.
  4. Correctors (only meaningful if the diagnostic shows signal), trained on the first 60% of dates,
     REPORTED on the last 40%: V1 linear (mu - (a+b*cond)), V2 threshold constants (per-side mean bias
     applied only when |cond| >= T, T in {1.5, 2.5} degC — the literal "bias only on big-swing clusters").
     Scored paired on identical rows: delta hit rate (bucket containment vs winner) + delta MAE, with
     city- AND day-clustered CIs.

MULTIPLICITY: 3 conditioners x 3 leads x several correctors ~ dozens of reads; at 95% expect ~1-2 false
positives. Only a pattern that is sign-consistent across leads AND mechanism-coherent counts. Read-only;
writes out/ only.

Run:  python scripts/research/swing-bias.py            (full)   |  --selftest
"""
import importlib.util
import json
import math
import sys
from datetime import timedelta

sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
from analytics import clustered_ci

_spec = importlib.util.spec_from_file_location("pb", "scripts/research/persistence-blend.py")
pb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pb)  # reuse: parse/choose/roll_value/loaders/rhu/date helpers (runs pb selftest)

OUT_JSON = "scripts/research/out/swing-bias.json"
LEADS = [0, 1, 2]
TRAIN_FRAC = 0.6
BINS = [(-99, -2), (-2, -1), (-1, 1), (1, 2), (2, 99)]
THRESHOLDS = [1.5, 2.5]
F_CITIES = {"atlanta", "austin", "chicago", "dallas", "denver", "houston", "los-angeles",
            "miami", "nyc", "san-francisco", "seattle"}


def c_equiv(city, delta_native):
    """A native-unit temperature DELTA in degC-equivalent (F deltas /1.8). Errors/swings only."""
    return delta_native / 1.8 if city in F_CITIES else delta_native


def build_rows(lead, causal, truth_by, meta_by):
    """One row per (city,date): mu, meta, the 7-day truth vector (newest first), winner, tail flag."""
    rows = []
    for (l, icao, tdate), mu in causal.items():
        if l != lead:
            continue
        slug = pb.ICAO2SLUG.get(icao)
        meta = meta_by.get((slug, tdate)) if slug else None
        if meta is None:
            continue
        tgt = pb.s2d(tdate)
        obs, tail = [], False
        for i in range(7):  # newest first: D-lead-1, D-lead-2, ...
            t = truth_by.get((slug, pb.d2s(tgt - timedelta(days=lead + 1 + i))))
            if t is None:
                obs = None
                break
            obs.append(pb.roll_value(*t))
            tail = tail or (t[0] != "exact")
        if obs is None:
            continue
        w = truth_by.get((slug, tdate))
        exact = w is not None and w[0] == "exact"
        actual = pb.roll_value(*w) if exact else None
        rows.append({
            "city": slug, "date": tdate, "mu": mu, "meta": meta, "tail": tail,
            "actual": actual,  # None on tail winners — excluded from error fitting
            "A": c_equiv(slug, (obs[0] + obs[1]) / 2 - sum(obs) / 7),
            "B": c_equiv(slug, mu - sum(obs[:5]) / 5),
            "C": c_equiv(slug, obs[0] - obs[1]),
        })
    return rows


def err(r):
    """Signed error mu - actual in degC-equivalent (model too warm > 0, too cold < 0)."""
    return c_equiv(r["city"], r["mu"] - r["actual"])


def bin_table(rows, cond):
    out = []
    fit = [r for r in rows if r["actual"] is not None]
    for lo, hi in BINS:
        sub = [r for r in fit if lo <= r[cond] < hi]
        if len(sub) < 30:
            out.append({"bin": f"[{lo},{hi})", "n": len(sub)})
            continue
        drows = [{"city": r["city"], "e": err(r)} for r in sub]
        ci = clustered_ci(drows, key="city", value="e")
        out.append({"bin": f"[{lo},{hi})", "n": len(sub), "meanErr": ci["mean"],
                    "cityCI": [ci["ciLow"], ci["ciHigh"]],
                    "mae": sum(abs(r["e"]) for r in drows) / len(drows)})
    return out


def city_slope(rows, cond):
    """Per-city OLS slope of e on cond, then mean +- t*SE over cities (the clustered slope read)."""
    fit = [r for r in rows if r["actual"] is not None]
    slopes = []
    for city in sorted({r["city"] for r in fit}):
        sub = [r for r in fit if r["city"] == city]
        if len(sub) < 10:
            continue
        xs = [r[cond] for r in sub]
        es = [err(r) for r in sub]
        mx, me = sum(xs) / len(xs), sum(es) / len(es)
        sxx = sum((x - mx) ** 2 for x in xs)
        if sxx < 1e-9:
            continue
        slopes.append(sum((x - mx) * (e - me) for x, e in zip(xs, es)) / sxx)
    n = len(slopes)
    mean = sum(slopes) / n
    sd = math.sqrt(sum((s - mean) ** 2 for s in slopes) / (n - 1))
    se = sd / math.sqrt(n)
    tcrit = 2.02  # ~t(40+)
    return {"nCities": n, "slope": mean, "ci": [mean - tcrit * se, mean + tcrit * se]}


def fit_linear(train, cond):
    fit = [r for r in train if r["actual"] is not None]
    xs = [r[cond] for r in fit]
    es = [err(r) for r in fit]
    mx, me = sum(xs) / len(xs), sum(es) / len(es)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (e - me) for x, e in zip(xs, es)) / sxx if sxx > 1e-9 else 0.0
    return me - b * mx, b  # alpha, beta


def fit_threshold(train, cond, T):
    """Per-side mean bias on the big-swing clusters only."""
    fit = [r for r in train if r["actual"] is not None]
    warm = [err(r) for r in fit if r[cond] >= T]
    cold = [err(r) for r in fit if r[cond] <= -T]
    return (sum(warm) / len(warm) if len(warm) >= 20 else 0.0,
            sum(cold) / len(cold) if len(cold) >= 20 else 0.0)


def hit(r, pred_int):
    p = pb.choose(r["meta"], pred_int)
    return 1.0 if (p is not None and p[1] == "win") else 0.0


def score_corrector(test, correct_native):
    """Paired delta hit + delta MAE of mu' = mu - correction vs mu, clustered CIs."""
    dh, dm = [], []
    for r in test:
        corr = correct_native(r)
        base = hit(r, pb.rhu(r["mu"]))
        newp = hit(r, pb.rhu(r["mu"] - corr))
        dh.append({"city": r["city"], "date": r["date"], "d": newp - base})
        if r["actual"] is not None:
            ccorr = c_equiv(r["city"], corr)
            dm.append({"city": r["city"], "date": r["date"],
                       "d": abs(err(r) - ccorr) - abs(err(r))})
    hci = clustered_ci(dh, key="city", value="d")
    hdi = clustered_ci(dh, key="date", value="d")
    mci = clustered_ci(dm, key="city", value="d")
    n_moved = sum(1 for r in test if pb.rhu(r["mu"] - correct_native(r)) != pb.rhu(r["mu"]))
    return {"n": len(dh), "nMoved": n_moved,
            "dHit": hci["mean"], "dHitCityCI": [hci["ciLow"], hci["ciHigh"]],
            "dHitDayCI": [hdi["ciLow"], hdi["ciHigh"]],
            "dMAE": mci["mean"], "dMAECityCI": [mci["ciLow"], mci["ciHigh"]]}


def native_corr(city, corr_c):
    return corr_c * 1.8 if city in F_CITIES else corr_c


def selftest():
    assert abs(c_equiv("nyc", 1.8) - 1.0) < 1e-9 and c_equiv("madrid", 1.5) == 1.5
    a, b = fit_linear([{"city": "madrid", "actual": 0.0, "mu": x, "X": x} for x in (0, 1, 2, 3)], "X")
    assert abs(b - 1.0) < 1e-9 and abs(a) < 1e-9  # e = mu-actual = x -> slope 1
    w, c = fit_threshold([{"city": "madrid", "actual": 0.0, "mu": 0.5, "X": 3.0}] * 25
                         + [{"city": "madrid", "actual": 0.0, "mu": -0.25, "X": -3.0}] * 25, "X", 2.5)
    assert abs(w - 0.5) < 1e-9 and abs(c + 0.25) < 1e-9
    print("selftest OK (swing-bias)", file=sys.stderr)


def main():
    selftest()
    if "--selftest" in sys.argv:
        return
    log = lambda *x: print(*x, file=sys.stderr)
    meta_by, truth_by = pb.load_truth_and_meta(pb.ARCHIVE)
    causal = pb.load_causal(pb.CAUSAL_CSV)

    result = {"diagnostic": {}, "correctors": {}}
    for lead in LEADS:
        rows = build_rows(lead, causal, truth_by, meta_by)
        nfit = sum(1 for r in rows if r["actual"] is not None)
        dates = sorted({r["date"] for r in rows})
        cut = dates[int(len(dates) * TRAIN_FRAC) - 1]
        train = [r for r in rows if r["date"] <= cut]
        test = [r for r in rows if r["date"] > cut]
        log(f"\nlead {lead}: n={len(rows)} (fit rows {nfit}) | {len(dates)} days | "
            f"{len({r['city'] for r in rows})} cities | train {len(train)} / test {len(test)}")

        result["diagnostic"][lead] = {}
        for cond in ("A", "B", "C"):
            sl = city_slope(rows, cond)
            result["diagnostic"][lead][cond] = {"slope": sl, "bins": bin_table(rows, cond)}
            log(f"  {cond}: slope {sl['slope']:+.4f} cityCI [{sl['ci'][0]:+.4f}, {sl['ci'][1]:+.4f}] "
                f"({sl['nCities']} cities)")
            for b in result["diagnostic"][lead][cond]["bins"]:
                if "meanErr" in b:
                    log(f"     {b['bin']:>9} n={b['n']:4d} err {b['meanErr']:+.3f} "
                        f"CI [{b['cityCI'][0]:+.3f}, {b['cityCI'][1]:+.3f}] mae {b['mae']:.3f}")

        result["correctors"][lead] = {}
        for cond in ("A", "B", "C"):
            al, be = fit_linear(train, cond)
            lin = score_corrector(test, lambda r, _a=al, _b=be, _c=cond:
                                  native_corr(r["city"], _a + _b * r[_c]))
            result["correctors"][lead][f"linear-{cond}"] = {"alpha": al, "beta": be, **lin}
            log(f"  linear-{cond} (a={al:+.3f}, b={be:+.3f}): testΔhit {lin['dHit']:+.4f} "
                f"cityCI [{lin['dHitCityCI'][0]:+.4f}, {lin['dHitCityCI'][1]:+.4f}] "
                f"Δmae {lin['dMAE']:+.4f} (moved {lin['nMoved']}/{lin['n']})")
            for T in THRESHOLDS:
                wbias, cbias = fit_threshold(train, cond, T)
                th = score_corrector(test, lambda r, _w=wbias, _cb=cbias, _c=cond, _T=T:
                                     native_corr(r["city"], _w if r[_c] >= _T else (_cb if r[_c] <= -_T else 0.0)))
                result["correctors"][lead][f"thresh{T}-{cond}"] = {"warmBias": wbias, "coldBias": cbias, **th}
                log(f"  thresh{T}-{cond} (warm {wbias:+.3f}, cold {cbias:+.3f}): testΔhit {th['dHit']:+.4f} "
                    f"cityCI [{th['dHitCityCI'][0]:+.4f}, {th['dHitCityCI'][1]:+.4f}] "
                    f"Δmae {th['dMAE']:+.4f} (moved {th['nMoved']}/{th['n']})")

    with open(OUT_JSON, "w") as f:
        json.dump(result, f, indent=1)
    log(f"\nwrote {OUT_JSON}")
    print("RESULT " + json.dumps({"diag": {l: {c: result["diagnostic"][l][c]["slope"]
                                               for c in result["diagnostic"][l]}
                                           for l in result["diagnostic"]}}))


if __name__ == "__main__":
    main()
