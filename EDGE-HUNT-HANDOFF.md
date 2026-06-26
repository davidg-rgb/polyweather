# EDGE-HUNT-HANDOFF — "turn every stone" (2026-06-26)

> **Operator directive (2026-06-26):** *"Sharpen every potential edge we can find, evaluate best-of, run on
> any small breadcrumb, learn patterns from the best, gamble where we can — any means, turn every stone."*
>
> This is the single self-contained brief for a **fresh context window** to execute that directive. Read
> it top-to-bottom, then start at §7 (First actions). Canonical background: `FINDINGS.md` (the verdict —
> 10 falsified signals), `CROSS-VENUE-SPIKE.md` (the most recent KILL + the new measurement lens).

---

## 1. The honest frame (read this first — it sets the bar)

The live-trading thesis is **CLOSED: 10 of 10 signals falsified.** The market is efficient to everything
this system can currently see. That is the *measured* result, not pessimism. So "turn every stone" does
**not** mean re-running the corpses — that's theatre, and chasing a fresh "signal #11" out of thin air is
the project's named avoidance pattern. The productive form is exactly three things:

1. **Stones not yet turned** — levers with code/flags but no recorded verdict.
2. **Flipped triggers** — dead levers whose *out-of-market* reopening condition has since changed (the one
   that already fired: Polymarket **turned on funded weather rewards**).
3. **Gamble lanes** — where the only way to learn is to put small real money down (the $59 reward-probe).

Four lanes survive that filter (§3). Everything else stays dead with a published CI.

## 2. Where we are (state as of 2026-06-26)

- **Just shipped:** the 10th signal (cross-venue Kalshi↔Polymarket) → **KILL on a capacity wall**. The day-1
  panel was about to FALSE-PASS (winFrac 0.857 on a 24h-vol/OI depth **proxy**); a live both-venue order-book
  walk proved the cumulative synthetic fills at only **1–10 contracts** → winFrac 0/7. Gate hardened
  (migration 0064, function `cross-venue-capture` v5 live). Merged to `main` (PR #7). Suite **1483 green**.
- **THE STANDARD TOOL THIS PRODUCED — use it on every lane below:** the **"quoted vs executable" lens.** A
  quoted edge is not money until the *cumulative position fills at real touch depth on BOTH books*. The
  reusable harness is `scripts/research/cross-venue-verify.ts`; the pure primitive is `bindingExecutable()`
  in `packages/core/src/sim/cross-venue-arb.ts` (binding = min resting size across every leg that must fill).
  **Every "edge" in this hunt must pass this lens, not a volume proxy.**
- Prod ref `lenysiqxihsmxljvyybt`. Crons live. The trading rail (`packages/trading`, `bets`) stays **DORMANT**.

## 3. The four lanes (work packages)

Each lane lists: the open question · exact files · next action · the **pre-registered kill-gate** (define it
BEFORE measuring — WO-5 discipline, never fit to result) · capital/operator gate · prior.

### Lane A — Reward-probe: the $59 real gamble (the cleanest "gamble where we can")

- **Open question / contradiction.** Three findings disagree and only real money settles it:
  - REC-4 **fired**: Polymarket turned on funded weather liquidity rewards (395/396 markets) — a genuine
    out-of-market change (`rewards-now-funded-on-weather` memory; `MAKER-REBATE-HANDOFF.md` §9).
  - REC-10 **backtest**: two-sided maker fill cost ≈ 8× the reward → **−41%/day** (`REWARD-INVENTORY-BACKTEST.md`).
  - Probe **pilot prediction**: **+$172/day** net on the live universe (`reward-probe.ts`).
  A backtest and a model are a mile apart. A 24h live probe resolves it.
- **Files.** `scripts/research/reward-probe.ts` (plan/reconcile); `supabase/functions/reward-snapshot/`
  (Phase-A logger, **deployed**, `market_rewards` cron every 20 min — the funded-market feed is warm);
  stale sheet `scripts/research/out/reward-probe-order-sheet.md` (dated Jun-24, **markets expired**).
  Runbook: `REWARD-FARMING-HANDOFF.md` §10–§11.
- **Next action.** (1) Agent **regenerates** a fresh sheet: `pnpm tsx scripts/research/reward-probe.ts --mode plan`
  (≈$59, 2–3 funded markets, ~24–36h to resolution). (2) **Operator places** the resting two-sided maker
  orders on Polymarket (Sweden reverse-solicitation; David has access). **Agents never trade.** (3) After
  24h: record actual USDC reward → `out/reward-probe-actuals.json`, run `--mode reconcile`.
- **Pre-registered kill-gate.** CONFIRM if realized net ≥ +0%/day (reward ≥ measured fill+inventory cost,
  CI-aware) → the funded-rewards income path is real → build the maker bot (operator flips the rail).
  OVER-ADVERTISED if realized net < 0 (REC-10 wins) → farming is **truly** closed, log the 11th falsification.
- **Capital:** YES (~$59, operator-placed). **Prior:** genuinely open — REC-4 (funded) vs REC-10 (cost wall)
  is an honest coin-flip the probe exists to settle.

### Lane B — negRisk mint-and-sell (the un-measured structural dual)

- **Open question.** The complete-set arb (8th signal) only tested the **underround** (buy-all-YES, taker-fee-
  walled). The **overround** dual was framed as "buy all NO" (also taker-walled) — but the textbook harvest is
  to **mint** a complete YES set for $1 via the `NegRiskAdapter` and **sell each leg into its bid as a MAKER**
  (a resting sell pays no taker fee). Never measured. `COMPLETE-SET-ARB-HANDOFF.md` **Move 5** (~L70–73).
- **Files.** Engine `packages/core/src/sim/complete-set-arb.ts`; live scan `scripts/research/complete-set-arb-live.ts`
  (the mirror to build from); the depth lens from `cross-venue-verify.ts`.
- **Next action (no capital — read-only measurement).** Verify: (a) the real `NegRiskAdapter` split/convert
  path + any gas/mechanics cost; (b) whether a resting sell genuinely avoids the taker fee; (c) **run the
  sum-of-bids harvest through the executable-depth lens** — does Σbid>1 actually fill at size, or is it
  tail-thin like cross-venue? Build a sibling scan + (if it survives) a forward depth-capture.
- **Pre-registered kill-gate.** PASS if, after the mint cost + gas + the maker-route adverse-selection model,
  a complete-set mint-and-sell nets > 0 **at executable depth (binding fill ≥ MIN_EXEC_SIZE)** on ≥X% of
  observed instants. Else KILL — same fee/depth wall as the buy side.
- **Capital:** none to measure; real capital only if it passes (operator-gated). **Prior:** low (likely the
  same maker adverse-selection wall), but a real un-turned stone.

### Lane C — In-play / be-the-fast-actor (the real frontier + "learn from the best")

- **Open question.** The named sports specialists (mintblade / fishalive / frostrizz) are the **only live-edge
  signature this project ever isolated** — 98.6% same-second book sweeps (`SPORTS-TRADERS.md` §4, §7).
  *Copying* them FAILED (survivorship + a non-executable book-sweep mark). *Being* the fast actor on markets
  they haven't swept yet was **never tested.** Highest ceiling, highest engineering bar.
- **Files / data.** `scripts/research/sports-traders-scan.ts` + `packages/core/src/sim/sports-copytrade.ts`;
  the Polymarket data-api SPORTS leaderboard (`category=SPORTS`); `WHALE-WATCH.md` + the
  `whale-insider-scan` / `sports-copytrade-scan` memory entries (the edge-is-in-sports finding).
- **Next action — TWO bounded, no-capital parts:**
  - **C1 (learn from the best).** Dissect the specialists' *actual* fills: sub-sport mix, entry-odds
    histogram, burst/sweep %, the precise event→fill latency, and which markets they DON'T touch. Output a
    mechanism fingerprint, not a copy list.
  - **C2 (scope the spike).** Define a bounded measurement: **can we detect a stale in-play book** (a quote
    that hasn't updated to a just-occurred game event) **before it corrects**, on markets the bots haven't
    swept — and is the staleness window > our realistic reaction latency? **Spike FIRST; do NOT fund any
    real-time build without the spike passing.**
- **Pre-registered kill-gate (for the spike).** PASS only if a detectable staleness window exists with
  positive expectancy after fees AND it is wider than our measured reaction latency on ≥N independent
  in-play events, with a CI excluding 0. Else: latency-arb is out of reach from where we sit — KILL.
- **Capital:** none for C1/C2 (measurement). A live build is a separate, spike-gated, operator-funded decision.
  **Prior:** low and effort-heavy — but it is the one frontier with a *live* edge signature, so it earns a spike.

### Lane D — Retro executable-depth re-check (free completeness pass)

- **Open question.** The 8th signal killed complete-set arb on a **fee** model ("0/107 open ladders clear the
  fee"). Now that we have a true both-book depth walker, re-check: of the historical instants that *did* clear
  the fee, do any clear it **at executable depth**? Confirms the fee wall isn't masking/masked-by a depth wall.
- **Files.** `scripts/research/complete-set-arb-live.ts` + `cross-venue-verify.ts` depth pattern +
  `bindingExecutable()`.
- **Next action.** Add the executable-depth walk to the complete-set live scan; re-run over the captured
  depth panel (migration 0060, `arb-depth-capture` cron). Cheap.
- **Pre-registered kill-gate.** If any fee-cleared instant ALSO clears at binding depth ≥ MIN_EXEC_SIZE →
  reopen Move 1; else the KILL stands, now confirmed on both fee AND depth.
- **Capital:** none. **Prior:** very low (expected to re-confirm KILL) — but it closes the loop honestly.

## 4. Execution — the multi-agent sweep (how the fresh session runs it)

Lanes **B, C1, C2, D are read-only measurement** → run them as a **Workflow** (parallel lanes, each producing
a structured verdict, each **adversarially verified** by an independent skeptic agent before it counts — the
discipline that has killed multiple plausible-but-wrong findings here). Shape:

- **Phase 1 — Measure (parallel):** one agent per lane (B, C1, C2, D) → structured `{lane, finding, numbers, kill-gate result}`.
- **Phase 2 — Verify (per finding):** for any lane that reads non-dead, ≥2 skeptic agents try to **refute** it
  (default to refuted if uncertain) + a check through the executable-depth lens. A finding survives only on majority-survive.
- **Phase 3 — Synthesize:** rank surviving lanes by (residual-edge-probability × executability × −capital-required),
  write verdicts into `FINDINGS.md` + the relevant `*-HANDOFF.md`.

**Lane A (reward-probe) runs on its own operator-gated track** (regenerate sheet → David places → 24h → reconcile),
because it needs real capital and a 24h clock, not an agent.

## 5. Hard rules (non-negotiable — these are why prior findings held up)

1. **Agents never trade.** Capital is operator-placed; the rail stays DORMANT until David explicitly flips it per-lever.
2. **Pre-register every kill-gate before measuring** (above). Never tune a gate to a result — WO-5 discipline.
3. **The executable-depth lens applies to every candidate.** Quoted ≠ capturable. A volume/OI proxy is not depth.
4. **Adversarially verify every non-dead finding** before recording it. Default to refuted under uncertainty.
5. **No signal #11 fishing.** Only these four lanes + any genuinely NEW out-of-market trigger. If a lane dies,
   it dies — log it; do not invent a fifth to feel productive.

## 6. File / command index

| Lane | Run | Key files |
|---|---|---|
| A | `pnpm tsx scripts/research/reward-probe.ts --mode plan` → (place) → `--mode reconcile` | `reward-probe.ts`, `supabase/functions/reward-snapshot/`, `out/reward-probe-*`, `REWARD-FARMING-HANDOFF.md §10–11` |
| B | build sibling of `complete-set-arb-live.ts` | `core/sim/complete-set-arb.ts`, `COMPLETE-SET-ARB-HANDOFF.md` Move 5 |
| C | `sports-traders-scan.ts` + data-api SPORTS | `core/sim/sports-copytrade.ts`, `SPORTS-TRADERS.md §7`, `WHALE-WATCH.md` |
| D | extend `complete-set-arb-live.ts` with the depth walk | `cross-venue-verify.ts`, `bindingExecutable()` in `core/sim/cross-venue-arb.ts` |
| lens | `pnpm tsx scripts/research/cross-venue-verify.ts --rounds 3` | the reference both-book depth probe |

Always: `pnpm test` + `pnpm typecheck` green before any commit; one feature branch; never push/PR without the operator asking.

## 7. First actions (fresh session, in order)

1. Read `FINDINGS.md` (the verdict) + `CROSS-VENUE-SPIKE.md` §"The capacity wall" (the lens you'll reuse).
2. **Lane A now:** regenerate the reward-probe order sheet (`--mode plan`); hand David the ~$59 sheet to place; set the 24h reconcile reminder.
3. **Launch the sweep** (Workflow) over Lanes B + C1 + C2 + D per §4, with the §3 kill-gates pre-registered.
4. Synthesize survivors → `FINDINGS.md`/handoffs; KILL the rest with numbers. Keep the rail DORMANT.

> Reality check to carry in: the base rate here is KILL. The win is not finding treasure — it's proving,
> honestly and at executable depth, whether each remaining stone hides any. If all four die, that is a
> complete, publishable result: this market is efficient, measured eleven ways.
