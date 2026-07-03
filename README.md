# Polyweather

An analytics instrument for weather prediction markets. Polyweather forecasts the
daily maximum temperature (Tmax) for ~46 global airport stations from a calibrated
multi-model NWP ensemble, prices Polymarket's daily "highest temperature" ladders
against that forecast, and measures two things honestly: **how good the forecast is**
and **how efficient the market is**.

The system was originally built to *trade* that edge. It doesn't. The R&D program
systematically tested for a tradable edge and found none. The product is now the
measurement — a calibrated forecast, a scored model-vs-market history, and a
defensible proof of market efficiency. The full verdict is **[FINDINGS.md](./FINDINGS.md)**.

> Codename `weather-edge` (packages are `@weather-edge/*`; prod is
> `weather-edge-two.vercel.app`). Same system.

## The headline

**No tradable edge. The market is efficient with respect to every signal this system
can see.** Twelve distinct signals were tested; each measured edge was zero-or-negative
with the confidence interval excluding a tradable margin.

- **The forecast is genuinely good.** The live inverse-MSE ensemble blend posts
  **1.33°C lead-1 RMSE** (1.57°C overall) and beats the best single model
  (`icon_seamless` 1.46°C). Per-station/per-model EMOS bias correction works
  (residual means ≈ 0). It is at its point-skill ceiling — four independent
  levers to improve μ-aim were all rejected.
- **The market is sharper than the forecast.** Our EMOS forecast vs the day-before
  market ask: edge **+0.46pp, CI [−0.92, +1.83]** (straddles 0); **0/44 stations**
  clear zero; our Brier 0.740/0.756 is *worse* than the market's 0.715.
- **By early afternoon the market is at the oracle ceiling.** At local h15, market
  RMSE **0.40°C** vs our intraday nowcast **0.65°C** vs the NWP blend **1.18°C** — it
  has already priced the same running-max METARs its participants observe.
- **The one edge that exists is unreachable.** An external sharp (`badatmath`) went
  **+$25,407 realized**, #1 on the weather leaderboard, ~$1.45M lifetime volume,
  ~1.8% ROI-on-volume, 40.6% win rate — but it is pure microstructure (resting cheap
  maker bids, collecting the rebate at enormous breadth) and is non-followable and
  non-replicable as a taker (copy-follower −6.05pp; resting our own bids −1.5 to −1.7pp,
  adverse selection).

**One live exception, still under forward test.** The 12th signal — opening convergence,
maker-exit variant — is the first positive-EV config in the program: **+6.7% / +$515,
CI [+0.3%, +12.0%]** on the corrected 819-event backtest. It is *not* a go-live signal.
A backtest is not a GO; it is measured forward by the `/maker-exit` paper loop, the gate
of record. **No capital moves before a frozen forward paper PASS.** The other eleven
signals stay dead. See FINDINGS.md for all twelve, with numbers.

## What it measures (the product)

- **A calibrated forecast** — multi-model NWP ensemble (Open-Meteo 8 models + best_match,
  ECMWF-ENS / GEFS members), per-station/per-model/per-lead bias + σ, Gaussian and
  ensemble-empirical bucket distributions over the exact market ladder.
- **A scored model-vs-market history** — information-time-matched, symmetric-source Brier,
  ECE, reliability, sharpness per (city, lead, source). The measurement that *proved* the
  market is the sharper forecaster.
- **A market-efficiency proof** — the day-before efficiency study, the running-max dead-mass
  latency study, and the five-angle sharp-wallet falsification, reproducibly demonstrating
  this market is efficient. A publishable finding, not a null to bury.
- **Truth accuracy** — forecast scored against the *real* station high (e.g. Amsterdam/KNMI
  station 240, TX), independent of market resolution.
- **Live paper-trades** — never real money; net-profit-vs-market measurement only.

## Dashboards (`weather-edge-two.vercel.app`)

| Route | What it shows |
|---|---|
| `/` | Verdict overview |
| `/efficiency` | The market-efficiency verdict — every falsified signal at executable depth |
| `/data` | Forecast accuracy by market: per-station best/worst, ours-vs-market by horizon, daily Brier gap |
| `/amsterdam` | Amsterdam $10/day paper-trade head-to-head + KNMI truth accuracy + peak-hour best-time model |
| `/paper-trade` | Multi-city paper-trade (Singapore, Karachi, …) + entry-time watcher |
| `/maker-exit` | The 12th-signal forward maker-exit paper loop (the live gate of record) |
| `/calibration` | Brier trends, reliability diagrams, ECE, champion/challenger |
| `/sharps` | Sharp-wallet benchmark (`badatmath` + weather leaderboard) as a free third forecaster |
| `/rewards` | Polymarket liquidity-reward pool tracker |
| `/whaletracker` | Large-trade tracker (single bets ≥ $100k, all markets) |
| `/replica` | `badatmath` three-curve replica P&L |

## Architecture (10 lines)

1. TypeScript monorepo, pnpm workspaces; strict TS; Postgres is the system of record.
2. `packages/core` — pure domain logic, no IO: bucket parsing, fee math, EMOS calibration, distributions, Kelly, sim engines. The unit-test surface.
3. `packages/io` — HTTP client, Polymarket wallet reads, Slack notifier.
4. `packages/trading` — one `TradeExecutor` interface; a paper executor and a **dormant** live executor behind a go-live gate.
5. `supabase/migrations` — schema 0001–0078: reference → ingestion → markets → analytics → trading → ops → RLS → cron, plus RPC / dashboard layers.
6. `supabase/functions` — ~30 Deno Edge Functions: discover markets, snapshot forecasts/ensembles/sources, poll markets, METAR nowcast, calibrate, grade, digest, health-monitor, and the analytics panels.
7. Scheduling: `pg_cron → pg_net → Edge Function` (Vercel Hobby crons can't run sub-daily); secrets via Vault, never literal.
8. `apps/web` (`@weather-edge/web`) — Next.js dashboard + operator API on Vercel; Supabase Auth with a single allow-listed operator, RLS denies everyone else.
9. Truth pipeline: Wunderground v1 hourly-max is canonical, cross-checked against METAR / IEM / ERA5T; grading verifies our winner equals Polymarket's resolved winner.
10. `scripts/` — local CLIs via `pnpm tsx`: backfills, coverage gates, source-accuracy ranking, and read-only research/sim replays.

Full blueprint: [ARCHITECTURE.md](./ARCHITECTURE.md) · spec: [REQUIREMENTS.md](./REQUIREMENTS.md) ·
ops: [RUNBOOK.md](./RUNBOOK.md) · status + operator TODO: [BUILD-STATE.md](./BUILD-STATE.md).

## Run / test

```bash
pnpm install
pnpm typecheck                          # strict TS across all packages
pnpm test                               # vitest: 2,000+ tests — core math, PGlite-backed jobs/RPCs, web loaders, scripts
pnpm test:coverage                      # 95% line/function floor on packages/core
pnpm dev                                # Next.js dashboard (needs .env.local — see .env.example)
pnpm --filter @weather-edge/web build
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test:coverage`, and the web build on every
push to `main` and every PR. The migration suite boots an embedded Postgres (PGlite), applies
the full chain twice, and verifies natural keys, indexes, RLS, the config/model seed, and the
pg_cron registrations. Hosted-Supabase setup (project link, secrets, seed) is in
[RUNBOOK.md](./RUNBOOK.md); config shape is [`.env.example`](./.env.example).

## Boundary — no trading advice

This is an analytics & forecasting record. **Nothing here is trading advice.** The live
trading rail is **DORMANT**: the live executor ships disabled behind a go-live gate and is
never enabled by default; every paper-trade on the dashboards is fictional, no-money
measurement. Any wallet and signing key are held by the operator (`.env.local`, never
committed, never in chat); no capital moves without a frozen forward paper PASS. Do not
reopen taker-edge work without genuinely out-of-market information.

_See [FINDINGS.md](./FINDINGS.md) for the canonical R&D verdict — all twelve signals, with the numbers._
