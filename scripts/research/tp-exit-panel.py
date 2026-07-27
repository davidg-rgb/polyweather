"""TP-EXIT panel: does a take-profit exit beat hold-to-resolution for the buy-table lane?

Mirror cohort of the live buy-table lane on the enriched market-history archive
(2026-03-28..07-02, 45 cities): position = our lead-0 predicted bucket, entered at the
first tick inside the lane's [close-12h, close-2h] window whose price is in the fillable
band [0.10, 0.45]. For each position: did the mid path touch X in (entry, close], and
what would selling at the touch have netted vs holding?

Key identity: delta(TP - hold) is nonzero ONLY on touched events, where it equals
(X - spread - won). Under the martingale null E[won | touch X] = X, so
E[delta] = -spread * P(touch): TP can only win if win-rate-given-touch < X.

GOTCHA handled (memory: pricing-bucket-exhaustive-close): archive bucket_idx is RAW
GAMMA order; pred_bucket_l0 is TEMPERATURE-SORTED index space. Join via label-parsed
temperature rank, never positional.

Writes: scripts/research/out/tp-exit-panel.csv (per-event rows) +
        scripts/research/out/tp-exit-verdict.json (the stats bundle).
Read-only by contract: reads the parquet, writes only to out/.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds

ROOT = Path(__file__).resolve().parents[1] / "research" / "out"
ARCHIVE = ROOT / "market-history-flat-enriched.parquet"

ENTRY_LO, ENTRY_HI = 0.10, 0.45          # lane fillable band (post-guard fills 0.18-0.44)
WINDOW_S, LEAD_MIN_S = 12 * 3600, 2 * 3600
THRESHOLDS = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]
SPREADS = [0.0, 0.01, 0.02]              # mid, bid proxy at observed 0.3-1c half-spreads, stress
ALLOWLIST = {"ankara", "helsinki", "wellington", "kuala-lumpur", "madrid", "singapore"}

TEMP_RE = re.compile(r"(-?\d+)")


def parse_temp(label: str) -> float:
    m = TEMP_RE.search(label)
    return float(m.group(1)) if m else np.nan


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def clustered_ci(values: pd.Series, clusters: pd.Series, z: float = 1.96):
    """Mean of per-cluster means +/- z * SE across clusters (the frozen-gate idiom)."""
    m = values.groupby(clusters).mean()
    if len(m) < 2:
        return (float(values.mean()), np.nan, np.nan, len(m))
    mu, se = m.mean(), m.std(ddof=1) / np.sqrt(len(m))
    return (float(mu), float(mu - z * se), float(mu + z * se), len(m))


def main() -> None:
    dataset = ds.dataset(str(ARCHIVE))

    # Pass A: per-event bucket dimension (last hour of each series -> near-distinct rows)
    fcast = pc.is_valid(pc.field("pred_bucket_l0"))
    dim = dataset.to_table(
        filter=fcast & (pc.field("t") >= pc.field("end_ts") - 3600),
        columns=["city", "target_date", "event_id", "end_ts", "bucket_idx", "label",
                 "resolved_outcome", "pred_bucket_l0"],
    ).to_pandas().drop_duplicates(subset=["event_id", "bucket_idx"])

    dim["temp"] = dim["label"].map(parse_temp)
    dim = dim.dropna(subset=["temp"])
    dim["sorted_idx"] = dim.groupby("event_id")["temp"].rank(method="first").astype(int) - 1
    picked = dim[dim["sorted_idx"] == dim["pred_bucket_l0"].round().astype(int)].copy()
    picked["won"] = (picked["resolved_outcome"] == "win").astype(int)
    # keep events whose winner is known (some buckets can be unresolved/absent)
    resolved_events = set(dim.loc[dim["resolved_outcome"] == "win", "event_id"])
    picked = picked[picked["event_id"].isin(resolved_events)]
    keys = picked[["event_id", "bucket_idx", "city", "target_date", "end_ts", "won", "label"]]
    print(f"pass A: {len(dim)} bucket rows -> {len(keys)} predicted-bucket events", file=sys.stderr)

    # Pass B: price paths of the predicted buckets inside the lane window
    paths = dataset.to_table(
        filter=fcast & (pc.field("t") >= pc.field("end_ts") - WINDOW_S),
        columns=["event_id", "bucket_idx", "t", "p", "end_ts"],
    ).to_pandas()
    paths = paths.merge(keys[["event_id", "bucket_idx"]], on=["event_id", "bucket_idx"], how="inner")
    print(f"pass B: {len(paths)} path ticks on predicted buckets", file=sys.stderr)

    rows = []
    for eid, g in paths.groupby("event_id", sort=False):
        g = g.sort_values("t")
        end = g["end_ts"].iloc[0]
        win_g = g[g["t"] <= end - LEAD_MIN_S]
        entry = win_g[(win_g["p"] >= ENTRY_LO) & (win_g["p"] <= ENTRY_HI)].head(1)
        if entry.empty:
            continue
        e_t, e_p = float(entry["t"].iloc[0]), float(entry["p"].iloc[0])
        post = g[g["t"] > e_t]
        max_p = float(post["p"].max()) if len(post) else e_p
        row = {"event_id": eid, "entry_t": e_t, "entry_p": e_p, "max_p": max_p,
               "lead_h": (end - e_t) / 3600}
        for x in THRESHOLDS:
            touched = post[post["p"] >= x]
            row[f"touch_{int(x*100)}"] = int(len(touched) > 0)
            row[f"ft_h_{int(x*100)}"] = (end - float(touched["t"].iloc[0])) / 3600 if len(touched) else np.nan
        rows.append(row)

    panel = pd.DataFrame(rows).merge(
        keys[["event_id", "city", "target_date", "won", "label"]], on="event_id")
    panel.to_csv(ROOT / "tp-exit-panel.csv", index=False)
    print(f"panel: {len(panel)} entered events, {panel['city'].nunique()} cities, "
          f"{panel['target_date'].nunique()} days, win rate {panel['won'].mean():.3f}",
          file=sys.stderr)

    def stats_for(sub: pd.DataFrame, name: str) -> dict:
        out = {"name": name, "n": len(sub), "cities": int(sub["city"].nunique()),
               "days": int(sub["target_date"].nunique()),
               "win_rate": float(sub["won"].mean()) if len(sub) else np.nan,
               "hold_net_mean": float((sub["won"] - sub["entry_p"]).mean()) if len(sub) else np.nan,
               "thresholds": []}
        for x in THRESHOLDS:
            col = f"touch_{int(x*100)}"
            touched = sub[sub[col] == 1]
            k, n = int(touched["won"].sum()), len(touched)
            wlo, whi = wilson(k, n)
            t = {"x": x, "n_touched": n, "touch_rate": n / len(sub) if len(sub) else np.nan,
                 "win_given_touch": k / n if n else np.nan,
                 "wilson_lo": wlo, "wilson_hi": whi, "martingale_null": x,
                 "median_ft_h": float(touched[f"ft_h_{int(x*100)}"].median()) if n else np.nan}
            for spr in SPREADS:
                # delta(TP - hold) per event: touched -> (x - spr - won), else 0
                delta = np.where(sub[col] == 1, x - spr - sub["won"], 0.0)
                dsr = pd.Series(delta, index=sub.index)
                mu_c, lo_c, hi_c, ncl = clustered_ci(dsr, sub["city"])
                mu_d, lo_d, hi_d, ndl = clustered_ci(dsr, sub["target_date"])
                t[f"delta_spr{int(spr*100)}"] = {
                    "mean": float(dsr.mean()),
                    "city_ci": [mu_c, lo_c, hi_c, ncl],
                    "day_ci": [mu_d, lo_d, hi_d, ndl]}
            out["thresholds"].append(t)
        return out

    result = {
        "archive": str(ARCHIVE.name),
        "entry_band": [ENTRY_LO, ENTRY_HI], "window_h": [2, 12],
        "all45": stats_for(panel, "all-45-cities"),
        "allowlist": stats_for(panel[panel["city"].isin(ALLOWLIST)], "allowlist-6"),
    }
    (ROOT / "tp-exit-verdict.json").write_text(json.dumps(result, indent=1))
    print("RESULT " + json.dumps({k: result[k] for k in ("all45", "allowlist")})[:400], file=sys.stderr)
    print("wrote tp-exit-panel.csv + tp-exit-verdict.json", file=sys.stderr)


if __name__ == "__main__":
    main()
