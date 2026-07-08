# BUYING-BUILDS-LOOP — the self-managed day-loop plan

> **What this is.** A continuous, mostly-autonomous work loop (started 2026-07-08). The operator checks
> in remotely; Claude self-manages between check-ins. **Files are the state**: every cycle reads this
> doc first (plus `BUILD-STATE.md` tail + `git status`), does ONE coherent chunk, tests, commits local,
> logs the cycle at the bottom, and refreshes the `⚑ FOR THE OPERATOR` block. This is the single source
> of truth for the loop — same idiom as `FASTTRACK-PLAN.md`.
>
> **Mission (operator's words, 2026-07-08):** improve + evaluate the two *buying* builds — the per-market
> bid stack behind **`/trading`** and the **Google convergence play** — and stand up a **separate
> Fahrenheit US-city test** (bid base = Google + the source that best matches that city's resolved high,
> same rules as the °C markets) to see if there's an added edge there. Alongside: **keep Supabase compute
> lean** — measure what's using compute, pause/remove what we safely can *without touching a prioritized
> build*.

---

## ⚑ FOR THE OPERATOR (remote check-in) — read this first

_Claude keeps this block current every cycle. It is the whole status in 20 seconds._

- **On fire?** No. (If yes, it says so here with the one action needed.)
- **Branch / state:** `loop/2026-07-08-buying-builds` off `main @ 2491598` (6 depth-capture-v2 commits still
  local/unpushed). Suite/typecheck: _green at last cycle_.
- **Staged, awaiting your yes/no (operator-gated — Claude will not apply):**
  - _(none yet — will list one-command bundles here: migrations, edge-fn deploys, the WS-A forward panel)_
- **Decisions I need from you:** _(none yet)_
- **Gate / compute readings (live):** _(filled each cycle — WS-A °F cohort n, §9R-E status; Micro DB health)_
- **Latest verdict / headline:** _(the most recent real finding)_

---

## Hard rules for the loop (non-negotiable — mirrors FASTTRACK §"Hard rules")

1. **BOUNDARY — the money line.** Claude builds software only. **Never** place a trade, **never** read or
   touch wallet keys / credentials / `.env*` / secrets, **never** activate the live rail (no `TRADE_MODE=live`,
   do **not** apply `0082`, do **not** start `scripts/trade-bot.ts`). The operator funds/keys/authorizes. All
   trading work is paper/backtest/code only. If a secret ever appears in context, redact it and flag rotation.
2. **The DB is the shared fragile resource.** It's a **Micro** instance (`lenysiqxihsmxljvyybt`, eu-north-1)
   that **saturates at US-evening peak**. One heavy DB op at a time. Do **not** run archive-scale pulls or
   `opening_captures` TOAST scans against prod at peak — **backtest off the offline archive**
   (`scripts/research/out/opening-captures-archive/`, 319k rows / 475 events) and local sim caches. If ticks
   slow / prod 504s appear → **stop DB work and shed load**, note it in the operator block.
3. **Frozen-gate discipline.** Pre-register the gate/criteria *before* measuring. Report vs the pre-registered
   bar. `INSUFFICIENT_DATA` is an honest, allowed outcome. **Backtest ≠ GO** — a synthetic-book or in-sample
   pass is not a live edge (the whole 12-signal graveyard is this lesson; see `FINDINGS.md`).
4. **Watch the backtest-vs-realized gap.** A flat-accuracy backtest already gave *wrong* entry-hour advice
   once (memory `city-taker-accuracy-hour-varying`, C101): buying cheap-early looked best in backtest, but
   realized data shows *late* hours win as the running-max floor is observed. Any entry-time claim must be
   cross-checked against realized forward `*_paper_bets`, not just the replay.
5. **Suite + typecheck green before every commit.** `pnpm test && pnpm typecheck`. Atomic commits on the loop
   branch. **Local only — do not push** unless the operator says so. Single-writer docs (`BUILD-STATE.md`,
   `FINDINGS.md`, this file) — the loop is the only writer during the loop.
6. **Additive-and-reversible for anything live.** New panels/migrations must be purely additive (no DROP, no
   money path) AND must not add net load to the Micro DB without freeing at least as much (WS-D funds WS-A).

## Autonomy envelope

- **🟢 GREEN — do freely:** read/search/analyse; write code, engines, sims, tests on the loop branch; run
  suite + typecheck; backtest/simulate on the offline archive + local caches; **light, read-only** SQL probes
  (respect rule 2); write/update analysis docs, `BUILD-STATE.md`, `FINDINGS.md`, this doc, and a `/remember`
  entry when a real thread closes; atomic local commits.
- **🟡 YELLOW — do only if reversible + verified-safe + logged; else stage for the operator:** slow/pause a
  cron via `cron.alter_job` **only** when it's a verified dead-signal or clearly over-provisioned job, nothing
  prioritized reads it, and you record the exact one-line re-enable command in the operator block + the
  updated compute-audit doc. Watch the next tick; revert on any strain.
- **🔴 RED — never autonomously (stage a one-command bundle for the operator instead):** apply any migration;
  deploy any edge function; any destructive SQL (DROP/DELETE beyond a verified, dump-gated prune); push to
  origin; anything in rule 1.

**Prioritized builds — protect these, never degrade them:** the forecasting analytics pipeline
(`discover-markets`, `poll-markets`, `snapshot-forecasts/-ensembles/-sources`, `build-distributions`,
`run-calibration`, `grade-bets`, `fetch-actuals`, `metar-nowcast`, `snapshot-downsample`); the deliverable
panels (`amsterdam-paper-trade`, `city-paper-trade`, `google-paper-panel`/`/convergence`, `/data`,
`/efficiency`, `/maker-exit`); and the **WS-A Fahrenheit test** once it exists.

---

## Current live state (verified 2026-07-08 — re-verify at session start; the fleet drifts)

- **`main @ 2491598`**, tree clean, **6 commits local/unpushed** (depth-capture v2 build + 3 review rounds).
- **Cron fleet: 21 active jobs.** Heavy/high-freq: `poll-markets` */5 (money path — untouchable),
  `opening-capture` */5 (jobid 32, **revived** to feed the Google panel + convergence/maker-exit `houseProb`),
  `opening-capture-deadman` */10 (33), `google-paper-panel` */15 (31 — **the Google convergence play**),
  `metar-nowcast` */15, `whale-watch` */10, `health-monitor` */30. Daily/2×-daily: the forecasting pipeline +
  `city-paper-trade` (10:00Z) + `amsterdam-paper-trade` + prunes.
- **`depth-capture` cron is PAUSED**; v2 is **BUILT + tested (2994 green) + committed, NOT deployed** —
  operator-gated (`0089` then `0088` + redeploy `discover-markets` + `depth-capture` fn; see
  `DEPTH-CAPTURE-V2-HANDOFF.md`). v2 repoints the Google panel off `opening_captures` onto a dedicated
  `market_depth` table — **this is the single biggest compute win available** (WS-B ∩ WS-D).
- **Trading rail:** `/trading` stack complete but **DORMANT + KILLED** (forward maker-exit gate settled KILL
  2026-07-07; all 12 signals dead — `FINDINGS.md`). `0082` MERGED-DARK, not applied. `TRADE_MODE` never-live.
- **DB:** `opening_captures` reclaimed to ~75 MB on 07-07; Micro still saturates at peak. Offline raw-book
  archive at `scripts/research/out/opening-captures-archive/`.
- **`source_forecasts` sources:** `google` (from 06-30, n≈4.4k), `openweathermap` (from 06-13, n≈3.3k),
  `weatherapi` (from 06-13, n≈1.9k). Scored vs truth by `source_accuracy` / `scripts/check-source-accuracy.ts`.

---

## WS-A — Fahrenheit US-city bid test  ★ HEADLINE / new experiment

**Thesis (operator):** run the Google convergence play's rules on US **°F** markets, but bid on **Google +
the source that best matches that city's resolved high** (not raw Google), scored as a **separate cohort**
from the °C markets — to find whether source-selection unlocks an edge °F currently doesn't have.

**Why this is the right shape (already-known facts — read before building):**
- The Google play **excludes °F today on purpose**: `packages/core/src/sim/google-bucket-view.ts:280`
  (`excludeFahrenheit`, default `true` in `GOOGLE_DEFAULTS`, `google-bucket-replay.ts:134`). Root cause in
  **`GOOGLE-FAHRENHEIT-INVESTIGATION.md`**: raw Google is **cold-biased** on °F (~14% bucket accuracy, zero
  take-profits) — NOT the old floor-vs-round bug (already fixed to `wuRound`). So "use a better source" is
  exactly the lever.
- **The overfitting trap (respect it):** per-city "best source" selection was investigated and **rejected**
  for the main blend — `packages/core/src/sim/source-accuracy-findings.ts` records the calibrated house blend
  dominates every single source at every lead, and the per-city overrides `survivesMultipleComparisons =
  false` (best-of-10 picks at n≈48). So this test **must** pre-register the per-city source choice on a TRAIN
  window and validate OOS; require the picked source to beat **both** raw-Google **and** the calibrated blend
  OOS, else fall back to the blend. Do not fit-and-declare.

**Read first (search before building):** `GOOGLE-FAHRENHEIT-INVESTIGATION.md`;
`scripts/research/google-fahrenheit-diagnostic.ts`, `google-f-biascorrect.ts`, `google-convergence-sweep.ts`,
`google-entry-window.ts`; `packages/core/src/sim/source-accuracy-findings.ts`; `scripts/check-source-accuracy.ts`.

**The "same rules as Celsius" are unit-blind by construction** — mirror by feeding native °F numbers + an °F
ladder: `packages/core/src/buckets.ts` (`parseBucketLabel`, `winningBucket`, `validateLadder` uniform-unit),
`units.ts` (`cToF`, `wuRound`, `toNative`), `sim/google-bucket-replay.ts` (`googleBucketIdx` already does
`cToF`+`wuRound`; `replayGoogleBracket` = cheap-band entry → absolute TP → hold-to-resolution),
`sim/google-bucket-view.ts` (`buildGoogleView`). The §9R-E gate to clear: `openingVerdict` in
`sim/opening-convergence.ts` (**≥40 markets / ≥6 cities / ≥7 distinct days, city-clustered CI > 0, zero-skill
MC < 5%**).

**Build order:**
1. **Best-matching-source selector** (new pure module + research script). Per US °F city, over a TRAIN window,
   rank {google, openweathermap, weatherapi, calibrated-house, bias-corrected-google} by fit to the resolved
   °F high (mean-miss / within-1). Emit the pick **+ its OOS-validated margin over raw-Google and over the
   blend**. Frozen: TRAIN→TEST split, pre-registered bar. Reuse `source_accuracy` plumbing; do not re-invent.
2. **°F cohort in the Google engine.** Add a cohort path to `buildGoogleView` that (a) does **not** exclude
   °F, (b) centers the bid on the selected source's forecast (falling back to the blend when no source clears
   OOS), (c) accounts °F **separately** from °C. Keep `replayGoogleBracket`/`googleBucketIdx` unchanged
   (already unit-general). Lock behaviour with tests mirroring `google-bucket-view.test.ts` for °F.
3. **Backtest first, off the offline archive** (rule 2) — does the source-selected °F cohort clear §9R-E
   frictionless, and does it survive the taker round-trip spread? Cross-check any entry-window claim vs
   realized data (rule 4). Honest verdict either way → `FINDINGS.md`.
4. **If (and only if) the backtest is promising:** build a **separate additive forward paper panel** for the
   °F cohort (its own snapshot table + `dash_*` + edge fn + `/…` tile), **paper-only, no money path**, and
   **stage the deploy bundle for the operator** (RED — don't deploy). It must be **net-neutral on the Micro
   DB** — fund its ticks by pruning per WS-D. The paper forward run is the gate of record, not the backtest.

**US °F cities available:** the calibration ∩ Polymarket-listable set includes Houston (KHOU), Dallas,
Miami, plus the broader US airports; the paper-trade already runs Houston/Ankara °F arms (proof the °F path
is sound: `packages/core/test/sim-city-fahrenheit.test.ts`). Confirm the live US °F market universe from
`market_events` before fixing the cohort list.

## WS-B — Evaluate + improve the Google convergence play (existing)

- **Land the depth-capture v2 evaluation.** It's built + committed, not deployed. Claude can't deploy (RED),
  but can: re-read `DEPTH-CAPTURE-V2-HANDOFF.md`, design + dry-run the **parity check** (does the new
  `market_depth` anchor reproduce the panel vs the `opening_captures` path?), tighten the deploy bundle, and
  present it in the operator block. This is also the biggest WS-D compute win.
- **Read the current `google-paper-panel` numbers** (light SQL): is `/convergence` accruing, what's the
  §9R-E readout on the °C cohort, is there *any* edge signal, and would `google-entry-window.ts` /
  TP-variant tuning move it? Honest read; don't force a signal.

## WS-C — Evaluate + improve `/trading` per-market bid (CODE/EVAL ONLY — rail stays dormant)

The rail is KILLED + dormant; **do not activate it**. "Improve + evaluate" here = code correctness + wire-
readiness, so that *if* WS-A finds edge, the executor that would place those bids is sound:
- Evaluate the per-market bid logic: `packages/trading/src/order-intent.ts` (`makerLimitPrice` never-cross
  guarantee, `orderIntentKey` idempotency), `live.ts` (`MakerExecutor` place/reprice/reconcile),
  `packages/core` `planPlacements` + the `MAKER_EXIT_TUNED` sizing/caps. Find bugs, add tests, note gaps.
- The shadow-diff harness (`scripts/research/trade-shadow-diff.ts`) can't run until `0082` is applied
  (operator-gated) — evaluate it statically; don't ask to apply `0082` just to run it.

## WS-D — Supabase compute (keep it lean; don't break a prioritized build)

- **Read first:** `docs/ops/COMPUTE-AUDIT-2026-07-07.md`. It unscheduled 10 dead-signal crons + reclaimed
  `opening_captures` 1.37 GB→75 MB. **The fleet has drifted since** (opening-capture revived */5,
  google-paper-panel */15 live, depth-capture pending) → the audit needs a 07-08 refresh, not a redo.
- **Measure what's using compute now** (light probes): `pg_stat_statements` top by `total_exec_time`, table
  sizes (`pg_total_relation_size`), cron frequency × cost, edge invocation counts. Identify the real hogs.
- **Rank pause/remove candidates with evidence.** Dead-signal edge fns still deployed ($0 at rest but list
  them). Over-provisioned crons. The prune of any table that's grown since 07-07. For each: exact reversible
  command + proof no prioritized build reads it.
- **Execute only 🟡 reversible + verified-safe** (logged, with the re-enable one-liner in the operator block);
  **stage** the depth-capture v2 deploy and anything 🔴 as a one-command bundle. Write the refreshed
  `docs/ops/COMPUTE-AUDIT-2026-07-08.md`.
- **Constraint:** WS-A's new panel must be funded here (rule 6) — net-neutral-or-better on the Micro DB.

---

## Per-cycle protocol

1. **Orient:** read this doc + `BUILD-STATE.md` tail + `git status`; re-verify live state if a session just
   started (fleet, gate, DB health — the fleet drifts).
2. **Pick the highest-value next action.** WS-A is the headline; interleave a WS-D compute probe early (cheap,
   protects the DB); WS-B/WS-C as they unblock. Prefer finishing an open thread over starting a new one.
3. **Do ONE coherent chunk.** Pre-register any gate first (rule 3). Backtest off the archive (rule 2).
4. **Green-gate + commit:** `pnpm test && pnpm typecheck` → atomic local commit → append a cycle-log line →
   refresh `BUILD-STATE.md` + the `⚑ FOR THE OPERATOR` block.
5. **Live change?** Reversible cron → do it, log the re-enable. Migration/deploy/push → **stage a bundle** in
   the operator block; do not execute.
6. **Blocked / decision-for-operator / gate adjudicated / on fire →** write it to the operator block and move
   to the next-best thread. Don't spin on a blocked item.
7. **Pace:** this loop mostly *builds*, so it rarely idles. When genuinely waiting (data accrual, a staged
   bundle) → drop to a low cadence and say so; don't churn tokens re-checking unchanged state.

## Cycle log (append-only; newest at bottom)

- **C0 (2026-07-08, setup):** loop plan written from a full code+infra map (2 Explore agents mapped the
  `/trading` stack and the convergence/paper-trade/unit seams; live cron fleet + `source_forecasts` +
  `city_sim_config` pulled; `COMPUTE-AUDIT-2026-07-07` + `DEPTH-CAPTURE-V2-HANDOFF` read). Key reframing:
  the Google play excludes °F on purpose (cold-bias), so WS-A's "best-matching source" *is* the fix; the
  per-city source pick carries a known overfitting trap → frozen-gate/OOS mandatory. Next: create the loop
  branch, WS-D compute probe (cheap, protects DB), then WS-A step 1 (source selector, read prior work first).
