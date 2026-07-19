#!/usr/bin/env python3
"""scripts/research/persistence-blend.py — does blending the causal forecast with a rolling average of
previous days' observed Tmax (3/5/7-day windows) improve documented bucket-hit accuracy? (operator ask
2026-07-19; the 6th point-skill lever after the five FORECASTING-RD.md rejections.)

THE TEST. For target date D at lead L, the documented prediction is the causal blend's mu (the
city-accuracy.ts --emit-forecast walk-forward emit — bias-corrected on PRIOR data only). Candidate:
    pred'(w, K) = round((1 - w) * mu + w * rollK)
where rollK = the mean of the K previous OBSERVED daily maxes, in native units. Scored exactly like the
documented accuracy: pick the bucket whose native-degree range contains pred', hit = that bucket resolves
as the market winner. If some w > 0 beats w = 0, persistence adds skill; if not, KILL.

HONESTY RAILS (references/traps.md):
  * NO LOOK-AHEAD in the window: the forecast for target D at lead L is made at the run on day D-L; the
    last COMPLETE observed day at that moment is D-L-1. The window is [D-L-K .. D-L-1], shifted by lead —
    using D-1 obs inside a lead-1 forecast would be leakage.
  * Baseline == documented: the blend is anchored on the emitted integer mu_native, so w=0 reproduces the
    documented pick BY CONSTRUCTION (and its hit rate is cross-checked against city-accuracy-22Z.csv).
  * Truth = the market winner (the same source the documented accuracy is scored against). A tail winner
    ("7°C or below") only bounds the actual — its boundary value feeds the rolling input, counted +
    stress-tested by excluding windows that contain any tail day.
  * Paired on the SAME rows: every (w, K, L) is scored on the identical row set as its w=0 baseline.
  * Clustered on the independent unit: city-clustered AND day-clustered CIs on the paired delta.
  * OOS: dates split 60/40 chronologically; w* is selected on train, REPORTED on test. The in-sample
    best-w curve is shown only as the winner's-curse upper bound.

Read-only: reads the local parquet archive + causal-forecast.csv; writes only out/. No DB, no trades.

Run:
  python scripts/research/persistence-blend.py                # full sweep, all leads
  python scripts/research/persistence-blend.py --selftest
"""
import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from datetime import date as _date, timedelta

sys.path.insert(0, r"C:\Users\david\.claude\skills\betting-market-analytics\scripts")
from analytics import clustered_ci  # the frozen city-clustered t-CI (opening-convergence.ts:346 port)

ARCHIVE = "scripts/research/out/market-history-flat-enriched.parquet"
CAUSAL_CSV = "scripts/research/out/causal-forecast.csv"
OUT_JSON = "scripts/research/out/persistence-blend.json"

WINDOWS = [3, 5, 7]
WEIGHTS = [round(0.1 * i, 1) for i in range(0, 11)]  # 0.0 .. 1.0
LEADS = [0, 1, 2]
TRAIN_FRAC = 0.6

# ── label parsing + bucket choice — extended from pnl-backtest.py (trap #7: bucket_idx is raw gamma
#    order; temperature must be parsed from the label). EXTENSION over the pnl-backtest parser: °F labels
#    are 2-degree BANDS ("10-11°F") — the first-integer-only parse matched just the low edge, so a pred
#    of 11 missed the 10-11 bucket entirely (°F base hit read 19.7% vs the documented 21.7%). Bands parse
#    to an inclusive [lo, hi] and choose() does containment. ────────────────────────────────────────────
def parse_temp(label):
    """(kind, lo, hi) with kind in exact|below|above; exact carries the inclusive integer band."""
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
    """buckets: list of (idx, kind, lo, hi, resolved). Containment first, then the tails."""
    for idx, k, lo, hi, r in buckets:
        if k == "exact" and lo <= pred_int <= hi:
            return (idx, r)
    for idx, k, lo, _hi, r in buckets:
        if k == "below" and pred_int <= lo:
            return (idx, r)
    for idx, k, lo, _hi, r in buckets:
        if k == "above" and pred_int >= lo:
            return (idx, r)
    return None


def roll_value(kind, lo, hi):
    """The EXPECTED actual max given the winner bucket — the rolling input. Winner semantics are
    floor(actual) ∈ [lo, hi], so actual ∈ [lo, hi+1): midpoint lo..hi+1. Using the raw label low edge
    would feed the roll a systematic ~0.5° cold bias. Tails keep their boundary (flagged upstream)."""
    if kind == "exact":
        return (lo + hi + 1) / 2.0
    return float(lo)


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
ICAO2SLUG = {v: k for k, v in SLUG2ICAO.items()}


def rhu(x):
    """round-half-up — matches the emit's mu_c→mu_native rounding (17.7625→18, 8.1375→8)."""
    return math.floor(x + 0.5)


def d2s(d):
    return d.isoformat()


def s2d(s):
    return _date.fromisoformat(str(s)[:10])


def selftest():
    assert parse_temp("15°C") == ("exact", 15, 15)
    assert parse_temp("7°C or below") == ("below", 7, 7)
    assert parse_temp("17°C or higher") == ("above", 17, 17)
    assert parse_temp("10-11°F") == ("exact", 10, 11)  # the °F 2-degree band
    bks = [(0, "below", 7, 7, "lose"), (1, "exact", 10, 11, "win"), (2, "above", 12, 12, "lose")]
    assert choose(bks, 10) == (1, "win") and choose(bks, 11) == (1, "win")  # BOTH edges contained
    assert choose(bks, 3) == (0, "lose") and choose(bks, 20) == (2, "lose")
    assert roll_value("exact", 15, 15) == 15.5   # °C floor-winner → expected actual
    assert roll_value("exact", 10, 11) == 11.0   # °F band → expected actual
    assert roll_value("below", 7, 7) == 7.0      # tail keeps its boundary (flagged)
    assert rhu(17.7625) == 18 and rhu(8.1375) == 8 and rhu(-0.5) == 0 and rhu(2.5) == 3
    # the leakage-shifted window: lead 1, K 3, target 2026-07-10 -> [07-06 .. 07-08] (NOT 07-09)
    tgt = s2d("2026-07-10")
    win = [tgt - timedelta(days=1 + 1 + i) for i in range(3)]
    assert d2s(max(win)) == "2026-07-08" and d2s(min(win)) == "2026-07-06"
    # blend identity: w=0 == mu_native exactly, w=1 == round(roll)
    assert rhu((1 - 0.0) * 18 + 0.0 * 15.3) == 18
    assert rhu((1 - 1.0) * 18 + 1.0 * 15.3) == 15
    print("selftest OK", file=sys.stderr)


def load_truth_and_meta(archive):
    """Per (city, date): the bucket meta list for scoring + the winner (kind, value) for the truth series."""
    import pyarrow.parquet as _pq  # noqa: F401 (precede dataset import on this Windows build)
    import pyarrow.dataset as ds

    dset = ds.dataset(archive, format="parquet")
    # the flat archive is PER-TICK (millions of rows) — collapse to distinct bucket rows in Arrow
    # (group_by with no aggregates = distinct) before touching Python objects, or to_pylist OOMs.
    tbl = (
        dset.to_table(columns=["city", "target_date", "event_id", "bucket_idx", "label", "resolved_outcome"])
        .group_by(["city", "target_date", "event_id", "bucket_idx", "label", "resolved_outcome"])
        .aggregate([])
    )
    meta_by = {}
    truth_by = {}
    ev_rows = defaultdict(list)
    for city, tdate, eid, bidx, label, outc in zip(
        tbl.column("city").to_pylist(), tbl.column("target_date").to_pylist(),
        tbl.column("event_id").to_pylist(), tbl.column("bucket_idx").to_pylist(),
        tbl.column("label").to_pylist(), tbl.column("resolved_outcome").to_pylist(),
    ):
        ev_rows[(str(city), str(tdate)[:10], eid)].append((int(bidx), label, outc))
    for (city, tdate, _eid), buckets in ev_rows.items():
        if (city, tdate) in meta_by:  # one event per (city, date); first wins (duplicates are re-listings)
            continue
        meta = []
        for bidx, label, outc in buckets:
            pt = parse_temp(label)
            if pt:
                meta.append((bidx, pt[0], pt[1], pt[2], outc))
        winner = next(((k, lo, hi) for _i, k, lo, hi, r in meta if r == "win"), None)
        if winner is None:
            continue
        meta_by[(city, tdate)] = meta
        truth_by[(city, tdate)] = winner  # (kind, lo, hi) — tails carry their boundary value
    return meta_by, truth_by


def load_causal(path):
    """(lead, icao, date) -> mu_native int (the documented pick's integer)."""
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            out[(int(row["lead"]), row["icao"], row["target_date"])] = int(row["mu_native"])
    return out


def build_panel(lead, K, causal, truth_by, meta_by):
    """Rows: one per (city, date) with a causal mu, scorable meta, and a COMPLETE K-day truth window
    ending at D-lead-1. Each row carries hit(w) for every w plus the tail-in-window flag."""
    rows = []
    for (l, icao, tdate), mu in causal.items():
        if l != lead:
            continue
        slug = ICAO2SLUG.get(icao)
        if slug is None:
            continue
        meta = meta_by.get((slug, tdate))
        if meta is None:
            continue
        tgt = s2d(tdate)
        win_days = [tgt - timedelta(days=lead + 1 + i) for i in range(K)]
        vals, tail = [], False
        for d in win_days:
            t = truth_by.get((slug, d2s(d)))
            if t is None:
                vals = None
                break
            vals.append(roll_value(*t))
            tail = tail or (t[0] != "exact")
        if vals is None:
            continue
        roll = sum(vals) / K
        hits = {}
        for w in WEIGHTS:
            pick = choose(meta, rhu((1.0 - w) * mu + w * roll))
            hits[w] = 1.0 if (pick is not None and pick[1] == "win") else 0.0
        rows.append({"city": slug, "date": tdate, "mu": mu, "roll": roll, "tail": tail, "hits": hits})
    return rows


def panel_stats(rows, w):
    n = len(rows)
    hit = sum(r["hits"][w] for r in rows) / n if n else float("nan")
    return n, hit


def delta_cis(rows, w):
    """Paired delta hit(w) - hit(0): overall mean + city-clustered and day-clustered 95% t-CIs."""
    drows = [{"city": r["city"], "date": r["date"], "d": r["hits"][w] - r["hits"][0.0]} for r in rows]
    mean = sum(r["d"] for r in drows) / len(drows) if drows else float("nan")
    return {
        "delta": mean,
        "cityCI": clustered_ci(drows, key="city", value="d"),
        "dayCI": clustered_ci(drows, key="date", value="d"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=ARCHIVE)
    ap.add_argument("--causal", default=CAUSAL_CSV)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    selftest()
    if a.selftest:
        return

    log = lambda *x: print(*x, file=sys.stderr)
    meta_by, truth_by = load_truth_and_meta(a.archive)
    causal = load_causal(a.causal)
    log(f"truth days: {len(truth_by)} (city,date) winners | causal rows: {len(causal)}")

    result = {"windows": {}, "spec": {
        "blend": "round_half_up((1-w)*mu_native + w*rollK)", "weights": WEIGHTS, "leads": LEADS,
        "window": "K complete winner-days ending at D-lead-1 (leakage-shifted)",
        "trainFrac": TRAIN_FRAC, "truth": "market winner (tails carry boundary value)",
    }}
    for K in WINDOWS:
        result["windows"][K] = {}
        for lead in LEADS:
            rows = build_panel(lead, K, causal, truth_by, meta_by)
            if len(rows) < 50:
                result["windows"][K][lead] = {"n": len(rows), "verdict": "INSUFFICIENT"}
                continue
            dates = sorted({r["date"] for r in rows})
            cut = dates[int(len(dates) * TRAIN_FRAC) - 1]
            train = [r for r in rows if r["date"] <= cut]
            test = [r for r in rows if r["date"] > cut]

            n, base_hit = panel_stats(rows, 0.0)
            _, pers_hit = panel_stats(rows, 1.0)
            # in-sample curve (winner's-curse upper bound, shown for transparency)
            curve = {str(w): panel_stats(rows, w)[1] for w in WEIGHTS}
            # OOS: select w* on train (max delta; ties -> smaller w, i.e. don't move without evidence)
            train_delta = {w: sum(r["hits"][w] - r["hits"][0.0] for r in train) / len(train) for w in WEIGHTS}
            w_star = min((w for w in WEIGHTS), key=lambda w: (-train_delta[w], w))
            test_read = delta_cis(test, w_star) if w_star > 0 else None
            # tail stress: same full-panel delta on exact-only windows
            notail = [r for r in rows if not r["tail"]]
            best_is = max(WEIGHTS, key=lambda w: curve[str(w)])
            result["windows"][K][lead] = {
                "n": n, "nCities": len({r["city"] for r in rows}), "nDays": len(dates),
                "baseHit": base_hit, "persistenceHit": pers_hit, "curveIS": curve,
                "bestISw": best_is, "bestISdelta": curve[str(best_is)] - base_hit,
                "trainN": len(train), "testN": len(test), "cut": cut,
                "wStar": w_star, "trainDeltaAtWstar": train_delta[w_star],
                "testAtWstar": test_read,
                "noTailN": len(notail),
                "noTailDeltaBestIS": (sum(r["hits"][best_is] - r["hits"][0.0] for r in notail) / len(notail))
                                     if notail else None,
            }
            tr = test_read
            log(f"K={K} lead={lead}: n={n} ({len(dates)}d/{len({r['city'] for r in rows})}c) "
                f"base={base_hit:.4f} pers(w=1)={pers_hit:.4f} bestIS w={best_is} Δ={curve[str(best_is)]-base_hit:+.4f} | "
                f"OOS w*={w_star}" + (f" testΔ={tr['delta']:+.4f} cityCI[{tr['cityCI']['ciLow']:+.4f},{tr['cityCI']['ciHigh']:+.4f}]"
                                      if tr else " (train picked w=0 — no move)"))

    with open(OUT_JSON, "w") as f:
        json.dump(result, f, indent=1)
    log(f"wrote {OUT_JSON}")
    print("RESULT " + json.dumps({
        K: {lead: {k2: v2 for k2, v2 in result["windows"][K][lead].items() if k2 != "curveIS"}
            for lead in result["windows"][K]} for K in result["windows"]
    }))


if __name__ == "__main__":
    main()
