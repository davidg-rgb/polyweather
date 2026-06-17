# Polyweather — Project Context

Weather prediction-market **analytics & forecasting** system. Predicts daily Tmax for
~46 global airport stations from a calibrated multi-model NWP ensemble, prices
temperature prediction markets against it, and measures forecast skill + market
efficiency. Stack: **Supabase** (Postgres + edge functions + pg_cron) + **Vercel**
dashboard, TypeScript monorepo (`packages/core|io|trading`, `supabase/functions`,
`scripts/*` run via `pnpm tsx`).

> **STRATEGIC PIVOT (2026-06-15): the live-trading thesis is CLOSED.** R&D falsified a
> tradable edge on every signal the system can see — the multi-day NWP blend is at its
> point-skill ceiling (4 rejected levers), the intraday nowcast is already priced by a
> faster/more-accurate market, and WO-5 (`FORECASTING-RD.md`) proved the market is
> efficient w.r.t. the hard running-max floor (no latency window). **The product is now
> the analytics/insight value** (calibrated forecast skill, model-vs-market scoring,
> market-efficiency measurement), per the operator's decision. The trading machinery
> (`packages/trading`, the `bets` surface) stays built but DORMANT — do not invest in
> taker-edge work without new out-of-market information.

- Hosted Supabase ref: `lenysiqxihsmxljvyybt` (eu-north-1) · Prod: `weather-edge-two.vercel.app`
- Canonical docs: `BUILD-STATE.md` (status + Operator TODO), `RUNBOOK.md` (ops),
  `REQUIREMENTS.md`, `ARCHITECTURE.md`. Tests: `pnpm test`, `pnpm typecheck`.
- Build is COMPLETE (P0–P8). Remaining work is operator/deploy-gated — see BUILD-STATE.
- **Headline analytics deliverable (2026-06-16): the Amsterdam paper-trade head-to-head** —
  `$10/day` on our predicted bucket at 13/14/15/16 local, racing to find the best time to bet,
  scored against the real market. Engine `packages/core/src/sim/amsterdam.ts`, migration `0039`,
  Edge Function `amsterdam-paper-trade`, `/amsterdam` page, seed `scripts/amsterdam-sim.ts`. NOT
  trading. Design + go-live: **`AMSTERDAM-SIM.md`**.
  - **Floor "truth accuracy" (2026-06-17, migration `0043`):** a second, cleaner accuracy lens scored
    against the **real** Schiphol high at 0.1°C from **KNMI** (free daggegevens API, station 240, var TX —
    897 gap-free days verified) — `truth_won = predicted == floor(decimal actual)` + a decimal signed-error
    log (MAE/bias). New `amsterdam_truth` table, `scripts/amsterdam-truth-backfill.ts`, `/amsterdam` truth
    panel + backtest columns. **Market-resolution accuracy stays its own number (drives the P&L);** truth is
    filled independently (the Edge tick refreshes KNMI best-effort). Operator-gated go-live: `AMSTERDAM-SIM.md` §4.
  - **Peak-hour best-time model + `/amsterdam` redesign (2026-06-17):** fuses **20 years of KNMI Schiphol
    hourly data** (peak-hour floor confidence — when is the running-max floor essentially the day's high?)
    with the empirical hit rate (prediction accuracy) into a single **best-time-to-bet** recommendation
    (`predictiveConfidence/ask − 1`, shrinkage-blended, hot-day aware). Committed climatology asset
    `core/sim/amsterdam-climatology.ts` (regen via `scripts/research/amsterdam-peak-hour.ts --emit`), pure
    model `core/sim/amsterdam-besttime.ts`, hero `components/PeakHourChart.tsx`, reworked `/amsterdam` in a
    "Terminal-Glass" bento (mockup in `/design`). No DB/migration — static asset, computed server-side.
    Design + formula: `AMSTERDAM-SIM.md` §6.

---

## P4 backfill + calibration refold — DONE (2026-06-17)

The one-time full-universe backfill + the calibration **full-refold are complete**:
`pnpm tsx scripts/check-p4-coverage.ts` reports `✅ P4 DoD MET` (**97.5% cell coverage,
45 stations, 28.8 months**). The former self-expiring auto-resume operational-rule block and
the `delete config calibCursor` finish-line step have been removed — they were one-time aids.
The refold drained 39,454 finalized obs (612,236 residual rows) in 15 manual `run-calibration`
triggers (RUNBOOK.md §99-124); steady-state daily calibration now keeps `model_stats` warm on
its own. **Do NOT re-add a backfill auto-resume rule** unless a fresh universe-wide backfill is
started.

Remaining operator-CLI deploys (non-blocking, **separate from P4**) per `RUNBOOK.md` 140–171:
redeploy `run-calibration` (3k cap) and deploy `snapshot-sources` + migration `0026` (set the
**rotated** WeatherAPI/OWM keys as Edge secrets — the old WeatherAPI key was exposed in chat and
should already be rotated).
