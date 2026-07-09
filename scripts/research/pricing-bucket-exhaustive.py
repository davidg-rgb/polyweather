#!/usr/bin/env python3
"""
Exhaustive evaluation of the Polymarket pricing-BUCKET data surface.
====================================================================

Operator-directed (2026-07-09): "evaluate every option available, leave no stone
unturned" on the bucket-ladder price data. This is the completeness sweep that follows
C19 (calibration), C20 (winner neighbourhood), C21 (round-trip scalp) and C22 (the
sufficient-statistic proof: price contains all single-bucket path/level/order-book info).

C22 closed every SINGLE-BUCKET angle. This script tests the axes C22's single-bucket
frame could NOT have covered, plus the two documented gaps:

  T1  High-price-band (55–95c) calibration        — C19 scoped only 5–55c.
  T2  Cross-bucket ladder GEOMETRY (unimodality)  — the flagship: a Tmax distribution is
                                                     physically single-peaked; does the
                                                     market ever price an interior trough,
                                                     and is that inconsistency fadeable
                                                     FORECAST-FREE? (frictionless + fee gate)
  T3  Real-book flip of T2 on opening_captures    — re-price the geometry trade at the REAL
                                                     bestAsk + depthUsd (the C22 mid->book flip).
  T4  Whole-ladder sharpness/entropy calibration  — does market confidence calibrate over life?

Everything is FORECAST-FREE (no pred_* columns) so it is a pure test of the price vector
itself. The temperature axis is derived from the bucket LABEL / loF-hiF, never from
`bucket_idx` — the enriched archive stores buckets in raw Gamma order (trap #7). All gate
reads go through the analytics.py port of the frozen §9R-E gate (opening_verdict).

Read-only by contract: reads the parquet + the opening-captures archive, writes only to
scripts/research/out/. Places no trades, imports no trading code, reads no secrets.

Usage:
  python pricing-bucket-exhaustive.py selftest
  python pricing-bucket-exhaustive.py partition   # one streaming pass -> per-city lean parquet
  python pricing-bucket-exhaustive.py run [--cities N] [--checkpoints K]
"""
from __future__ import annotations
import sys, os, re, json, gzip, glob, math, argparse, shutil
from collections import defaultdict

# ── wire in the skill's faithful port of the TS statistics + frozen gate ──────────
SKILL_SCRIPTS = r"C:\Users\david\.claude\skills\betting-market-analytics\scripts"
sys.path.insert(0, SKILL_SCRIPTS)
from analytics import (  # noqa: E402
    opening_verdict, clustered_ci, wilson_interval, mean_ci, bootstrap_mean_ci,
    taker_fee_per_share, arm_edge_stats,
)

REPO = r"D:\Second Brain\03 Projects\Polyweather"
OUT = os.path.join(REPO, "scripts", "research", "out")
ENRICHED = os.path.join(OUT, "market-history-flat-enriched.parquet")
OC_ARCHIVE = os.path.join(OUT, "opening-captures-archive")
PART_DIR = os.path.join(OUT, "_pbx_city_parts")   # lean per-city partition (scratch)

# ── economics knobs (production-faithful) ─────────────────────────────────────────
FEE_RATE = 0.05          # Polymarket weather taker replica (fees.ts)
PROBE_STAKE = 20.0       # the project probe stake for executable depth ($20)
# geometry detection thresholds
TROUGH_DELTA = 0.02      # a bucket must sit >=2c below BOTH neighbours (exceeds tick/spread noise)
SHOULDER_MIN = 0.05      # at least one shoulder must be material (>=5c) — not a flat far tail
OVERROUND_LO, OVERROUND_HI = 0.90, 1.20   # keep snapshots whose ladder sum is sane (liquid)

# ══════════════════════════════════════════════════════════════════════════════════
#  Temperature axis + geometry  (the load-bearing, testable core)
# ══════════════════════════════════════════════════════════════════════════════════
_INT_RE = re.compile(r"-?\d+")

def temp_sort_key(label: str) -> float:
    """Order buckets along the TEMPERATURE axis from the human label, NOT bucket_idx
    (the enriched archive is raw Gamma order — trap #7). The FIRST integer in the label
    is a monotone sort key across every observed form:
        '35°F or lower'  -> 35   (coldest; '≤35')
        '36-37°F'        -> 36   (range lower edge)
        '46°F or higher' -> 46   (warmest; '≥46')
        '28°C'           -> 28
        '-2 to -1°C'     -> -2   (signed, still monotone)
    Only the ORDER matters for unimodality; exact midpoints are irrelevant."""
    m = _INT_RE.search(label or "")
    if not m:
        return math.inf
    return float(m.group(0))


def interior_extrema(p):
    """Given a TEMPERATURE-ORDERED price vector p (len m), return (troughs, spikes).
    A `trough` is an interior strict local MIN that is >=TROUGH_DELTA below BOTH
    neighbours with at least one material shoulder — a unimodal (single-peaked)
    distribution CANNOT have one, so it is a pricing inconsistency (candidate BUY,
    the market underprices the dip). A `spike` is the dual interior strict local MAX
    with both neighbours >=TROUGH_DELTA below (candidate overpricing / fade).
    Returns lists of dicts {k, p, left, right, depth}."""
    m = len(p)
    troughs, spikes = [], []
    for k in range(1, m - 1):
        lo, hi = p[k - 1], p[k + 1]
        # trough: below both neighbours, material shoulder
        if p[k] < lo - TROUGH_DELTA and p[k] < hi - TROUGH_DELTA and max(lo, hi) >= SHOULDER_MIN:
            troughs.append({"k": k, "p": p[k], "left": lo, "right": hi,
                            "depth": min(lo, hi) - p[k]})
        # spike: above both neighbours, itself material
        if p[k] > lo + TROUGH_DELTA and p[k] > hi + TROUGH_DELTA and p[k] >= SHOULDER_MIN:
            spikes.append({"k": k, "p": p[k], "left": lo, "right": hi,
                           "height": p[k] - max(lo, hi)})
    return troughs, spikes


def ladder_entropy(p):
    """Shannon entropy (nats) of the normalised ladder — the market's whole-distribution
    (un)sharpness. Low entropy = confident/peaked; high = flat/uncertain."""
    s = sum(p)
    if s <= 0:
        return math.nan
    h = 0.0
    for pi in p:
        q = pi / s
        if q > 1e-12:
            h -= q * math.log(q)
    return h


# ══════════════════════════════════════════════════════════════════════════════════
#  SELFTEST — known-answer checks before any archive is touched
# ══════════════════════════════════════════════════════════════════════════════════
def selftest():
    ok = True
    def check(name, cond):
        nonlocal ok
        print(f"  {'✓' if cond else '✗'} {name}")
        ok = ok and cond

    print("temp_sort_key")
    labels = ["35°F or lower", "36-37°F", "38-39°F", "40-41°F", "42-43°F", "44-45°F", "46°F or higher"]
    keys = [temp_sort_key(l) for l in labels]
    check("labels sort strictly ascending by temperature", keys == sorted(keys) and len(set(keys)) == len(keys))
    check("'or lower' is coldest", temp_sort_key("35°F or lower") < temp_sort_key("36-37°F"))
    check("'or higher' is warmest", temp_sort_key("46°F or higher") > temp_sort_key("44-45°F"))
    check("signed °C monotone", temp_sort_key("-5°C or lower") < temp_sort_key("-2 to -1°C") < temp_sort_key("3-4°C"))
    check("28°C parses", temp_sort_key("28°C") == 28.0)

    print("interior_extrema")
    # unimodal: no interior trough
    t, s = interior_extrema([0.02, 0.10, 0.82, 0.13, 0.02])
    check("clean unimodal -> no trough", len(t) == 0)
    check("clean unimodal -> one spike at the mode", len(s) == 1 and s[0]["k"] == 2)
    # a genuine interior trough (bimodal): 0.30, 0.05, 0.35
    t, s = interior_extrema([0.02, 0.30, 0.05, 0.35, 0.02])
    check("bimodal -> one interior trough at k=2", len(t) == 1 and t[0]["k"] == 2)
    check("trough depth = min(shoulder) - p", abs(t[0]["depth"] - (0.30 - 0.05)) < 1e-9)
    # dip too shallow (< DELTA) -> not a trough
    t, s = interior_extrema([0.30, 0.29, 0.31])
    check("sub-delta dip is NOT a trough (noise floor)", len(t) == 0)
    # dip in the flat far tail (immaterial shoulders) -> not a trough
    t, s = interior_extrema([0.04, 0.01, 0.045])
    check("immaterial-shoulder dip is NOT a trough", len(t) == 0)
    # monotone decreasing -> no interior extrema
    t, s = interior_extrema([0.6, 0.3, 0.08, 0.02])
    check("monotone -> no interior trough/spike", len(t) == 0 and len(s) == 0)

    print("ladder_entropy")
    check("point mass -> ~0 entropy", ladder_entropy([1.0, 0.0, 0.0]) < 1e-6)
    check("uniform 3 -> ln 3", abs(ladder_entropy([1, 1, 1]) - math.log(3)) < 1e-9)

    print("gate wiring (analytics.py port reachable)")
    thin = [{"city": "a", "target_date": "d", "net_return": 0.1, "net_pnl_usd": 1} for _ in range(5)]
    check("thin panel -> INSUFFICIENT_DATA", opening_verdict(thin).label == "INSUFFICIENT_DATA")
    check("taker_fee(0.34,0.05)≈0.01122", abs(taker_fee_per_share(0.34, 0.05) - 0.01122) < 1e-5)

    print("\n" + ("ALL PASS" if ok else "FAILURES ABOVE"))
    return 0 if ok else 1


# ══════════════════════════════════════════════════════════════════════════════════
#  PARTITION — one streaming pass: 238M rows -> lean per-city parquet
# ══════════════════════════════════════════════════════════════════════════════════
LEAN_COLS = ["city", "target_date", "event_id", "label", "resolved_outcome", "t", "p"]

def partition():
    import pyarrow.dataset as ds
    import pyarrow as pa
    if os.path.isdir(PART_DIR):
        shutil.rmtree(PART_DIR)
    os.makedirs(PART_DIR, exist_ok=True)
    dset = ds.dataset(ENRICHED, format="parquet")
    scanner = dset.scanner(columns=LEAN_COLS, batch_size=1_000_000)
    part = ds.partitioning(pa.schema([("city", pa.string())]), flavor="hive")
    ds.write_dataset(scanner, PART_DIR, format="parquet",
                     partitioning=part, existing_data_behavior="overwrite_or_ignore",
                     max_rows_per_file=50_000_000, max_rows_per_group=1_000_000)
    parts = glob.glob(os.path.join(PART_DIR, "city=*"))
    print(f"partitioned into {len(parts)} city dirs")
    return 0


# ══════════════════════════════════════════════════════════════════════════════════
#  RUN — the four tests over the lean per-city partition + the real-book archive
# ══════════════════════════════════════════════════════════════════════════════════
def run(max_cities=None, checkpoints=20):
    import pandas as pd
    import numpy as np
    import pyarrow.dataset as ds

    city_dirs = sorted(glob.glob(os.path.join(PART_DIR, "city=*")))
    if not city_dirs:
        print("no partition found — run `partition` first"); return 1
    if max_cities:
        city_dirs = city_dirs[:max_cities]

    # ── accumulators ──────────────────────────────────────────────────────────────
    # T1 calibration: per price-bin, per-event (event-clustered) win/obs at checkpoints
    PRICE_BINS = [round(x, 2) for x in np.arange(0.05, 0.98, 0.05)]
    def price_bin(p):
        for b in PRICE_BINS:
            if p < b + 0.025:
                return b
        return PRICE_BINS[-1]
    calib = defaultdict(lambda: defaultdict(lambda: [0, 0]))  # bin -> event -> [won, n]
    calib_tick = defaultdict(lambda: [0, 0])                  # bin -> [won_ticks, n_ticks] (opportunity-weighted)

    # T2 geometry: one trough-trade row per (event, temp_rank) — deepest snapshot
    trough_best = {}   # (event, k_temp) -> trade dict (deepest)
    spike_best = {}
    ladder_snapshots = 0
    troughy_snapshots = 0
    overround_vals = []

    # T4 sharpness/entropy: per life-decile, modal-prob calibration + entropy
    modal_cal = defaultdict(lambda: [0, 0])                   # life_decile -> [won, n] for the modal bucket
    modal_price = defaultdict(list)                          # life_decile -> [modal p]
    entropy_by_life = defaultdict(list)                      # life_decile -> [entropy]

    winner_lookup = {}   # (city, target_date, norm_label) -> won(bool)  (for T3 real-book grading)

    def norm_label(l):
        return re.sub(r"\s+", "", (l or "").lower()).replace("°", "").replace("f", "").replace("c", "")

    for cd in city_dirs:
        city = os.path.basename(cd).split("=", 1)[1]
        tbl = ds.dataset(cd, format="parquet").to_table(columns=[c for c in LEAN_COLS if c != "city"])
        df = tbl.to_pandas()
        df["won"] = (df["resolved_outcome"] == "win")
        # temperature sort key per row (label constant per bucket)
        lab_keys = {l: temp_sort_key(l) for l in df["label"].unique()}
        df["tk"] = df["label"].map(lab_keys)

        for ev, g in df.groupby("event_id", sort=False):
            tmin, tmax = g["t"].min(), g["t"].max()
            span = tmax - tmin
            if span <= 0:
                continue
            target_date = g["target_date"].iloc[0]
            # winner lookup (for T3) — keyed on TEMPERATURE (robust to °C/°F label phrasing)
            for lab, gg in g.groupby("label"):
                winner_lookup[(city, target_date, round(temp_sort_key(lab), 2))] = bool(gg["won"].iloc[0])

            ts = np.sort(g["t"].unique())
            # snapshot at K evenly-spaced life fractions
            for ci in range(checkpoints + 1):
                frac = ci / checkpoints
                target_t = tmin + frac * span
                # nearest actual tick
                t_snap = ts[np.searchsorted(ts, target_t).clip(0, len(ts) - 1)]
                snap = g[g["t"] == t_snap]
                snap = snap.sort_values("tk")
                labs = snap["label"].tolist()
                pv = snap["p"].to_numpy(dtype=float)
                wv = snap["won"].to_numpy()
                if len(pv) < 3:
                    continue
                s = pv.sum()
                overround_vals.append(s)
                # T1 calibration — every bucket at this checkpoint (event-clustered)
                for p_i, w_i in zip(pv, wv):
                    if 0.03 <= p_i <= 0.97:
                        b = price_bin(p_i)
                        cell = calib[b][ev]
                        cell[0] += int(w_i); cell[1] += 1
                        tk_cell = calib_tick[b]
                        tk_cell[0] += int(w_i); tk_cell[1] += 1
                # geometry / entropy only on liquid, sane-overround snapshots
                if not (OVERROUND_LO <= s <= OVERROUND_HI):
                    continue
                ladder_snapshots += 1
                # T4 modal calibration + entropy by life decile
                dec = min(9, int(frac * 10))
                mi = int(np.argmax(pv))
                modal_cal[dec][0] += int(wv[mi]); modal_cal[dec][1] += 1
                modal_price[dec].append(float(pv[mi]))
                entropy_by_life[dec].append(ladder_entropy(list(pv)))
                # T2 geometry
                troughs, spikes = interior_extrema(list(pv))
                if troughs:
                    troughy_snapshots += 1
                for tr in troughs:
                    k = tr["k"]
                    key = (ev, round(snap["tk"].iloc[k], 2))
                    won_k = bool(wv[k])
                    fair = 0.5 * (tr["left"] + tr["right"])
                    trade = {"city": city, "target_date": target_date, "event_id": ev,
                             "label": labs[k], "p": tr["p"], "won": won_k,
                             "depth": tr["depth"], "fair_interp": fair, "frac": frac}
                    prev = trough_best.get(key)
                    if prev is None or tr["depth"] > prev["depth"]:
                        trough_best[key] = trade
                for sp in spikes:
                    k = sp["k"]
                    key = (ev, round(snap["tk"].iloc[k], 2))
                    won_k = bool(wv[k])
                    trade = {"city": city, "target_date": target_date, "event_id": ev,
                             "label": labs[k], "p": sp["p"], "won": won_k,
                             "height": sp["height"], "frac": frac}
                    prev = spike_best.get(key)
                    if prev is None or sp["height"] > prev["height"]:
                        spike_best[key] = trade
        del df, tbl
        print(f"  ..{city}: snapshots so far ladder={ladder_snapshots} troughy={troughy_snapshots} "
              f"troughs={len(trough_best)}", flush=True)

    # ── T1 build calibration table ─────────────────────────────────────────────────
    def build_calib():
        rows = []
        for b in PRICE_BINS:
            evs = calib.get(b, {})
            if not evs:
                continue
            # event-clustered: per-event win-rate within this bin, then mean±z over events
            per_event = [c[0] / c[1] for c in evs.values() if c[1] > 0]
            won_ticks, n_ticks = calib_tick[b]
            if not per_event:
                continue
            ci = mean_ci(per_event)
            wr_tick = won_ticks / n_ticks if n_ticks else math.nan
            rows.append({
                "price_bin": b, "n_events": len(per_event), "n_ticks": n_ticks,
                "winrate_tick": wr_tick,               # opportunity-weighted (C19-comparable)
                "winrate_evclust": ci["mean"],         # event-clustered point
                # CI is on the GAP (winrate − price): a calibrated bin brackets 0
                "gap_evclust": ci["mean"] - b,
                "gap_ci_low": ci["lo"] - b, "gap_ci_high": ci["hi"] - b,
                "gap_tick": wr_tick - b,               # + = underpriced (buy), - = overpriced
            })
        return rows
    calib_rows = build_calib()

    # ── T2 gate the trough-buy (frictionless + fee-only) ────────────────────────────
    trough_trades = list(trough_best.values())
    spike_trades = list(spike_best.values())

    def gate_trades(trades, side="buy"):
        """side='buy' YES trough: net_return = won - p (frictionless), fee = taker_fee(p).
        side='fade' spike: sell YES == buy NO at (1-p): won_no=not won, cost (1-p);
        frictionless nr = (1-p) side... measured as (won_no - (1-p)) = p - won."""
        panel_f, panel_fee = [], []
        bets = []
        for tr in trades:
            p = tr["p"]
            won = tr["won"]
            if side == "buy":
                nr_f = (1 if won else 0) - p
                fee = taker_fee_per_share(p, FEE_RATE)
                nr_fee = nr_f - fee
                bets.append({"won": bool(won), "ask": p})
            else:  # fade the spike: buy NO at (1-p)
                won_no = not won
                cost = 1 - p
                nr_f = (1 if won_no else 0) - cost
                fee = taker_fee_per_share(cost, FEE_RATE)
                nr_fee = nr_f - fee
                bets.append({"won": bool(won_no), "ask": cost})
            panel_f.append({"city": tr["city"], "target_date": tr["target_date"],
                            "net_return": nr_f, "net_pnl_usd": nr_f})
            panel_fee.append({"city": tr["city"], "target_date": tr["target_date"],
                              "net_return": nr_fee, "net_pnl_usd": nr_fee})
        vf = opening_verdict(panel_f, day_block_null=True)
        vfee = opening_verdict(panel_fee, day_block_null=True)
        edge = arm_edge_stats(bets) if bets else None
        return vf, vfee, edge

    tr_vf, tr_vfee, tr_edge = gate_trades(trough_trades, "buy")
    sp_vf, sp_vfee, sp_edge = gate_trades(spike_trades, "fade")

    # ── T4 sharpness/entropy tables ─────────────────────────────────────────────────
    t4 = []
    for dec in range(10):
        won, n = modal_cal.get(dec, [0, 0])
        if n == 0:
            continue
        wl, wh = wilson_interval(won, n)
        mp = modal_price[dec]
        ent = entropy_by_life[dec]
        t4.append({"life_decile": dec, "n": n, "modal_winrate": won / n,
                   "modal_winrate_ci": [wl, wh],
                   "mean_modal_price": float(np.mean(mp)),
                   "modal_gap": won / n - float(np.mean(mp)),  # +=modal underpriced
                   "mean_entropy_nats": float(np.mean(ent))})

    result = {
        "meta": {"cities": len(city_dirs), "checkpoints": checkpoints,
                 "ladder_snapshots": ladder_snapshots,
                 "troughy_snapshots": troughy_snapshots,
                 "trough_frequency": (troughy_snapshots / ladder_snapshots) if ladder_snapshots else 0,
                 "n_trough_trades": len(trough_trades), "n_spike_trades": len(spike_trades),
                 "overround_p50": float(np.median(overround_vals)) if overround_vals else None},
        "T1_high_band_calibration": calib_rows,
        "T2_geometry": {
            "trough_buy_frictionless": _v(tr_vf),
            "trough_buy_fee_only": _v(tr_vfee),
            "trough_buy_edge": tr_edge,
            "spike_fade_frictionless": _v(sp_vf),
            "spike_fade_fee_only": _v(sp_vfee),
            "spike_fade_edge": sp_edge,
        },
        "T4_sharpness": t4,
    }
    # persist the trough trades for the T3 real-book stage
    with open(os.path.join(OUT, "pbx-trough-trades.json"), "w", encoding="utf-8") as f:
        json.dump({"troughs": trough_trades, "spikes": spike_trades}, f)
    with open(os.path.join(OUT, "pbx-winner-lookup.json"), "w", encoding="utf-8") as f:
        json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in winner_lookup.items()}, f)
    print(f"\nwinner_lookup: {len(winner_lookup)} (city,date,temp) winners cached for the real-book stage")
    with open(os.path.join(OUT, "pbx-mid-result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, default=str)
    print("\n=== MID-ARCHIVE RESULT ===")
    print(json.dumps(result, indent=2, default=str))
    return 0


def realbook():
    """T3 — the real-book flip (trap #1/#8). Detect interior troughs directly on the
    REAL opening_captures ask ladder (bestAsk per bucket, temperature-ordered), require
    executable depth >= the probe stake, and grade against the resolved winner. This is
    where every prior mid-priced signal died: the mid is a stale one-sided mark, the real
    ask sits a spread above and the depth at the unloved trough bucket is ~$0."""
    import numpy as np
    wl_raw = json.load(open(os.path.join(OUT, "pbx-winner-lookup.json"), encoding="utf-8"))
    winner = {}
    for k, v in wl_raw.items():
        c, d, tk = k.rsplit("|", 2)
        winner[(c, d, float(tk))] = v

    shards = sorted(glob.glob(os.path.join(OC_ARCHIVE, "part-*.ndjson.gz")))
    n_rows = 0
    n_captures_with_trough = 0
    depth_vals = []            # depthUsd at detected trough buckets (the C22 reality check)
    trades = []                # graded real-book trough-buys (deepest per (event,tempkey))
    trough_best = {}
    ungraded = 0
    for sh in shards:
        with gzip.open(sh, "rt", encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                n_rows += 1
                city = row.get("city"); td = row.get("target_date")
                buckets = row.get("buckets") or []
                lad = []
                for b in buckets:
                    ask = b.get("bestAsk")
                    if ask is None or not (0 < ask < 1):
                        continue
                    tk = temp_sort_key(b.get("label", ""))
                    lad.append((tk, ask, b.get("depthUsd") or 0.0, b.get("label", "")))
                if len(lad) < 3:
                    continue
                lad.sort(key=lambda x: x[0])
                pv = [x[1] for x in lad]
                s = sum(pv)
                if not (OVERROUND_LO <= s <= OVERROUND_HI * 1.5):  # ask-side sum runs a touch high
                    continue
                troughs, _ = interior_extrema(pv)
                if troughs:
                    n_captures_with_trough += 1
                for tr in troughs:
                    k = tr["k"]
                    tk, ask, depth, lab = lad[k]
                    depth_vals.append(depth)
                    key = (row.get("event_id") or f"{city}|{td}", round(tk, 2))
                    w = winner.get((city, td, round(tk, 2)))
                    rec = {"city": city, "target_date": td, "label": lab, "ask": ask,
                           "depth": depth, "won": w, "trough_depth": tr["depth"]}
                    prev = trough_best.get(key)
                    if prev is None or tr["depth"] > prev["trough_depth"]:
                        trough_best[key] = rec

    for rec in trough_best.values():
        if rec["won"] is None:
            ungraded += 1
            continue
        trades.append(rec)

    # gate: executable-depth-gated real-book taker trough-buy
    exec_trades = [t for t in trades if t["depth"] >= PROBE_STAKE]
    def gate(ts, label):
        panel = []
        bets = []
        for t in ts:
            ask = t["ask"]; won = bool(t["won"])
            fee = taker_fee_per_share(ask, FEE_RATE)
            nr = (1 if won else 0) - ask - fee
            panel.append({"city": t["city"], "target_date": t["target_date"],
                          "net_return": nr, "net_pnl_usd": nr})
            bets.append({"won": won, "ask": ask})
        v = opening_verdict(panel, day_block_null=True)
        e = arm_edge_stats(bets) if bets else None
        return _v(v), e

    v_all, e_all = gate(trades, "all-troughs-real-ask")
    v_exec, e_exec = gate(exec_trades, "exec-depth-gated")

    result = {
        "meta": {"oc_rows_scanned": n_rows, "captures_with_trough": n_captures_with_trough,
                 "n_graded_troughs": len(trades), "n_ungraded_no_winner": ungraded,
                 "n_exec_depth_ok": len(exec_trades), "probe_stake": PROBE_STAKE,
                 "trough_depthUsd_p10": float(np.percentile(depth_vals, 10)) if depth_vals else None,
                 "trough_depthUsd_p50": float(np.percentile(depth_vals, 50)) if depth_vals else None,
                 "trough_depthUsd_p90": float(np.percentile(depth_vals, 90)) if depth_vals else None,
                 "frac_troughs_with_probe_depth": (len(exec_trades) / len(trades)) if trades else None},
        "realbook_trough_buy_ALL": {"verdict": v_all, "edge": e_all},
        "realbook_trough_buy_EXEC_DEPTH_GATED": {"verdict": v_exec, "edge": e_exec},
    }
    with open(os.path.join(OUT, "pbx-realbook-result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, default=str)
    import sys as _s
    _s.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, indent=2, default=str))
    return 0


def _v(verdict):
    return {"label": verdict.label, "n_markets": verdict.n_markets, "n_cities": verdict.n_cities,
            "n_days": verdict.n_distinct_days, "win_frac": verdict.win_frac,
            "mean_net_return": verdict.mean_net_return, "ci_low": verdict.ci_low,
            "ci_high": verdict.ci_high, "zero_skill_pass_rate": verdict.zero_skill_pass_rate,
            "day_block": verdict.day_block, "reason": verdict.reason}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["selftest", "partition", "run", "realbook"])
    ap.add_argument("--cities", type=int, default=None)
    ap.add_argument("--checkpoints", type=int, default=20)
    a = ap.parse_args()
    if a.cmd == "selftest":
        sys.exit(selftest())
    elif a.cmd == "partition":
        sys.exit(partition())
    elif a.cmd == "realbook":
        sys.exit(realbook())
    else:
        sys.exit(run(max_cities=a.cities, checkpoints=a.checkpoints))
