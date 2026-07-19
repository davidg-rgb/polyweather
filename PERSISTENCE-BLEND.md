# PERSISTENCE-BLEND — rolling-average Tmax blended into the causal forecast. VERDICT: KILL. 2026-07-19.

> **The question (operator):** does extrapolating our model's guess with a rolling average of the previous
> days' max temperatures (3/5/7-day windows) increase or decrease our documented accuracy?
>
> **The answer: it decreases it — at every real weight, every window, every lead.** The pure model is the
> optimum. The 6th rejected point-skill lever (`FORECASTING-RD.md`).

## Hypothesis (framed as a testable claim)

For target date D at lead L, replace the documented prediction μ (the walk-forward causal blend emit,
`causal-forecast.csv`) with `pred'(w,K) = round((1−w)·μ + w·rollK)`, where rollK = the mean observed daily
max over the K previous *knowable* days. Score exactly like the documented accuracy: pick the bucket whose
native-degree range contains pred'; hit = that bucket resolves as the market winner. If some w > 0 beats
w = 0, persistence adds skill.

## Data (all local)

- **Forecast:** `scripts/research/out/causal-forecast.csv` — 11,712 rows, 45 cities, leads 0/1/2,
  2026-04-09 → 2026-07-09. Walk-forward, bias-corrected on prior data only (no hindsight).
- **Truth + ladders:** `market-history-flat-enriched.parquet` — 6,270 resolved events, 45 cities,
  2025-01-23 → 2026-07-02. Winner = the market's resolved bucket (the same source the documented /data +
  /cities accuracy is scored against). Deep pre-panel history feeds the rolling windows.
- **Panel per (K, lead):** every (city, date) with a causal μ, a scorable ladder, and a COMPLETE K-day
  truth window — ~2,000–2,700 rows, 45 cities, 79–83 days each.

## Honesty rails (traps ruled out)

- **No look-ahead in the window:** the forecast at lead L is made on day D−L; the last complete observed
  day is D−L−1. The window is [D−L−K .. D−L−1] — *shifted by lead* (using D−1 inside a lead-1 forecast
  would be leakage).
- **Baseline == documented:** the blend anchors on the emitted integer `mu_native`, so w=0 reproduces the
  documented pick by construction. Panel base hit 36.1/32.5/31.2% (K=3, leads 0/1/2) reconciles with the
  documented 39.4/31.8/29.2% (`city-accuracy-22Z.csv`) on the complete-window subset.
- **°F band scoring fixed before believing anything:** °F labels are 2-degree bands ("10-11°F"); the
  first-integer parse (inherited from pnl-backtest.py) matched only the low edge — a pred of 11 missed the
  10-11 bucket. Range-aware containment matching restored °F base hit to the documented level (19.7% →
  ~22%). Same fix debiased the rolling input: winner semantics are floor(actual), so the roll uses the
  expected actual (°C exact → v+0.5, °F band → lo+1), not the label's low edge (~0.5° systematic cold bias).
- **Paired on identical rows; clustered on the independent unit:** every (w,K,L) vs its w=0 baseline on
  the same rows; city-clustered AND day-clustered 95% t-CIs on the paired Δ.
- **OOS:** dates split 60/40 chronologically; w* selected on train, reported on test. In-sample curves
  shown only as the winner's-curse upper bound.
- **Tail stress:** windows containing a tail winner ("7°C or below" bounds, not measures, the actual) are
  flagged; the exact-only subset reproduces every delta.

## Results

**OOS: in all 9 (K, lead) cells the train data selects w\* = 0 — it never supports moving off the pure
model.** There is no out-of-sample gain to report because no weight ever survives training.

In-sample (the winner's-curse *upper bound*): best weight is 0 in 7 of 9 cells; the two exceptions
(lead 1, K=3/K=5) peak at w=0.1 with +0.11pp / +0.48pp — and both CIs straddle zero
(K=5 L=1 w=0.1: city-CI [−0.22pp, +1.55pp], day-CI [−0.77pp, +1.27pp]). Noise.

Any real weight actively damages accuracy, with CIs excluding zero (K=3, lead 1; K=5 similar):

| w | Δ hit (pp) | city-CI | day-CI |
|---|---|---|---|
| 0.1 | +0.11 | [−0.85, +1.02] | [−1.01, +0.93] |
| 0.2 | **−2.39** | [−4.08, −0.48] | [−3.88, −0.83] |
| 0.3 | **−3.53** | [−5.39, −1.18] | [−5.20, −0.98] |
| 0.5 | **−6.68** | [−9.10, −3.93] | [−8.74, −4.02] |
| 1.0 (pure persistence) | **−15.5** | [−19.0, −12.8] | [−17.5, −11.8] |

Pure persistence hits 16–21% vs the model's 30–36% — the calibrated blend beats a 3–7-day rolling average
by roughly **2×** at every lead.

## Mechanism (why this was never going to work)

The calibrated blend already *contains* what persistence knows: its bias correction is learned from recent
residuals (`model_stats`), i.e., recent observed-vs-predicted temperature is already assimilated, city by
city. WO-L3-b (`FORECASTING-RD.md`) independently proved the blend's residuals carry **no exploitable
structure** — a rolling average of past maxes is exactly a crude residual-autocorrelation play on
information the blend has already priced in. Diluting a sharp estimate with a blunt one can only lose;
the only regime where persistence could win (NWP-blind, high-autocorrelation stagnant weather) is one the
NWP models resolve fine.

## Verdict

**KILL.** Do not blend rolling-average persistence into the forecast at any window or weight. The
documented accuracy is the ceiling of this family; w=0 is optimal. This is the **6th rejected point-skill
lever** (after regression-MOS, recency reweighting, residual-structure, regime-conditional weighting, and
per-city model trim) — all six say the same thing: the blend is at its data-limited skill ceiling, and the
real lever remains **more/longer history + better inputs**, not post-processing.

## Reproduce

```bash
python scripts/research/persistence-blend.py            # full sweep; writes out/persistence-blend.json
python scripts/research/persistence-blend.py --selftest
```

Artifacts: `scripts/research/out/persistence-blend.json` (full w-grid curves per K×lead).
