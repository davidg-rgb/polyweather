# POST-FABLE HANDOFF — what accrues, what to check, how to adjudicate

> Written 2026-07-03 (the Fable-window fast-track sprint, `FASTTRACK-PLAN.md`). Audience: the operator
> and any future session on any model. Everything here is deterministic reads + one pre-registered
> judgment call that the code makes for you. **The standing boundary is unchanged: no capital before a
> frozen forward paper PASS + an explicit operator decision; Claude never trades or touches keys.**

## The one thing that matters: the forward maker-exit paper gate

The 12th signal's sole surviving form (maker entry at the first enterable tick, maker take-profit exit)
backtests **PASS-but-marginal** on 21 days (`MAKER-EXIT-SIM.md` top banner: +6.8 % / +$535,
CI [+0.25 %, +11.9 %]; day-block robust; LODO fragile → *days* are the scarce resource). The **live
forward paper loop is the gate of record** — it accrues real-book evidence daily, for free, via
`opening-capture` (`*/10`) → `maker-exit-panel` (hourly `:35`) → `/maker-exit` + `bot_gate_snapshot`.

**Sufficiency bars (frozen):** ≥40 realized markets · ≥6 cities · ≥7 distinct target days. As of
2026-07-03 15:20Z the panel sees 43–58 markets *in scope* per tick (the 0077 fix unlocked the starved
fetch path) but **realized** counts accrue only as markets resolve — expect sufficiency ~2026-07-08→12.

## How to adjudicate (any model can do this)

1. Read the gate: `select * from public.dash_maker_exit();` (or open `/maker-exit` on prod). The
   `gate` object carries `label` — `openingVerdict` computes it; nobody re-derives statistics by hand.
2. `label = 'PASS'` → **stop; operator decision.** A frozen forward PASS is the *precondition* for the
   §9R capital conversation (wallet scope, city allowlist, `GO-LIVE-CHECKLIST-OPENING.md`) — it does
   not itself authorize anything.
3. `label = 'KILL'` → the 12th signal joins the other eleven; update `FINDINGS.md` + `CLAUDE.md`
   header; rail back to fully DORMANT. The analytics product (the actual pivot) is unaffected.
4. `label = 'INSUFFICIENT_DATA'` → do nothing; it accrues by itself. The three measured assumptions to
   glance at meanwhile (headlined on `/maker-exit`): **maker-fill rate** (backtest 49 % — if the live
   number craters toward the early-live 0.30, that is the most likely KILL path), **realized rebate**,
   **days accrued**.

## Steady-state configuration (as left on 2026-07-03; do not "fix" without evidence)

| Knob | Value | Why |
|---|---|---|
| `opening-capture` cron | `*/10 * * * *` | **Permanent** (operator-approved): flat-open is dead (Phase-0.5 NO-GO), `*/10` halves TOAST growth; the 20-min replay loses nothing |
| `maker-exit-panel` cron | `35 * * * *` (hourly) | Consecutive heavy ticks still cycle the buffer cache (two-probe evidence, WS1-ROLLOUT outcome block). Revisit `5,20,35,50` after ~07-17 (the */2-era rows age out of the 21-day window) or on an instance upsize; if restored, set `bot.tickStaleMin.paper` back to `'45'` |
| `convergence-panel` cron (job 26) | `*/15 * * * *`, active | v7 bounded pool + 0077: first tick 23.2 s / 0 errors |
| `bot.tickStaleMin.paper` | `'180'` | Matches the hourly cadence (3×) — deadman pages the operator on real gate staleness |
| `bot.consensusSource` | `calibrated` | The validated seed (73.9 % vs 52.8 % selector) |
| Slack | paused except WHALE_TRADE + deadman kinds | Deadmen page correctly (proven 07-03) |

## Maintenance that becomes due later

- **~late July:** `scripts/ops/prune-opening-captures.ts` starts finding candidates (events resolved
  ≥25 d). Dry-run → sanity → `--execute` → `vacuum analyze public.opening_captures`. The archive
  pre-flight refuses to delete anything not held in `scripts/research/out/market-history/`.
- **Deferred once:** a `VACUUM ANALYZE public.opening_captures` in a quiet window (was skipped 07-03 —
  stats were sane; the disk was the floor).
- **If a panel tick ever wedges again:** the 0078 janitor self-heals the row at the job's next claim;
  the deadmen page on real staleness. The incident playbook that worked twice on 07-03: throttle
  capture, pause panels, let the IO budget refill, re-enable staggered.

## The signal backlog — CLOSED 2026-07-03 evening (every item adjudicated vs its pre-registered gate)

`SIGNAL-BACKLOG.md` carries the full verdict blocks; `FINDINGS.md` the one-row records. Scorecard:
- **1b reward-stacking — gate-PASS** (ciLow +0.25 %→+2.38 % at the 0.05 share floor, linear in share).
  THE caveat: pool share is unmeasured. **Follow-on (operator-greenlit 07-03): forward reward-eligibility
  instrumentation on `/maker-exit` — built + staged, deploy rides the next operator bundle.**
- **3 disagreement-regime efficiency — NO-PASS** (naive PASS revoked: 3 weather-day clusters, permutation
  false-PASS 17.3 %). Re-open at ≥10 distinct Q4-carrying weather-days.
- **KILLs:** 2 (null) · 4 (sign-reversed — market OVERPRICES extreme-day tails) · 5 (basket dilutes) ·
  6 (well-powered null, n=568/44 cities) · 7 · 9 · 11 (nonlinear-ML residual: correction harmful OOS).
- **10 — INSUFFICIENT_DATA structural** (10Z/22Z rows begin 06-13; >30 d snapshots are 4/day). Re-open =
  ≥30 d accrued pairs + a forward ask-capture design.
- **8 stays gated** on a live forward PASS (capital-sizing refinement, not a signal).
The closing rule stands: nothing here outranks letting the forward gate accrue.

## Where everything is

- Sprint record: `FASTTRACK-PLAN.md` (workstream statuses) · rollout evidence: `docs/ops/WS1-ROLLOUT.md`
  (outcome block) · canonical ops log: `BUILD-STATE.md` (Active Phase, 07-03 addenda)
- Verdict docs: `FINDINGS.md` (start here) · `MAKER-EXIT-SIM.md` (the surviving lever) ·
  `CONVERGENCE-TUNING.md` / `FLUCTUATION-TAKER.md` (the taker KILLs)
- Local commits not pushed as of writing: `52f115d` (WS-1) · `6c053f1` (WS-5) · `c0892ec` (runbook) —
  plus the parallel agent's uncommitted signal-backlog work in the main tree. Push is the operator's call.
