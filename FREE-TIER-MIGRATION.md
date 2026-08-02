# FREE-TIER MIGRATION — Supabase Micro → Free (2026-08-02)

**Goal (operator, 2026-08-02):** cut Supabase to the free tier; keep only *potential edges* live — the
**Google forward watch** — plus **continuous data collection**; **pause the current purchase structure**
(possibly to switch to something else later) while **keeping all data logging for future statistics**;
and move whatever can move **local**.

---

## 1. What the free tier actually constrains

| Limit | Free tier | Where we were | Binding? |
|---|---|---|---|
| Database size | **500 MB** | **3,030 MB** | **YES — the whole problem** |
| Compute | **Nano** (weaker than Micro) | Micro, already saturating at peak | **YES** |
| Edge invocations | 500K/month | ~33K/month | No |
| Bandwidth / storage | 5 GB / 1 GB | well under | No |

Two consequences drove every decision below:

1. **An over-limit free project is forced READ-ONLY.** That would silently stop every capture job — losing
   exactly the forward statistics this project exists to accumulate. So the database must be under 500 MB
   **before** the plan is downgraded, and must *stay* under it afterwards.
2. **Nano is weaker than the Micro that was already timing out** (`dash_events_list` statement timeouts,
   the C18-era saturation). Cutting scheduled compute was not optional.

## 2. The split: capture stays cloud, storage + analysis go local

The organising principle. **Capture cannot move local** — it is time-critical, must run when the laptop is
off, and a forward watch with gaps is not a forward watch. **Storage and analysis can and did move local.**

| Layer | Where it runs | Why |
|---|---|---|
| Order-book / market / forecast / truth **capture** | **Cloud** (pg_cron + Edge) | Must run 24/7 on schedule; gaps are unrecoverable |
| **Bulk history** (the statistics record) | **Local** gzipped NDJSON shards | No size limit on disk; nothing is lost |
| **Replays, backtests, panels, sweeps** | **Local** (`scripts/research/*`) | Already local; batch compute over captured data |
| **Retention sweep** (archive→prune→vacuum) | **Local** (`free-tier-sweep.ts`) | A cloud cron cannot write the operator's disk, so a blind cloud prune would delete un-archived rows |
| The Google forward panel | **Cloud** (hourly) | Deliberately NOT moved: a forward measurement must accrue continuously, including while the laptop is off. It costs ~17s/hour |

**Nothing in the statistics record was deleted — it was relocated.** Every pruned row is archived locally
first, and the prune is *gated* on that day's shard verifying (row count match). No archive, no delete.

## 3. Purchase structure — PAUSED, not dismantled

Per the operator's instruction ("pause current purchase structure to possibly switch to something else").
Two independent brakes, both reversible:

1. **Cron unscheduled**: `buy-table-tick`, `buy-table-tick-fast`, `buy-table-deadman`, `account-snapshot`.
2. **Config flag**: `buy_table.tick_enabled = false` — so even a manual invocation places nothing.

Left fully intact for a future restart or a different structure: all `packages/trading` code, the
`buy_table.*` config (allowlist, per-city caps, window), both floor vetoes (0121/0122), the ledger
(`live_orders` / `live_fills`), and the wallet itself. **The live override had already lapsed 2026-07-31
00:00Z**, so no live posting was possible anyway; the lane was down ≈$30 lifetime with $62.85 cash idle.

**To resume purchasing later:** re-schedule the cron jobs → set `buy_table.tick_enabled = true` → create a
fresh operator override (the operator's click; expiry ≤14 days). The boundary is unchanged: the operator
funds/keys/authorizes; Claude never trades.

## 4. What still runs in the cloud (17 jobs, all capture/analytics)

**Data collection — the statistics record keeps growing:**
`snapshot-forecasts` (2×/day, our NWP blend) · `snapshot-ensembles` (2×/day) · **`snapshot-sources`
(2×/day — the Google Weather lane)** · `build-distributions` (2×/day, house distributions) ·
`fetch-actuals` (hourly, resolution truth) · `metar-nowcast` (2×/hour, intraday running max) ·
`poll-markets` (2×/hour ↓ from 4×) · `discover-markets` (3×/day ↓ from 5×) · `opening-capture`
(3×/hour ↓ from 12×) · `run-calibration` + `grade-bets` (daily).

**The one live edge:** `google-paper-panel` (hourly) — the European-cluster forward watch
(milan / paris / london / cape-town / warsaw / lucknow, pre-registered forward-only) keeps accruing.

**Retention/ops:** `opening-captures-prune`, `snapshot-downsample`, `job-run-details-retention`,
`bot-tick-log-prune`, `health-monitor` (hourly ↓ from 2×).

**Stopped** (dead signals / paused lane / ops noise): the 4 purchase jobs, `whale-watch`,
`amsterdam-paper-trade`, `city-paper-trade` ×3, `cheap-early-panel`, `synoptic-nowcast`, `daily-digest`,
`opening-capture-deadman`. Scheduled runs: **~7,750/week → ~1,750/week**; edge compute roughly a third.

> `synoptic-nowcast` was capture-only on a 14-day trial ending ~2026-08-08 — stopped early here. Its token
> secret stays set; re-schedule if the US 5-min lane is ever wanted again.

## 5. Result: 3,030 MB → 434 MB (executed 2026-08-02)

| Stage | Size |
|---|---|
| Before | **3,030 MB** |
| After archive + prune + `VACUUM FULL` (pass 1) | 785 MB |
| After tightened windows (pass 2) | 528 MB |
| After closed-signal archival + final windows (pass 3) | **434 MB — 66 MB headroom** |

**It keeps falling on its own.** `opening_captures` (183 MB, the largest remaining table) is still holding
rows captured at the old 12×/hour cadence; at 3×/hour those age out within ~2 days and it settles near
50–70 MB, putting the database around **~300 MB steady state**.

Archived locally and verified before any delete: **~4.1M rows / ~245 MB gzipped** across 13 tables, plus
the 570k-row raw order-book dump. Zero unverified days — the prune is structurally gated on verification.

### Hot windows (`archive-retention.ts` → `RETENTION`)

Server keeps the hot window; local keeps everything.

| Table | Hot window | Deepest live reader |
|---|---|---|
| `opening_captures` | resolved + **1 day** | Google panel replays *open* events (≤3-day life); the 1-day grace gives the hourly panel ~24 chances to grade a just-resolved event before its captures go |
| `market_snapshots` | 3 days | `/events` + panels want days, not months |
| `bucket_probabilities` | 7 days | panels replay open events — 2× margin |
| `forecast_snapshots` | 25 days | longest lead (16d) + grading lag; calibration state lives in `model_stats` |
| `job_runs` / `model_stats_history` | 7 days | deadman reads the last few runs / no live reader |
| `market_rewards` | 14 days | signal closed |
| `edge_evaluations` | 2 days | the PAUSED lane's own log; no training value, no new writes |
| closed-signal tables † | 1 day (full archive kept) | none — producing job unscheduled |

† `complete_set_depth_captures`, `convergence_panel`, `maker_exit_panel`, `whale_trades`,
`wallet_positions_daily`, `wallet_bet_calibration`, `synoptic_obs`. Static datasets whose verdicts are
written up in the canonical docs; re-import from the shards if a signal is ever reopened.

## 6. The weekly command (this is the new operational habit)

```bash
pnpm tsx scripts/ops/free-tier-sweep.ts            # dry-run — see the plan
pnpm tsx scripts/ops/free-tier-sweep.ts --execute  # the weekly sweep
```

Chains: raw-book archive → dump-gated raw-book prune → table archive + verified cold-tail prune → VACUUM →
**prints headroom vs the 500 MB ceiling**. Warns under 120 MB headroom (≈one week of capture growth),
shouts if over.

**Cadence: weekly — this is now load-bearing, not hygiene.** The windows above are steady-state only if the
sweep actually runs; skipping it lets `opening_captures` and `market_snapshots` grow past the ceiling, and an
over-limit project goes read-only (capture stops). Verified post-migration: every capture job green, the
Google panel writing hourly.
`--full` adds `VACUUM FULL` (returns space to the OS; takes exclusive locks — run it off-window, not while
capture is mid-write).

## 7. Operator steps to actually downgrade

1. **Verify size first** — `pnpm tsx scripts/ops/free-tier-sweep.ts` and confirm the database is comfortably
   under 500 MB. *Downgrading while over the limit risks the project being forced read-only.*
2. Supabase dashboard → Project Settings → Billing → change the plan to Free (billing is the operator's
   click; Claude does not touch it).
3. After the switch, watch the first day's `job_runs` for timeouts on Nano — the heavy jobs are
   `discover-markets` (~108s) and `opening-capture` (~25s). If they start failing, the next lever is
   cadence (they are already reduced), then `discover-markets` → 2×/day.
4. Free projects pause after ~7 days of *inactivity*; the hourly capture jobs keep this project active, so
   no action needed — but if you ever stop all crons, expect a pause.

## 8. Where the statistics record lives now

`scripts/research/out/` (gitignored, ~10 GB): `<table>-archive/part-YYYY-MM-DD.ndjson.gz` per table with a
verifying `_manifest.json`, plus `opening-captures-archive/` (the ONLY raw bid/ask archive, ~460k rows) and
the flattened price-path parquet (`market-history-flat*.parquet`, ~238M rows). This is now the primary
history; Supabase is a hot cache in front of it.

**Back it up.** It is on one disk, gitignored, and is now the only copy of the pruned history.
