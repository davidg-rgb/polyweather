# BUY-TABLE — per-city "$10 on our predicted high, bought cheap, held to close"

> **↳ CORRECTION 2026-07-19 — the °F 2-degree-band parse fix (PERSISTENCE-BLEND.md rails).** The research
> parser matched only the LOW edge of °F band labels ("86-87°F"), so °F predictions landing on the band's
> upper degree were mapped to the WRONG bucket. Regenerated record (same flags, fixed parser):
> **82 bets / 37 days / 36 cities, sweet-spot 48h, pooled +2.4% / +$20, day-CI [−52.3%, +60.5%]** — the ~27
> recovered °F picks drift the point estimate just positive, and the verdict is UNCHANGED: an underpowered
> wash, no lead's day-clustered lower bound anywhere near zero, signal #12 stays dead. The committed asset
> + /paper-trade + the tests carry the corrected record; the 2026-07-09 numbers below are the pre-fix
> record, kept for the audit trail.

> **Verdict (2026-07-09): KILL / no demonstrable edge — at both cost bases.** Staking $10 on our predicted
> daily-high bucket, entered ONLY while still cheap (ask ≤ 15¢), held to resolution:
>
> - **Canonical calibrated book + taker fee (the record of record, §Addendum below):** the fillable population
>   nearly VANISHES — 55 bets @ the 12h sweet-spot (the sub-9¢ longshots that drove the mid-based loss were never
>   fillable at $10; the calibrated cheap zone carries $4–$24 of walked depth). What survives is an **underpowered
>   wash leaning negative**: −9.2% ROI / −$51, day-CI [−62.9%, +56.8%]; every well-populated lead negative; no
>   day-clustered lower bound anywhere near 0. The 6h row (+141%) is a 3-bet fluke, CI [−100%, +624%].
> - **Legacy mid+1¢ scoring (the original headline, kept below as the fantasy-population record):** −28.2% ROI /
>   −$977 over 347 bets / 46 weather-days / 43 cities, day-CI [−57.7%, +4.3%].
>
> This is **signal #12 (opening-convergence), re-confirmed** with the cheap-entry filter added: the filter buys
> the predicted bucket only while it is still a **not-yet-converged longshot**, and the market prices our bucket
> ≤15¢ **exactly when it is unlikely to win**. **Nothing here reopens the trading rail.** The `/paper-trade` page
> renders the calibrated record (plus the LIVE forward ledger, which keeps accruing).

- **Engines:** `scripts/research/city-accuracy.ts --emit-forecast` (the causal blend μ) → `scripts/research/city-buy-table.py`
  (adds the ≤15¢ cheap gate + per-city aggregation to the MARKET-PNL scoring). Sibling of `pnl-backtest.py`.
- **Committed asset:** `packages/core/src/sim/city-buy-table-results.ts` (typed, frozen record; the page renders it
  server-side — no DB round trip). Artifact: `scripts/research/out/city-buy-table.json`.

## The question & method

*If we bet $10/day on our predicted bucket in every city, but only when it's cheap and at the best time, held to
close — net profit or loss, per city?* This is the operator's `/paper-trade` replacement. Honesty rails (identical
to MARKET-PNL, `references/traps.md`):

- **Forecast** = the CAUSAL walk-forward blend μ, bias corrected on **prior data only** (no hindsight/look-ahead).
- **Bucket match** by parsing temperature from the label (bucket_idx is raw gamma order — trap #7).
- **Price** = archive mid; **buy at the executable ask** = mid + 1¢ spread, floored at 3¢ (can't fill $10 on a
  sub-floor longshot). The archive is a mid, not the depth-walked ask — so the real number is only worse.
- **Cheap gate:** enter only when the executable ask ≤ **15¢**.
- **Sweet-spot lead:** the entry lead (hours before close) maximizing the **day-clustered lower bound** (shrinkage,
  not the point estimate) — the honest "least likely to be luck" pick. It resolves to **24h**.
- **Cluster** on the independent unit (city × weather-day) for the pooled CI.

## Results (lead-1 causal, 43 cities, 2026-05-14→06-30, 46 weather-days)

**The "peak time for ROI confidence" axis — ROI by entry lead (the sweet-spot the operator asked for):**

| Entry lead | bets | win% | avg ask | ROI | net | day-clustered CI |
|---|---|---|---|---|---|---|
| 48h before | 298 | 5.7% | 6.7¢ | −27.6% | −$824 | [−60.8%, +10.5%] |
| **24h (sweet-spot)** | 347 | 6.3% | 6.2¢ | **−28.2%** | **−$977** | **[−57.7%, +4.3%]** |
| 12h | 721 | 2.4% | 4.5¢ | −68.9% | −$4,970 | [−84.5%, −50.2%] |
| 6h | 1,114 | 0.2% | 3.1¢ | −98.1% | −$10,923 | [−100.0%, −94.9%] |

The tell is the direction: ROI is **negative at every lead, and gets *worse* the closer to close you buy**. A genuine
forecast edge would do the opposite — strengthen near resolution, where our forecast is sharpest. That it collapses
instead is the efficiency signature: near close the eventual winner has already converged **above 15¢**, so the cheap
filter keeps only near-certain losers (0.2% win at 6h). The sweet-spot is the *least bad* lead, not a positive one.

**Per-city:** 16 of 43 cities show a net-positive point estimate — pure small-sample longshot noise, not an edge
(Jeddah went 2-for-2 → +1209% ROI; most "winners" are one lucky ~6¢ ticket paying ~15×). No city clears a
clustered bar. High-*accuracy* cities (Madrid, Munich) are 0-for-6 and 0-for-15 here: the market prices their
predictability into the price, so our accuracy buys nothing when we can only enter cheap.

**Why "win 6.3% vs ~6% breakeven" still nets −28.2%:** the breakeven comparison only holds bet-by-bet if ask and
win-probability were independent — they are not (that correlation IS the efficiency finding). The few winners
were disproportionately the *higher-priced* entries (smaller payout multiples), while the cheapest tickets lost
almost surely — so the stake-weighted P&L lands far below what the pooled win-rate-vs-average-ask comparison
suggests.

## Addendum (2026-07-09, same day) — re-scored on the canonical calibrated book: the population, not the edge, was the story

The original scoring above used a flat mid+1¢ ask floored at 3¢. The project's canonical cost model
(`CALIBRATED_BOOK` in `core/sim/history-replay-ingest.ts`, fit from real `opening_captures` books; new zero-drift
Python mirror `scripts/research/cost_model.py`) prices the cheap zone honestly: **askOver ~1.8–4pp and only
$4–$24 of walked depth below mid ~0.12**. Re-scored with it (+ the explicit taker fee, `fees.ts` convention —
the flat +1¢ was a *total-friction* proxy; the calibrated askOver is spread only):

| Entry lead | bets | win% | avg all-in ask | ROI | net | day-clustered CI |
|---|---|---|---|---|---|---|
| 48h | 70 | 11.4% | 13.5¢ | −11.8% | −$83 | [−66.5%, +46.5%] |
| 24h | 65 | 12.3% | 13.5¢ | −11.8% | −$77 | [−66.6%, +45.7%] |
| **12h (sweet-spot)** | 55 | 12.7% | 13.5¢ | **−9.2%** | **−$51** | **[−62.9%, +56.8%]** |
| 6h | 3 | 33.3% | 13.9¢ | +141.3% | +$42 | [−100.0%, +623.9%] |

Three honest readings, in order of importance:

1. **The strategy barely exists at executable depth.** 347 mid-fantasy bets collapse to 55–78 fillable ones:
   a $10 order cannot fill below mid ~0.085, which excludes exactly the deep longshots that produced the −28%.
   The efficiency signature restates as a **population collapse near close** (78 → 3 bets from 48h to 6h) — by
   resolution the winner has converged above the gate and the rest is depth-starved.
2. **What survives is an UNDERPOWERED WASH, not a discovered edge and not a proven deep loss.** Every populated
   lead is negative (−9 to −12%) but the day-clustered CIs span ±50pp — this panel can neither demonstrate nor
   exclude a modest edge (n is just too small once you only count real bets). The KILL stands on the falsified
   signal #12 family, the negative point estimates, and the absence of any lower bound near 0.
3. **The two scorings agree on the verdict and differ on the mechanism** — the mid+1¢ read said "you lose big
   buying cheap longshots"; the calibrated read says "you mostly *can't* buy them, and the buyable remnant shows
   nothing." Both close the strategy.

Regenerated artifacts: `city-buy-table-results.ts` (the page's committed record, now `book: 'calibrated'`),
`out/city-buy-table.json`. The legacy numbers reproduce with `--book flat`.

## Traps ruled out

Executable ask (mid + 1¢, floored) ✔ · cheap gate ✔ · day + city clustering ✔ · lead/sweet-spot robustness (all
four leads shown) ✔ · look-ahead removed (causal forecast) ✔ · gamma-order bucket match by label ✔. The one thing
this cannot remove is that the archive price is a **mid, not the depth-walked executable ask** — which only makes
the real number worse (the convergence-tuning KILL used the real bid/ask book and died at the spread).

## What shipped

- `/paper-trade` **replaced**: was the multi-city Singapore/Karachi arms-race; is now the per-city buy table
  (hero verdict + summary strip + the lead-curve "peak time" chart + the 43-city table with a per-city net-by-lead
  sparkline + the pre-registered 45-City Scan companion section). Pure static-asset render, no DB round trip.
- `packages/core/src/sim/city-buy-table-results.ts` (committed record) + export; `packages/core/test/city-buy-table-results.test.ts`
  (18 invariant/golden tests); `apps/web/test/paper-trade-page.render.test.ts` rewritten. Suite 3097 green, typecheck clean.

## Reproduce

```bash
pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
python scripts/research/city-buy-table.py --stake 10 --cheap-max 0.15 --asof 2026-07-09 \
  --emit scripts/research/out/city-buy-table.json --emit-ts packages/core/src/sim/city-buy-table-results.ts
# legacy flat-book comparison (the original -28.2% headline):
python scripts/research/city-buy-table.py --book flat --stake 10 --cheap-max 0.15
```

Read-only: reads the local parquet archive + the causal-forecast CSV; writes only `out/` + the committed asset;
places no trade. Re-confirms MARKET-PNL on the cheap-entry subset. Signal #12 stays dead; the rail stays DORMANT.
