#!/usr/bin/env python3
"""scripts/research/city-buy-table — the per-city "$10 on our predicted bucket, bought CHEAP, held to close" table.

THE OPERATOR ASK (2026-07-09): replace /paper-trade with a per-city table. For every city, place a fictive
$10 bet on OUR predicted daily-high bucket, but ONLY enter when the bucket is still cheap (ask <= 15c = "high
return potential"), at the confidence sweet-spot (a fixed entry lead before market close), held to resolution.
Log per city: bets, days active, win%, avg entry price, net P&L, ROI.

THIS IS SIGNAL #12 (opening-convergence), ALREADY FALSIFIED (FINDINGS.md / MARKET-PNL.md). The cheap-entry
filter IS the not-yet-converged leg the mid-price "profit" rides up; at the EXECUTABLE ask it does not survive.
This script exists to render that truth per city HONESTLY, not to resurrect the signal. It is the sibling of
pnl-backtest.py (that script = the pooled MARKET-PNL record; this one = the per-city dashboard artifact with the
<=15c filter added). Same honesty rails:
  * Forecast = the CAUSAL walk-forward blend mu from city-accuracy.ts (--emit-forecast). No hindsight/look-ahead.
  * Bucket match by PARSING TEMPERATURE FROM label (bucket_idx is raw gamma order, trap #7).
  * Price = archive MID; we BUY at the CANONICAL calibrated-book executable ask (cost_model.py = the committed
    CALIBRATED_BOOK fit from real opening_captures books), and a bet only EXISTS where the walked depth can fill
    the stake (depth_usd >= stake). `--book flat` reproduces the legacy mid+1c/3c-floor scoring for comparison.
  * Entry lead = fixed hours-before-close (causal: observed price at a fixed clock offset). Reported per lead so
    the accuracy/return "sweet-spot" is visible; the headline table uses one pooled-chosen lead.
  * Cluster on the independent unit (DAY + CITY) for the pooled CI. Per-city n is small -> shown, not trusted.

Read-only. Reads the local parquet archive + the causal-forecast CSV; writes only out/. No trade, no DB.

Run:
  pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
  python scripts/research/city-buy-table.py --stake 10 --cheap-max 0.15 --emit scripts/research/out/city-buy-table.json
  python scripts/research/city-buy-table.py --selftest
"""
import argparse
import csv
import json
import re
import sys

import cost_model  # the canonical calibrated-book cost model (parses core's CALIBRATED_BOOK — zero drift)

ARCHIVE = "scripts/research/out/market-history-flat-enriched.parquet"
CAUSAL_CSV = "scripts/research/out/causal-forecast.csv"
OUT_JSON = "scripts/research/out/city-buy-table.json"
LEADS_H = [48, 24, 12, 6]  # hours-before-close entry candidates (the "peak time for ROI confidence" axis)

# slug -> the ICAO actually present in forecast_snapshots (mirrors pnl-backtest.py SLUG2ICAO — city-catalog.ts
# with the 6 forecast-station overrides where the captured airport differs from the catalog's canonical one).
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

# Display names for the dashboard (slug -> pretty). Falls back to a title-cased slug if absent.
DISPLAY = {
    "kuala-lumpur": "Kuala Lumpur", "buenos-aires": "Buenos Aires", "cape-town": "Cape Town",
    "los-angeles": "Los Angeles", "mexico-city": "Mexico City", "nyc": "New York", "panama-city": "Panama City",
    "san-francisco": "San Francisco", "sao-paulo": "Sao Paulo",
}


def display_name(slug):
    return DISPLAY.get(slug) or " ".join(w.capitalize() for w in slug.split("-"))


def parse_temp(label):
    """(kind, value) from a bucket label; kind in exact|below|above. Robust to the degree encoding."""
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


def ask_of(mid, half_spread, floor):
    """LEGACY flat executable buy price (--book flat): mid + half-spread, floored, capped."""
    return min(max(mid + half_spread, floor), 0.999)


def price_bet(mid, book, half_spread, floor, stake):
    """(ask, fillable) under the chosen cost basis.

    calibrated: the canonical CALIBRATED_BOOK exec ask; fillable iff the walked depth covers the stake
    (the cheap zone is genuinely thin — $4-$24 below mid ~0.12 — so a $10 order often cannot fill at all).
    flat: the legacy mid+half-spread/floor, always considered fillable (the floor was its fillability proxy).
    """
    if book == "flat":
        return ask_of(mid, half_spread, floor), True
    q = cost_model.synth_quote(mid)
    if q is None:
        return None, False
    # effective cost = calibrated exec ask + the taker fee per share (fees.ts convention: charged on the
    # entry fill). The flat book's +1c was its TOTAL friction proxy; the calibrated askOver is spread only,
    # so the fee must be explicit here or the round-trip cost is understated (skill non-negotiable #3).
    eff = min(0.999, q["exec_ask"] + cost_model.taker_fee_per_share(q["exec_ask"], 0.05))
    return eff, q["depth_usd"] >= stake


def bet_net(ask, won, stake):
    """Net on one bet bought at `ask`: +stake*(1/ask-1) if the bucket wins, else -stake."""
    return stake * (1.0 / ask - 1.0) if won else -stake


def selftest():
    assert parse_temp("15C") == ("exact", 15)
    assert parse_temp("7C or below") == ("below", 7)
    assert parse_temp("17C or higher") == ("above", 17)
    bks = [(0, "below", 7, "lose"), (1, "exact", 15, "win"), (2, "above", 17, "lose")]
    assert choose(bks, 15) == (1, "win")
    assert choose(bks, 3) == (0, "lose")
    assert choose(bks, 20) == (2, "lose")
    assert abs(ask_of(0.12, 0.01, 0.03) - 0.13) < 1e-9
    assert abs(ask_of(0.001, 0.01, 0.03) - 0.03) < 1e-9   # floored
    assert abs(bet_net(0.10, True, 10) - 90.0) < 1e-9     # $10 at 0.10 wins -> +$90
    assert bet_net(0.10, False, 10) == -10.0
    cost_model.selftest()
    a, f = price_bet(0.12, "calibrated", 0.01, 0.03, 10)
    # knot 0.12: exec ask 0.138, + taker fee 0.05*0.138*(1-0.138) -> the all-in per-share cost
    assert abs(a - (0.138 + 0.05 * 0.138 * (1 - 0.138))) < 1e-9 and f is True
    a, f = price_bet(0.05, "calibrated", 0.01, 0.03, 10)
    assert f is False                                     # cheap zone: depth $4 < $10 -> cannot fill
    a, f = price_bet(0.12, "flat", 0.01, 0.03, 10)
    assert abs(a - 0.13) < 1e-9 and f is True             # legacy path unchanged (its +1c is total friction)
    print("selftest OK", file=sys.stderr)


def load_causal(path, lead):
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if int(row["lead"]) != lead:
                continue
            out[(row["icao"], row["target_date"])] = int(row["mu_native"])
    return out


def emit_ts(result, path, asof):
    """Write the committed, typed display asset (mirrors packages/core/sim/city-scan-results.ts idiom).
    Hand-generated from the JSON result so the dashboard renders a frozen record with no DB round trip."""
    p = result["params"]
    u = result["universe"]
    pl = result["pooled"]

    def numlit(x):
        # clean TS literal — repr(np.float64(4.3)) leaks 'np.float64(4.3)', so coerce to native first.
        if isinstance(x, str):
            return repr(x)
        if isinstance(x, bool):
            return "true" if x else "false"
        if isinstance(x, int):
            return str(x)
        return repr(float(x))

    def arr(xs):
        return "[" + ", ".join(numlit(x) for x in xs) + "]"

    def row_ts(r):
        leadnet = result["per_city_leads"].get(r["city"], {})
        ln = "{ " + ", ".join(f"'{k}': {v}" for k, v in leadnet.items()) + " }"
        return (
            f"  {{ city: {r['city']!r}, display: {r['display']!r}, icao: {r['icao']!r}, "
            f"bets: {r['bets']}, daysActive: {r['days_active']}, won: {r['won']}, lost: {r['lost']}, "
            f"winPct: {r['win_pct']}, winCi: {arr(r['win_ci'])}, avgAsk: {r['avg_ask']}, "
            f"staked: {r['staked']}, netUsd: {r['net_usd']}, roiPct: {r['roi_pct']}, "
            f"firstDate: {r['first_date']!r}, lastDate: {r['last_date']!r}, leadNet: {ln} }},"
        )

    def lead_ts(l):
        return (
            f"  {{ leadH: {l['lead_h']}, bets: {l['bets']}, days: {l['days']}, winPct: {l['win_pct']}, "
            f"avgAsk: {l['avg_ask']}, roiPct: {l['roi_pct']}, netUsd: {l['net_usd']}, ciPct: {arr(l['ci_pct'])} }},"
        )

    body = f'''/**
 * packages/core/sim/city-buy-table-results — the committed, typed record behind the /paper-trade per-city
 * table: "$10 on OUR predicted daily-high bucket, bought CHEAP (ask <= {p['cheap_max']}), held to market close",
 * scored across every city from the local price archive. Mirrors the city-scan-results.ts committed-asset
 * idiom (this file IS the display-ready record; the page renders it server-side, no DB round trip, no fetch).
 *
 * VERDICT (recorded {asof}): this is SIGNAL #12, opening-convergence — ALREADY FALSIFIED (FINDINGS.md /
 * MARKET-PNL.md). The cheap-entry filter buys the predicted bucket only while it is still a not-yet-converged
 * LONGSHOT. On the {p['book']} book (exec ask + taker fee; a bet exists only where walked depth covers the
 * stake) the fillable-and-cheap population nearly VANISHES — the sub-9c longshots that drove the legacy
 * mid+1c −28% were never fillable at this stake — and what remains is an UNDERPOWERED WASH leaning negative:
 * pooled ROI {pl['roi_pct']}% at the sweet-spot {p['sweet_lead_h']}h lead (win {pl['win_pct']}%, day-clustered
 * CI [{pl['day_ci_pct'][0]}%, {pl['day_ci_pct'][1]}%]) on {pl['bets']} bets / {u['n_days']} days /
 * {u['n_cities']} cities. NO lead demonstrates an edge (no day-clustered lower bound clears 0; every
 * well-populated lead's point estimate is negative; tiny-n rows are longshot noise). The
 * {pl['n_cities_positive']} net-positive cities are small-sample noise, not a per-city edge.
 *
 * SOURCE OF TRUTH: scripts/research/city-buy-table.py (reproduce below). Do NOT hand-edit a number — re-run:
 *   pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
 *   python scripts/research/city-buy-table.py --book {p['book']} --emit scripts/research/out/city-buy-table.json \\
 *     --emit-ts packages/core/src/sim/city-buy-table-results.ts --asof {asof}
 */

/** One entry-lead row of the pooled "sweet-spot" curve (hours before market close). No lead demonstrates an
 *  edge (no day-clustered lower bound clears 0); the fillable-and-cheap population COLLAPSES near close —
 *  by resolution the winner has converged above the cheap gate and the rest is too thin to fill. */
export interface CityBuyLeadPoint {{
  /** entry lead in hours before the market's close/resolution. */
  leadH: number;
  /** cheap-filtered bets pooled at this lead. */
  bets: number;
  /** distinct weather-days covered at this lead. */
  days: number;
  /** win rate at this lead (percent). */
  winPct: number;
  /** mean executable entry ask at this lead. */
  avgAsk: number;
  /** pooled ROI at this lead (percent of stake). */
  roiPct: number;
  /** pooled net P&L (USD) at this lead. */
  netUsd: number;
  /** day-clustered ROI 95% CI [lo, hi] in percent. */
  ciPct: [number, number];
}}

/** One city's row at the sweet-spot lead — the table the operator asked for. */
export interface CityBuyRow {{
  city: string;
  display: string;
  icao: string;
  /** bets placed (days the predicted bucket passed the cheap gate at the sweet lead). */
  bets: number;
  /** distinct weather-days a bet was active. */
  daysActive: number;
  won: number;
  lost: number;
  /** win rate (percent) with a Wilson 95% CI. */
  winPct: number;
  winCi: [number, number];
  /** mean executable entry ask (fraction). */
  avgAsk: number;
  /** total staked (USD). */
  staked: number;
  /** net P&L (USD) at the executable ask, held to resolution. */
  netUsd: number;
  /** ROI (percent of stake). */
  roiPct: number;
  firstDate: string;
  lastDate: string;
  /** net P&L (USD) by entry lead — the per-city "peak-time" sparkline. Keys are lead-hours as strings. */
  leadNet: Record<string, number>;
}}

export interface CityBuyTable {{
  params: {{
    stake: number;
    cheapMax: number;
    /** cost basis: 'calibrated' = the canonical CALIBRATED_BOOK exec ask + depth-fillability; 'flat' = legacy mid+1c. */
    book: string;
    halfSpread: number;
    floor: number;
    forecastLead: number;
    sweetLeadH: number;
    /** entry leads with a scoreable (cheap + fillable) population, far -> near. */
    leadsH: number[];
  }};
  universe: {{ nCities: number; nDays: number; dateRange: [string, string]; nCitiesTotal: number }};
  pooled: {{
    bets: number;
    won: number;
    winPct: number;
    avgAsk: number;
    netUsd: number;
    roiPct: number;
    dayCiPct: [number, number];
    nCitiesPositive: number;
  }};
  /** when the record was adjudicated. */
  recordedAt: string;
  leadCurve: CityBuyLeadPoint[];
  /** per-city rows at the sweet-spot lead, pre-sorted by net P&L descending. */
  rows: CityBuyRow[];
}}

export const CITY_BUY_TABLE: CityBuyTable = {{
  params: {{ stake: {p['stake']}, cheapMax: {p['cheap_max']}, book: {p['book']!r}, halfSpread: {p['half_spread']}, floor: {p['floor']}, forecastLead: {p['forecast_lead']}, sweetLeadH: {p['sweet_lead_h']}, leadsH: {arr(p['leads_h'])} }},
  universe: {{ nCities: {u['n_cities']}, nDays: {u['n_days']}, dateRange: {arr(u['date_range'])}, nCitiesTotal: {len(result['per_city_leads'])} }},
  pooled: {{ bets: {pl['bets']}, won: {pl['won']}, winPct: {pl['win_pct']}, avgAsk: {pl['avg_ask']}, netUsd: {pl['net_usd']}, roiPct: {pl['roi_pct']}, dayCiPct: {arr(pl['day_ci_pct'])}, nCitiesPositive: {pl['n_cities_positive']} }},
  recordedAt: {asof!r},
  leadCurve: [
{chr(10).join(lead_ts(l) for l in result['lead_curve'])}
  ],
  rows: [
{chr(10).join(row_ts(r) for r in result['per_city'])}
  ],
}};
'''
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stake", type=float, default=10.0)
    ap.add_argument("--lead", type=int, default=1, help="forecast lead-day (causal CSV) to bet")
    ap.add_argument("--cheap-max", type=float, default=0.15, help="only enter when the executable ask <= this")
    ap.add_argument("--book", choices=["calibrated", "flat"], default="calibrated",
                    help="cost basis: 'calibrated' = the canonical CALIBRATED_BOOK exec ask + depth-fillability "
                         "(cost_model.py); 'flat' = the legacy mid+half-spread/floor (for comparison)")
    ap.add_argument("--half-spread", type=float, default=0.01, help="flat-book only")
    ap.add_argument("--floor", type=float, default=0.03, help="flat-book only")
    ap.add_argument("--archive", default=ARCHIVE)
    ap.add_argument("--causal", default=CAUSAL_CSV)
    ap.add_argument("--emit", default=None, help="write the dashboard JSON artifact to this path")
    ap.add_argument("--emit-ts", default=None, help="write the committed typed display asset (.ts) to this path")
    ap.add_argument("--asof", default="", help="record date (YYYY-MM-DD) stamped into the artifacts")
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
    CHEAP = a.cheap_max
    causal = load_causal(a.causal, a.lead)
    pred_col = f"pred_c_l{a.lead}"
    dset = ds.dataset(a.archive, format="parquet")
    cities = sorted(pc.unique(dset.to_table(columns=["city"]).column("city")).to_pylist())

    # one bet-row per (city, event, lead): entry ask, whether the bucket won, whether it passed the cheap gate
    rows = []
    for city in cities:
        icao = SLUG2ICAO.get(city)
        if not icao:
            continue
        tbl = dset.to_table(
            filter=(pc.field("city") == city) & pc.field(pred_col).is_valid(),
            columns=["event_id", "target_date", "end_ts", "bucket_idx", "label", "resolved_outcome", "t", "p"],
        )
        df = tbl.to_pandas()
        if df.empty:
            continue
        for _, g in df.groupby("event_id", sort=False):
            date = str(g.target_date.iloc[0])
            cnat = causal.get((icao, date))
            if cnat is None:
                continue
            end_ts = int(g.end_ts.iloc[0])
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
            pick = choose(meta, int(cnat))
            if pick is None or pick[0] not in paths:
                continue
            b_idx, resolved = pick
            won = resolved == "win"
            ts, ps = paths[b_idx]

            def mid_at(targ):
                j = int(np.searchsorted(ts, targ))
                j = min(max(j, 0), len(ts) - 1)
                if j > 0 and abs(ts[j - 1] - targ) < abs(ts[j] - targ):
                    j -= 1
                return float(ps[j])

            for L in LEADS_H:
                mid = mid_at(end_ts - L * 3600)
                ask, fillable = price_bet(mid, a.book, a.half_spread, a.floor, STAKE)
                if ask is None:
                    continue  # degenerate mid — no real quote exists
                rows.append({
                    "city": city, "icao": icao, "date": date, "lead_h": L,
                    # a "cheap" bet must ALSO be fillable at the stake — an order the walked depth cannot
                    # absorb is not a bet, it's a fantasy (the calibrated cheap zone is $4-$24 thin).
                    "ask": ask, "won": won, "cheap": (ask <= CHEAP) and fillable,
                })

    b = pd.DataFrame(rows)
    log = lambda *x: print(*x, file=sys.stderr)
    if b.empty:
        log("no bets — check the archive/causal paths")
        return

    # ── pooled per-lead read on the CHEAP-filtered population: pick the sweet-spot lead by day-clustered CI ──
    def net_col(df):
        return np.where(df.won.values, STAKE / df.ask.values - STAKE, -STAKE)

    def day_ci(df, iters=4000, seed=42):
        rng = np.random.default_rng(seed)
        net = net_col(df)
        keys = (df.city + "|" + df.date).values
        uk = np.array(sorted(set(keys)))
        idxby = {k: np.where(keys == k)[0] for k in uk}
        est = np.empty(iters)
        for i in range(iters):
            sel = np.concatenate([idxby[k] for k in rng.choice(uk, len(uk), replace=True)])
            est[i] = 100 * net[sel].sum() / (STAKE * len(sel))
        est.sort()
        return est[int(0.025 * iters)], est[int(0.975 * iters)]

    log(f"\nCHEAP-FILTERED (<= {CHEAP:.2f} ask) — pooled ROI by entry lead (the sweet-spot axis):")
    log(f"  {'lead':>5} {'bets':>5} {'days':>5} {'win%':>6} {'avgAsk':>7} | {'ROI':>8} {'net$':>9} | {'day-CI':>18}")
    lead_summ = []
    for L in LEADS_H:
        d = b[(b.lead_h == L) & b.cheap]
        if d.empty:
            continue
        net = net_col(d)
        roi = 100 * net.sum() / (STAKE * len(d))
        win = 100 * d.won.mean()
        lo, hi = day_ci(d)
        lead_summ.append({"lead_h": int(L), "bets": int(len(d)), "days": int(d.date.nunique()),
                          "win_pct": round(win, 1), "avg_ask": round(float(d.ask.mean()), 3),
                          "roi_pct": round(roi, 1), "net_usd": round(float(net.sum()), 0),
                          "ci_pct": [round(lo, 1), round(hi, 1)]})
        log(f"  {L:>4}h {len(d):>5} {d.date.nunique():>5} {win:>5.1f}% {d.ask.mean():>7.3f} | "
            f"{roi:>+7.1f}% {net.sum():>+9.0f} | [{lo:>+6.1f}%, {hi:>+6.1f}%]")

    # sweet-spot lead = the cheap-filtered lead with the highest day-clustered LOWER bound (shrinkage, not the
    # point estimate — an honest "least likely to be luck" choice, mirrors the entry-watcher's LB rule).
    sweet = max(lead_summ, key=lambda s: s["ci_pct"][0])["lead_h"]
    log(f"\nsweet-spot lead (max day-clustered lower-bound) = {sweet}h")

    prim = b[(b.lead_h == sweet) & b.cheap].copy()
    net = net_col(prim)
    pooled_roi = 100 * net.sum() / (STAKE * len(prim))
    plo, phi = day_ci(prim)
    clo, chi = day_ci(prim.assign())  # city+day key already; keep same (city|date) unit

    # ── per-city table at the sweet-spot lead ──
    def wilson(k, n, z=1.96):
        if n == 0:
            return (0.0, 0.0)
        p = k / n
        d = 1 + z * z / n
        c = p + z * z / (2 * n)
        h = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
        return ((c - h) / d, (c + h) / d)

    per_city = []
    for city, g in prim.groupby("city"):
        gnet = net_col(g)
        k = int(g.won.sum())
        n = int(len(g))
        wlo, whi = wilson(k, n)
        per_city.append({
            "city": city, "display": display_name(city), "icao": g.icao.iloc[0],
            "bets": n, "days_active": int(g.date.nunique()), "won": k, "lost": n - k,
            "win_pct": round(100 * k / n, 1), "win_ci": [round(100 * wlo, 1), round(100 * whi, 1)],
            "avg_ask": round(float(g.ask.mean()), 3), "staked": round(STAKE * n, 0),
            "net_usd": round(float(gnet.sum()), 2), "roi_pct": round(100 * gnet.sum() / (STAKE * n), 1),
            "first_date": g.date.min(), "last_date": g.date.max(),
        })
    per_city.sort(key=lambda r: r["net_usd"], reverse=True)

    # also: per-city net at EVERY lead (for a compact per-city sweet-spot sparkline in the UI)
    per_city_leads = {}
    for city, g in b[b.cheap].groupby("city"):
        per_city_leads[city] = {}
        for L in LEADS_H:
            d = g[g.lead_h == L]
            if d.empty:
                continue
            dn = net_col(d)
            per_city_leads[city][str(int(L))] = round(float(dn.sum()), 1)

    n_cities_pos = sum(1 for r in per_city if r["net_usd"] > 0)
    log(f"\nPER-CITY @ {sweet}h cheap: {len(per_city)} cities, {n_cities_pos} net-positive, "
        f"{len(per_city) - n_cities_pos} net-negative")
    log(f"pooled: {len(prim)} bets / {prim.date.nunique()} days / {prim.city.nunique()} cities · "
        f"ROI {pooled_roi:+.1f}% day-CI [{plo:+.1f}%, {phi:+.1f}%] · net ${net.sum():+.0f}")

    result = {
        "script": "city-buy-table",
        "recorded_at": a.asof or None,
        # leads_h = the leads with a scoreable (cheap+fillable) population — under the calibrated book a lead
        # can be empty (nothing both cheap AND depth-fillable), so the curve carries what actually exists.
        "params": {"stake": STAKE, "cheap_max": CHEAP, "book": a.book, "half_spread": a.half_spread,
                   "floor": a.floor, "forecast_lead": a.lead, "sweet_lead_h": sweet,
                   "leads_h": [s["lead_h"] for s in lead_summ]},
        "universe": {"n_cities": int(prim.city.nunique()), "n_days": int(prim.date.nunique()),
                     "date_range": [prim.date.min(), prim.date.max()]},
        "pooled": {"bets": int(len(prim)), "won": int(prim.won.sum()),
                   "win_pct": round(100 * prim.won.mean(), 1), "avg_ask": round(float(prim.ask.mean()), 3),
                   "net_usd": round(float(net.sum()), 0), "roi_pct": round(pooled_roi, 1),
                   "day_ci_pct": [round(plo, 1), round(phi, 1)], "n_cities_positive": n_cities_pos},
        "lead_curve": lead_summ,
        "per_city": per_city,
        "per_city_leads": per_city_leads,
    }
    print(json.dumps(result))
    if a.emit:
        with open(a.emit, "w") as f:
            json.dump(result, f, indent=2)
        log(f"wrote {a.emit}")
    if a.emit_ts:
        emit_ts(result, a.emit_ts, a.asof or result["universe"]["date_range"][1])
        log(f"wrote {a.emit_ts}")


if __name__ == "__main__":
    main()
