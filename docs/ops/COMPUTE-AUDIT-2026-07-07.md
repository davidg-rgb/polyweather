# Supabase compute audit — 2026-07-07

Executed the morning after the 12th (and final) signal was recorded KILL (`FINDINGS.md`,
investigation CLOSED). With all twelve tradable signals dead and the product now purely the
forecasting analytics, the trading/convergence capture pipelines that had been saturating the
Micro instance were no longer needed. Operator-authorized (scope: "crons only", data left intact).

## Root problem
The Micro DB saturated at US-evening peak all of 07-06 → 07 (prod 504, gate couldn't clean-write,
daemon degraded, real-book sweep un-runnable). Cause: a handful of **high-frequency heavy** crons —
most feeding signals that are now closed. `opening_captures` is the largest table by 4× (**1.37 GB /
283k rows**), fed by the `opening-capture` pipeline that existed to feed the now-closed 12th-signal gate.

## Changed (2026-07-07, via `cron.unschedule` / `cron.alter_job`)

**UNSCHEDULED (10) — closed-gate + dead-signal captures:**

| Job | Was | Fed / reason it can die |
|---|---|---|
| `opening-capture` | */10 | convergence/maker-exit gate → **12th signal CLOSED**; the heavy 45-city read that saturated the DB |
| `opening-capture-deadman` | */10 | deadman for `opening-capture` |
| `opening-bot-deadman` | */10 | deadman for the DORMANT trade-bot |
| `convergence-panel` | */15 | `/convergence` dashboard → 12th signal CLOSED (heavy) |
| `maker-exit-panel` | hourly | the maker-exit gate — recorded 2026-07-07, job done (heavy) |
| `arb-depth-capture` | */30 | complete-set arb = **8th signal KILLed** |
| `cross-venue-capture` | */30 | Kalshi↔Poly = **10th signal KILLed** |
| `reward-snapshot` | */20 | reward farming = **REC-8 closed** |
| `sharps-snapshot` | daily | sports sharps = **9th signal dead** |
| `sharp-wallet-track` | daily | sports sharps = **9th signal dead** |

**SLOWED (1):** `whale-watch` `*/1` → `*/10` (was firing 1,440×/day for a standalone Slack alarm;
the whale-insider signal found no signature).

**Net load removed:** ~450 heavy invocations/day (incl. every `opening-capture` 45-city read that drove
the saturation) + ~1,300 `whale-watch` invocations/day.

## Kept — the retained analytics product (all low-freq)
Forecasting pipeline: `discover-markets`, `poll-markets` (*/5), `fetch-actuals`, `build-distributions`,
`snapshot-forecasts`/`-ensembles`/`-sources`, `run-calibration`, `grade-bets`, `snapshot-downsample`,
`metar-nowcast`. Deliverables: `amsterdam-paper-trade`, `city-paper-trade`. Ops/maintenance:
`health-monitor`, `daily-digest`, `bot-tick-log-prune`, `job-run-details-retention`,
`opening-captures-prune`. **19 jobs remain (was 29).**

## Done (2026-07-07, C95/C96 — the footprint reclaim)
- **`opening_captures`: 1.37 GB → 75 MB** (95% reclaimed). Sequence: (1) dumped the raw order book
  (bid/ask/depth per bucket — the ONE thing the price-path archive lacks) locally to
  `scripts/research/out/opening-captures-archive/` (208 gzipped-NDJSON shards, **319,434 rows / 475
  events / 569 MB**, keyset-chunked + verified rows/events == live table); (2) **aggressive prune**
  (`prune-opening-captures.ts --preflight dump --resolved-age-days 2 --execute`) gated on the VERIFIED
  dump's event set — deleted **301,608 rows / 344 resolved events**, keeping the recent ~2-day window
  (17,826 rows / 131 events; nothing reads it live — the dashboards read the `convergence_panel` /
  `maker_exit_panel` snapshot tables, not `opening_captures`); (3) `VACUUM (FULL, ANALYZE)` (18.5 s,
  exclusive lock blocked nothing since capture crons are unscheduled) → total 1370 MB → **75 MB**
  (heap 51 MB → 2.9 MB, TOAST 1266 MB → 70 MB). Raw bid/ask preserved locally; forecasting pipeline
  (`forecast_snapshots` 363k / `model_stats` 6.5k / `observations` 40k) untouched.
- **Local dry-run daemon (`scripts/trade-bot.ts`)** — STOPPED (C94; PIDs 91824/94988/95132 → 0). Inert
  post-KILL (`opening-capture` dead → 0 candidates). **Do NOT relaunch** — intentional stop.

## Still open
- Edge functions for the killed crons are left deployed (serverless — $0 at rest, nothing invokes them).

## Re-enable (idempotent — `cron.schedule` upserts by jobname)
Each killed job's original `cron.schedule(...)` lives in the migration that created it:
`opening-capture`/deadmen → `0066_opening_convergence.sql`; `convergence-panel` → `0069`;
`maker-exit-panel` → `0073`; `arb-depth-capture` → `0060`; `cross-venue-capture` → `0062`;
`reward-snapshot` → `0057`; `sharps-snapshot`/`sharp-wallet-track` → the sports-sharps migration.
Re-run the relevant `cron.schedule(...)` block to restore. `whale-watch`:
`select cron.alter_job((select jobid from cron.job where jobname='whale-watch'), schedule => '* * * * *');`
