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
> taker-edge work without new out-of-market information. **The complete verdict — all seven
> falsified signals, with the numbers — is the canonical record `FINDINGS.md`.**
>
> **SCOPED EXCEPTION (2026-06-27): the trading rail is REACTIVATED for ONE tested lever — OPENING
> CONVERGENCE — and nothing else.** The 12th signal is the first that did **not** die at its cheap gate:
> freshly-listed daily-weather markets open flat (~10–12%/bucket) and converge; buy the forecast-center cheap
> at the flat open, sell into the convergence on **brackets**. Operator greenlit an **autonomous paper-first
> buy/sell bot** (dedicated funded wallet, start small, aim net-profit). Blueprint **`ARCHITECTURE-OPENING-CONVERGENCE.md`**
> is BUILD-READY (Phase-9 Full review converged 3→1→0 CRITICAL; `REVIEW-opening-convergence.md`); spec
> `OPENING-CONVERGENCE-HANDOFF.md` (§9R locked params). The load-bearing unknown — is the signal even available
> while the book is still flat-open, and is there net edge at executable depth — is **measured forward** by the
> bot's keyless capture layer (Phase 0) and a hard **Phase-0.5 go/no-go spike** before any execution; **no
> capital until a frozen net-profit gate PASSes** (≥40 paper markets, CI excl 0). This is NOT a reversal of the
> efficiency findings — it is the single exception that earned a real test. The other eleven signals stay dead.
> **Boundary (NON-NEGOTIABLE): Claude builds the software; the operator funds a dedicated wallet + holds the
> signing key (`.env.local`, never in chat); Claude never places a trade or touches credentials.**
>
> **↳ UPDATE 2026-06-30 — the bracket thesis is now TUNED on 708 events → KILL at executable spread (`CONVERGENCE-TUNING.md`).**
> The starved live panel (n≈2) was replaced by the price-history archive joined to the bot's real `house_gaussian`
> seed (708 events / 45 cities / 17 days), run through the same engine across an entry/exit grid validated
> out-of-sample. No threshold set clears §9R-E: the convergence price-path edge is REAL (+8.2% frictionless) but
> the **taker round-trip spread consumes it** (breakeven ×0.70 of the real spread) — a **maker edge, not a taker
> edge**. Two carry-forwards: a **maker-exit** variant is the one open lever (must beat the §12 adverse-selection
> wall), and the **calibrated `house_gaussian` out-selects `ensemble_raw`** for bracketing the winner (73.9% vs
> 52.8%). Rail stays DORMANT; live config unchanged — the Phase-0.5 spike on real-book depth is still the live gate.
>
> **↳ UPDATE 2026-06-30 (2) — the MAKER-EXIT lever is BUILT + SIMULATED → flips POSITIVE, still KILLs (`MAKER-EXIT-SIM.md`).**
> Built the maker-exit engine (`core/sim/opening-maker-exit-replay.ts`: take profit as a MAKER — $0 fee + rebate,
> fills only when a later bid lifts the resting sell; TAKER stop-loss + a hard time-stop at resolvesAt−Nh) and ran
> an **agent-team dynamic Workflow** (`tune-maker-exit`: 7 parallel coordinate agents/round × ≤3 rounds, stop-on-no-gain)
> to maximize net profit. The maker exit moves the SAME strategy from the taker's **−3.0% to +1.8% (no rebate) /
> +5.1% / +$313 (measured weather maker rebate)** — the **first positive-EV config in twelve signals** — but the
> §9R-E gate **still KILLs** (17-day city-clustered CI [−1.6%, +11.5%], ciLow just below 0; winFrac + zsMC clear).
> Tuned: tp 0.12 / sl 0.20 / tstop 18h / chw 0 / depth $150 / makerWindow 30. NOT a GO (three assumptions resolve
> only forward) → it earns a **live forward test**, not capital. Rail stays DORMANT; live config unchanged.
>
> **↳ UPDATE 2026-07-03 — the archive was MISALIGNED-then-CORRECTED → the tuned maker-exit config now PASSES the backtest §9R-E gate (`MAKER-EXIT-SIM.md` banner); four new improvement levers tested + REJECTED.**
> The on-disk archive predated the 06-30 canonical-sort fix → re-pulled (1 108 events) + every verdict regenerated on the
> grown **819-event / 45-city / 20-day** panel: the SAME pinned config nets **+6.7 % / +$515, CI [+0.3 %, +12.0 %], PASS**
> (rebate 0; +7.6 % at the fixed 0.25 tier) — the misalignment had been UNDERSTATING the edge. A four-lever improvement
> campaign (per-city accuracy gate / absolute "sell at 30+¢" TP / delayed entry / no-chase fallback) was built + swept
> OOS → **all rejected** (first-tick entry IS the low; entry-relative TP beats level targets; city-gating widens the
> clustered CI). Per-city source accuracy (~2 100 events): the calibrated blend dominates every source at every lead →
> two operator-gated alignment actions: redeploy `maker-exit-panel` (scope 10→45-city capture universe) + flip
> `bot.consensusSource` → `calibrated`. **Backtest ≠ GO: the live forward paper loop stays the gate of record; no
> capital before a frozen paper PASS.** Rail otherwise DORMANT; boundary intact.
>
> **↳ UPDATE 2026-06-30 (3) — the FORWARD MAKER-EXIT PAPER LOOP is BUILT + tested (operator-deploy-gated; `MAKER-EXIT-PAPER-LOOP-HANDOFF.md` §0a).**
> Built as the maker-exit twin of `convergence-panel` (re-replay over the live `opening_captures` stream, NOT a
> per-tick state machine): the pure `replayMakerExitEvent` now records the measurement diagnostics (maker-fill
> latency, observed entry/exit spreads, rebate rate); new `core/sim/opening-maker-exit-view.ts` (`buildMakerExitView`)
> + migration `0073` (`maker_exit_panel` snapshot + `dash_maker_exit` + forward `bot_gate_snapshot` writes + a
> cadence-aware `bot_deadman` `bot.tickStaleMin`) + edge fn `maker-exit-panel` (*/15) + the `/maker-exit` dashboard
> headlining the **three measured assumptions** (maker-fill rate #1 / realized rebate #2 / days #3). Suite **1772
> green**, typecheck clean. Operator deploy = apply 0073 + deploy the edge fn; then ≥7 days/≥40 markets accrue → the
> live §9R-E gate adjudicates. **No capital before a frozen paper PASS.** Boundary intact (Claude never trades/keys).
>
> **↳ UPDATE 2026-07-05 — the operator authorized REAL BUYING (22:47 local 07-04) → the LIVE-RAIL execution stack is BUILT (night loop v9, C43–C49) and sits DARK behind the unchanged gate.**
> Five lanes, each adversarially lens-reviewed to MERGE-CLEAN, all on main @ `7d35c79` (suite 160 files / 2583 green):
> **T1** `packages/trading` MakerExecutor (maker entry/TP, taker FAK exits, dry-run-default mode ladder, idempotent
> ledger) · **T2** the LOCAL daemon `scripts/trade-bot.ts` + operator smoke `scripts/trade-smoke.ts` + runbook
> `docs/ops/TRADING-ACTIVATION.md` (its 3-round lens caught a CRITICAL filled-TP over-sell on the WINNING path
> pre-merge) · **T3** migration **`0082` (trade_config + trade_live_preflight interlock + live ledger + dash_trading)
> — MERGED-DARK, NOT applied** · **T4** the `/trading` operator console (renders "0082 NOT APPLIED" until then) ·
> **T5** the shadow-week diff harness `scripts/research/trade-shadow-diff.ts` (dry-run daemon vs replay twin).
> **NOTHING RUNS YET.** Operator morning items (`docs/ops/LIVE-RAIL-NIGHT-HANDOFF.md`): apply 0082 → run the smoke
> (keyless-safe default) → start the DRY-RUN daemon (begins the shadow week T5 measures). TRADE_MODE defaults
> never-live; a live post additionally needs the preflight interlock (forward-gate PASS or explicit 14d-capped
> override). **The forward paper §9R-E gate is UNCHANGED as the gate of record (INSUFFICIENT 6-of-7 days at build
> close, first 07-05 entries open) — no capital before a frozen PASS; the boundary holds (operator funds/keys/
> authorizes; Claude never trades, never touches credentials).**
>
> **↳ UPDATE 2026-07-07 — the forward maker-exit paper gate KILLS → the 12th signal's last surviving form is closed; ALL TWELVE signals are now dead (`FINDINGS.md`). Investigation CLOSED.**
> The live gate rendered a settled **KILL** on **62 markets / 26 cities / 7 distinct days** (above the ≥40/≥6/≥7 floor): mean net **−12.6%**, 95% CI
> **[−21.6%, −3.5%]** (the whole interval negative), `makerFillRate` **0.065** (backtest 49.0%), rebate $0, net −$168. Mechanism proven, not inferred: the
> backtest replayed a SYNTHETIC `house_gaussian`-centered book that converges to the forecast by construction; the live gate replays the REAL efficient
> Polymarket book, which does not — so the resting-maker take-profit leg that carried the whole backtest edge almost never fills live (`MAKER-EXIT-SIM.md`
> root-cause banner). **No capital was ever risked.** The durable clean gate-row write was infra-blocked ~2 days by Supabase-Micro saturation at peak (every
> tick degraded → the gate correctly refused to auto-write); verdict settled + robust across subsets → operator-authorized direct recording 2026-07-07. Rail
> (`packages/trading`, the `bets` surface) stays **DORMANT** with **no scoped exception pending** — reopen only per `SIGNAL-BACKLOG.md` §13. The product is
> fully the analytics/insight value now; the forward instruments (`/maker-exit`, `/paper-trade`, `/amsterdam`, `/replica`, `/data`, `/efficiency`) keep
> running as analytics regardless of this verdict.

- Hosted Supabase ref: `lenysiqxihsmxljvyybt` (eu-north-1) · Prod: `weather-edge-two.vercel.app`
- Canonical docs: **`FINDINGS.md`** (the R&D verdict — start here: is there a tradable edge? no, and why),
  `BUILD-STATE.md` (status + Operator TODO), `RUNBOOK.md` (ops), `REQUIREMENTS.md`, `ARCHITECTURE.md`,
  **`DATA.md`** (2026-06-26: the `/data` forecast-accuracy-by-market analytics page — per-station best/worst,
  by-horizon ours-vs-market, the daily Brier gap; migration 0065 `dash_data`, LIVE-on-prod RPC),
  **`WHALE-WATCH.md`** (2026-06-24: Polymarket large-trade alarm — Slack-alerts any single bet ≥ $100k across
  ALL markets — + a global Slack-alert pause gate, LIVE on prod),
  **`CROSS-VENUE-SPIKE.md`** (the 10th signal — Kalshi↔Polymarket cross-venue relative value, the first
  genuinely-EXECUTABLE orthogonal lever. **VERDICT 2026-06-26: KILL — a capacity wall.** Real quoted gap (6/7
  city-days net-positive) but the cumulative synthetic fills at only 1–10 contracts of TRUE both-book depth; the
  24h-vol/OI proxy would have FALSE-PASSED (winFrac 0.857), hardened by migration 0064 to gate WINS on true
  executable depth → winFrac 0 → KILL. Rail DORMANT),
  **`CITY-SIM.md`** (2026-06-29: the **multi-city paper-trade** — the Amsterdam sim generalized to N cities by a
  `city_sim_config` row. Seeds **Singapore (WSSS)** + **Karachi (OPKC)** — the most forecast-accurate °C markets
  with a liquid Polymarket book — racing arms 11/12/13/14 (tropical ~12:30 peak); migration `0070`, Edge fn
  `city-paper-trade`, `/paper-trade` page, seed `scripts/city-sim.ts`. NOT trading — measures net-profit-vs-market.
  **+ 2026-06-30 (§6/§7): the ENTRY-TIME WATCHER** (`core/sim/entry-watch.ts`, live on `/paper-trade`) — recommends
  the optimal entry hour from the graded ledger, ranking arms by the 95%-lower-bound of edge (shrinkage, not the
  point estimate; ⭐ ≠ the 🥇 P&L leader); arms widened to {10..15} (migration `0071`) so it samples both sides of
  the peak. **+ the convergence/accuracy forecast SPLIT** — the opening-convergence bot's house seed now centers on
  the RAW cross-model consensus (`buildDistributionForEvent({biasCorrect:false})`, `BotConfig.consensusSource=
  'ensemble_raw'`), NOT our bias-corrected accuracy forecast: the convergence play bets on what the *crowd* believes,
  so a truth-correction that helps the paper-trade hurts it. **BUILT + fully tested (1715 green); go-live
  operator-gated** — apply 0070+0071 + deploy edge fn + seed). Tests: `pnpm test`, `pnpm typecheck`.
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
