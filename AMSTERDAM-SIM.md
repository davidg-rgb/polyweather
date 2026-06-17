# AMSTERDAM-SIM — the $10/day paper-trade head-to-head

> **What it is.** A live, falsifiable score of our Amsterdam nowcast against the real Polymarket
> market. Every day we place **$10 of fictitious money** on our model's predicted whole-°C bucket for
> EHAM at **four intraday lock hours — 13:00 / 14:00 / 15:00 / 16:00 local** — under identical rules,
> record the **market odds at placement**, and once the day resolves to the Wunderground Schiphol high
> we log **win/loss + net P&L**. The four arms race; the dashboard shows whose cumulative sum is
> highest. The operator's question — *"which hour is the best time to bet, after ~14 days?"* — answers
> itself from the data.
>
> **It is NOT trading.** The live-trading thesis is closed (`FORECASTING-RD.md` WO-5; market efficient).
> This is the analytics-pivot deliverable: **model-vs-market insight value made tangible**. The trading
> machinery (`packages/trading`, `bets`) stays dormant and untouched.

---

## 1. The finding — best time of day

From 14 resolved Amsterdam events with intraday coverage (the exact-bucket hit rate is robust over 182
days; the odds column is dense on only ~4 days so far — the live sim is what accrues `n`):

| Lock hour (local) | exact-bucket hit | market ask on our bucket | read |
|---|---|---|---|
| 13:00 | 50% | ~0.26 | coin-flip on fat odds (~3.8× if right) |
| 14:00 | 64% | ~0.52 | some accuracy, real odds |
| **15:00** | **86%** | **~0.82** | **confident sweet spot** — still a real payout |
| 16:00 | 100% | ~0.98 | near-certain, but the market has priced it (~no payout) |
| 19:00 | 100% | ~0.999 | pointless to bet |

**The structural truth:** the market re-prices our predicted bucket in lockstep with our accuracy — its
ask ≈ our hit rate at every hour (the WO-5 efficiency result, seen again). So the later you wait the
surer you are *and* the less the odds pay; expected value is ~0 at every hour before fees. **15:00 is the
headline operating point** (high confidence, odds still < 1), but the whole point of racing all four
arms forward is to *measure* whether any hour drifts positive — if the curve climbs, we found an edge;
if it hugs $0 (or bleeds via fees), we confirmed efficiency. Either outcome is a result, visualised.

### Predictor upgrade — forecast-aware nowcast (2026-06-17, migrations 0040 + 0041)

The running max is a hard **floor** on the day's high (it can only finish ≥ what's already happened),
but early in the day it under-predicts the peak. So at the **early arms (≤ 14:00)** we now lift the floor
to our own **lead-1 NWP forecast, corrected for its trailing observed bias** —
`basis = max(runningMax, forecast)` → `wuRound`. Late arms (15:00/16:00) keep the pure floor (already
86%/92% exact on the ~180-day raw curve; the forecast only adds noise there). The bias correction is the
mean (actual − forecast) over the **trailing 30 finalized days before the target** (walk-forward, no
look-ahead — the same lead-1 bias `dash_station_predictions` measures; a *trailing* window, not an
all-history mean, because Amsterdam's bias drifts seasonally ≈+0.4 °C spring → +0.83 °C June); **< 20
prior pairs ⇒ no correction**, fall back to the floor. Constants `AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS` /
`_MIN_PAIRS` live in `core/sim/amsterdam.ts` and are mirrored in the `0041` RPC + the backtest.

A **walk-forward backtest** (`scripts/amsterdam-nowcast-backtest.ts`) over **69 post-warmup test days**
(of ~180 finalized EHAM days; only 89 have a lead-1 forecast) measured, with a **McNemar exact test** on
the discordant flips:

| Arm | exact-hit | MAE | within-1°C | significance |
|---|---|---|---|---|
| 13:00 | 42% → **62%** (+20pp) | 0.81 → **0.41** (−50%) | 81% → **97%** | McNemar p = **0.024** ✓ |
| 14:00 | 57% → **65%** (+9pp) | 0.49 → **0.38** | 94% → **97%** | p = 0.33 (directional, not significant) |
| 15:00 / 16:00 | unchanged (hour-gated) | | | n/a |

**Honest read:** 13:00 is a *significant* improvement (n=69, p=0.024) but the evidence is **single-station
(EHAM) and single-season (spring/summer — the forecast record starts 2026-03-20, no autumn/winter data)**;
14:00 is **directional only**. Re-run the backtest and quote what it prints — don't trust a stale literal.
The negative-temperature `wuRound` path (assumption A-11) and the °F→°C branch are **unexercised** on this
dataset; revisit after cold-season pairs accrue.

Under WO-5 efficiency this sharpens **forecast skill** (the analytics deliverable), not necessarily PnL —
the market re-prices the better bucket in lockstep. It makes the model-vs-market scoreboard a fair fight.
The seam is `nowcastBasisC` in `core/sim/amsterdam.ts`; `forecastC = null` reproduces the original floor.

> **Live-leaderboard caveat (mixed regime).** Migrations 0040/0041 change only **future** placements —
> `amsterdam_sim_record` is `on conflict … do nothing`, so the ~5 bets/arm placed pre-0040 keep their old
> pure-floor prediction (`forecast_c = NULL`) and are **not** re-predicted. Because the lift is gated to
> ≤ 14:00, the **13:00/14:00** equity curves splice floor-only history with forecast-aware future, while
> 15:00/16:00 stay pure-floor throughout. It self-heals over ~2 weeks; until then the 13/14 arms are not a
> clean like-for-like vs 15/16. Pre-0040 rows are identifiable by `forecast_c IS NULL`. To make history
> consistent, delete the affected days and re-seed (`nowcastBasisC` reconstructs the call from stored
> runMax + forecast).

## 2. Architecture (one engine, two drivers, one surface)

```
packages/core/src/sim/amsterdam.ts   ← the ENGINE (pure, 20 tests). Single source of truth for:
  predictedNativeC / predictedBucketIdx   wuRound(runningMax) → ladder bucket (= how the market resolves)
  placeSimBet / gradeSimBet               stake/ask → shares ; win→shares·(1−ask), loss→−stake, net of fee
  planPlacements / planSettlements        the place/grade DECISIONS the two drivers share
  AMSTERDAM_SIM_ARM_HOURS = [13,14,15,16] · PRIMARY = 15 · COMPARE_DAYS = 14 · STAKE = $10

supabase/migrations/0039_amsterdam_paper_sim.sql
  amsterdam_paper_bets        one row per (target_date, arm_hour); RLS like every table
  amsterdam_sim_place_inputs  reconstructs each due arm from intraday_advances + market_snapshots
  amsterdam_sim_record        idempotent insert (ON CONFLICT DO NOTHING — odds lock at first placement)
  amsterdam_sim_grade_inputs  pending bets whose EHAM obs finalized + the winner bucket
  amsterdam_sim_settle        writes won/pnl/fee
  dash_amsterdam_sim          the operator read (operator_guard + authenticated)
  cron 'amsterdam-paper-trade' @ 15:30 UTC (= 17:30 local)

DRIVER 1 — supabase/functions/amsterdam-paper-trade   the daily cron tick (place today + grade pending)
DRIVER 2 — scripts/amsterdam-sim.ts                   backfill history + print the decision table + leaderboard

SURFACE  — apps/web /amsterdam   leaderboard cards · cumulative-P&L EquityChart (4 lines) · evidence
           table · latest call · bet log.  Loader getAmsterdamSim degrades to null if the RPC is absent.
```

**Why a daily reconstruction is faithful, not look-ahead:** both the running max (`intraday_advances`,
by local hour) and the odds (`market_snapshots`, timestamped, delta-deduped) are *persisted*. An arm's
bet at hour H is built strictly from data with `local_hour ≤ H` and snapshots `captured_at < end-of-H`,
so a bet placed by the 15:30-UTC cron records exactly the odds a live order at hour H would have seen.
The integration test proves this (the forward-fill ignores a poison snapshot printed after the arm hour).

## 3. Operate it

```bash
# Tests (all green): engine + the full place→grade→dash integration + forecast-lift + null-gate
pnpm test            # 721 passing
pnpm typecheck

# Re-run the backtest and quote what it PRINTS (don't trust a stale literal):
pnpm tsx scripts/amsterdam-nowcast-backtest.ts    # per-arm hit/MAE/within-1 + McNemar p

# Best-buy curve (AMSTERDAM-EV-MODEL.md Deliverable 2): edge(t)/EV(t) over the 5-min buy-time grid with CIs.
# Faithful best_ask curve is ~5 days (best_ask only exists since ~June 12); --price mid extends to ~14 days
# (optimistic, non-executable). The live arm h is grid point (h+1):00.
pnpm tsx scripts/amsterdam-best-buy.ts                       # faithful (executable best_ask)
pnpm tsx scripts/amsterdam-best-buy.ts --price mid          # extended mid-history (optimistic upper bound)

# Seed history + see the decision table and leaderboard (idempotent on the unique (date,arm) key — it
# extends history forward; it does NOT re-predict already-placed bets, see the mixed-regime caveat above)
pnpm tsx scripts/amsterdam-sim.ts                 # seed all simulable days + grade + print
pnpm tsx scripts/amsterdam-sim.ts --analyze-only  # print only, no writes
pnpm tsx scripts/amsterdam-sim.ts --from 2026-05-01 --to 2026-06-15
```

**Go-live (operator-gated — hosted DDL/deploys need per-action authorization):**

1. **Apply the migrations** `0039_amsterdam_paper_sim.sql`, then `0040_amsterdam_forecast_nowcast.sql`
   (adds `forecast_c` + rewrites place_inputs/record/dash), then `0041_amsterdam_nowcast_trailing_bias.sql`
   (trailing-window bias) to hosted — **all three are required** for the forecast-aware behaviour
   (`npx supabase db push`, the SQL editor, or authorize the MCP `apply_migration`).
2. **Deploy the Edge Function:**
   `npx supabase functions deploy amsterdam-paper-trade --use-api --no-verify-jwt`
   (the function self-authenticates via `x-cron-secret`, mirroring every other job). Required so the
   bundled `planPlacements` is the forecast-aware one; the bias correction itself lives in the 0040/0041 RPC.
3. **Seed the curve:** `pnpm tsx scripts/amsterdam-sim.ts` (then the 15:30-UTC cron carries it forward).

After that the `/amsterdam` page is live and self-updating. **To turn it off:** `select
cron.unschedule('amsterdam-paper-trade');` — the data and dashboard stay; no new bets are placed.

## 4. Honest caveats

- **Odds history is thin (~4 dense days).** The decision table's EV column is noisy until the live sim
  accrues `n`; the 182-day *accuracy* curve is robust, the *odds* side is what the race measures forward.
- **Efficiency prior.** Expect the curves to hug $0 (minus fees). A sustained climb on any arm is the
  signal worth chasing — and the hook for "continuously evolve the underlying prediction system": improve
  the nowcast, and this is the scoreboard that proves it moved.
- **Fees.** P&L is net of the Polymarket taker fee (`rate·p·(1−p)` per share, stored per bet) so the
  total is honest, not gross.
- **Truth timing.** A bet grades only once `observations.finalized_at` is set for EHAM that date
  (~1–2 days), matching the market's own resolution-revision window.

Companion docs: `AMSTERDAM-BUILDOUT.md` (the accuracy finding that seeded this), `FORECASTING-RD.md`
(why trading is closed), `BUILD-STATE.md`, `RUNBOOK.md`.
