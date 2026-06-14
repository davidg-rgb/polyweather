# Forecasting-skill R&D — log

> The market-beating lever per `DF5-FINDINGS.md` is forecasting **skill** (getting μ into the
> right bucket), not calibration. This log tracks the experiments against that, each a measured
> yes/no. Harness: `scripts/research/mos-pointskill.ts` (+ `.test.ts`). Started 2026-06-14 (iter-46).

## The instrument (read this first)

`mos-pointskill.ts` is an **offline, read-only, controlled walk-forward A/B** over the backfill
(`forecast_snapshots` slot `backfill` vs finalized `observations`). For each (station, model, lead)
it keeps a trailing `sigmaWindowDays` window and, building each target day on PRIOR data only,
computes the house blend μ under several arms that change **one variable at a time**, then scores
the **ladder-free point error in °C** (|μ − obs|, the direct proxy for *aim*).

Two deliberate design choices, both to dodge the overfit trap `DF5-FINDINGS` flagged for the
prior-σ lever:
- **Metric = point RMSE/MAE over the FULL backfill** (months × all covered stations), *not* Brier
  on the 30-day market window. Brier needs Polymarket ladders (30 days only, small, overfit-prone);
  point error needs only forecasts+obs (28 months, large-n). A μ-aim gain *must* show here first.
- **One variable per arm.** Probe #1 varies the per-model **correction** with blend weights held at
  the live inverse-MSE. Probe #2 varies the blend **weights** with the correction held at baseline.

`baseline` = the live model exactly (per-model `f − EMA_bias`, intercept only, slope ≡ 1; inverse-MSE
blend). Harness sanity: the baseline blend (lead-1 RMSE **1.33°C**) beats the best single model
(`icon_seamless` 1.46°C) — the blend works, so the comparison is trustworthy.

Run: `pnpm tsx scripts/research/mos-pointskill.ts --from 2025-01-01 --to 2026-06-12 --leads 1,2,3`
(45 stations, 8,775 blended build-days scored).

## Baseline (the number to beat)

| | lead 1 | lead 2 | lead 3 | overall |
|---|---|---|---|---|
| **blend μ RMSE (°C)** | 1.3325 | 1.5706 | 1.7660 | **1.5657** |
| blend μ MAE (°C) | 0.9898 | 1.1470 | 1.2937 | 1.1430 |

A ~1.3–1.6°C point RMSE against Polymarket buckets ~0.5–1°C wide IS the aim deficit in absolute
terms: μ is routinely 1–2 buckets off.

## Probe #1 — regression MOS (slope-free per-model correction). REJECTED.

Hypothesis: mean bias ≈ 0 with bad aim is the signature of **conditional/slope** bias; the live
intercept-only correction can't remove it; `obs = a + b·forecast` (OLS, b free) can.

| arm | overall RMSE Δ vs live |
|---|---|
| `mos` (OLS slope+intercept) | **−3.32%** (worse) |
| `mos_shrunk` (slope shrunk toward 1 by n/(n+10)) | −1.95% (worse) |

Uniform MOS makes the blend WORSE — but the per-model view explains why and is the real finding:

| model (lead 1) | `mos` Δ | model (lead 1) | `mos` Δ |
|---|---|---|---|
| **gfs_seamless** | **+3.84%** | **icon_seamless** | **−5.21%** |
| meteofrance | +1.83% | jma_seamless | −3.22% |
| ecmwf_ifs025 | +0.74% | ukmo_seamless | −2.47% |

MOS **helps the weak models** (gfs +3.8/+6.3/+5.1% across leads 1/2/3; the genuine slope error is
real) and **hurts the strong models** (icon −5.2/−4.6/−2.9%). But the inverse-MSE blend already
**down-weights gfs and up-weights icon** — so MOS improves exactly what the blend ignores and
degrades exactly what it leans on → net negative. `mos_shrunk` is uniformly less bad (small-window
overfit is part of the damage) but still loses. **The aim deficit is not per-model conditional bias.**

## Probe #2 — recency / concentration reweighting. REJECTED.

Hypothesis (DF5 lever 1, the tractable "recency" half): weight models by *recent* local skill, or
concentrate harder on the best, rather than a flat inverse-MSE window.

| arm | overall RMSE Δ vs live |
|---|---|
| `recency` (inverse-MSE on a 10-day half-life decayed window) | **−0.01%** (neutral) |
| `concentrate` (1/MSE² — sharper toward the best model) | −0.43% (worse) |

Both fail. Recency is a wash because the **skill ranking is stable** over the window (icon/ecmwf are
consistently best — recency just adds variance without signal). Concentration loses the blend's
**diversification** benefit. The live inverse-MSE blend is already near-optimal *for point error*.

## Conclusion so far

The two cheap, tunable levers — **post-processing the correction** and **reweighting the blend** —
are **exhausted**. They do not move μ-aim on large-n out-of-sample data. This sharpens `DF5-FINDINGS`:
the gap is not a knob on the existing pipeline; the inverse-MSE intercept-corrected blend sits at the
**point-skill ceiling of these inputs**. Consistent with DF-5: **ship no model change.**

## What's left (the structural levers — bigger, none disproven)

1. **Regime-conditional weighting** — the *untested* half of DF5 lever 1. Not recency, but
   conditioning weights on the synoptic regime (model-disagreement/spread bucket, season, or a
   pattern proxy): "which model is best *when the models disagree this much / in this season*." Needs
   a regime feature + per-regime fit + a hard overfit guard. **Next probe (#3).**
2. **The intraday nowcast beyond lead 0** — at lead 0 the running-max + climatological lift
   (`nowcast_lift`, ADR-15) is genuine non-NWP information. Its lead-0 aim contribution is unmeasured
   in isolation; and partial-day signal may help lead-1 late builds. Needs intraday replay data.
   **Probe #4.**
3. **Better inputs (DF5 lever 3)** — the likeliest real lever given #1/#2 of this log: a stronger
   deterministic source or station-level features (urban heat island, microclimate) the free NWP
   grid misses. This breaks the input ceiling rather than re-tuning under it.

Rejected, unchanged from DF-5: **blending the market price into the prior** (beats Brier-vs-market by
construction, defeats the thesis).

## Bottom line

Two levers measured and killed with large-n walk-forward evidence; the harness now makes every future
lever a fast yes/no. The market-beating path is **regime-conditional skill or better inputs**, not
tuning the blend. Do not promote (F-019); do not spend cycles on MOS or reweighting.

---

# Round 2 — handoff work-orders (`FORECASTING-RD-HANDOFF.md`)

Driven as the continuous loop (order L3-b → WO-3 → WO-4 → L3-a → L3-c). Each verdict committed.

## WO-L3-b — residual-structure diagnostic. VERDICT: NO exploitable structure → feature/MOS lever DEAD.

The decider: does the live blend residual `(μ − obs)` carry structure an observable feature could
explain? Script `scripts/research/l3b-residual-structure.ts` (+ `.test.ts`), walk-forward over the full
backfill, 45 stations, **8,775 builds**.

- **Residual: mean +0.025°C (≈0 → bias-corrected ✓), std 1.5655°C** (= the baseline blend RMSE — validates).
- **Per-feature Pearson |corr| with the residual — all tiny:** disagreement **0.0745** (strongest),
  anomaly 0.017, season_sin 0.005, season_cos 0.003, lead 0.004.
- **Multivariate in-sample R² of residual on ALL features: 0.60%** — and that is the *upper* bound on
  exploitable variance (OOS would be less).
- **Per-station residual means all ≈0** (−0.07…+0.17): the blend's per-station-per-model bias correction
  already works; no station-level bias survives. Residual std is per-station forecast difficulty
  (EHAM 0.85, KMIA 0.86 easy; KORD 2.04 hard) — irreducible, not bias.

**Verdict: the residual is effectively irreducible NWP error.** Any feature-based or MOS-style
correction is capped at <0.6% — DEAD (a third, independent confirmation of #1/#2). **Lever-3 therefore
means a genuinely BETTER SOURCE, not a feature** → L3-c is the live branch. Caveat for WO-3: regime
weighting reallocates weight by regime-specific *skill ranking* (a different mechanism than predicting
the residual from a regime feature), so it is still measured — but this result lowers its prior.

## WO-3 — regime-conditional weighting. VERDICT: REJECTED.

Script `scripts/research/wo3-regime-weighting.ts` (+ `.test.ts`). Per-(model, lead, regime) skill
windows; regime weights shrunk toward the global inverse-MSE by n/(n+12); correction held at baseline.
Walk-forward, 45 stations, 8,775 builds.

| regime arm | overall RMSE Δ vs live |
|---|---|
| `regime_season` (DJF/MAM/JJA/SON) | **−0.05%** (neutral) |
| `regime_disagreement` (rolling spread terciles) | **−0.02%** (neutral) |

Both neutral, far below the +1.5% bar; per-station deltas are tiny and mixed (KORD +0.08/+0.20%, KSEA
−0.29/0.00%, KSFO +0.15/−0.21%). **The model skill RANKING is regime-stable** — conditioning weights on
season or model-disagreement does not move μ-aim. This is the *fourth* independent confirmation (after
#1 MOS, #2 reweighting, L3-b structure) that the existing-NWP-input branch is exhausted.

## WO-4 — intraday nowcast beyond lead 0. VERDICT: WORKS (the first positive lever, and a big one).

Script `scripts/research/wo4-nowcast-value.ts` (+ `.test.ts`). Data: `intraday_advances` (running max by
local hour) spans **182 days × 45 stations** — NOT blocked. Walk-forward: NWP lead-0 build μ (baseline
blend of lead-1 forecasts) vs the nowcast `running_max_h + median(obs − running_max_h)` (lift refit
walk-forward, no lookahead), by local hour, 9,486 (station,day,hour) samples. (`max_tenths_c` is a
misnomer — it stores °C; verified KORD 2026-06-01 h14 = 22.2 == 72°F.)

| local hour | NWP RMSE | nowcast RMSE (Δ%) | gate RMSE (Δ%) | oracle-min |
|---|---|---|---|---|
| 0–10 (morning) | ~1.17 | 2.0–4.2 (−75…−230%) | ~neutral | ~0.9–1.1 |
| 12 | 1.205 | 1.445 (−20%) | 1.122 (**+6.8%**) | 0.780 |
| 13 | 1.179 | 1.161 (+1.5%) | 0.991 (**+16.0%**) | 0.677 |
| 14 | 1.227 | 0.897 (+26.9%) | 0.915 (**+25.5%**) | 0.552 |
| 15 | 1.180 | **0.652 (+44.7%)** | 0.833 (**+29.4%**) | 0.428 |

**The same-day intraday running-max + lift nearly HALVES the point error vs the NWP blend by mid-afternoon.**
The `gate` variant — use the nowcast only when the running max already EXCEEDS μ_NWP (a hard, provable
"the day WILL beat the forecast" lower-bound) — is walk-forward-safe and positive from ~noon, reaching
+25–29% at h14–15. The morning hours are correctly negative (the running max is far from the daily max
and the lift is uncertain). oracle-min (per-sample best of NWP/nowcast, an unrealizable ceiling) shows
0.43°C at h15 — there is a lot of capturable value.

**This reframes the thesis.** DF-5 + probes #1–3 + L3-b proved the multi-day NWP blend is at its
point-skill ceiling and loses to market. WO-4 shows the system's REAL edge is the **late-day intraday
signal**, which the NWP path doesn't carry. The production lead-0 build already applies a running-max
constraint (ADR-15) — so this CONFIRMS that path is the valuable one and shows the value is strongly
**hour-dependent (concentrated after ~13:00 local)**.

### Productionization sketch (for operator review — NOT auto-shipped)

1. **Bet/build timing is the lever.** The nowcast edge at h15 (+45% point-skill) dwarfs h10 (−75%). The
   value is only capturable if the lead-0 build/bet runs at/after the local afternoon. Audit the 22Z
   slot's local-hour alignment per station; consider a late same-day build/bet pass closer to market
   close for stations whose afternoon lags 22Z. **This is the highest-leverage, lowest-risk change.**
2. **Sharpen the lead-0 distribution toward the nowcast at late hours.** The current
   `applyRunningMaxConstraint` may be too soft; the data says by h14–15 the nowcast should dominate the
   NWP prior. Re-evaluate the constraint's weight as a function of local hour.
3. **Refocus the market-beating R&D** from the NWP blend (dead end) to the late-day intraday capture +
   its timing. Re-run the 30-day market-overlap Brier with a late-hour, nowcast-weighted lead-0 build to
   see if THIS beats `market_consensus` where the NWP blend did not.

Caveat: this is point-RMSE; the Brier/edge-vs-market confirmation needs the 30-day market-overlap re-run
with a late-hour build. But the magnitude (NWP 1.18 → nowcast 0.65 at h15) is large and physical.
