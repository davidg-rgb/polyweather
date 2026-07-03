# Fluctuation-Taker — intraday path-signal taker trading of the key buckets

> **VERDICT 2026-07-03: KILL — decisively, not marginally.** Across a 384-cell sweep of price-path taker
> strategies on the corrected 827-event / 45-city / 20-day archive panel, **not one cell passes the frozen
> §9R-E gate even IN-SAMPLE on TRAIN**. The best cell of 384 (selected by max ciLow, the conservative bound)
> loses **−14.3% on TRAIN, −17.6% on out-of-sample TEST, −15.8% / −$2,002 on the FULL panel** at a 23% win
> rate, and the entire top-10 has **ciHigh below zero** — the loss is statistically unambiguous in BOTH
> directions of the path signal, at every window, under every exit family. No survivors → per the run plan,
> **no finer (per-minute) cache rebuild**. The 12th signal's sole surviving form remains the maker-exit
> variant (`MAKER-EXIT-SIM.md`); this variant joins the falsified list.

## The question (operator-requested, BUILD-STATE 2026-07-03 morning queue #3)

The corrected archive moved the plain taker bracket's breakeven from ×0.70 to ×1.14 of the calibrated spread
(`CONVERGENCE-TUNING.md` banner) — mean-positive at the real spread, CI-blocked — so PRICE-PATH taker variants
were no longer pre-doomed by the round-trip cost alone. The specific question: do intraday FLUCTUATIONS of the
key buckets (the forecast-center ±1 set, re-centered per lead as the house forecast refreshes at leads 2/1/0)
carry a harvestable taker edge — buy a dip (or ride momentum), sell into the bounce — where flat-open and
first-tick entries could not?

## Method

- **Panel**: the maker-exit cache (827 resolved events / 45 cities / 20 days, 2026-06-13→07-01, 20-min
  cadence, calibrated synthetic book ×1) ⋈ each event's production `house_gaussian` dist stream at leads
  0–2 (4,192 dists, 6h-thinned, **made_at-anchored — a fresher forecast is never visible before it existed**).
- **Engine**: `core/sim/opening-fluctuation-replay.ts` (pure + total, no-look-ahead pinned by 21 tests).
  Key set at tick t = argmax bucket of the latest dist with made_at ≤ t, ± centerHalfWidth (1 ≈ ±1°C).
  Entry: taker at execAsk + 1¢ slippage when the bucket's mid moves ≥ dipDepth within the trailing window
  ('dip' = below the rolling max, 'momentum' = above the rolling min); gates: ask ≤ 0.30, depth ≥ $100.
  Exits (all taker, real fee curve rate·p·(1−p) both legs): fixed-TP bracket OR trailing peak-bid drawdown,
  both with the ternary SL, the hard resolvesAt−18h time-stop, and an optional recenter flatten.
- **Gate discipline**: frozen §9R-E floors (≥40 realized / ≥6 cities / ≥7 days, winFrac ≥ 0.5, city-clustered
  ciLow > 0, sign-flip MC < 5%) **plus the day-block tightening (always ON)**; 60/40 date split — cells
  selected on TRAIN only, the one selected cell quoted on TEST + FULL.
- **Grid (384 cells)**: entryMode {dip, momentum} × dipDepth {3,5,8,12pp} × window {60,120,240,480m} ×
  exit {bracket TP 6/10/15pp, trail 5/8/12pp} × recenter {off,on}.

## Result

| scope | n realized | winFrac | mean net | total $ | 95% CI (city) | day CI | §9R-E+day |
|---|---|---|---|---|---|---|---|
| TRAIN (selected cell) | 351 | 22.8% | **−14.3%** | −$1,006 | [−19.4%, −9.9%] | [−18.6%, −6.7%] | KILL |
| TEST (out-of-sample) | 283 | 23.0% | **−17.6%** | −$996 | [−22.2%, −12.8%] | [−24.7%, −8.6%] | KILL |
| FULL | 634 | 22.9% | **−15.8%** | −$2,002 | [−19.4%, −13.3%] | [−18.7%, −9.9%] | KILL |

Selected cell (the least bad of 384): momentum 3pp / 60m window / trail −5pp / recenter ON / chw 1.
Selection basis was "closest-to-passing" — **tier 1 (PASS on TRAIN) was EMPTY**. The whole top-10 spans
means −12.0%…−17.5% with ciHigh < 0 throughout; both entry directions appear in it, so neither
mean-reversion nor continuation has even a weak edge. Exit decomposition of the FULL ledger: 451/634
trail-stops, 148 time-stops, 34 recenters, 1 SL — the "sell into the bounce" leg almost never gets a bounce.

## Mechanism (why it loses, in one paragraph)

The intraday fluctuations of cheap key-set buckets are **noise plus adverse selection, not mean-reversion**:
a dip in a bucket's mid is more often the market correctly re-rating that temperature DOWN (weather
information arriving) than an uninformed liquidity wobble, so dip-buys systematically catch falling knives —
the same §12 adverse-selection wall that killed maker-spray, and the same direction as the earlier
"delayed entry is monotone toxic / the first enterable tick IS the low" finding. Momentum entries fail
symmetrically: by the time a rise clears the signal bar on a 20-min grid the re-rating is done, and the
taker pays the top. On top of a signal with no positive drift, the double taker round-trip
(~2×(spread+fee)+slippage ≈ 4–7pp on 10–30¢ buckets) turns noise into a reliable −15%.

## Artifacts

- Engine + tests: `packages/core/src/sim/opening-fluctuation-replay.ts`, `packages/core/test/opening-fluctuation-replay.test.ts` (21 tests)
- Harness: `scripts/research/sim-fluctuation-taker.ts` (`--build-cache` / `--grid` / `--sweep` / single-cell)
- Run outputs: `scripts/research/out/fluctuation-grid.json` (selected + TEST/FULL + top-10),
  `out/fluctuation-ledger.csv`/`.md` (the FULL ledger of the selected cell), `out/fluctuation-dists.json.gz`
- Status: read-only research; the trading rail stays DORMANT; no config, migration, or deploy touched.
