# Efficiency Monitor — the forward paper confirmation loop (C23/C24)

**Operator-requested 2026-07-09.** A forward **paper** loop that trades the two most-recent falsified
findings on real, forward, **day-before executable** prices and lets the frozen §9R-E gate adjudicate them
**over time**. Paper only — **no capital, ever; the rail stays DORMANT** (Claude never trades or touches keys).

## What it is (and what it is NOT)

It is a **confirmation instrument, not a profit engine.** Every backtest (C19–C24) says the market is
efficient, so the honest expectation is that both strategies **wash or bleed**. Its one high-value outcome:
the small chance a signal holds **forward** against expectation — which is the *only* thing that could reopen
trading under the project's standing rule (`FINDINGS.md`). Running it is the methodologically-correct step:
the project's own rule (`traps.md #1`) is that a backtest is never the gate of record — the live forward
paper loop is. This forward-papers C23 + C24 exactly as the maker-exit loop forward-papered the 12th signal
(which forward-KILLed).

## The two strategies

| | Strategy | Confirms | Entry | Expected |
|---|---|---|---|---|
| **S1** | Regime + forecast cheap-subset | KILL-GATE 2 (pooled) + **C24** (regime split) | paper-buy our calibrated forecast's cheap-longshot subset at the real **day-before ask**, tag each buy by ensemble-disagreement quartile | KILL — cheap longshots are overpriced; Q4 (high-disagreement) is the only cell with a positive point estimate (+1.16pp), tracked separately |
| **S2** | Ladder-geometry troughs | **C23**-T2/T3 | detect interior price-troughs (a bimodal ladder a single-peaked Tmax dist shouldn't price) on the day-before ask ladder, buy the trough | KILL/INSUFFICIENT — troughs are ~1% and don't carry underpricing (−8.72pp on the real book); slow accrual is itself the finding |

Each **paper purchase** = one panel row: buy 1 share at the real ask, pay the taker fee, collect $1 iff it
wins → `netReturn = (won?1:0) − ask − takerFee(ask)`. The frozen `openingVerdict` gate clusters these by
city (≥40 buys / ≥6 cities / ≥7 days, winFrac ≥ 0.5, city-clustered CI > 0, zero-skill MC < 5%).

## Baseline on data-so-far (2026-06-16 → 07-08, the live-slot TEST window)

Cross-validates C24 exactly (the run script + core scorer reproduce the committed C24 numbers):

- **S1 pooled §9R-E gate: KILL** — n=3,442 buys / 45 cities / 21 days · winFrac 6.0% · net −0.09pp CI
  [−1.00, +0.82] · zsMC 1.3%. Per-quartile: Q1 −0.67 · Q2 −0.61 · Q3 +0.44 · **Q4 +1.16pp [−0.41, +2.73]**.
  **Q4 day-clustered +1.05pp CI [−1.11, +3.20]** over **21 distinct weather-days** (includes 0 → confirms C24).
- **S2 geometry: INSUFFICIENT_DATA** — only 10 day-before troughs (rare on tight near-resolution books);
  accrues ~1 trough / 100 markets, so it may stay INSUFFICIENT — itself confirming troughs are too rare to trade.

## Architecture

- **Pure scorer** `packages/core/src/sim/efficiency-monitor.ts` (10 tests) — `detectLadderTroughs` +
  `scoreEfficiencyMonitor`: takes walked `MonitorEvent`s → both strategies through the frozen gate + the C24
  per-quartile / Q4-day-clustered breakdown. Temperature axis from the bucket numeric edges, never
  `bucket_idx` (trap #7).
- **Driver** `scripts/research/efficiency-monitor-run.ts` — stitches the `backfill` warm-up (≤06-15) + the
  live `10Z` slot (TEST) exactly like `conditional-efficiency-live.ts`, builds `MonitorEvent`s, scores, and
  (with `--record`) persists one snapshot. Re-derives from resolved tables each run → idempotent, no
  look-ahead, no mutable bet state.
- **Persistence** migration `0091` — `efficiency_monitor_panel` + `record_efficiency_monitor` (service-role)
  + `dash_efficiency_monitor` (operator read: latest view + a compact trend series). 4 db tests.
- **Dashboard** `/monitor` — both strategies' §9R-E gate banners + the C24 per-quartile table with the Q4
  day-clustered highlight. `getEfficiencyMonitor` loader; DashNav link.

## Deploy (operator — the boundary: you apply/deploy/schedule; Claude never trades or holds keys)

1. **Apply migration 0091** to prod (`efficiency_monitor_panel` + the two RPCs).
2. **Record the first snapshot + accrue daily.** Run the driver (outside the reserved :32–:42 UTC cron
   window); it needs `DATABASE_URL` (service-role, read + the record RPC — no trading keys):
   ```bash
   pnpm tsx scripts/research/efficiency-monitor-run.ts --record        # --to defaults to today; window rolls forward
   ```
   Schedule it **daily** by whichever is convenient:
   - **GitHub Action** (recommended — machine-independent): a daily `cron` workflow running the command with
     `DATABASE_URL` as a secret.
   - **Windows Task Scheduler** (quick/local): a daily task running the same command from the repo.
   - *(Future native option:* a thin Supabase Edge tick could read the stored live `house_gaussian`
     (`bucket_probabilities`) instead of recomputing the EMOS fold — deferred because the EMOS engine lives in
     a research script, not deployable core, and reading `house_gaussian` introduces minor drift from the
     research recompute. The scheduled script is the faithful driver.)*
3. **Watch `/monitor`.** It renders once the first snapshot lands; the trend series shows how each strategy's
   §9R-E gate + the Q4 day-clustered edge evolve as data accrues.

## The bar for acting on it

A forward **PASS** on either strategy — city-clustered CI clearing 0, ≥40/≥6/≥7, zsMC < 5%, and for S1's Q4
the day-clustered CI clearing 0 — would be **genuinely new measured information** and the only trigger to
reconsider the standing KILL (`FINDINGS.md`). Anything short of that confirms the findings. No capital before
a frozen forward PASS **and** an explicit operator decision. Rail stays DORMANT.

_Analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
