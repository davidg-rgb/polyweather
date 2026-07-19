# BREAKEVEN-SKILL — the skill target trading would require, vs the skill we have

> **↳ CORRECTION 2026-07-19 — the °F 2-degree-band parse fix (PERSISTENCE-BLEND.md rails).** Re-run with
> the fixed parser (°F band labels previously matched only at their LOW edge): buying OUR bucket at all-in
> cost nets **−1.9% per $1, day-clustered CI [−3.8, +0.1]** (n=10,834 zone rows / 1,899 ours / 45 cities /
> 81 days). The interval's upper edge now GRAZES zero instead of excluding it — the honest reading weakens
> from "entirely negative" to "negative-to-zero"; the verdict is UNCHANGED (no positive EV demonstrated,
> the required-lift arithmetic stands, the route stays closed). Numbers below are the pre-fix record.

> **Verdict (2026-07-09): the forecast-for-trading route is CLOSED by arithmetic.** To break even as a
> taker in the buyable zone (mid 5–40¢), a signal must add **+3.7 to +5.1pp of win-probability beyond
> price** (the longshot tax + calibrated spread + taker fee, band-dependent). Our causal forecast DOES
> carry real within-band residual information (+2.7 to +6.7pp in several bands; two bands' CIs exclude 0 —
> the C22 `house_gap` finding, reproduced) — **but it is not monetizable**: buying OUR bucket at its own
> all-in executable cost at the deployable 24h entry nets **−2.2% per $1, day-clustered CI [−4.3, −0.2]
> — entirely negative, well-powered** (n=10,834 zone rows / 1,730 ours / 45 cities / 49 days). The
> market's price already contains our forecast where it matters. To flip the sign, our conditional win
> rate where the market disagrees with us must rise ~**2.2pp pooled (~+8–9% relative) at unchanged
> prices** — an order of magnitude beyond what any tested forecast lever has produced (5 point-skill
> levers + 3 post-processing KILLs, each ≤~0.05 °C MAE ≈ ≲1pp bucket equivalent, mostly ≤0), against a
> market that is currently the *sharper* forecaster on the same public NWP inputs.
>
> **Consequence — the backfill adjudication:** the ≥12-month Open-Meteo historical-forecast backfill
> (MODEL-TRIM §8 #1) is **NOT justified as a trading investment** — its plausible yield (sharper
> calibration windows on data the market also sees) is a fraction of the ours-to-market gap and cannot
> manufacture a +2–3pp edge OVER the market. It remains a legitimate **analytics-product** investment
> (seasonal calibration coverage; unblocks the "at this n" forecast-R&D verdicts) if the operator values
> the forecast product per se. The trading goal's only live paths remain the forward efficiency monitor
> and genuinely out-of-market information.

- **Engine:** `scripts/research/breakeven-skill.py` (selftested; uses `cost_model.py` = the canonical
  calibrated book + taker fee, and the CAUSAL forecast from `city-accuracy.ts --emit-forecast`).
- **Artifacts:** `out/breakeven-skill.json` (24h), `out/breakeven-skill-48h-lead2.json` (honest 48h).

## The question

Every prior study asked "does strategy X profit?" This one asks the prior question that adjudicates
*whole investment directions*: **how good would the forecast have to be** for taker-buying to be +EV at
executable cost — and how far short is the forecast we have? It prices the "spend months improving the
forecast to trade it" route *before* the spend.

## Method

Per (event, bucket) at a fixed entry (24h before close; 48h robustness), on the 238M-row mid archive:
mid → all-in cost via the canonical calibrated book (exec ask + 5% taker fee), `won` from the resolved
winner (bucket matched by label — trap #7), `ours` = the bucket picked by the CAUSAL walk-forward blend
(no hindsight; at 48h the **lead-2** forecast, because lead-1 does not exist yet at that entry — using
lead-1 there, as a naive read would, inflates EV by ~1.5pp).

- **Required lift** per mid band: `mean(all-in cost) − P(won | band)`.
- **Achieved lift**: `P(won | ours, band) − P(won | band)` — C22's sufficient-statistic test with our
  own forecast as the feature.
- **The verdict number** (composition-free): `EV = P(won | ours) − mean(cost | ours)` — because the
  naive lift-vs-required comparison is **inflated by within-band composition** (our bucket clusters at
  each band's expensive end — mid|ours 26.2¢ vs 20.5¢ zone-wide — and price carries win-prob even inside
  a 10¢ band). Day-clustered bootstrap CIs throughout (seeded).

## Results (24h entry, lead-1 causal, 45 cities, 2026-05-13 → 06-30)

| band | n | n_ours | win% | all-in cost% | REQUIRED Δ | OURS Δ [95% CI] | EV(buy ours) [95% CI] |
|---|---|---|---|---|---|---|---|
| 3–5¢ | 1,879 | 64 | 3.5 | 8.3 | +4.8pp | +2.8 [−2.2, +9.1] | −2.0% [−6.9, +4.5] |
| 5–10¢ | 2,366 | 138 | 6.7 | 11.4 | +4.7pp | +2.7 [−1.8, +7.6] | −2.2% [−6.9, +2.9] |
| 10–15¢ | 1,556 | 130 | 12.1 | 14.9 | +2.7pp | +4.0 [−2.0, +10.2] | +1.1% [−4.8, +7.7] |
| 15–20¢ | 1,404 | 150 | 14.5 | 19.5 | +5.1pp | +0.2 [−5.0, +5.9] | −5.1% [−10.5, +1.0] |
| 20–30¢ | 2,964 | 579 | 22.3 | 27.0 | +4.6pp | **+6.2 [+2.7, +9.6]** | +1.3% [−2.4, +5.0] |
| 30–40¢ | 2,544 | 733 | 33.1 | 36.7 | +3.6pp | −1.3 [−4.4, +1.8] | **−5.1% [−8.4, −1.7]** |
| 40–55¢ | 1,728 | 578 | 43.8 | 47.5 | +3.7pp | **+6.7 [+3.1, +10.2]** | +3.1% [−1.1, +7.0] |

**Pooled cheap zone (5–40¢): EV of buying our bucket at all-in cost = −2.2% per $1 [−4.3, −0.2].**
The CI excludes zero on the negative side — a *well-powered negative*, the cleanest single statement in
the record that the market already prices our forecast at the point of execution.

Three readings:

1. **The information is real; the money is not.** Within-band, our pick wins more than the band average
   in most bands (two significantly). But the market concedes that lift only at prices that fully charge
   for it — the moment you pay OUR bucket's own ask + fee, the edge is gone and then some. This is
   C20's realizability collapse and C22's sufficient-statistic result, unified with the cost model.
2. **48h looks better and is not real.** Naive 48h (lead-1 pick): +2.8% [+0.9, +4.6] — but lead-1 does
   not exist at a 48h entry (look-ahead worth ~1.5pp), and the honest lead-2 read is **+1.3% [−0.5,
   +3.2]** — a wash, sitting squarely in the falsified signal-#12 convergence-carry family, on a
   MID-BASIS panel (synthetic book on archive mids). The real-tick-book replays of exactly this
   buy-early-hold family (C5–C10, both units) were all negative. Under the project's new gate law a
   mid-basis positive caps at PASS_PENDING_REAL_BOOK — and this one isn't even a PASS.
3. **The skill target is quantified and out of reach by increments.** Breaking even needs our
   conditional win rate (where the market disagrees) up ~2.2pp at unchanged prices — ~+8–9% relative.
   The entire tested forecast-R&D program (slope-MOS, regime weighting, recency, per-city trim,
   boosted-stumps, per-city sources) moved point skill by ≤~0.05 °C, i.e. ≲1pp bucket-equivalent, and
   mostly the wrong way. Nothing incremental crosses a 2–3pp-over-the-market bar on public inputs.

## Traps ruled out

Causal forecast (no archive `pred_c_l1` hindsight) ✔ · forecast-availability alignment (lead-2 at 48h —
the naive lead-1 read is reported *as* the trap) ✔ · canonical calibrated cost + taker fee ✔ ·
within-band composition exposed (mid|ours vs mid|all reported; EV is the verdict stat) ✔ ·
day-clustered CIs, seeded ✔ · label-parsed buckets (trap #7) ✔ · mid-basis limitation stated (and it
biases the verdict *for* the strategy — the real book is worse; the negative stands a fortiori) ✔.

## Reproduce

```bash
pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
python scripts/research/breakeven-skill.py --entry-lead-h 24                    # the verdict
python scripts/research/breakeven-skill.py --entry-lead-h 48 --lead 2           # honest 48h robustness
python scripts/research/breakeven-skill.py --selftest
```

Read-only: local parquet archive + causal CSV in; `out/` artifacts out; no DB, no trade, no credentials.

_Analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
