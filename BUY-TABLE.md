# BUY-TABLE — per-city "$10 on our predicted high, bought cheap, held to close"

> **Verdict (2026-07-09): KILL — a net loss at every entry lead.** Staking $10 on our predicted daily-high bucket
> across all cities, entered ONLY while the bucket is still cheap (executable ask ≤ 15¢ = "high return potential"),
> at the confidence sweet-spot (24h before close), held to resolution, nets **−28.2% ROI / −$977** over 347 bets on
> 46 weather-days / 43 cities; the day-clustered 95% CI **[−57.7%, +4.3%]** leans hard negative (positive only via a
> fat longshot right-tail). This is **signal #12 (opening-convergence), re-confirmed** with the cheap-entry filter
> added: the filter buys the predicted bucket only while it is still a **not-yet-converged longshot**, and the market
> prices our bucket ≤15¢ **exactly when it is unlikely to win** (pooled win rate 6.3% vs the ~6% you need just to
> break even). **Nothing here reopens the trading rail.** The `/paper-trade` page now renders this table.

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
```

Read-only: reads the local parquet archive + the causal-forecast CSV; writes only `out/` + the committed asset;
places no trade. Re-confirms MARKET-PNL on the cheap-entry subset. Signal #12 stays dead; the rail stays DORMANT.
