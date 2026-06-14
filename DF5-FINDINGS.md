# DF-5 Findings — Why house_gaussian loses to market_consensus (and why no quick fix closes it)

> Diagnostic run 2026-06-14 (iter-42) on the live DF-5 backtest
> (`calibration_scores window_tag='backtest'`, 959 matched event-leads, 25 cities,
> 30-day window 2026-05-13→2026-06-12). This is the answer to the project's core
> thesis question: **can our model beat the market?** Short answer today: **no, and
> not for a reason a quick patch fixes.**

## Headline

- **house Brier 0.6494 vs market_consensus 0.6074** (n-weighted) — house ~7% worse;
  house beats market in only **4 of 50** city-lead cells.
- The gap is a **forecasting-aim deficit, not a calibration-width deficit.** House puts
  **0.344** probability on the bucket that actually wins vs the market's **0.373** — it
  aims at the wrong bucket more often. Width/sharpness are fine (Σq² house 0.337 vs
  market 0.352 — house is even slightly sharper, so it is NOT over-diffuse).

## Error decomposition (full 959-pair run)

| Component | Finding |
|---|---|
| **σ source** | 76.2% fitted (n≥sigmaMinN=8), 23.8% prior-σ ladder fallback. Prior-σ cells Brier 0.789 vs fitted 0.640 — worse, but a shrinking minority. |
| **Blend weights** | 76.2% real inverse-MSE local weights, 23.8% equal 1/n fallback. Equal-weight cells = the thin cold-start cities (seoul, milan, paris, ankara, mexico-city, panama-city, 4–6 foldable days each) — exactly the cells that also use prior-σ. |
| **Bias** | Mean \|applied bias\| 0.50°C (correctPoint active). Residual systematic bias of house μ vs truth: **−0.030°C ≈ zero**. Nothing to harvest. |
| **Aim (smoking gun)** | p(realized winner) house **0.344** vs market **0.373** — μ lands in the wrong bucket more often. This is the gap. |

**Model-quality spread is real** (backfill, leadCol=2): `icon_seamless` RMSE 2.11 /
74% within 2°C … `cma_grapes_global` RMSE **7.15** (fat tail) … `jma` 51.9% within
2°C, **−1.65°C cold bias**. Equal-weighting cma/jma at 1/8 in the cold-start cells is
genuinely destructive — but it is confined to the ~24% cold-start minority.

## The "thick-cell" control — why P4 will NOT rescue this

On the **898 fully-calibrated pairs** (fitted σ AND real inverse-MSE weights — i.e. P4
already effectively done for those cells): **house 0.6399 vs market 0.6020 — still
loses by 6.3%.** P4 finishing pulls the 61 thin cells (house 0.789 vs market 0.687) up
to thick-cell quality, shaving the *aggregate* gap modestly, but it cannot make house
win because **house already loses where it is fully calibrated.** Calibration is not
the lever.

## Now-buildable fixes — all measured, all marginal, none close the gap

| Fix | Result | Verdict |
|---|---|---|
| Informed cold-start weights (RMSE-derived prior, down-weight cma/jma, up-weight icon/ecmwf) | 0.6494 → **0.6492** | Negligible; only the ~5 thinnest cells move. Changes documented cold-start behavior (ARCH §6.16) for ~0.03% — **not worth it**. |
| Prior-σ shrink (×0.7) | 0.6494 → **0.6461** (~0.5%, wins 4→6/50) | The prior σ *is* slightly too wide, but tuning it to THIS 30-day window is **overfitting** — methodologically unsound to ship from a small OOS sample. |
| Combined | 0.6494 → **0.6468** | Still ratio 1.065 — does not cross 1.0. Levers do not stack into a win. |
| Bias prior | — | No signal (residual bias already ≈0). Not built. |

**Decision: ship NO model change.** Every lever is either cosmetic, overfit, or
thesis-defeating. Shipping one would be a workaround standing in for the real fix.

## Caveat on the benchmark

`market_consensus` here is the **backfilled/synthesized consensus-mid** (DF-5 C2), and
`simulate-historical-edge`'s own HONEST-FIDELITY NOTE flags the consensus-mid proxy as
**gating-direction-only** (no depth/spread/volume veto). So "market" is likely an
*optimistic* benchmark — the executable ask (what we'd actually trade against) is worse
than the mid by the spread+fee. Beating the mid on Brier is necessary for F-019
promotion but is a harder bar than beating the executable price for a *trade*. This does
not change the verdict (we lose to the mid), but it means the trade-level edge picture
is a separate question from the calibration-gate picture.

## What would actually move the needle (real R&D, not a patch session)

The deficit is point-forecast **skill** (getting μ into the right bucket). Candidate
directions, all larger architectural efforts, none P4-blocked:

1. **Regime-/recency-aware model weighting** — weight models by *recent local* skill
   under the current synoptic regime, not a flat inverse-MSE window. (Plain inverse-MSE
   local weighting is already in place and still loses, so this means conditioning on
   regime, not just shortening the window.)
2. **Better post-processing of the ensemble mean** — MOS / quantile-mapping per
   station, diurnal/seasonal terms — to fix aim, not width.
3. **Add genuinely better inputs** — a stronger deterministic source, or station-level
   features the NWP grid misses (urban heat island, microclimate).

Explicitly rejected: **blending the market price into the house prior** — it would
improve Brier-vs-market by construction but defeats the entire thesis (you cannot beat
a market you are copying). The house must stand on independent skill.

## Bottom line

House is not market-beating on the only honest evidence we have, and the reason is
forecasting skill, not calibration. Do **not** promote (F-019). Do **not** burn cycles
on calibration tuning or cosmetic weight fixes expecting it to flip. The re-run-after-P4
plan is still worth doing (it will tighten the thin cells and give a cleaner read), but
set the expectation correctly: it will narrow the gap, not close it. Closing it is a
forecasting-model R&D problem.
