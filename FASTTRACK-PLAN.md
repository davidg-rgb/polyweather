# FASTTRACK — the Fable-window execution plan (2026-07-03 → 07-06/07)

> **What this is.** The operator has a 3–4-day window of Fable-model access and wants every remaining
> workstream planned in executable detail NOW, so architect/orchestrator/executor agents can build in
> parallel without re-deriving context. This document is the single source of truth for that sprint.
> Written 2026-07-03 ~13:20Z by the incident-watch session, immediately after the post-restoration
> steady state was reached.
>
> **What cannot be compressed (say it once, plan around it):** the live forward maker-exit paper gate
> (`/maker-exit`, the gate of record) needs **≥40 markets / ≥6 cities / ≥7 distinct days** of accrual —
> calendar time driven by market resolutions, not tokens. It will NOT adjudicate inside the Fable
> window (currently 8 markets / accruing since 06-30). The window is therefore spent on everything
> *around* it: the structural data-path fix, the backlog falsifications, the backtest refinements, and
> a handoff so a lighter model (or the operator) can read the gate when it matures.
> **No capital before a frozen paper PASS — the model window changes nothing about that boundary.**

## Hard rules for every agent in this sprint

1. **The DB is the shared fragile resource.** One heavy DB operation at a time, project-wide. The
   maker-exit panel tick (hourly at :35, ~6 min) is a blackout window for heavy reads. Two incidents
   today came from violating exactly this. Heavy = anything touching `opening_captures` TOAST,
   archive-scale pulls, or the sim cache build. Coordinate via the orchestrator; never assume.
2. **Worktree isolation per executor agent.** The main tree carries uncommitted signal-backlog engine
   work. `BUILD-STATE.md`, `FINDINGS.md`, `MAKER-EXIT-SIM.md`, `SIGNAL-BACKLOG.md` are single-writer:
   only the orchestrator/integration pass edits them.
3. **Frozen-gate discipline everywhere.** Pre-register the gate before measuring. Every signal test
   reports vs its pre-registered criteria; INSUFFICIENT_DATA is an honest outcome.
4. **Operator boundary unchanged.** No keys, no capital, no trades. Migrations + fn deploys + any
   destructive SQL are operator-gated: build + test + stage everything, then present a one-command
   bundle with verification steps.
5. **Suite + typecheck green before any commit; commits local unless told.**

## Current state (2026-07-03 13:20Z, verified live)

- `opening-capture` `*/10` — healthy (32–38s, full inserts). `maker-exit-panel` hourly `35 * * * *` —
  ticks complete, snapshots land, but **cityErrors ~41/45** (see WS-1 root cause). `convergence-panel`
  **paused** (v6 unbounded fetch — must not re-enable before WS-1). `whale-watch` + all light crons healthy.
- `bot.consensusSource` = `calibrated` (the queued flip is DONE). `bot.cities` = 45. `bot.gateStaleMin`
  180. `bot.tickStaleMin.paper` = **180 while hourly** (restore '45' when the panel returns to `*/15`).
- **Root cause found (WS-1):** `opening_captures` = 46 MB heap + **1.2 GB TOAST** (`buckets` jsonb).
  A 45-city × 21-day panel tick detoasts ~1.2 GB — bigger than the buffer cache → every tick is
  disk-bound; 40 × 30s-timeout statements/tick was eating the IO-burst refill. The 45-city panel has
  NEVER had a clean tick; today's incident exposed it.
- Forward gate: INSUFFICIENT (8 mkts / accruing). 07-02 grading 29/45 (venue resolutions pending —
  gates WS-2). Signal backlog: 1a answered (partially eligible → 1b live), 1b + 5 engine code BUILT
  (uncommitted, tested, 996 core tests green), 7 KILL (data structurally impossible keyless),
  9 KILL ($802/24h vs $7k floor).

---

## WS-1 — Panel data-path structural fix — **✅✅ DEPLOYED + VERIFIED 2026-07-03 15:20Z** (operator approved; outcome block + 3 evidence-based deviations in `docs/ops/WS1-ROLLOUT.md`: canary >60 s→instant, convergence-panel live again at 23.2 s/0 errors, gate scope 43–58 mkts/tick, maker-exit stays hourly, prune correctly empty until ~late July, vacuum deferred)

> 2026-07-03 ~14:00Z: 3-lens adversarial review × 2 rounds → 4 confirmed findings fixed (headline: the
> dropped 0069 last-tick invariant would have fired the gate-of-record's time-stops up to ~40 min late —
> caught by the SQL lens, fixed as a dual-window rule), 1 false-positive overturned (BUILD-STATE staleness,
> since remedied), 0 outstanding. Combined-tree suite 1904 green + 1 pre-existing real-timers flake
> (passes 2× in isolation; fake-timers fix added to WS-5). Worktree branch `worktree-agent-a12af96a47327ece2`
> commit `0a8896c`; main-tree local commit `52f115d` (signal-backlog work left uncommitted, untouched).

**Goal:** a maker-exit panel tick that completes in ≤120s with cityErrors ≤2 at 45-city scope, and a
convergence-panel that can safely reactivate. Kill the incident class, not the symptom.

**Deliverables (in dependency order):**

1. **Migration `0077_capture_read_thinning.sql`**
   - `convergence_capture_inputs(p_days, p_cities)` gains server-side **20-min grid thinning**: per
     event, keep one capture row per 20-min bucket (deterministic pick: min `captured_at` per bucket),
     using the 0076 slim-window-then-PK-join pattern so the thinning predicate never detoasts skipped
     rows. The replay engine already samples on a 20-min grid (`SAMPLE_MIN = 20` in
     `scripts/research/sim-maker-exit.ts`), and capture runs `*/10` → this halves (at `*/2` capture:
     ~10×) the detoasted volume with **zero fidelity loss to the replay**.
   - Signature/grants byte-compatible (additive default param if a raw mode is worth keeping for the
     Phase-3 backtest reader — decide in review; `bot_capture_series` stays untouched).
   - PGlite twin in `supabase/tests/migrations.test.ts` mirroring the 0068/0073 twin pattern: thinned
     row-count assertions + the {rows:[…]} wrap lock + grant checks.
2. **`opening_captures` retention prune (operator-gated, destructive — dry-run first)**
   - Policy: delete capture ticks for events **resolved ≥25 days** (> PANEL_DAYS 21; the on-disk
     price-history archive is the permanent record).
   - Pre-flight (MANDATORY): assert every prune-candidate `eventId` exists in the local archive index
     (`indexArchive` over the archive root) — no archive file, no delete. Emit the dry-run count +
     size estimate; operator approves; then batched deletes (≤5k rows/statement, off the :35 window).
   - Follow with `VACUUM ANALYZE public.opening_captures` (operator-gated, IO-heavy, quiet window).
     Collector shows autovacuum never ran post-incident.
3. **`maker-exit-panel` v5** — consume the thinned RPC (likely no handler change if the RPC keeps its
   signature; verify), keep the v4 bounded pool as belt-and-braces. After ONE verified clean tick:
   restore cadence `5,20,35,50 * * * *` + set `bot.tickStaleMin.paper` back to `'45'`.
4. **`convergence-panel` v7** — port v4's bounded worker pool (concurrency 5 / 30s per-city / 240s
   budget / partial-view degradation) into the convergence handler + the thinned RPC. Re-enable
   `*/15` (permanently offset from maker-exit). Twin tests mirror the maker-exit handler tests.
5. **Rollout runbook (operator bundle):** apply 0077 → deploy maker-exit-panel → verify a :35 tick
   (target: <120s, cityErrors ≤2, snapshot + gate land) → deploy convergence-panel v7 → re-enable
   job 26 → verify one tick → prune dry-run → operator yes/no → prune + vacuum → restore maker-exit
   `*/15` + tickStaleMin 45. Each step has a verification query; stop on any regression.

**Effort:** ~half a day of agent work + review. **DB-load:** the migration itself is cheap; the prune
and vacuum are the heavy steps (operator-scheduled).
**Review:** the project's proven 4-lens adversarial pattern (migration SQL · edge pipeline · pure
core · tests) — one round minimum, two if findings are non-trivial.

## WS-2 — The true 21-day baseline — **✅ DONE 2026-07-03 13:41Z** (07-02 graded 45/45 → 844 ev/45 c/21 d: **PASS holds** +6.8 %/+$535, CI [+0.25 %, +11.9 %]; LOCO 15/45, LODO 9/21, day-block PASS. Banner + BUILD-STATE updated. **The new cache unblocks WS-3b.**)

**Trigger:** 07-02 graded ≥44/45 (`select count(*) … market_events … target_date='2026-07-02' …
winner not null`). If one market is UMA-stuck for hours, proceed at 44 with a note.
**Steps (serialize with the :35 tick window and with WS-3c — ONE heavy pull at a time):**
1. `pnpm tsx scripts/research/sim-maker-exit.ts --build-cache` (the heavy pull; ~849 events expected).
2. Pinned baseline: `--from-cache --split --tp 0.12 --sl 0.20 --tstop-hours 18 --chw 0
   --max-entry 0.30 --depth 150 --maker-window 30 --rebate 0`.
3. `jackknife-maker-exit.ts` (LOCO/LODO + day-block).
4. Update the `MAKER-EXIT-SIM.md` top banner + BUILD-STATE morning-summary item 2 + memory.
**This cache is also the substrate for WS-3b — build once, share.** The prior banner (20-day):
+6.9%/+$534, CI [+0.4%,+12.1%], PASS. The question is only whether the PASS holds/strengthens at 21.

## WS-3 — Signal-backlog execution — **✅✅ CLOSED 2026-07-03 ~19:50 local (orchestrator /loop v2, C1–C13 below): all 9 verdicts adjudicated vs pre-registered gates — 1b gate-PASS (pool-share caveat → forward instrumentation follow-on) · 2/4/5/6/7/9/11 KILL · 3 NO-PASS (hardening revoked) · 10 INSUFFICIENT structural. Records: FINDINGS.md rows + SIGNAL-BACKLOG.md verdict blocks + BUILD-STATE 17:45Z addendum.**

- **3a — ✅ DONE (2026-07-03 ~15:08 local, parallel agent):** CLI wiring for `rewardCfg` + `basketSize`
  landed; items 2–4 pre-registered with the analysis script written and its SQL staged-not-executed.
  57 test files / 1159 tests green, whole-repo typecheck clean, prod untouched, uncommitted (6-file
  diff). State: `SIGNAL-BACKLOG.md` + the 15:08 memory entry.
- **3b (after WS-2's cache):** run 1b — pinned config ± reward income, `myPoolShareIfQualifying`
  swept {0.05, 0.10, 0.25, 0.50}; gate: does ciLow move materially toward/past 0 with everything else
  frozen. Run 5 — basket 1/2/3, judged on **jackknife fragility** (count of LOCO/LODO flips), not mean.
- **3c (after the orchestrator's stability green light, ~14:00Z):** items 2–4 as ONE data pull + three
  conditioning splits. Heavy read — schedule off the :35 window, never concurrent with WS-2's step 1.
- **3d (after 3c):** item 6 cheap check (adjacent-day join). Expected KILL per the backlog's own
  downgrade; budget minutes, not hours.
- **3e (only if time remains):** item 10. Item 8 stays dormant (needs a live PASS first).
- **Recording:** every verdict → a FINDINGS.md row + SIGNAL-BACKLOG.md status flip, via the
  single-writer integration pass. Items 7 + 9's KILLs are already due for recording.

## WS-4 — Live-loop alignment — **DONE** (verified this session)

`bot.consensusSource` = `calibrated` ✅ · 45-city panel scope deployed + verified ✅. Nothing remains.

## WS-5 — Ops hardening — **✅ BUILT + REVIEWED + INTEGRATED (local `6c053f1`); rides the combined operator bundle**

> 2026-07-03 ~14:35Z: terminal-write retry (2×, 3s/8s, 15s/attempt — panel snapshots only; never-pruned
> gate history explicitly NOT retried), 10s-bounded bookkeeping writes (complete wall arithmetic: 346s
> worst case vs the 400s wall), 0078 `claim_job_run` janitor (dead-isolate `running` rows self-heal at
> next claim; grants re-asserted per the 0046/0047 idiom), fake-timers determinism for the two flaky
> budget tests (3× proven). 2-lens review → 1 MEDIUM + 2 LOW confirmed → fixed → 0 outstanding.
> Combined tree 135 files / 1928 green, zero-flake. Deploys via the SAME bundle as WS-1
> (`docs/ops/WS1-ROLLOUT.md`, updated `c0892ec`).

1. **Terminal-write retry in the panel handlers** (or `runJob` helper): 2 retries + short backoff on
   `record_maker_exit_panel` / gate-snapshot writes — one transient timeout must not discard a
   6-minute tick. (Today's failures were pooler-jam, but the resilience is correct regardless.)
2. **Wedged-row janitor:** at job start, mark own-job `running` rows older than 30 min as `failed`
   (forensic noise class — 4 wedged rows today).
3. **Deadman audit:** thresholds now cadence-aware and verified paging correctly (they paged the
   operator correctly overnight). After WS-1 restores `*/15`, restore `bot.tickStaleMin.paper='45'`.

## WS-6 — Docs, memory, and the post-Fable handoff

1. BUILD-STATE addendum for today's second incident + the TOAST root cause + the steady state (owner:
   this session, today).
2. FINDINGS.md: backlog rows for 7 (impossible keyless) + 9 (liquidity KILL); later 1b/5/2–4/6 verdicts.
3. **`POST-FABLE-HANDOFF.md`:** the one-page adjudication guide — when the forward gate hits
   ≥40/≥6/≥7 (arithmetic at current accrual: ~07-08 to 07-10), run `dash_maker_exit` / read
   `/maker-exit`, the §9R-E function renders the verdict deterministically; what PASS/KILL each mean
   (PASS → operator decision on the §9R capital scope; KILL → the 12th signal joins the other eleven,
   rail back to DORMANT); plus the restore-state table (every cron/config knob touched this sprint and
   its steady-state value).
4. `/remember` at every session end.

## Day-by-day

- **Day 0 (today):** WS-1 build + review (agent team, worktree) · WS-3a now · WS-2 when grading lands ·
  WS-3c after stability green light · BUILD-STATE addendum · evening: WS-3b if the cache is in.
- **Day 1:** WS-1 operator bundle (0077 + deploys + verified restoration + prune decision) · WS-3b/3d
  runs · WS-5 build + review.
- **Day 2:** consolidation — FINDINGS/SIGNAL-BACKLOG/banners; WS-3e if time; WS-5 deploy; buffer
  (today proved surprises cost half a day).
- **Day 3:** POST-FABLE-HANDOFF.md · final memory entry · leave the system accruing.

## The autonomous /loop prompt — v5, gate-watch + enrollment-forward (paste as-is; self-paced — no interval)

> v4 (below, superseded) closed at C20: deploy verified (first `qualifyingTickFrac` = 0), item 12 adjudicated
> (2 candidates) + recorded + pushed. The operator then gave in-session blanket approval → enrollment EXECUTED
> (C21): ankara + houston live in `city_sim_config`, backfilled, forward clock starts 07-04. Board at v5 start:
> backlog FULLY closed; the ONLY live questions are (a) the forward maker-exit gate label (renders when 07-03
> grades — 73/34/6-of-7 at last read) and (b) the new cities' first forward day. Pre-authorization recorded:
> a KILL verdict may be RECORDED without re-asking; a PASS only ever gets STAGED — capital/wallet/keys remain
> operator-physical, never pre-authorizable.

```
/loop Polyweather FASTTRACK orchestrator v5 (gate-watch; Fable window closes ~2026-07-06/07). You are PLANNER/ORCHESTRATOR/CHECKER/ADJUDICATOR ONLY — sonnet agents build/run/draft; you verify, adjudicate, record. Files are the state: FASTTRACK-PLAN.md (cycle log C1–C21 + this prompt), POST-FABLE-HANDOFF.md (THE gate adjudication guide), SIGNAL-BACKLOG.md §12 (verdict + executed enrollment + the confirmation-clock rule), FINDINGS.md, docs/ops/REWARD-INSTR-ROLLOUT.md, TaskList — read every cycle. Board: main == origin; backlog FULLY CLOSED (item 12 executed — do NOT start new signal work; re-open criteria live in SIGNAL-BACKLOG.md); city_sim_config = 4 active cities (ankara/houston enrolled 07-03, backfill IN-SAMPLE, candidate confirmation = target_date ≥ 07-04 ONLY); commits local by default, push only follow-ups to already-authorized threads.

EACH CYCLE, in order:
1. GATE WATCH (headline): read the latest bot_gate_snapshot (mode='paper'). While n_distinct_days < 7 → report accrual (mkts/cities/days + makerFillRate vs 0.49 backtest + realizedRebateUsd) and do nothing. WHEN n_distinct_days ≥ 7 the code renders the label — report it PROMINENTLY with POST-FABLE-HANDOFF §adjudicate's meaning. Handling is PRE-AUTHORIZED (operator blanket approval 2026-07-03 ~22:05 local, recorded C21): KILL → RECORD it fully without re-asking (FINDINGS.md 12th-signal closing row with the realized numbers; CLAUDE.md banner line; SIGNAL-BACKLOG re-open criteria; commit+push as a follow-up) and lead the summary with it; INSUFFICIENT → keep accruing; PASS → present prominently + STAGE the §9R capital-scope options as a decision document — capital, wallet funding, and keys are OPERATOR-PHYSICAL and were explicitly NOT pre-authorized. Never blur that line.
2. ONE-TIME ENROLLMENT VERIFICATION (task #31, skip once done): after the 07-04 10:00Z city-paper-trade tick — bets exist for ankara+houston (arms 11–16 local, target_date 07-04), the tick's job_runs row is ok, /paper-trade data surface shows 4 cities. Explicitly check houston's first graded °F day buckets correctly (first real °F exercise of 0070's unit-agnostic bucketing). Report; any defect → one sonnet fix agent, lens if engine-adjacent.
3. REWARD-INSTR TREND (cheap, ~once per 2 cycles): qualifyingTickFrac across the recent :35 ticks (first read 0 @ 19:35Z 07-03) — report the trend; it bounds the 1b reward term. No action, measurement only.
4. PROD HEALTH (cheap probes, never :35–:42): opening-capture (*/10: ok/<60s/inserted>0) · maker-exit-panel (:35 hourly: ok/snapshotId/nMarkets≥40/~95–250s) · convergence-panel (*/15: ok/<60s/cityErrors≤2) · city-paper-trade (daily 10:00Z: ok). One failure = note+watch; two identical = the pre-authorized playbook (throttle capture → pause offender → IO refill → staggered re-enable). NEW migrations/fn deploys/destructive SQL: stage + ask.
5. GUARDRAILS (non-negotiable): ONE heavy DB op project-wide; :35–:42 blackout; no capital, no keys, rail paper/DORMANT; no new signal hunts; never touch other agents' uncommitted files; the PASS→capital boundary above is absolute.
6. RECORD + PACE: cycle tick + TaskList each cycle; /remember before any >1h idle. Wakeups: overnight/watch-only → 3600s; label imminent or agent in flight → 1500s. STOP when BOTH the gate label is rendered+handled per the pre-authorization AND enrollment verification (#31) is done → final tick + /remember + summary ending with the operator's pending items (only a PASS leaves one: the capital-scope decision; a KILL leaves none — the analytics product continues per FINDINGS.md).
```

## (v4, post-deploy — superseded) The autonomous /loop prompt (paste as-is; self-paced — no interval)

> v3 (below, superseded) was written before the operator authorized commit/deploy/push. Board at
> 2026-07-03 ~21:30 local: WS-3 + reward-instr are MERGED/DEPLOYED/PUSHED (main == origin @ `b982ea9`);
> item 12 (CITY-SCAN) was in flight when the session ended — its runner dies with the session, so verify
> whether results were recorded and re-dispatch if not (the pre-registered spec is committed). The forward
> gate is ~1 graded day from sufficiency.

```
/loop Polyweather FASTTRACK orchestrator v4 (post-deploy; Fable window closes ~2026-07-06/07). You are PLANNER/ORCHESTRATOR/CHECKER/ADJUDICATOR ONLY — sonnet agents build/run/draft; you verify, review, adjudicate, record. Files are the state: FASTTRACK-PLAN.md (cycle log C1–C14 + workstream statuses), POST-FABLE-HANDOFF.md (steady state + THE gate adjudication guide), SIGNAL-BACKLOG.md (all verdicts + item 12 CITY-SCAN pre-registration), BUILD-STATE.md (17:45Z addendum), docs/ops/REWARD-INSTR-ROLLOUT.md, TaskList — read every cycle. Board: main == origin @ b982ea9 (WS-3 verdicts + reward-instr diagnostic merged/deployed/pushed 07-03 ~21:15 local); backlog CLOSED except item 12; commits stay local by default — push only follow-ups to already-authorized threads.

EACH CYCLE, in order:
1. ONE-TIME DEPLOY VERIFICATION (skip once done, per docs/ops/REWARD-INSTR-ROLLOUT.md): first post-deploy :35 tick (first eligible 19:35Z 07-03) — job_runs.stats carries qualifyingTickFrac (number|null) and the tick stays healthy (ok, cityErrors ≤2, nMarkets ≥40, ~95–250 s); Vercel READY + /maker-exit renders tile #4 (em-dash on pre-deploy snapshots = correct). Record the first observed qualifyingTickFrac in the cycle log — it bounds the 1b reward term (income ∝ frac × pool × share) BEFORE the share question opens.
2. CITY-SCAN (item 12): check whether a verdict block exists under SIGNAL-BACKLOG §12 — if not, re-dispatch a sonnet runner implementing the pre-registered block VERBATIM (one new file scripts/research/city-scan.ts; local maker-exit cache + ONE cheap bucket_probabilities pull, blackout-guarded, stop-on-2-identical-failures; raw tables only, no self-verdicts; reuse entry-watch LB + clusterMeanTCi + the live engine's fee math). On report: verify footprint, then YOU adjudicate vs the locked bars (candidate = TRAIN LB>0 AND TEST net>0 among the top-5 TRAIN cells; all else descriptive) → record FINDINGS row + §12 verdict block + tick → present candidates + the pooled entry-hour curve to the operator as a city_sim_config ENROLLMENT decision (stage exact commands; do NOT apply). One review lens on the script ONLY if a candidate emerges (behavior-changing); waive with documented reasoning for a null.
3. PROD HEALTH (cheap probes, never :35–:42): opening-capture (*/10: ok/<60 s/inserted>0) · maker-exit-panel (hourly :35: ok + snapshotId + nMarkets ≥40) · convergence-panel (*/15: ok/<60 s/cityErrors ≤2). One failure = note+watch; two identical = the pre-authorized playbook (throttle capture → pause offender → IO refill → staggered re-enable). NEW migrations/fn deploys/destructive SQL: stage + ask the operator.
4. GATE WATCH — sufficiency is IMMINENT (18:36Z 07-03: 73 mkts / 34 cities / 6 of 7 days; read: net −$160 / −11 % ROI, makerFillRate 0.082 vs 0.49 backtest — the POST-FABLE-named KILL path). When nDistinctDays ≥ 7 the code renders the gate label — report it PROMINENTLY with what POST-FABLE-HANDOFF §adjudicate says it means. NEVER adjudicate it yourself: PASS → operator decision (capital scope conversation, nothing auto-authorized); KILL → STAGE the FINDINGS.md + CLAUDE.md updates and ask the operator to confirm before recording the 12th signal dead; INSUFFICIENT → keep accruing.
5. GUARDRAILS (non-negotiable): ONE heavy DB op project-wide; :35–:42 blackout; no capital, no keys, rail paper/DORMANT; no new signal hunts (re-open criteria in SIGNAL-BACKLOG.md only); never touch other agents' uncommitted files.
6. RECORD + PACE: cycle-log tick + TaskList each cycle; /remember before any >1 h idle. Wakeups: runner in flight → 1500 s; watch-only → 2700–3600 s. STOP when: deploy verified + item 12 adjudicated/recorded + the gate status reported (label rendered, or still <7 days with nothing else open) → final tick + /remember + a summary ending with the operator's pending decisions (city enrollment; the gate verdict handling; nothing else is open).
```

## (v3, post-WS-3-close — superseded) The autonomous /loop prompt (paste as-is; self-paced — no interval)

> v2 (below, kept for reference) drove the WS-3 adjudication sprint to completion (cycle log C1–C13).
> v3 reflects the board after 2026-07-03 ~20:30 local: ALL workstreams closed; the tree is committed
> locally (feat/research/docs triplet on main); ONE build is in flight (the operator-greenlit 1b
> follow-on: forward reward-eligibility instrumentation, worktree agent); the forward gate accrues.

```
/loop Polyweather FASTTRACK orchestrator v3 (post-WS-3; Fable window closes ~2026-07-06/07). You are PLANNER/ORCHESTRATOR/CHECKER/ADJUDICATOR ONLY — sonnet agents build/run/draft; you verify, review, adjudicate, record. Files are the state: read FASTTRACK-PLAN.md (WS statuses + cycle log), POST-FABLE-HANDOFF.md (steady-state config + gate adjudication guide — do not "fix" it without evidence), BUILD-STATE.md (17:45Z addendum = the WS-3 scorecard), and TaskList, every cycle. Board expectations: main carries the local WS-3 commit triplet (feat 0064445 · research 899f77e · docs — plus predecessors); NEVER push; the signal backlog is CLOSED (all 9 verdicts recorded; re-open criteria live in SIGNAL-BACKLOG.md — do NOT start new signal work).

EACH CYCLE, in order:
1. INTEGRATE the reward-instrumentation build (agent 'reward-instr', worktree): verify diff scope is ADDITIVE-DIAGNOSTIC ONLY (a qualifyingTickFrac/pool-context diagnostic on the forward view + /maker-exit; the §9R-E gate math byte-identical, proven by unchanged existing tests + exact suite/typecheck counts reported green; no prod touches; no migration unless jsonb-additive was impossible — if a migration appears, treat it as a finding to adjudicate, not auto-accept). Then TWO sonnet review lenses (it touches the engine-adjacent view + an edge handler; SEVERITY·file:line·claim·evidence; you adjudicate; stop at zero code defects; 1-2 rounds). On zero defects: merge the worktree branch into main locally (suite+typecheck green on the merged tree before the commit), then have a sonnet agent draft docs/ops/REWARD-INSTR-ROLLOUT.md (deploy = redeploy maker-exit-panel [+ apply migration if any]; per-step verification queries; rollback = redeploy previous fn) — you review + commit it. Present the bundle to the operator in the cycle summary, bolded. If the agent stalls >45 min or dies: ONE corrective re-brief to a fresh agent, else record the lane blocked.
2. PROD HEALTH (cheap probes, never :35–:42): last ticks of opening-capture (*/10: ok/<60s/inserted>0), maker-exit-panel (hourly :35: ok/snapshotId/nMarkets≥40 — healthy reference is now ~95s/0 cityErrors), convergence-panel (*/15: ok/<60s/cityErrors≤2). One failure = note+watch; two identical = the pre-authorized playbook (throttle capture → pause offender → refill → staggered re-enable). NEW migrations/fn deploys/destructive SQL stay operator-gated — stage, never apply.
3. GATE ACCRUAL (read-only): once per ~2 cycles read the latest bot_gate_snapshot / dash_maker_exit — report realized markets/cities/days vs the frozen ≥40/≥6/≥7 bars + the three assumptions (makerFillRate — 0.092 last read vs 0.49 backtest, THE number to watch; realizedRebateUsd; days). You NEVER adjudicate the gate: at sufficiency the code renders the label and POST-FABLE-HANDOFF.md §adjudicate says what each label means — a PASS is an OPERATOR decision; INSUFFICIENT means do nothing.
4. GUARDRAILS (non-negotiable): ONE heavy DB op project-wide; :35–:42 blackout; no capital, no keys, rail paper/DORMANT; commits local, never push; no new signal hunts (the backlog's closing rule stands).
5. RECORD + PACE: FASTTRACK cycle-log tick + TaskList each cycle; /remember before any >1h idle stretch. ScheduleWakeup: build/lenses in flight → 1500s; only watching prod + accrual → 2700-3600s. STOP the loop when the reward-instr bundle is merged + staged (or the lane is recorded blocked) and prod is steady: write a final tick + /remember + status summary ending with the operator's pending actions (deploy the bundle; read the gate at sufficiency ~07-08→12; push is your call) — the deadmen page on real prod problems and POST-FABLE-HANDOFF.md carries the rest.
```

## (v2, WS-3 sprint — superseded) The autonomous /loop prompt (paste as-is; self-paced — no interval)

> v1 (below, kept for reference) drove the day-0 build sprint. v2 reflects the board after 15:20Z
> 07-03: WS-1/2/4/5/6 DONE + DEPLOYED; what remains is WS-3 execution/adjudication, verdict recording,
> and the accrual/health watch.

```
/loop Polyweather FASTTRACK orchestrator v2 (post-day-0; Fable window closes ~2026-07-06/07). You are PLANNER/ORCHESTRATOR/CHECKER/ADJUDICATOR ONLY — you never write bulk code, run long jobs, or draft docs yourself; Agent(model:'sonnet') does, in worktrees for code and the MAIN tree only for cache-consuming runs; model:'haiku' for trivial mechanical work. Files are the state: read FASTTRACK-PLAN.md (workstream statuses), POST-FABLE-HANDOFF.md (steady-state config — do not "fix" it without evidence), SIGNAL-BACKLOG.md (item specs + pre-registered gates), and TaskList, every cycle.

EACH CYCLE, in order:
1. RECOVER + INTEGRATE: git status (expect 5 local commits ending b31917e + the parallel agent's uncommitted signal-backlog work — do not commit or clobber files you don't own); integrate any finished background agent FIRST (verify: diff scope matches brief · exact suite+typecheck counts reported green · no prod touches · gate pre-registered BEFORE measurement) — accept into the plan/docs or reject with ONE corrective re-brief.
2. PROD HEALTH (cheap probes only, never during :35–:42): last 2 job_runs each for opening-capture (*/10, bar: ok/<60s/inserted>0), maker-exit-panel (hourly :35, bar: ok + snapshotId + nMarkets≥40 scope), convergence-panel (*/15, bar: ok/<60s/cityErrors≤2). One failed tick = note and watch; two identical failures = the incident playbook (throttle capture → pause the offender → let IO refill → re-enable staggered) — that ops set is pre-authorized; NEW migrations/fn deploys/destructive SQL are NOT (stage + ask the operator).
3. ADVANCE WS-3 (the only build lane left) — coordinate, don't duplicate: the operator's parallel agent owns 3b/3c unless SIGNAL-BACKLOG.md + git show no progress for >3h, in which case dispatch your own sonnet runner per the backlog's own spec. Order: 3b (1b reward-stacking sweep {0.05,0.10,0.25,0.50} + basket 1/2/3, --from-cache on the 844-event cache, LOCAL compute only, judge 1b on ciLow movement / 5 on jackknife-fragility reduction) → 3c (items 2–4 ONE pull + three splits, heavy DB — serialize globally, off :35–:42) → 3d (item 6 cheap check, expect KILL) → 3e (item 10, only if idle). YOU adjudicate every result against its PRE-REGISTERED gate — never let a runner self-declare PASS/KILL — then record: FINDINGS.md row + SIGNAL-BACKLOG.md status + a one-line FASTTRACK tick (you are the single writer for FINDINGS/SIGNAL-BACKLOG/BUILD-STATE/MAKER-EXIT-SIM/FASTTRACK).
4. REVIEW anything that touches engines or SQL with 1-2 sonnet lenses before accepting (the day-0 pattern: reviewers report SEVERITY·file:line·claim·evidence; you adjudicate; stop at zero code defects). Pure analysis scripts reading existing data need one lens only.
5. GUARDRAILS (non-negotiable): ONE heavy DB operation project-wide at a time; :35–:42 blackout; no capital, no keys, rail stays paper/DORMANT — a forward-gate PASS is an OPERATOR decision, never yours (POST-FABLE-HANDOFF.md §adjudicate); commits stay local; never push; never touch the parallel agent's uncommitted files.
6. RECORD + PACE: update TaskList + FASTTRACK ticks each cycle; BUILD-STATE addendum at day boundaries; /remember before any sleep >1h-equivalent idle stretch. ScheduleWakeup: agents in flight → 1500s fallback; only waiting on the hourly :35 tick or the parallel agent → 1800-2700s; mid-integration → continue now. STOP the loop (no wakeup) when: WS-3 verdicts are all recorded and no lane has work — write the final BUILD-STATE tick + a /remember entry and end with a status summary; the deadmen page the operator on real prod problems, the gate accrues by itself (~sufficiency 07-08→12), and POST-FABLE-HANDOFF.md carries the rest.
```

## (v1, day-0 — superseded) The autonomous /loop prompt (paste as-is; self-paced — no interval)

```
/loop Polyweather FASTTRACK orchestrator — Fable window closes ~2026-07-06/07. You are PLANNER/ORCHESTRATOR/CHECKER ONLY: you never write bulk code, tests, or doc drafts yourself — cheaper models do; you plan, brief, review, adjudicate, integrate. Files are the state: read FASTTRACK-PLAN.md + TaskList first every cycle.

EACH CYCLE, in order:
1. RECOVER: git status; FASTTRACK-PLAN.md workstream statuses; cheap prod probes only (cron.job actives; last 2 job_runs for opening-capture + maker-exit-panel; 07-02+ grading count). Integrate any finished background agent FIRST: verify (diff scope matches brief · suite+typecheck counts reported green · no prod touches · gates pre-registered) → accept into the plan or reject with a corrective re-brief. Never patch a rejected deliverable by hand.
2. ADVANCE the highest unblocked gate: WS-1 build → 3-lens adversarial review (parallel Agent calls, model sonnet: migration-SQL / edge-pipeline / tests-and-twins; YOU adjudicate findings, 1-2 rounds, stop at zero code defects) → stage the operator deploy bundle. WS-2 when 07-02 graded ≥44/45: dispatch a sonnet agent to run cache rebuild + pinned baseline + jackknife and return raw outputs; YOU judge vs §9R-E and write the MAKER-EXIT-SIM.md banner. WS-3c once prod stable ≥1h; WS-3b after the new cache; then 3d, 3e. WS-5 build anytime a lane is idle. WS-6 last.
3. DELEGATE every build/run/draft to Agent(model:'sonnet', isolation:'worktree' for code) with: the exact FASTTRACK-PLAN.md section pasted in, file-level deliverables, acceptance criteria, "run pnpm test + pnpm typecheck, report exact counts", and "no prod access, no commits, don't touch BUILD-STATE/FINDINGS/MAKER-EXIT-SIM/SIGNAL-BACKLOG". Trivial mechanical work → model:'haiku'. YOU alone touch: the four single-writer docs, prod SQL (cheap probes + already-authorized cron/config repairs only), verdict adjudication, operator bundles.
4. GUARDRAILS (non-negotiable): ONE heavy DB operation at a time project-wide; :35–:42 every hour is panel-tick blackout for heavy reads; migrations/fn deploys/destructive SQL are OPERATOR-GATED — stage, never apply; convergence-panel cron stays paused until WS-1 is deployed; no capital, no keys, rail stays paper/DORMANT; commits local only.
5. RECORD: tick statuses in FASTTRACK-PLAN.md + tasks every cycle; BUILD-STATE addendum at day boundaries; /remember before any long idle. When an operator bundle is ready, lead the cycle summary with it in bold and keep other lanes moving.
6. PACE via ScheduleWakeup: background agents in flight → 1500s fallback; blocked only on venue grading → 1800s; mid-integration → continue now. STOP when all workstreams are done or operator-blocked, or the window closes → write POST-FABLE-HANDOFF.md + a final memory entry, then end the loop.
```

## Orchestration notes

- Executor agents get ONE workstream each, in a worktree, with this file + the workstream section as
  the brief. The orchestrator serializes every DB-heavy step on a single global lane and owns the
  four single-writer docs.
- Review pattern: adversarial multi-agent for anything touching prod SQL or the engines (the project's
  asymptotic-findings experience says 1–2 rounds, stop on zero code defects).
- The operator's actions are batched into at most one bundle per day (0077+deploys+prune is Day 1's).

## Orchestrator cycle log (v2 loop, from 2026-07-03 ~17:30 local)

- **C26 (~00:55 local / 22:53Z — reward-instr v2 MERGED + PUSHED + DEPLOYED; verification = the 23:35Z tick):** Both lenses ZERO gate-math/correctness defects (Lens A walked all 5 settle() sites incl. the v1-bug post-break loop — threaded symmetrically; Lens B verified jsonb additivity end-to-end + old-snapshot em-dash handling). Batched fix pass (1 LOW tie-break → strict-majority both axes + 2 boundary tests that FAIL against the old code · 1 MEDIUM defaults-caveat → ROLLOUT.md v2 section incl. **the documented reading of the live 0/1,732: the mid<0.10 strict two-sided regime zeroes one-sided quotes** + tile WHY-line defaults caption) → zero outstanding. Merged tree **136 files / 1975 tests green** + typecheck clean → commit `5a38f6d` pushed → **maker-exit-panel DEPLOYED** (authed CLI). Verify next: 23:35Z tick's job_runs.stats carries `dominantDisqualifier` (+ the WHY fields land in snapshot assumptions). Remaining lanes: cityscan-page (#35+#37 — appendix null-fill + F° + operator current-bet box + Stockholm times) in flight; task #31 (10:00Z) + gate watch (last read 6/7 days) continue.
- **C25 (~00:45 local 07-04 / 22:44Z — three lanes landed: cs-harden + f-unit-test MERGED+PUSHED; reward-instr-2 → 2 lenses; cityscan-page → data-appendix resume):** **f-unit-test (#33) DONE, merged `44e4603`:** NO °F defect — 0070's convert-then-round path verified end-to-end; 28 regression tests (17 core KHOU 2°F-ladder fixtures incl. the x.5°F bucket-PAIR boundary + 11 PGlite twin: full °F place→grade→settle round trip); houston's 10:00Z tick de-risked. **cs-harden (#32) DONE, merged `7efedac`:** lens 6/7 zero-defect + 1 MEDIUM (mode-banner mislabel on mixed flag combos) fixed via ONE corrective re-brief (`describeMode()` from effective toggles, all 4 combos verified live); `--legacy` bit-for-bit; hardened default: munich/16h + b-aires/14h become INELIGIBLE (findings-1×3 compounding), **candidate set UNCHANGED {ankara/14h, houston/14h}**. **reward-instr-2 REPORTED** (7 files, no migration, 1954/135 green, gate-math-untouched claim; KEY: the 'none'-case test reproduces the live 0/1,732 symptom — within-band + above-min-size but mid<0.10 ⇒ the strict two-sided regime zeroes one-sided quotes — the concrete why-zero hypothesis) → engine-adjacent, **2 lenses dispatched** (ri2-lens-a engine math / ri2-lens-b semantics+surfaces). **cityscan-page REPORTED** (correctly refused to fabricate the 9 unpreserved curve rows) → §12 **Data appendix appended** (full pooled curve + terciles + per-cell top-5 from the two bit-identical runs, C16/C17 source) + agent resumed to fill nulls from the canonical doc + the F° label fix. Gate probe skipped this cycle (22:35Z tick mid-blackout); next wake reads it.
- **C24 (~00:25 local 07-04 / 22:24Z 07-03 — gate-drafts INTEGRATED · cs-harden REPORTED → lens dispatched):** **gate-drafts (#36) DONE:** GATE-DAY-PLAYBOOK.md reviewed (2 fixes: re-open bar ALL-of-3 → necessary-#1+strengtheners; /convergence scope caution on the deactivation checklist), committed+pushed `3365a06`. Its best catch: §9R's B/C entry/exit rules were locked for the DEAD flat-open thesis — any PASS-day sizing must reconcile the maker-exit config first. **cs-harden reported:** one-file diff (+224/−32); `--legacy` reproduces the recorded run BIT-FOR-BIT; hardened default excludes 296 fallback bets + 244 ineligible cells → munich/16h + buenos-aires/14h become INELIGIBLE (fallback removal drops n 10→9 — a findings-1×3 compounding interaction), houston LB +3.1→+4.5pp exactly matching city-scan-2's independent counterfactual; **locked-bar candidate set UNCHANGED {ankara/14h, houston/14h}** = what's enrolled. Selection-affecting → single lens dispatched (`cs-harden-lens`) before merge. Still in flight: f-unit-test · reward-instr-2 · cityscan-page.
- **C23 (~23:10 local / 21:08Z — operator token-spend directive → 5 parallel build lanes launched):** All non-signal work (backlog stays closed): **(1) cs-harden** — city-scan forward-tool hardening per the §12 review record (eligibility floor + fallback exclusion + ask-gate honesty; `--legacy` must reproduce the recorded run bit-for-bit; verdict NOT revised); **(2) f-unit-test** — °F fixture tests proving 0070's unit-agnostic claim BEFORE houston's first live tick (any real defect = urgent pre-10:00Z integrate); **(3) reward-instr-2** — the "why-zero" pool-context diagnostic (dist-from-band/min-size/dominant disqualifier; additive-only, gate math byte-identical, v1 discipline: 2 lenses → merge → deploy → :35 verify); **(4) cityscan-page** — /paper-trade "45-City Scan" section from a committed static asset (§12 numbers copied not recomputed, caveats rendered); **(5) gate-drafts** — docs/ops/GATE-DAY-PLAYBOOK.md (KILL package pre-authorized-to-record; PASS package stage-only with the capital boundary absolute; INSUFFICIENT check). Tasks #32–36. All code lanes in worktrees; zero DB writes; integration serial with lenses where engine-adjacent. Gate watch continues in parallel (6/7 days at C22).
- **C22 (~23:00 local / 21:00Z — v5 cycle 1, quiet):** GATE unchanged: INSUFFICIENT 73/34/**6 of 7 days** (07-03 grading pending — the 7th day). `qualifyingTickFrac` trend **0 → 0** (19:35Z, 20:35Z ticks) — the 1b reward term stays bounded at zero. Prod green: maker-exit 20:35Z 94 s/0 errors/73 mkts; 21:00Z capture+convergence caught mid-run (~30 s in, normal). #31 waits for the 07-04 10:00Z tick. Next wake 3600 s.
- **C21 (~22:15 local / 20:14Z — OPERATOR BLANKET APPROVAL → ENROLLMENT EXECUTED + v5 written+armed):** Operator: "approval for any decision — move forward — write the loop prompt for next build." Executed the reasonable set: §12 staged SQL applied VERBATIM (verified 4 active `city_sim_config` rows: +ankara LTAC, +houston KHOU, arms 11–16, fmh 14, thru 07-31) + `city-sim.ts` backfill (ankara 126/121 graded, houston 125/120, 06-12→07-03 — same shape as incumbents; daily 10:00Z cron auto-picks-up). **Confirmation-clock rule recorded in §12: backfill is IN-SAMPLE vs the scan — candidate confirmation = target_date ≥ 07-04 ONLY.** Pre-authorization scope recorded: gate KILL → record without re-asking; gate PASS → stage only (capital/wallet/keys operator-physical, never pre-authorized); INSUFFICIENT → accrue. v5 loop prompt written above + started (overnight watch cadence). Houston = first °F city — first-graded-day check is task #31.
- **C20 (~21:58 local / 19:57Z — ITEM 12 ADJUDICATED + RECORDED; loop stop conditions met):** city-scan-2's contamination-scope report closed the last blocking question: all 296 fallback bets confirmed look-ahead (296/296 empirical, 0 anomalies) but **100 % TRAIN-confined — the TEST holdout is CLEAN** — and every touched top-5 cell IMPROVES without its (losing) fallback bet → candidate set INSENSITIVE. **FINAL: 2 enrollment candidates (ankara/14h, houston/14h) vs the locked bars; pooled negative every hour.** Recorded: SIGNAL-BACKLOG §12 verdict block (with all 3 lens findings + staged enrollment SQL: LTAC + KHOU, arms {11..16}, fmh 14, active_until 07-31; houston = first °F city, unit-agnostic bucketing note) + FINDINGS.md item-12 row + this tick. Skip-by-arm distribution confirms the 0.95-gate binds only late (3 @9h → 500 @19h). Loop STOP: deploy verified (C19) + item 12 recorded + gate still 6/7 days with nothing else open — the deadmen + POST-FABLE-HANDOFF.md carry the watch. Operator pending: (1) enrollment decision, (2) gate label at sufficiency ~07-04→05, (3) /maker-exit tile #4 one-glance visual check.
- **C19 (~21:47 local / 19:46Z — REWARD-INSTR DEPLOY VERIFIED, one-time check DONE):** 19:35Z tick ok/93 s/0 cityErrors/73 mkts/snapshot 189 AND `job_runs.stats.qualifyingTickFrac` present. **First observed `qualifyingTickFrac` = 0** (0 of 1 732 resting ticks qualified; also live now: meanObservedEntry/ExitSpread ≈ 2.06/2.07 ¢, meanMakerFillLatency 29.7 ticks). **Read: the 1b reward-stacking term is bounded at ≈ ZERO live income at current conditions** — the backtest's ciLow lift (+0.25 %→+2.38 % @ 0.05 share) rested on qualifying-band residency the live loop isn't getting; exactly what the instrument was built to measure before the share question opened. Re-read as days accrue. Vercel production READY on `add950e` (19:17Z). Tile #4 visual render auth-gated (/login) — data contract verified in `maker_exit_panel.view.assumptions` + component under the 1937-green suite; operator one-glance check outstanding. Still in flight: city-scan-2 contamination-scope follow-up (nudged 19:43Z).
- **C18 (~21:37 local / 19:37Z, event-driven — city-scan-lens reported; ADJUDICATED):** Lens: 1 real latent defect + 1 doc-overclaim + 1 genuine gap; 8 load-bearing paths CONFIRMED CLEAN (strict-before recovery, split hygiene on targetDate, LB reuse, argmax tie-break + DST, bucket index-space identity incl. the W6 label-alignment risk, clusterMeanTCi on weather-day, consistency identity, fee math). Adjudication: **(1) missing entry-watch eligibility floor in rankTrainCells — CONFIRMED latent, NOT behavior-changing here** (replication printed eligibility: all top-5 cells n=10–11, `eligible:true`; no small-n cell outranked them) → hardening note. **(2) MAX_ENTRY_ASK 0.95 gate is NOT in the live city-sim path — confirmed deviation from the "mirrors live" docstring claim**; binds at late arms; pooled-curve caveat, candidates (14h) insensitive. **(3) frozen-seed fallback = look-ahead BY CONSTRUCTION** (fallback ⇒ no pre-tick build ⇒ frozen seed = first-ever build ⇒ postdates the bet) — the lens's "spot-check" is actually deterministic; ALL 296 fallback bets (4.1 %) contaminated. Blocking question = scope: dispatched a targeted follow-up to the warm runner (fallback distribution by arm/cell; top-5 cells touched? with/without recompute if so; local compute + at most the same cheap pull re-run, blackout-guarded). Verdict recording gated on that scope read. 19:35Z tick running now (blackout) — deploy verification next wake.
- **C17 (~21:36 local / 19:35Z, event-driven — city-scan-2 reported before the stand-down landed):** Accidental but valuable: an INDEPENDENT execution of the same script reproduced the original runner's numbers exactly (7 262 bets / 2 022 skips; identical top-20 TRAIN, top-5 TEST, pooled curve, terciles; same 10 909-row pull, blackout-guarded 19:27:13Z, 16.7 s) + a second zero-deviation spec-conformance read with file:line evidence + one new fact: all top-5 TRAIN cells are `eligible:true` under entry-watch's minGraded=10 (n=10–11 TRAIN). Candidate arithmetic unchanged: ankara/14h + houston/14h clear the locked bar; munich/16h + buenos-aires/14h fail TEST net; helsinki/15h fails TRAIN LB. Recording still gated on the adversarial `city-scan-lens` (in flight — checks the original runner's OWN claims can't verify: look-ahead strictness, bucket index-space mapping, split hygiene in the callee code).
- **C16 (~21:33 local / 19:32Z, event-driven — the ORIGINAL city-scan runner reported):** The prior session's runner did NOT die — its full report arrived via mailbox (built + typechecked clean + ran in ~10 s; footprint exactly one untracked file; 7 262 bets / 2 022 skips over 9 284 cells; 95.9 % genuine point-in-time DB-recovered forecasts, 4.1 % frozen-seed fallback). Redundant `city-scan-2` stood down. **PRELIMINARY adjudication vs the locked §12 bars: TWO candidates — ankara/14h (TRAIN LB +3.6 pp, TEST +$44.88) + houston/14h (LB +3.1 pp, TEST +$12.04);** munich/16h + buenos-aires/14h fail TEST net, helsinki/15h fails TRAIN LB. Pooled curve negative at EVERY hour (mechanism-A prior confirmed); all TEST CIs straddle 0 (n=7–8) — the scan SELECTS, the live loop CONFIRMS. Candidates emerged → the pre-committed review lens is REQUIRED: dispatched `city-scan-lens` (sonnet, background) on the script's load-bearing paths (look-ahead, split hygiene, LB reuse, P&L/index mapping, join key). Verdict recording + enrollment staging deferred to lens completion. Deploy verification (19:35Z tick) at next wake.
- **C15 (~21:30 local / 19:29Z — v4 loop re-entered after session restart):** Board reconciled: main == origin @ `add950e` (v4 prompt committed; reward-instr merged/deployed/pushed at C14). CITY-SCAN: NO §12 verdict block (the prior runner died with its session; a complete-looking 696-line `scripts/research/city-scan.ts` left untracked) → re-dispatched `city-scan-2` (sonnet, background) to validate-vs-spec then run, blackout-guarded, stop-on-2-identical-failures. Prod green: capture 30–43 s/73 inserts · maker-exit 18:35Z tick 101 s/0 cityErrors/73 mkts (pre-deploy tick — no `qualifyingTickFrac` yet; first eligible 19:35Z) · convergence 25–45 s/0 errors. **GATE (18:36Z snapshot): INSUFFICIENT — 73 mkts / 34 cities / 6 of 7 days — only day 7 missing; label renders when 07-03 markets grade.** Net −$160.05, `makerFillRate` 0.082 (vs 0.49 backtest — KILL-path watch), rebate $0, 0 open. Next wake ~19:54Z: verify the 19:35Z post-deploy tick + runner progress.
- **C14 (~21:20 local, operator-authorized commit/deploy/push):** reward-instr build INTEGRATED — 2 lenses ran: lens B 1 LOW (stale-snapshot tile counts, fixed `31fbe51`) · lens A 1 MEDIUM (resting-tick undercount on the no-bid time-stop break path, REPRODUCED, fixed `6662b56` with a stash-and-rerun falsification proof + 3 tests, then CONFIRMED-FIXED by lens A with full boundary tracing) → zero outstanding. FF-merged to main (`4669c5c`→`6662b56`), suite 135/1937 green + typecheck clean on merged tree. Deploying maker-exit-panel + pushing main (Vercel) per operator authorization; verification = the next :35 tick carries `qualifyingTickFrac`. Also in flight: `city-scan` (SIGNAL-BACKLOG item 12, pre-registered — all-45-city historical city-sim replay, TRAIN-select/TEST-confirm).
- **C13 (~19:50 local — FINAL, loop STOPPED):** item 11 ACCEPTED + **ADJUDICATED: KILL** (correction harmful OOS: TEST MAE +0.0159 °C worse, day-clustered CI [−0.0280,−0.0051], R² −6.11 %; the feature leak favored the model and it lost anyway; lens waived — prior-consistent negative). **WS-3 CLOSED — all verdicts recorded: 1b gate-PASS(share unmeasured→forward option) · 2/4/5/6/7/9/11 KILL · 3 NO-PASS(hardening revoked) · 10 INSUFFICIENT(structural).** BUILD-STATE evening addendum written; /remember written; loop ended per the stop rule (no lane has work; the deadmen watch prod; the gate accrues ~07-08→12; POST-FABLE-HANDOFF.md carries adjudication). Uncommitted-tree inventory in the BUILD-STATE addendum — commit is the operator's call.
- **C12 (~19:30 local, event-driven — replacement lens reported):** item3-hardening.ts review = **ZERO DEFECTS**, all 5 checks verified with file:line evidence + full bit-for-bit reproduction (3rd independent confirmation of the pooled numbers). **Item 3 FINAL: naive gate-PASS REVOKED → NO-PASS / INSUFFICIENT_DATA at the day grain** (3 weather-day clusters; perm false-PASS 17.3%; and Q4's 29 station-days fails the strict "≥30 station-days" prose bar outright — bet-count/station-day ambiguity named in the record). Re-open: ≥10 distinct Q4-carrying weather-days. #27 done. Sole remaining lane: item 11 (nonlinear residual, in flight). **All 9 WS-3 verdicts now recorded: 1b gate-PASS(fwd caveat) · 2/4/5/6 KILL · 3 NO-PASS · 7/9 KILL · 10 INSUFFICIENT_DATA.**
- **C11 (~19:25 local):** Last discretionary lane LAUNCHED — the crosscheck's nonlinear-ML residual check **pre-registered as SIGNAL-BACKLOG item 11** (boosted stumps pure-TS/no-deps · fixed hyperparams · l3b feature set · gate: TEST-MAE delta day-clustered CI excl 0, ≥30 days/≥30 stations; low prior per linear R²=0.60%) → item5-rerun. In flight: item-3 lens (ws3c-runner) · item 11. All other WS-3 verdicts recorded.
- **C10 (~19:20 local, event-driven — item 10 reported):** ACCEPTED (exact locked design, no improvisation, one-file footprint). **Item 10 ADJUDICATED: INSUFFICIENT_DATA, structural** — 10Z/22Z rows begin 06-13 (17 d after the split) → TRAIN 0 deltas, 0 shocks; plus >30 d snapshot downsampling makes retrospective 20-min ask recovery impossible for any old-enough window. CLOSED (re-open = ≥30 d accrued pairs + forward ask-capture design; 3 latency nulls say don't build it). #24 done. Prod probe (17:07Z): all green, maker-exit 16:35Z tick 95.7 s/0 errors/65 mkts — 2nd consecutive clean fast tick. Remaining: item-3 lens (reassigned to ws3c-runner after item3-lens went silent) → final item-3 verdict → #25 decision → wrap.
- **C9 (~19:50 local, event-driven — ws3c-runner reported item 6):** ACCEPTED (one new file, blackout respected incl. a self-imposed wait at the :32 edge, self-test bug disclosed+fixed pre-DB). **Item 6 ADJUDICATED: KILL, well-powered null** — n=568/44 cities, edge +0.80pp CI [−1.74,+3.34], day-clustered [−2.14,+3.61]; no sibling-resolution lag (3rd latency-family confirmation). Lens waived (prior-consistent null, no behavior change). #23 done. Remaining: item 10 (running, resumed :43) · item3-lens (report pending, pinged). Then: #25 decision + wrap.
- **C8 (~18:30 local, event-driven — item3-hardening reported):** deliverable ACCEPTED (one new file; duplicate walk matches official runScan() bit-for-bit ×4 quartiles; clusterMeanTCi reused verbatim; seed 20260703). **Hardening numbers fail BOTH survive-rule prongs:** Q4's 104 bets = 29 station-days on **3 distinct weather-days** → day-clustered CI [−7.86,+23.09] n=3; station-clustered [−0.43,+13.62]; perm false-PASS **17.3%**, P(mean≥obs) 6.85%; armEdgeStats confirmed per-bet i.i.d. (stats.ts:195). Verdict NOT finalized — the new script's outputs are load-bearing this time, so the pre-committed review lens runs first (`item3-lens`, dispatched). Pending lens: downgrade item 3 to NO-PASS / INSUFFICIENT_DATA-at-day-grain (clustering artifact, cross-venue-false-PASS pattern repeated).
- **C7 (~19:15 local):** 3e LAUNCHED — item 10 design **pre-registered in SIGNAL-BACKLOG §10 before measurement** (per-station TRAIN-P90 shock on |ΔblendedMu| between consecutive builds · post-build calibratedP vs first ask ≥B_k+20 min · m≥+5pp @ ask≤0.60 · ≤B_k+2 h · gate n≥40/≥6 cities/CI>0; expect KILL per WO-4/WO-5) → assigned to idle item5-rerun (one new file cap). All WS-3 lanes now adjudicated or in flight: hardening(3) · item6 · item10 running; 1b/2/4/5/7/9 recorded.
- **C6 (~19:05 local, event-driven — item5-rerun reported):** deliverable ACCEPTED (one-file diff as capped, defaults byte-identical, typecheck clean, WS-2 baseline artifact untouched). **Item 5 ADJUDICATED: KILL** — basket @ chw=1: mean 6.81→3.78%, ciLow +0.25→−3.23%, LOCO 45/45 / LODO 21/21 (vs 15/45, 9/21); chw=1 control shows widening alone hurts (4.61%) — the pre-named dilution branch. Review lens on the harness diff waived (non-load-bearing: sim prong through unmodified engine decides; harness CIs corroborate to 4 dp). FINDINGS + backlog recorded; #26 done. Note: `jackknife-maker-exit.ts` mod in main tree is MINE (CLI ext), not the parallel agent's. In flight: item3-hardening · ws3c-runner(item 6). WS-3 scorecard so far: 1b gate-PASS(fwd-assumption caveat) · 2 KILL · 3 PROVISIONAL-PASS(hardening) · 4 KILL · 5 KILL · 6 running · 7/9 KILL (earlier).
- **C5 (~18:55 local):** 3d LAUNCHED — item 6 design **pre-registered in SIGNAL-BACKLOG §6 before measurement** (R_N sibling-resolution event · pre-R_N snapshot only · m ≥ +5pp @ ask ≤ 0.60 · entry ≤ R_N+2 h · gate n≥40/≥6 cities/CI>0; expect KILL) → assigned to idle ws3c-runner (one new file cap). Three runners in flight: item5-rerun · item3-hardening · ws3c-runner(item 6).
- **C4 (~18:45 local, event-driven — ws3c-runner reported):** 3c ACCEPTED (28 s run — the "heavy pull" fear was overblown for this dataset) + ADJUDICATED: **item 2 KILL** (+2.91pp, CI [−3.21,+9.03] straddles 0, n=84) · **item 3 gate-PASS PROVISIONAL** (Q4 +7.47pp CI [+1.06,+13.87] n=104, Q1–Q3 null as pre-registered, monotone-ish trend) → hardening dispatched (`item3-hardening`: day+station-clustered CIs, ≥2000-perm zero-skill; survive-rule pre-stated in task #27) · **item 4 KILL sign-reversed** (−1.73pp CI [−2.77,−0.69] — market OVERPRICES extreme-day tails). FINDINGS 3 rows + backlog 3 blocks recorded. #22 done. In flight: item5-rerun, item3-hardening. Next after both: 3d (item 6, threshold pre-registration first).
- **C3 (~18:25–18:35 local, event-driven — ws3b-runner reported):** Deliverable ACCEPTED (zero file mods, raw-only, file:line evidence). **1b ADJUDICATED: gate-PASS** — full ciLow +0.25%→+2.38% at the 0.05 share floor (linear in share; TRAIN+TEST PASS from 0.10); caveat: pool share UNMEASURED, $67/day derived average — recorded in FINDINGS.md + SIGNAL-BACKLOG. **Item 5: first measurement VACUOUS** (chw=0 ⇒ 1 candidate ⇒ basket ≡ single, byte-identical; jackknife harness unwired) — NOT a KILL; amended spec (basket 2/3 @ chw=1, gate unchanged) pre-registered in SIGNAL-BACKLOG BEFORE re-measurement. Dispatched `item5-rerun` (harness wiring + local runs; one-file diff cap) + `ws3c-runner` (items 2–4 ONE pull, blackout-guarded, stop-on-2-identical-failures). Tasks: #21 done, #22 in_progress, #26 new.
- **C2 (18:05–18:15 local / 16:05–16:15Z):** Prod green + improving — the 15:35Z maker-exit tick ran **94 s / cityErrors 0 / 65 mkts** (vs 264–378 s pre-0077); capture 34–58 s; convergence 22–36 s/0 errors. `makerFillRate` 0.092 (watch continues). New file `EXTERNAL-AGENT-CROSSCHECK.md` (parallel thread, research-only, no code): third-party AI report crosschecked → **nothing changes priorities**; one open candidate (nonlinear-ML residual check) boarded as idle-lane task #25. **3b takeover triggered** — no parallel-agent progress since 15:06 (>3 h): dispatched own sonnet runner (`ws3b-runner`, background, main tree, read-only, from-cache local compute) for 1b reward sweep {0.05,0.10,0.25,0.50} + basket 1/2/3 + jackknife. Task #21 in_progress.
- **C1 (17:30–17:40 local / 15:30–15:40Z):** Prod green — capture 35–51 s/85–88 inserts · convergence-panel 23–27 s/0 cityErrors · maker-exit :35 ticks ok (264–378 s). The off-schedule 14:59:50Z+15:03:04Z maker-exit runs = the WS-1 rollout verification ticks (scope 58/43 mkts matches the outcome block) — not an anomaly. **Watch:** live `makerFillRate` 0.10–0.12 vs backtest 0.49 (POST-FABLE assumption #1; <0.30 flagged as the likely KILL path) — note-and-watch, the gate accrues. 7+9 KILL rows confirmed recorded in FINDINGS.md (b31917e). WS-3 board → TaskList #21–#24; 3b/3c stay the parallel agent's (last progress 15:08 local; takeover threshold 18:08). Next wake ~18:10: check parallel-agent progress → dispatch own 3b runner if none.
