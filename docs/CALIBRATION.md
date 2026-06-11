# CALIBRATION — EMOS math, scoring, promotion (matches core/calibration + §6.18)

## Bias (per station × model × lead × slot)

Decaying average: `bias ← α·error + (1−α)·bias`, error = forecast°C − observed°C,
α = `biasAlpha` (0.15). First observation seeds bias = error. `correctPoint(raw,
bias) = raw − bias` is **the only bias-subtraction site in the codebase** — a
grep tripwire test enforces it.

## σ and weights

- `fitSigma`: sample std-dev (n−1) of the corrected-residual window
  (`sigmaWindowDays` = 30); returns null under `sigmaMinN` = 8 → fall back to
  the prior ladder `priorSigmaByLead` = [1.6, 1.9, 2.3, 2.7, 3.1, 3.5, 3.9, 4.3] °C
  (leads 0–7). Floor: `sigmaFloorC` = 0.45 °C, applied BEFORE native conversion
  (°F σ = °C σ × 9/5).
- Weights: inverse-MSE over the window, normalized to Σ=1; models with window
  n < sigmaMinN are excluded from weighting that run (qualification guard);
  no qualified model ⇒ equal weights.
- Blend σ: per (station, lead, slot), the σ of weight-renormalized blended
  residuals — stored as the `'blend'` pseudo-model row in model_stats.
  Backfill seeds BOTH live slots (10Z/22Z) at ×1.15 widening (W19).

## House distribution (§6.16)

μ = weighted mean of bias-corrected per-model points → native units →
`gaussianBucketProbs(μ, σ_blend, ladder)` (Φ via A&S 7.1.26, |ε| < 7.5e-8;
renormalized; DistributionError at σ ≤ 0.2). house_ensemble dresses pooled
bias-corrected members (≥20 guard). Lead-0 + intraday running max ⇒ ADDITIONAL
nowcast=true rows via `applyRunningMaxConstraint` (bucket elimination +
piecewise-linear lift CDF through (p50, 0.5)/(p90, 0.9)).

## Scoring (ADR-16 — the comparison everything gates on)

`cutoff(event, lead) = localDayWindow(tz, target).startUtc − lead × 24h`,
scored leads {0, 1} only. The scored row per (event, source, lead) = the LAST
`bucket_probabilities` row with `made_at ≤ cutoff` and `nowcast = false`.
Gate/promotion statistics use only (event, lead) pairs where BOTH the house
source and market_consensus have a scored row (C7 — asymmetric availability
must not tilt the comparison).

**Brier** = Σq² − 2·q_winner + 1 over the bucket vector. 0 = certainty on the
winner; uniform over 11 buckets = 1/11 − 2/11 + 1 ≈ **0.909**; worst case 2.
**ECE** = n-weighted |observed − predicted| over reliability bins;
**sharpness** = mean Σq² (higher = more concentrated). All from
core/calibration/scores.ts, aggregated over 30/60/90d windows per
(city, lead, source) plus the pooled zero-UUID gate row (lead −1 sentinel)
carrying `pairedBootstrapPValue` (seeded, one-sided; returns 1.0 under n<30).

## Promotion (F-019) and the gate (C5)

Champion promotion (admin → server re-checked): ≥60 distinct out-of-sample
days ∧ paired bootstrap p < 0.05 vs market_consensus ∧ point estimate ≤ 0.95×.
The go-live gate adds per-city enablement (≤1.0× with n ≥ 30) and the
operational conditions — see GO-LIVE-CHECKLIST.md. A zero-skill Monte-Carlo
regression test holds the conjunctive gate's false-pass rate < 5%.

## Backtest

`scripts/simulate-historical-edge.ts` replays the same math walk-forward with
the live information horizon (stats for lead L of day D fold targets ≤ D−L−2,
mirroring run-calibration's 11:30Z cadence) and writes `window_tag='backtest'`
rows. Its consensus-mid price proxy is NOT an executable book — the printed
fidelity note marks results as gating-direction only (§11.4).
