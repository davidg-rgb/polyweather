# Gate-day playbook — the forward maker-exit paper gate

> Written 2026-07-03 (Fable-window fast-track sprint). Purpose: when `label` renders on
> `select * from public.dash_maker_exit();` (or `/maker-exit`), the response is paste-and-go, not
> drafted cold. **`POST-FABLE-HANDOFF.md` §"How to adjudicate" is the authoritative meaning of each
> label — this doc does not override it, it pre-drafts the artifacts that section tells you to
> produce.** Read that section first if there is any conflict.

## Where things stand as this was written

`FASTTRACK-PLAN.md` (C22 cycle log): **INSUFFICIENT — 73 markets / 34 cities / 6 of 7 distinct days**
(`n_distinct_days` renders the label at ≥7 per `POST-FABLE-HANDOFF.md` §"The one thing that
matters"). `makerFillRate` **0.082** vs the backtest's **0.49** (`MAKER-EXIT-SIM.md` "Ledger
decomposition" — 187/382 realized exits were maker take-profits in the backtest). `realizedRebateUsd`
**0**. Total net **−$160.05**. `qualifyingTickFrac` (the 1b reward-stacking bound, `docs/ops/REWARD-
INSTR-ROLLOUT.md`) has read **0** at every tick since deploy. The 7th day (07-03) is expected to grade
within ~24h of this writing.

---

## Package 1 — KILL

**Pre-authorized to record without re-asking.** `FASTTRACK-PLAN.md` C21 records the operator's blanket
approval ("approval for any decision — move forward — write the loop prompt for next build") and the
explicit pre-authorization scope written into the v5 loop prompt: *"KILL → RECORD it fully without
re-asking (FINDINGS.md 12th-signal closing row with the realized numbers; CLAUDE.md banner line;
SIGNAL-BACKLOG re-open criteria; commit+push as a follow-up)."* Execute all four sub-items below in one
pass; do not stop to ask.

### 1a. FINDINGS.md — the 12th-signal closing text

Two edits to `FINDINGS.md`, matching the existing running-log style (the "↳ NEW {date} — …" append
blocks under "Bottom line, up front", most recently the 2026-07-03 entries at `FINDINGS.md:239–273`).

**Append a new closing block** immediately after the 2026-07-03 (later) block (`FINDINGS.md:262–273`):

```
> **↳ NEW {gate_date} — the live forward maker-exit paper gate KILLs; the 12th signal joins the other
> eleven. Investigation CLOSED — twelve of twelve signals now dead.** The gate of record
> (`POST-FABLE-HANDOFF.md`, `dash_maker_exit()`) rendered on {n_markets} realized markets / {n_cities}
> cities / {n_days} distinct days: mean net **{mean_net}%**, 95% CI **[{ci_low}%, {ci_high}%]**
> (ciLow ≤ 0), `makerFillRate` **{maker_fill_rate}** (backtest 49.0% — {fill_rate_note}),
> `realizedRebateUsd` **{realized_rebate}**, total net **${total_net}**. The backtest's marginal PASS
> (+6.7–6.9%, CI [+0.3%,+12.1%], `MAKER-EXIT-SIM.md`) did not replicate forward — {mechanism_note, e.g.
> "the maker-fill rate collapsed from the modeled 49% to {maker_fill_rate}, starving the one leg that
> carried the entire backtest edge (Ledger decomposition, MAKER-EXIT-SIM.md): with most exits forced to
> the taker time-stop/stop-loss, the structural −$1,028 drag from those two legs was never offset."}.
> Rail **DORMANT**, unchanged from every prior signal. No capital was risked (`POST-FABLE-HANDOFF.md`
> boundary). SIGNAL-BACKLOG.md carries the re-open criteria (§1b below).
```

**Update the summary table row** (`FINDINGS.md:49`, the "Opening convergence…" row) — replace the
verdict cell (currently "Measured forward by `opening-resolution-score.ts`; verdict pending resolved
markets…") with:

```
**KILL, forward-confirmed 2026-{gate_date}** — the maker-exit variant (the sole surviving form after
the Phase-0.5 flat-open NO-GO, `FINDINGS.md` 2026-07-03) backtested a marginal PASS but KILLed on the
live forward gate: {n_markets} markets / {n_cities} cities / {n_days} days, mean net {mean_net}%, CI
[{ci_low}%, {ci_high}%], makerFillRate {maker_fill_rate} vs backtest 49.0%. Twelfth and final signal
closed.
```

Also update the "Bottom line, up front" prose (`FINDINGS.md:12–33`) — the opening paragraph currently
reads "**No.** … on every distinct lever we could test…" with the 12th signal carved out as the one
live exception (`FINDINGS.md:20–33`). Fold the exception back into the main verdict: strike or amend
the "One live exception…" paragraph so the bottom line reads as unconditional across all twelve
signals, and add one line to "Where each finding lives" (`FINDINGS.md:453–483`) pointing at the new
closing block.

### 1b. CLAUDE.md — the pivot-block banner line

One `↳ UPDATE` line appended to the pivot block at the top of `CLAUDE.md` (project root), matching the
existing banner's style and voice (see the 2026-06-30/07-03 entries already there — terse, numbers-
first, states the rail status and the boundary each time):

```
> **↳ UPDATE {gate_date} — the forward maker-exit paper gate KILLS → the 12th signal's last surviving
> form is closed; all twelve signals are now dead (`FINDINGS.md`).** The live gate rendered on
> {n_markets} markets / {n_cities} cities / {n_days} days: mean net {mean_net}%, CI [{ci_low}%,
> {ci_high}%], makerFillRate {maker_fill_rate} (backtest 49.0%, `MAKER-EXIT-SIM.md`). No capital was
> risked. Rail (`packages/trading`, the `bets` surface) stays DORMANT with no further scoped exception
> pending — reopen only per `SIGNAL-BACKLOG.md`'s recorded criteria. The product is fully the analytics/
> insight value now (`FINDINGS.md` "What's actually valuable"); the forward measurement instruments
> (`/maker-exit`, `/paper-trade`, `/amsterdam`, `/replica`) continue to run as analytics regardless of
> this verdict — see the deactivation checklist (§1d) if the operator wants to stop them, which is
> optional and NOT implied by this KILL.
```

Place it as the newest (bottom-most) entry in the pivot block, directly after the current last entry
(the 2026-06-30 (3) maker-exit-paper-loop-built line).

### 1c. SIGNAL-BACKLOG.md — re-open criteria for the maker-exit lever

Append to `SIGNAL-BACKLOG.md` (as a new dated verdict block under item 12's neighborhood, or as its own
"13. Maker-exit forward gate — CLOSED" entry, matching the existing closed-item convention, e.g. item 10
"Re-open = ≥30 d accrued pairs + a forward ask-capture design" at `SIGNAL-BACKLOG.md:475` and item 3's
"re-open only when the TEST period holds ≥10 distinct Q4-carrying weather-days" at `SIGNAL-BACKLOG.md:479`):

```
## 13. Maker-exit forward gate — CLOSED {gate_date}, KILL

Forward paper gate KILLed ({n_markets} mkts / {n_cities} cities / {n_days} days; mean net {mean_net}%,
CI [{ci_low}%, {ci_high}%]). The backtest PASS (`MAKER-EXIT-SIM.md`) did not replicate live — the
binding gap was `makerFillRate` ({maker_fill_rate} live vs 49.0% backtest), exactly the KILL path
`POST-FABLE-HANDOFF.md` §4 named in advance ("if the live number craters toward the early-live 0.30,
that is the most likely KILL path").

**Re-open requires #1 (the binding gap — the backtest edge existed at rebate 0, so fill-rate restoration
is the necessary condition); #2/#3 strengthen the case but cannot substitute for it:**
1. A **measured, understood mechanism change** to the maker-fill rate — not a lucky window. E.g. a
   documented queue-position or depth-provisioning change that plausibly moves realized fills back
   toward the 40–49% band the backtest needed (`MAKER-EXIT-SIM.md` "Ledger decomposition": the TP leg
   is the entire edge, at 100% win rate when it fills — everything rides on fill frequency, not fill
   quality).
2. **A materially higher realized maker rebate.** The backtest's positive scenarios assume rebate 0
   (fee-saving floor, +6.7%) up to the weather tier 0.25 (+7.6%); if Polymarket's rebate schedule
   changes, re-run `sim-maker-exit.ts --rebate <new>` before considering a re-open.
3. **A materially higher `qualifyingTickFrac`** (`docs/ops/REWARD-INSTR-ROLLOUT.md`) — the 1b reward-
   stacking upside (ciLow +0.25%→+2.38% at even a conservative 0.05 pool share, `SIGNAL-BACKLOG.md`
   item 1b) requires the resting TP to actually sit in the reward-qualifying band; it read 0 through
   the entire forward measurement window.
Do NOT re-open on a backtest re-tune alone — the live gate is definitionally the higher bar
(`POST-FABLE-HANDOFF.md`), and a backtest tune was exactly what produced the false-positive PASS this
KILL corrects.
```

### 1d. Deactivation checklist for the forward loop — OPTIONAL, operator's call only

**A KILL verdict does NOT require this.** `FINDINGS.md` "What's actually valuable — the analytics
instrument" is explicit that the measurement layer (calibrated forecast, model-vs-market scoring,
market-efficiency proof) is the retained product; `/maker-exit` and its capture pipeline can keep
running purely as analytics with zero capital implication, same as `/amsterdam`, `/paper-trade`,
`/replica` already do post-verdict. Only execute this if the operator explicitly decides to stop
measuring (e.g. to reclaim the DB/compute budget `POST-FABLE-HANDOFF.md`'s steady-state table
describes as already tightened for cost).

**Scope caution:** `opening-capture` and `convergence-panel` also feed the `/convergence` dashboard —
unscheduling them stops THAT surface's new data too, not just the maker-exit gate. If the operator wants
to keep `/convergence` live, unschedule only `maker-exit-panel` + the bot deadman.

Follows the repo's existing "turn it off" idiom (`RUNBOOK.md:42,367,392` — `cron.unschedule`, data and
dashboard remain, no new writes):

```sql
-- pauses the forward capture + panel pipeline; opening_captures, maker_exit_panel, bot_gate_snapshot
-- rows and the /maker-exit dashboard all remain queryable — this only stops new rows.
select cron.unschedule('opening-capture');          -- migration 0066
select cron.unschedule('opening-capture-deadman');  -- migration 0066
select cron.unschedule('opening-bot-deadman');       -- migration 0066
select cron.unschedule('maker-exit-panel');          -- migration 0073
select cron.unschedule('convergence-panel');         -- migration 0069 (the sibling dashboard's own capture)
-- verify: select jobname from cron.job where jobname like 'opening-%' or jobname in
--   ('maker-exit-panel','convergence-panel');  -- should return 0 rows
```

Rollback: re-run the `cron.schedule(...)` calls at `supabase/migrations/0066_opening_convergence.sql:791–798`,
`0073_maker_exit_paper_loop.sql:365`, `0069_convergence_dashboard.sql:199` (same job names, same
schedules — idempotent upsert by job name per `0009_cron.sql:142`'s documented convention).

---

## Package 2 — PASS (STAGE ONLY, do not execute)

**Capital, wallet funding, and keys are operator-physical and were explicitly NOT pre-authorized**
(`FASTTRACK-PLAN.md` C21: *"PASS → present prominently + STAGE the §9R capital-scope options as a
decision document — capital, wallet funding, and keys are OPERATOR-PHYSICAL and were explicitly NOT
pre-authorized. Never blur that line."*). On a PASS label, produce the decision document below and
stop. Do not touch `.env.local`, do not fund anything, do not place an order.

### §9R capital-scope decision document

**1. What §9R already locked** (`OPENING-CONVERGENCE-HANDOFF.md` §9R, lines 236–274, operator-confirmed
2026-06-27): dedicated wallet **$100–200**; caps **$10–25/position, $40/market, $100 total concurrent**;
daily-loss kill at **−$30 or −25% of bankroll**, whichever first; paper duration **≥2 weeks AND ≥40
captured markets** before any real money (the sufficiency bar the gate itself enforces); validation gate
**net positive after fees + measured slippage over ≥40 markets, CI excluding 0** (§9R-E, the same bar
`dash_maker_exit()` just cleared); boundary **F, confirmed**: dedicated separately-funded wallet, operator
funds it and holds the signing key in `.env.local`, Claude never places/cancels a trade or touches
credentials (also restated in `GO-LIVE-CHECKLIST-OPENING.md:8–10` and `CLAUDE.md`'s pivot-block boundary
line).

**⚠ Flag before using §9R B/C as-is:** §9R's entry rule (B: flat-open trigger, peak≤18%/≤6h/mode±1) and
exit brackets (C: TP +25pp or model prob, SL −12pp, flatten by lead-0 local noon) were locked for the
**original flat-open thesis**, which `FINDINGS.md`'s 2026-07-03 update formally KILLed (Phase-0.5 spike,
0/325 seeded events, Wilson 95% CI [0%,1%] — "the original 'buy the ≤1h flat open' execution stack …
is dead and will not be built"). The verdict that just PASSed is the **maker-exit variant**, entering at
the first enterable tick (not the flat open) with a different tuned config: `tp 0.12 / sl 0.20 / tstop
18h / chw 0 / maxEntryPrice 0.30 / depthFloorUsd 150 / makerWindow 30` (`MAKER-EXIT-SIM.md` "The
trajectory" + "The verified result"). **Before sizing anything, reconcile which config actually funds** —
§9R's capital envelope ($100–200, the caps) is reusable, but its entry/exit *rules* (B/C) are not what
was tested; the funded bot must run the maker-exit config, not the original §9R B/C brackets.

**2. The three live assumptions vs. their backtest values** (`MAKER-EXIT-SIM.md` "What this changes —
and the load-bearing assumptions"):

| Assumption | Backtest | Live (this gate) | Note |
|---|---|---|---|
| Maker-fill rate | 49.0% of realized exits (`MAKER-EXIT-SIM.md` Ledger decomposition) | **{maker_fill_rate}** | The entire edge rides on this leg — it wins 100% of the time when it fills; every miss falls to a structurally negative taker exit |
| Realized rebate | Scenarios at 0 (+6.7%/+$515) and 0.25 weather tier (+7.6%/+$583) | **{realized_rebate_usd}** (`realizedRebateUsd` on `dash_maker_exit()`) | Rebate is not the whole edge (0-rebate is still positive backtested) but it is the margin between "comfortably positive" and "marginal" |
| Distinct-day extent | 21 backtest days, CI fragile on LODO (9/21 city/date exclusions flip ciLow below 0, `MAKER-EXIT-SIM.md` jackknife) | **{n_days}** live days at PASS | A PASS at exactly the 7-day sufficiency floor is a thinner statistical base than the 21-day backtest that itself called its own significance "marginal" |

**3. The makerFillRate tension a PASS must explain before funding anything.** `POST-FABLE-HANDOFF.md`
§4 names low maker-fill rate as *the* most likely KILL path, explicitly citing the early-live read of
0.30 as the warning threshold. As of this playbook's writing the live read is **0.082** — well below
even that warning level, not just below the 49% backtest. **If the gate PASSes despite a maker-fill
rate anywhere near that low, the mechanism is not understood and must be before capital moves**: check
whether the realized {n_markets} markets that cleared the gate did so via an unusual mix (e.g., taker
exits underperforming the backtest's −13.4%/−79.9% averages less badly than modeled, rather than the TP
leg actually firing more often — `MAKER-EXIT-SIM.md`'s per-exit-kind table). A PASS riding on a
different mechanism than the one the backtest validated is not the same PASS; say so explicitly in the
writeup to the operator rather than treating the label as self-explanatory.

**4. Decision menu (operator chooses; Claude does not execute any of these):**
- **Fund at paper-scale** — the full §9R-A envelope ($100–200, standard caps) once the makerFillRate
  tension (§3 above) is either resolved (mechanism understood, live rate tracking backtest) or
  explicitly accepted as an open risk.
- **Fund at micro-scale** — a reduced envelope (e.g. $50–100, tighter per-position caps) as a live
  smoke test before scaling to the full §9R-A numbers, buying one more real-money data point on the
  fill-rate question at bounded risk.
- **Extend measurement** — let the paper loop keep accruing past the 7-day/40-market floor (it already
  runs for free, `POST-FABLE-HANDOFF.md`) before committing capital, particularly if the makerFillRate
  tension (§3) is unresolved.
- **Decline** — treat the PASS as informative but insufficient; rail stays DORMANT; the maker-exit
  loop continues as analytics only (same status as a KILL's optional §1d, except nothing is
  deactivated by default).

**5. Hard boundary, restated (non-negotiable, does not change on a PASS):** Claude builds and stages
software only. The operator creates/funds the dedicated wallet, acquires collateral, tops up gas, places
`POLY_PRIVATE_KEY` in `.env.local`, and performs every on-chain approval, smoke test, and first-N review
in `GO-LIVE-CHECKLIST-OPENING.md` §1–§5. Nothing in that checklist is performed by Claude
(`GO-LIVE-CHECKLIST-OPENING.md:8–10`). A PASS label authorizes writing this decision document; it does
not authorize funding, approving, or trading anything.

---

## Package 3 — INSUFFICIENT at (or near) 7 days

Covers the case where `n_distinct_days` sits at or drops back below 7 — e.g. a grading gap pulls the
7th day back out of scope, or a capture gap invalidates a day that had counted.

**What to check, in order:**
1. **Grading lag vs. genuine data loss.** `MAKER-EXIT-SIM.md`'s own re-run history shows this exact
   pattern already occurring in the backtest cache (the 09:50Z re-run at 827/20-days vs the 13:41Z
   re-run at 844/21-days, "the intended 21st day, 07-02, had not graded in yet — its markets resolved
   during the morning DB outage; re-joins the panel once fetch-actuals/grading catch up"). Check
   whether markets for the missing day have actually **resolved** (their target date has passed) but
   not yet been graded into `bot_gate_snapshot` — that is lag, not loss, and resolves itself on the
   next tick once grading catches up.
2. **If it is lag:** do nothing beyond noting it in the cycle log — per `FASTTRACK-PLAN.md`'s gate-watch
   instruction, "while n_distinct_days < 7 → report accrual (mkts/cities/days + makerFillRate vs 0.49
   backtest + realizedRebateUsd) and do nothing."
3. **If it is genuine data loss** (a capture gap, a deadman firing, a city dropping out of scope): check
   `job_runs` for the `opening-capture` / `maker-exit-panel` jobs around the gap window for non-`ok`
   statuses or elevated `cityErrors`, and check whether `capture_deadman_check` / `bot_deadman_check`
   fired in Slack (`POST-FABLE-HANDOFF.md` "If a panel tick ever wedges again" — the documented
   incident playbook: throttle capture, pause panels, let the IO budget refill, re-enable staggered).
   This is an operational incident, not a statistical one — fix the pipeline, then let the day
   re-accrue; it does not change the sufficiency bar or any package above.
4. **Otherwise:** keep accruing. No package fires below the 40-market / 6-city / 7-day floor
   (`POST-FABLE-HANDOFF.md` "Sufficiency bars (frozen)"); this is the steady state until sufficiency is
   genuinely reached.
