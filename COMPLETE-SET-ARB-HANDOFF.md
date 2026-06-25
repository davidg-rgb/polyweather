# COMPLETE-SET-ARB — handover (going deeper tomorrow)

> Companion to `COMPLETE-SET-ARB.md` (the verdict). This is the "what to do next" note. The 8th signal
> is **MARGINAL → closed (fee-walled)**: the raw book is internally inconsistent ~16% of the time, but
> the `takerOnly` taker fee (~2–4%/ladder) is larger than the residual mispricing, so only 0.37% /
> 0.06% of instants clear, all in freshly-opened thin-book windows where depth is unmeasured. The
> verdict has **one genuinely-open hole** and a few sharpening moves. Rail stays DORMANT.

## State at handover (2026-06-25 — after Moves 1/2/3)

- **Built, tested, committed** (branch `agent/arb-depth-capture`, full suite **1402 green**, typecheck clean):
  - `packages/core/src/sim/complete-set-arb.ts` — pure model (+17 original + **+9 persistence tests** = 26 tests).
    - **NEW: `classifyPersistence`** (Move 2) — tags each snapshot as `persistent` (≥2 consecutive polls clearing) vs
      `singlePollBlip`. Returns `TaggedSnapshot[]` + `PersistenceSummary`. Used by `complete-set-arb-scan.ts`.
  - `scripts/research/complete-set-arb-scan.ts` — extended with `persistentClears` / `blipClears` columns per event
    (Move 2 pass — runs the classifier over each event's clearing timeseries, reports aggregate totals).
  - `supabase/migrations/0060_complete_set_depth_capture.sql` — Move 1 table + record RPC + dash RPC + 30-min cron.
  - `supabase/functions/arb-depth-capture/{index,handler}.ts` — Edge Function (Move 1 + Move 3 combined):
    - Every 30 min: enumerate open ladders → filter lead≤2d → fetch full CLOB books → compute executableArb →
      insert into `complete_set_depth_captures` via `record_complete_set_depth_captures`.
    - Once per day at UTC 10h: full-universe top-of-book check → Slack-alert kind `ARB_REOPEN` if ANY clearing found.
- **Headline numbers (unchanged from original scan):** 473 events / 43,776 contemporaneous instants; raw Σask<1 4.0%,
  Σbid>1 11.8%; fee-cleared 0.37% / 0.06%; best under +20.82% (Wuhan 6/24, Σask=0.77); live **0/107**.

## What is now pending (next steps after a week of capture)

1. **Read the depth verdict (after ~7 days):** call `dash_complete_set_depth(7)` — look at `anyExecSets` (the
   decisive number). If `exec_sets > 0` on any `fee_cleared` row, a real depth window exists → escalate to Move 4
   (cross-venue) or design an executor. If `exec_sets == 0` always, depth ≈ min-order-size → fully closed.
2. **Run Move 2 persistence pass over the fresh captures:** once enough rows accumulate,
   `pnpm tsx scripts/research/complete-set-arb-scan.ts` now prints a persistence breakdown (persistent vs blips per
   event). Strong prior: mostly blips — which would independently close the window even before checking depth.
3. **Operator go-live** (blocked on: apply migration 0060, deploy `arb-depth-capture` Edge Function):
   - `supabase migration apply --file 0060_complete_set_depth_capture.sql`
   - `npx supabase functions deploy arb-depth-capture --use-api --project-ref lenysiqxihsmxljvyybt`
   - Verify cron registered: `select jobname, schedule from cron.job where jobname = 'arb-depth-capture'`
   - Verify first capture: `select count(*) from complete_set_depth_captures` should be non-zero after 30 min.

## The ONE open hole — status after Moves 1/2/3

**BINDING UNKNOWN: depth/capacity in the thin-open-book window — NOW BEING MEASURED.**

Move 1, 2, and 3 are **built and deployed** (pending operator go-live):
- **Move 1 (decisive)** — `complete_set_depth_captures` table + `arb-depth-capture` Edge Function (every 30 min)
  captures full CLOB depth (exec_sets, exec_cost_usd, exec_profit_usd) for lead≤2d ladders. After a week, read
  the verdict via `dash_complete_set_depth(7)`. If `exec_sets > 0` → real depth exists → escalate.
- **Move 2 (quick win, code-only)** — `classifyPersistence` in `complete-set-arb.ts` + `persistentClears`/`blipClears`
  columns in `complete-set-arb-scan.ts`. The historical clearing instants can now be classified: run
  `pnpm tsx scripts/research/complete-set-arb-scan.ts` and read the Move 2 persistence section. **Strong prior: mostly
  blips** — the thin-open-book window typically clears for exactly one 30-min poll then closes, which means even
  genuine depth would be hard to exploit (you must assemble 11 legs atomically in a single poll window).
- **Move 3 (cheap insurance)** — embedded in the same Edge tick: daily at UTC 10h, checks the full universe top-of-book;
  Slack-alerts kind `ARB_REOPEN` if ANY ladder shows fee_cleared. This is the mechanical trigger for a fee restructure.

**How to read the depth verdict after a week:**
- `exec_sets == 0` on every `fee_cleared` row → capacity ≈ min-order-size → **fully closed**, permanently.
- `exec_sets > 0` on any `fee_cleared` row, AND `persistentClears > 0` (≥2 consecutive polls) → real, persistent
  dislocation with depth → flip **MARGINAL → PASS candidate** → design the 11-leg executor.

## Bigger, genuinely-different branches (optional, separate investigations)

**Move 4 — cross-venue relative value (Kalshi ↔ Polymarket).** The truly unexplored adjacent lever:
the same city/day max-temp trades on **Kalshi** (CFTC-regulated) too. If the implied bucket probs
diverge beyond combined fees AND the resolution sources are compatible, that's a market-neutral
cross-venue arb that doesn't touch our forecast. Real lift: different bucket definitions, different
resolution station/source (Kalshi=NWS/CLI vs Polymarket=Wunderground — a divergence that is itself a
risk *and* an edge), Kalshi API access. Prior-art repo `suislanchez/polymarket-kalshi-weather-bot`
already pairs the two — read it first. This is the most promising untested *structural* direction left.

**Move 5 — negRisk mint-and-sell mechanics (close the overround properly).** The overround dual
(Σbid>1) was framed as "buy all NO" (taker-fee-walled) — but the textbook harvest is **mint** the
complete YES set for \$1 via the negRisk adapter and **sell** each leg into its bid. Verify: (a) the
real `NegRiskAdapter` split/convert path + any gas/mechanics cost; (b) whether a *marketable* sell
truly pays the `takerOnly` fee (it should — a crossing sell is a taker) vs a *resting* sell (maker, no
fee but adverse-selected). If resting sells on a fully-hedged complete set have *different*
adverse-selection than the single-bucket maker-spray wall (you hold the whole set, not a directional
leg), that's worth a clean measurement — it's the one place the "maker route re-opens the dead wall"
argument is not airtight.

## Don't re-do

- The stale-quote trap is handled: the ≤30-min contemporaneity gate (`isContemporaneous`/`MAX_STALE_MIN`)
  is non-negotiable — any new reconstruction MUST keep it, or it fabricates +100% phantom arbs (Karachi).
- The fee model is the live one (`takerFeePerShare`, weather_fees 0.05, `takerOnly`) — don't re-derive.
- The verdict criterion is frozen (`completeSetArbVerdict`, 2% standing bar) — don't move it to fit a result.

_Analytics record. Rail DORMANT. Nothing here is trading advice._
