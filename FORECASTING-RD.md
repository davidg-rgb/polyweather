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
