# Supabase compute audit — 2026-07-08 (refresh of `COMPUTE-AUDIT-2026-07-07.md`)

Executed inside the buying-builds day-loop (WS-D). The 07-07 audit unscheduled 10 dead-signal/closed-gate
crons + reclaimed `opening_captures` 1.37 GB → 75 MB after the 12th signal was recorded KILL. This refresh
re-measures the drifted fleet and asks: is the compute problem still solved, and what's left to do?

## Headline: the crisis is RESOLVED; the fleet is healthy. No firefight needed.

Measured live 2026-07-08 ~14:00Z:

- **Cron fleet: 21 active jobs, 0 failures in the last 24h.** DB-side cron time is trivial (~200s/day total;
  pg_cron only times the async HTTP-POST invocation — the edge runtime does the real work off-DB). The heaviest
  DB-side job is the daily `snapshot-downsample` (107s, once/day). Nothing is wedged or timing out.
- **`opening_captures` is bounded, not a runaway:** 97 MB / 22,899 rows, +5,073 rows/24h in, held flat by the
  daily `opening-captures-prune` (2-day resolved-window retention). It is NOT re-growing toward the 1.2 GB TOAST
  trap that drove the 07-06/07 saturation — that trap was the (now-unscheduled) 45-city `convergence-panel` /
  `maker-exit-panel` detoasting the fat `buckets` jsonb every tick. **Those panels are off; the acute cause is gone.**
- **The Micro instance is not saturated.** The 07-07 cull did the heavy lifting and it has held.

## Storage leaders (persistent tables)

| Table | Size | Note |
|---|---|---|
| `market_snapshots` | **346 MB** | poll-markets books + the **v1 `depth` column** (depth-capture v2's `0089` DROPs it — a real reclaim) |
| `forecast_snapshots` | 279 MB | forecasting core — **keep** |
| `bucket_probabilities` | 262 MB | the house distributions (`mu_native`/`probs`) — forecasting core, **keep** |
| `market_rewards` | **140 MB** | dead-signal (rewards closed, REC-8) — **drop/archive candidate** (operator-gated; destructive) |
| `opening_captures` | 97 MB | held by prune (see above) |

## What to do (ranked)

1. **★ Land depth-capture v2 — the one real forward win (operator-gated deploy; bundle below).** It is the
   *preventive* fix for the exact regrowth trap: it moves the live `google-paper-panel` off `opening_captures`
   (`google_paper_inputs` TOAST reads) onto a purpose-built `market_depth` table, AND `0089` drops the
   `market_snapshots.depth` v1 column (reclaims part of the 346 MB). Built + tested (2994 green) + committed, NOT
   deployed. It self-gates (stays on `opening_captures` until `market_depth` ≥ 200 rows) and has an instant
   config-flip rollback. **Deploy sequence = `DEPTH-CAPTURE-V2-HANDOFF.md` §6** (verified current 2026-07-08):
   - Apply `0089` **then** `0088` (via MCP `apply_migration`).
   - Redeploy the `discover-markets` **and** `depth-capture` edge functions.
   - Let `market_depth` accrue ≥1 day → verify (`exec_ask` ∈ [0,1], `gamma_created_at` populated, no
     `statement_timeout`, job stats `capped/budgetHit/writeErrors = 0`) → parity-check (the fresh cohort will be
     honestly SMALLER — §6.3 caveat) → auto-cutover at ~200 rows.
   - Rollback (instant, no migration): `update config set value='999999999' where key='bot.depthCutoverMinRows'`.
2. **Optional housekeeping (operator-gated, low value — storage not compute):**
   - Drop/archive `market_rewards` (140 MB, dead rewards signal). Destructive → stage, don't execute.
   - Remove the 8 deployed-but-unscheduled dead-signal edge functions (`execute-bet`, `sharp-wallet-track`,
     `reward-snapshot`, `sharps-snapshot`, `arb-depth-capture`, `cross-venue-capture`, `convergence-panel`,
     `maker-exit-panel`). **$0 at rest** — pure tidiness; skip unless you want the console clean.
3. **No reversible cron pause is warranted right now.** Unlike 07-07, there is no dead-signal cron still
   scheduled to shed — every one of the 21 jobs feeds the forecasting core, a live deliverable panel, or
   maintenance. So this cycle executed **no** live change (correct: don't manufacture savings that degrade a
   prioritized build).

## Open question for the operator (not decided here)

Post-v2, `google-paper-panel` no longer reads `opening_captures`. The v2 handoff §6.5 says **keep
`opening-capture` anyway** — "convergence/maker-exit read `opening_captures` for `houseProb`." But those signals
are DEAD (unscheduled, gate KILLED 07-07). So **if** you accept the dormant panels will never run without a new
scoped exception, `opening-capture` (*/5) + its `opening_captures` writes could eventually be paused too,
eliminating the regrowth entirely (a further compute/storage win). The handoff deliberately keeps it for now;
flagging it as a lever, not a recommendation.

## Net

The 07-07 audit solved the crisis and it has held. The only forward compute action worth doing is landing
depth-capture v2 (preventive + a `market_snapshots` reclaim); everything else is optional tidiness. **19→21
jobs, all healthy; no capital, no keys, no destructive change made this cycle.**
