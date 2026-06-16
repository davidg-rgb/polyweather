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
# Tests (all green; 28 new): engine + the full place→grade→dash integration
pnpm test            # 710 passing
pnpm typecheck

# Seed history + see the decision table and leaderboard (idempotent; safe to re-run any time)
pnpm tsx scripts/amsterdam-sim.ts                 # seed all simulable days + grade + print
pnpm tsx scripts/amsterdam-sim.ts --analyze-only  # print only, no writes
pnpm tsx scripts/amsterdam-sim.ts --from 2026-05-01 --to 2026-06-15
```

**Go-live (operator-gated — hosted DDL/deploys need per-action authorization):**

1. **Apply the migration** `supabase/migrations/0039_amsterdam_paper_sim.sql` to hosted
   (`npx supabase db push`, the Supabase SQL editor, or authorize the MCP `apply_migration`).
2. **Deploy the Edge Function:**
   `npx supabase functions deploy amsterdam-paper-trade --use-api --no-verify-jwt`
   (the function self-authenticates via `x-cron-secret`, mirroring every other job).
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
