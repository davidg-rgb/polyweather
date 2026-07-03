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

## WS-3 — Signal-backlog execution (the parallel agent's track)

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

## The autonomous /loop prompt — v2, post-day-0 (paste as-is; self-paced — no interval)

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
