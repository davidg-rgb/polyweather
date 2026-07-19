# SWING-BIAS — swing-conditional hot/cold correction on regime-transition days. VERDICT: KILL. 2026-07-19.

> **The question (operator):** can hit rate / model efficiency improve by identifying big swings in
> average temperature (heatwave onsets, cold fronts) and applying hot/cold biases on those smaller daily
> clusters — i.e., accommodating how regime transitions disrupt standard forecasting?
>
> **The answer: no corrector converts to accuracy — KILL for the documented metric.** But the diagnostic
> found the one real (and previously unmeasured) piece of structure in the forecast: **the model
> under-regresses its own big regime-change calls** — consistently, at every lead. It is real, it is
> recorded, and it is too small relative to the 1° bucket to move picks. The 7th rejected point-skill lever.

## Hypothesis + mechanism tested

The blend's bias correction is learned on TRAILING residuals (`model_stats`), so it is stale exactly when
the regime flips — after a stable warm stretch, a cold front arrives and the learned warm-regime
correction points the wrong way. WO-L3-b killed feature-MOS on anomaly/season/disagreement/lead but never
tested a recent-swing feature; WO-3 killed regime *weighting*, not swing-conditional *bias*. This was the
one untested seam in the family.

Three conditioners, all knowable at forecast time (windows end at D−lead−1, leakage-shifted):
- **A obs-swing** = mean(last 2 obs) − mean(last 7 obs) — the operator's "small daily cluster vs average"
- **B pred-swing** = μ − mean(last 5 obs) — the model itself calling a regime change
- **C accel** = day-over-day delta — the front signature

Panel: `causal-forecast.csv` × archive winners; ~2,000 rows / 45 cities / 79–83 days per lead; all
deltas °C-equivalent (°F ÷1.8) so cities pool. Same rails as PERSISTENCE-BLEND (paired, city- and
day-clustered CIs, 60/40 chronological OOS, exact-winner truth for error fitting).

## Diagnostic (run FIRST — is there a directional error to correct?)

**A (observed swings): no stable signature.** Slope of signed error on A: −0.10 / −0.06 / −0.01 across
leads 0/1/2 — inconsistent, CIs crossing zero at leads 1–2. NWP handles observed fronts fine; the "big
observed swing" cluster carries no correctable bias. **C (day-over-day): nothing** (−0.04, CIs straddle 0).

**B (the model's own calls): a real, consistent signature.** Slope of error on B, city-clustered CI:

| lead | slope | 95% CI |
|---|---|---|
| 0 | **+0.154** | [+0.090, +0.217] |
| 1 | **+0.114** | [+0.050, +0.178] |
| 2 | **+0.095** | [+0.042, +0.149] |

Same sign, all CIs exclude zero, monotone in lead. Reading: when the model predicts a big departure from
the recent 5-day mean, it **overshoots the call** — it should shade back toward the recent mean
(under-regression). Relative to the panel baseline the overshoot at |B| ≥ 2 °C is ≈ ±0.6 °C, and it is
**strongest on cold-front calls** (B ≤ −2: error −0.8 to −1.0 °C at every lead).

## Correctors — none convert (OOS, paired, on the documented metric)

- **Raw fitted correctors (linear + per-side threshold constants on |cond| ≥ 1.5/2.5):** every variant
  DAMAGED test hit rate (up to −4.5pp, city-CIs excluding zero). Root cause isolated before believing it:
  the fits absorbed a global α ≈ −0.44 °C intercept that is a truth-convention artifact (winner-band
  expected actual v+0.5 vs the model's bucket-targeting calibration — WO-L3-b's obs-truth residual mean
  ≈ 0 stands), so they shifted up to half of ALL predictions, not just swing days.
- **Centered slope-only correctors (the decontaminated pure-swing test, μ′ = μ − β·(B − B̄)):** across all
  9 (conditioner × lead) cells, **not one improves hit rate with a CI excluding zero**; lead-0 A/B actively
  hurt (−1.9pp [−3.6, −0.2]; −3.2pp day-CI [−6.5, −0.2]); everything else is flat (the lone +0.87pp at
  lead-1 B has CI [−0.9, +2.7] — with 27 test reads at 95%, exactly the expected noise). ΔMAE after
  decontamination: every CI straddles zero.

**Why the real signature can't convert:** β ≈ 0.10–0.15 means a typical big swing (|B| = 2 °C) warrants a
0.2–0.3 °C shade — far below the 1° bucket width. It flips pick-roundings near boundaries in both
directions and nets zero-to-negative. This is precisely the sub-bucket structure WO-L3-b's 0.6% R²
ceiling said could exist without being harvestable.

## Verdict

**KILL.** No swing-conditional correction — observed-swing, predicted-swing, or day-over-day; linear or
thresholded clusters; any lead — improves documented accuracy out-of-sample, and several variants damage
it. The **7th rejected point-skill lever** (after regression-MOS, recency reweighting, residual-structure,
regime-conditional weighting, model-trim, persistence-blend).

**Carry-forward (the one non-null finding):** the under-regression of the model's own big departures
(B-slope +0.10..+0.15, cold-side dominant) is the first *consistent* residual structure found in seven
levers. It is unharvestable at 1° buckets, but if the system ever scores on a continuous metric (MAE/CRPS
products, the /data analytics) a mild shrinkage of μ toward the recent 5-day mean on big-departure days
(≈ 12% of the departure) is a real sub-bucket refinement — file under analytics, not trading.

## Reproduce

```bash
python scripts/research/swing-bias.py            # diagnostic + raw correctors; writes out/swing-bias.json
python scripts/research/swing-bias.py --selftest
```
Centered-corrector read: the driver in this doc's commit (`git log -1 --format=%H -- SWING-BIAS.md`).
Artifacts: `scripts/research/out/swing-bias.json`.
